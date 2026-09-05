/**
 * Candidate retrieval over the entity index.
 *
 * Scoring 15,483 entities with the full feature extractor on every request
 * would be wasteful, so retrieval happens in two stages, the standard shape
 * for record linkage:
 *
 *   BLOCKING     cheap, recall-oriented: pull anything that shares a rare word
 *                or a run of three characters with the query.
 *   SCORING      expensive, precision-oriented: run the model over that set.
 *
 * The blocking stage is the one that decides what the model can possibly find,
 * so it is deliberately generous — an entity that never enters the candidate
 * set is a false negative no threshold can recover.
 *
 * Identifier lookups (CIN, exact name, e-mail domain, official hostname) are
 * separate and take precedence. A CIN is an identity; a similar name is a
 * coincidence waiting to happen.
 */

import { nameCore, normalizeCin, normalizeHostname, normalizeName } from "../normalize";
import { retrievalNgrams } from "../ml/features";
import { loadEntityIndex, type EntityIndex } from "./store";
import type { IndexedEntity } from "./types";

/** How the candidate was reached. Reported to the user, never inferred. */
export type RetrievalRoute =
  | "cin"
  | "exact_name"
  | "alternate_name"
  | "email_domain"
  | "official_website"
  | "blocking";

export interface Candidate {
  readonly entity: IndexedEntity;
  readonly routes: readonly RetrievalRoute[];
  /** Cheap blocking score, used only to bound the candidate set. */
  readonly blockingScore: number;
}

export interface RetrievalOptions {
  /** Upper bound on candidates handed to the model. */
  readonly maxCandidates?: number;
}

const DEFAULT_MAX_CANDIDATES = 60;
/** Postings lists longer than this are skipped during blocking. */
const MAX_POSTINGS_SCAN = 4_000;
/** Only fall back to character n-grams when token blocking came back thin. */
const NGRAM_STAGE_THRESHOLD = 200;

// ---------------------------------------------------------------------------
// Identifier lookups
// ---------------------------------------------------------------------------

function resolve(index: EntityIndex, positions: readonly number[] | undefined): IndexedEntity[] {
  if (!positions) return [];
  return positions.map((position) => index.entities[position]).filter(Boolean);
}

export function findByCin(cin: string, index = loadEntityIndex()): IndexedEntity[] {
  const normalized = normalizeCin(cin);
  if (!normalized) return [];
  return resolve(index, index.byCin.get(normalized));
}

export function findByExactName(name: string, index = loadEntityIndex()): IndexedEntity[] {
  const normalized = normalizeName(name);
  if (normalized.length === 0) return [];
  return resolve(index, index.byNameNormalized.get(normalized));
}

export function findByAlternateName(name: string, index = loadEntityIndex()): IndexedEntity[] {
  const normalized = normalizeName(name);
  if (normalized.length === 0) return [];
  return resolve(index, index.byAlternateName.get(normalized));
}

export function findByEmailDomain(domain: string, index = loadEntityIndex()): IndexedEntity[] {
  const host = normalizeHostname(domain);
  if (!host) return [];

  const direct = resolve(index, index.byEmailDomain.get(host));
  if (direct.length > 0) return direct;

  // A published address on `mail.example.com` still identifies example.com.
  const parts = host.split(".");
  for (let i = 1; i < parts.length - 1; i += 1) {
    const parent = parts.slice(i).join(".");
    const found = resolve(index, index.byEmailDomain.get(parent));
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * Entities whose OFFICIAL website, as published by the RBI, is on this
 * hostname. Only banks have one — which is exactly why a domain claim about an
 * NBFC cannot be settled this way and has to be reported as uncorroborated.
 */
export function findByOfficialHostname(hostname: string, index = loadEntityIndex()): IndexedEntity[] {
  const host = normalizeHostname(hostname);
  if (!host) return [];

  const direct = resolve(index, index.byHostname.get(host));
  if (direct.length > 0) return direct;

  const parts = host.split(".");
  for (let i = 1; i < parts.length - 1; i += 1) {
    const parent = parts.slice(i).join(".");
    const found = resolve(index, index.byHostname.get(parent));
    if (found.length > 0) return found;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Blocking
// ---------------------------------------------------------------------------

/**
 * Gather candidates for a claimed name.
 *
 * Rare tokens contribute their IDF weight; character 3-grams contribute a
 * small flat weight, which is what keeps a misspelling ("Bajajj Finance")
 * inside the candidate set even though none of its tokens match.
 */
export function retrieveCandidates(
  claimedName: string,
  options: RetrievalOptions = {},
  index = loadEntityIndex(),
): Candidate[] {
  const normalized = normalizeName(claimedName);
  if (normalized.length < 2) return [];

  const core = nameCore(claimedName) || normalized;
  const limit = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const scores = new Map<number, number>();
  const routes = new Map<number, Set<RetrievalRoute>>();

  const bump = (position: number, weight: number, route: RetrievalRoute): void => {
    scores.set(position, (scores.get(position) ?? 0) + weight);
    let set = routes.get(position);
    if (!set) {
      set = new Set();
      routes.set(position, set);
    }
    set.add(route);
  };

  for (const token of new Set(core.split(/\s+/).filter(Boolean))) {
    const postings = index.tokenPostings.get(token);
    if (!postings || postings.length > MAX_POSTINGS_SCAN) continue;
    const weight = index.idf.get(token) ?? 1;
    for (const position of postings) bump(position, weight, "blocking");
  }

  // The n-gram stage is what keeps a misspelling in the candidate set, but it
  // is an order of magnitude more expensive than the token stage. It is only
  // worth paying for when the token stage came back thin — which is exactly
  // the case where a name has been mistyped or abbreviated.
  if (scores.size < NGRAM_STAGE_THRESHOLD) {
    const gramWeight = 0.35;
    for (const gram of new Set(retrievalNgrams(core))) {
      const postings = index.ngramPostings.get(gram);
      if (!postings || postings.length > MAX_POSTINGS_SCAN) continue;
      for (const position of postings) bump(position, gramWeight, "blocking");
    }
  }

  // Exact and former-name hits always survive to the scoring stage, whatever
  // the blocking score says.
  const guaranteed = new Set<number>();
  for (const [route, key, map] of [
    ["exact_name", normalized, index.byNameNormalized],
    ["exact_name", core, index.byNameCore],
    ["alternate_name", normalized, index.byAlternateName],
  ] as const) {
    for (const position of map.get(key) ?? []) {
      guaranteed.add(position);
      bump(position, 1_000, route);
    }
  }

  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(limit, guaranteed.size));

  return ranked.map(([position, score]) => ({
    entity: index.entities[position],
    routes: [...(routes.get(position) ?? new Set<RetrievalRoute>(["blocking"]))],
    blockingScore: score,
  }));
}
