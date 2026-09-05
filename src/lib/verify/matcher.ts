/**
 * Entity resolution: given what the lender calls itself, which RBI record — if
 * any — is that?
 *
 * This is the one place the machine-learning model is used, and the order of
 * operations matters more than the model does:
 *
 *   1. IDENTIFIERS FIRST. A CIN, an exact name, a former name the RBI itself
 *      records, or a website the RBI publishes for a bank. These are lookups,
 *      not inferences. When one hits, the answer is settled and the model's
 *      opinion is recorded but not needed.
 *
 *   2. THE MODEL SECOND, over candidates from the blocking stage. It answers
 *      one narrow question — are these two names the same institution — and
 *      its probability is reported as a probability, never as a fact.
 *
 * The model never decides regulatory standing. It decides *which record* is
 * being talked about; what that record then says about registration or
 * cancellation is read straight out of the RBI data.
 */

import { loadEntityIndex, type EntityIndex } from "../index/store";
import {
  findByAlternateName,
  findByCin,
  findByEmailDomain,
  findByExactName,
  findByOfficialHostname,
  retrieveCandidates,
  type RetrievalRoute,
} from "../index/search";
import { emailDomain as domainOfAddress, isMailProviderDomain } from "../normalize";
import type { IndexedEntity } from "../index/types";
import { buildIdfContext, buildQueryProfile, extractFeatures } from "../ml/features";
import { loadEntityMatchModel, ModelUnavailableError, type EntityMatchModel } from "../ml/model";
import { confidenceLabelFor, type EntityMatch } from "./types";

export interface MatchInput {
  readonly claimedName: string | null;
  readonly cin: string | null;
  readonly hostname: string | null;
  /**
   * A contact domain to identify a record by — either a bare domain or a full
   * address, from which the domain is taken. The RBI publishes a contact
   * address for most of its records and a website for very few, so this is
   * usually the only identifier the regulator itself gives that ties a company
   * to a place on the web.
   */
  readonly emailDomain: string | null;
}

export interface MatchOutcome {
  readonly matches: readonly EntityMatch[];
  readonly model: {
    readonly available: boolean;
    readonly version: string | null;
    readonly algorithm: string | null;
    readonly threshold: number | null;
    readonly candidatesScored: number;
    readonly unavailableReason: string | null;
  };
  readonly notices: readonly string[];
}

/** How many candidates the model scores per request. */
const CANDIDATE_LIMIT = 60;
/**
 * Candidates below this are not shown at all. Well under the model's decision
 * threshold, so a near-miss is still visible to a user who wants to see what
 * was considered and rejected.
 */
const DISPLAY_FLOOR = 0.05;
const MAX_MATCHES_RETURNED = 12;

