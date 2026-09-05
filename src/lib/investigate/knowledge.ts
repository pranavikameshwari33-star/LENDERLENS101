import "server-only";

/**
 * The investigation's first tool: what does LenderLens already know?
 *
 * This is a thin wrapper over the existing entity resolver — the same compiled
 * RBI index, the same blocking, the same entity-matching model the
 * deterministic verification uses. Nothing about matching is reimplemented
 * here; the wrapper exists only to present a result in the flat, quotable form
 * the agent's prompt needs, and to leave the model's probability behind.
 *
 * The probability is deliberately dropped. It is a number about strings, not
 * about companies, and putting it in a prompt would invite the language model
 * to reason about it as though it measured legitimacy.
 *
 * The tool is called twice in an investigation: once with what the user
 * supplied, and again with whatever legal name the website turned out to
 * disclose. The second call is the point of the whole exercise — a lender that
 * is in the RBI data under a legal name nobody types into a search box is
 * exactly the case the deterministic path cannot reach on its own.
 */

import { loadEntityIndex, type EntityIndex } from "../index/store";
import { resolveEntities } from "../verify/matcher";
import { entitySourceLabel, standingLabel, type EntityMatch } from "../verify/types";

export interface KnownEntity {
  readonly id: string;
  readonly name: string;
  /** "RBI list of registered NBFCs", and so on. */
  readonly sourceLabel: string;
  /** "Certificate of Registration on record", and so on. */
  readonly standingLabel: string;
  readonly standing: string;
  readonly cin: string | null;
  readonly classification: string | null;
  readonly hostnames: readonly string[];
  readonly emailDomains: readonly string[];
  /** How the record was reached: by CIN, by exact name, by similarity. */
  readonly foundBy: string;
  /**
   * Which identifier reached it, if one did. The agent needs the identifier
   * itself and not just its label: "the RBI publishes this domain for that
   * company" and "that company has a similar name" are different facts, and
   * only the first may tie a website to an entity.
   */
  readonly identifiedBy: EntityMatch["identifiedBy"];
  /**
   * True when the record was reached by an IDENTIFIER — a CIN, an exact name,
   * a former name the RBI itself records, or a website the RBI publishes — as
   * opposed to being scored as similar by the matching model.
   *
   * This is the difference between "the RBI holds a record for this company"
   * and "the RBI holds a record for a company with a somewhat similar name",
   * and only the first may ever be treated as regulatory corroboration.
   */
  readonly identified: boolean;
}

export interface KnownEntitySearch {
  readonly query: { readonly hostname: string | null; readonly organizationName: string | null };
  readonly matches: readonly KnownEntity[];
  readonly datasetAsOf: string | null;
}

const MAX_RETURNED = 3;

export function searchKnownEntities(
  input: { hostname?: string | null; organizationName?: string | null; cin?: string | null },
  index: EntityIndex = loadEntityIndex(),
): KnownEntitySearch {
  const hostname = input.hostname?.trim() || null;
  const organizationName = input.organizationName?.trim() || null;
  const cin = input.cin?.trim() || null;

  const nbfcDataset = index.file.datasets.find((dataset) => dataset.key === "registered_nbfc");

  if (!hostname && !organizationName && !cin) {
    return {
      query: { hostname, organizationName },
      matches: [],
      datasetAsOf: nbfcDataset?.asOf ?? null,
    };
  }

  // The domain doubles as a contact-domain key, but ONLY when no company name
  // was supplied.
  //
  // The RBI publishes an official website for very few records and a contact
  // address for most, so for an NBFC the contact domain is usually the only
  // identifier the regulator itself gives that ties a company to a place on the
  // web. Passing null here — which this call did until it was found to be why a
  // domain the RBI does hold resolved to nothing — throws that away.
  //
  // The condition is what keeps it honest. A search carrying a company name is
  // asking "is THIS COMPANY registered", and only a name or a CIN can answer
  // that. Letting the domain identify a record in the same result would report
  // the RBI as having identified whatever name the caller passed, on the
  // strength of a record that matched the URL instead — a different company,
  // presented as the answer to a question about this one. So the two questions
  // are asked separately, and the caller that wants "who does the RBI say this
  // domain belongs to" asks it with the domain alone.
  //
  // This never makes the dataset the answer to "who operates this website". It
  // makes the dataset offer a CANDIDATE NAME, which is then looked up on its
  // own to produce the regulatory answer. See `agent.ts`, steps 7 and 8.
  const outcome = resolveEntities(
    { claimedName: organizationName, cin, hostname, emailDomain: organizationName ? null : hostname },
    index,
  );

  // Only matches the existing engine would itself act on, so the agent cannot
  // be handed a near-miss and treat it as an identification.
  const matches = outcome.matches
    .filter((match) => match.acceptedByModel || match.identifiedBy !== null)
    .slice(0, MAX_RETURNED)
    .map((match): KnownEntity => {
      const entity = match.entity;
      return {
        id: entity.id,
        name: entity.name,
        sourceLabel: entitySourceLabel(entity),
        standingLabel: standingLabel(entity.standing),
        standing: entity.standing,
        cin: entity.cin,
        classification: entity.attributes.classification ?? entity.attributes.bankCategory ?? null,
        hostnames: entity.hostnames,
        emailDomains: entity.emailDomains,
        foundBy: match.confidenceLabel,
        identifiedBy: match.identifiedBy,
        identified: match.identifiedBy !== null,
      };
    });

  return {
    query: { hostname, organizationName },
    matches,
    datasetAsOf: nbfcDataset?.asOf ?? null,
  };
}

/** True when a search produced a record reached by an identifier. */
export function hasIdentifiedMatch(search: KnownEntitySearch): boolean {
  return search.matches.some((match) => match.identified);
}

/** The dataset search, written out for the prompt. Never invents a record. */
export function describeKnownEntities(search: KnownEntitySearch): string {
  if (search.matches.length === 0) {
    const asked = [
      search.query.hostname ? `domain "${search.query.hostname}"` : null,
      search.query.organizationName ? `name "${search.query.organizationName}"` : null,
    ]
      .filter(Boolean)
      .join(" and ");

    return (
      `No record in the RBI reference data LenderLens holds (registered NBFCs, registered ARCs, ` +
      `the cancelled-registration list and the Banks in India directory, as on ` +
      `${search.datasetAsOf ?? "an unrecorded date"}) matched ${asked || "the query"}. ` +
      `This dataset covers those lists only; lenders regulated under other frameworks are absent ` +
      `from it, so absence here is not evidence of anything.`
    );
  }

  return search.matches
    .map((match) => {
      const parts = [
        `name: ${match.name}`,
        `list: ${match.sourceLabel}`,
        `standing: ${match.standingLabel}`,
        match.cin ? `CIN: ${match.cin}` : null,
        match.classification ? `classification: ${match.classification}` : null,
        match.hostnames.length > 0 ? `RBI-published website: ${match.hostnames.join(", ")}` : null,
        match.emailDomains.length > 0
          ? `RBI-held contact domains: ${match.emailDomains.join(", ")}`
          : null,
        `found by: ${match.foundBy}`,
      ].filter(Boolean);
      return `- ${parts.join("; ")}`;
    })
    .join("\n");
}