export function resolveEntities(input: MatchInput, index: EntityIndex = loadEntityIndex()): MatchOutcome {
  const notices: string[] = [];

  let model: EntityMatchModel | null = null;
  let unavailableReason: string | null = null;
  try {
    model = loadEntityMatchModel();
  } catch (error) {
    unavailableReason =
      error instanceof ModelUnavailableError
        ? error.message
        : "The entity-matching model could not be loaded.";
    notices.push(
      "Part of the name-matching is unavailable on this deployment, so a lender could only be " +
        "found by an exact name, a company number or a website the RBI itself publishes. Treat a " +
        "result of “not found” with more caution than usual.",
    );
  }

  // --- identifier lookups -------------------------------------------------
  const identified = new Map<string, EntityMatch["identifiedBy"]>();
  const routesById = new Map<string, Set<RetrievalRoute>>();
  const pool = new Map<string, IndexedEntity>();

  const remember = (
    entity: IndexedEntity,
    route: RetrievalRoute,
    identifier: EntityMatch["identifiedBy"],
  ): void => {
    pool.set(entity.id, entity);
    let routes = routesById.get(entity.id);
    if (!routes) {
      routes = new Set();
      routesById.set(entity.id, routes);
    }
    routes.add(route);
    if (identifier && !identified.has(entity.id)) identified.set(entity.id, identifier);
  };

  if (input.cin) {
    for (const entity of findByCin(input.cin, index)) remember(entity, "cin", "cin");
  }
  if (input.claimedName) {
    for (const entity of findByExactName(input.claimedName, index)) {
      remember(entity, "exact_name", "exact_name");
    }
    for (const entity of findByAlternateName(input.claimedName, index)) {
      remember(entity, "alternate_name", "former_name");
    }
  }
  if (input.hostname) {
    for (const entity of findByOfficialHostname(input.hostname, index)) {
      remember(entity, "official_website", "official_website");
    }
  }

  // The RBI's own contact address for a record.
  //
  // This index has always been built and, until now, never queried: the input
  // below was declared and dropped on the floor, so a domain the regulator
  // itself publishes for a company resolved to nothing. That is the difference
  // between "the RBI holds no record for i2ifunding.com" — true, and useless,
  // because the RBI lists companies and not websites — and "the RBI records
  // that domain as RNVP Technology Private Limited's contact address", which is
  // the regulator tying the two together and is the strongest identifier
  // available for a site that names no operator a fetcher can read.
  //
  // A mailbox provider is excluded: an NBFC that filed a Gmail address must not
  // make gmail.com resolve to a registered lender.
  const contactDomain = input.emailDomain
    ? (domainOfAddress(input.emailDomain) ?? input.emailDomain)
    : null;
  if (contactDomain && !isMailProviderDomain(contactDomain)) {
    for (const entity of findByEmailDomain(contactDomain, index)) {
      remember(entity, "email_domain", "contact_domain");
    }
  }

  // --- blocking -----------------------------------------------------------
  const queryName = input.claimedName ?? deriveNameFromDomain(input.hostname);
  if (queryName) {
    for (const candidate of retrieveCandidates(queryName, { maxCandidates: CANDIDATE_LIMIT }, index)) {
      pool.set(candidate.entity.id, candidate.entity);
      let routes = routesById.get(candidate.entity.id);
      if (!routes) {
        routes = new Set();
        routesById.set(candidate.entity.id, routes);
      }
      for (const route of candidate.routes) routes.add(route);
    }
  }

  // --- scoring ------------------------------------------------------------
  const scoringName = queryName ?? input.claimedName;
  const profile = scoringName ? buildQueryProfile(scoringName) : null;
  const idfContext = buildIdfContext(index.idf, index.totalDocuments);
  const threshold = model?.threshold ?? 0.9;

  const matches: EntityMatch[] = [];
  let bestBelowFloor: EntityMatch | null = null;
  let scored = 0;

  for (const entity of pool.values()) {
    const identifiedBy = identified.get(entity.id) ?? null;

    let probability = 0;
    if (profile && model) {
      probability = model.score(extractFeatures(profile, entity, idfContext));
      scored += 1;
    } else if (profile) {
      // Without the model, fall back to the strongest single similarity
      // feature so the interface can still rank candidates. This is clearly
      // reported as a degraded mode rather than passed off as a model score.
      const features = extractFeatures(profile, entity, idfContext);
      probability = Math.max(features[3], features[6]);
    }

    // An identifier hit is an identification, not an inference. Reporting a
    // low model probability against a matched CIN would be misleading.
    const effective = identifiedBy ? Math.max(probability, 1) : probability;

    const match: EntityMatch = {
      entity,
      matchProbability: identifiedBy ? probability : effective,
      acceptedByModel: identifiedBy !== null || probability >= threshold,
      routes: [...(routesById.get(entity.id) ?? new Set<RetrievalRoute>(["blocking"]))],
      identifiedBy,
      confidenceLabel: confidenceLabelFor(identifiedBy, probability),
    };

    if (!identifiedBy && effective < DISPLAY_FLOOR) {
      if (!bestBelowFloor || match.matchProbability > bestBelowFloor.matchProbability) {
        bestBelowFloor = match;
      }
      continue;
    }

    matches.push(match);
  }

  // When nothing clears the display floor, keep the single best candidate so the
  // interface can still report what the model looked at and rejected. "We
  // considered X and scored it 4%" is more useful to a reader than silence.
  if (matches.length === 0 && bestBelowFloor) matches.push(bestBelowFloor);

  matches.sort(rankMatches);

  return {
    matches: matches.slice(0, MAX_MATCHES_RETURNED),
    model: {
      available: model !== null,
      version: model?.version ?? null,
      algorithm: model?.algorithm ?? null,
      threshold: model?.threshold ?? null,
      candidatesScored: scored,
      unavailableReason,
    },
    notices,
  };
}

/**
 * Identifier matches first, then model probability. Within a tie, a currently
 * registered record outranks a cancelled one — not because it is better news,
 * but because the registered lists carry CINs and can therefore be verified
 * further, while the cancelled list carries only names.
 */
const STANDING_RANK: Record<string, number> = {
  registered: 0,
  bank: 0,
  cancelled: 1,
  cancellation_record: 2,
};

function rankMatches(a: EntityMatch, b: EntityMatch): number {
  const identifier = Number(b.identifiedBy !== null) - Number(a.identifiedBy !== null);
  if (identifier !== 0) return identifier;

  const probability = b.matchProbability - a.matchProbability;
  if (Math.abs(probability) > 0.001) return probability;

  return (STANDING_RANK[a.entity.standing] ?? 3) - (STANDING_RANK[b.entity.standing] ?? 3);
}

/**
 * When only a website or e-mail was supplied, the domain label is the only
 * name-like text available. "bajajfinserv.in" becomes "bajajfinserv", which
 * the matcher handles well enough to be worth trying — and which is reported
 * to the user as a guess derived from the domain, not as a name they gave.
 */
function deriveNameFromDomain(hostname: string | null): string | null {
  if (!hostname) return null;
  const parts = hostname.split(".").filter((part) => part.length > 0);
  if (parts.length < 2) return null;

  const twoPartSuffixes = new Set(["co.in", "net.in", "org.in", "co.uk", "com.au", "bank.in"]);
  const lastTwo = parts.slice(-2).join(".");
  const index = twoPartSuffixes.has(lastTwo) ? parts.length - 3 : parts.length - 2;
  const label = index >= 0 ? parts[index] : null;

  return label && label.length >= 3 ? label : null;
}
