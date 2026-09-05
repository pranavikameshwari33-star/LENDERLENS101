/**
 * LAYER 2 — Company identity.
 *
 * The regulatory layer answered "does this institution exist and what is its
 * standing?". This one answers a different question: "does the name the lender
 * gave you actually correspond to the legal entity that was found?"
 *
 * The two come apart in exactly the case this product exists for. A caller says
 * "XYZ Finance Limited". XYZ Finance Limited is real, registered, in the RBI
 * list. The regulatory layer is satisfied. But if the caller also gave a CIN
 * belonging to a different company, or the name they gave only loosely
 * resembles the entity that was matched, the identity is not established — and
 * saying "verified" at that point would be the single most damaging thing this
 * application could do.
 */

import { trigramSimilarity } from "../../normalize";
import { signal, type Signal } from "../signals";
import { COMPANY_STATUS_LABELS, type CompanyIdentityFindings, type CompanyIdentityStatus, type EntityMatch } from "../types";

/** Below this the claimed name and the matched legal name are unrelated. */
const NAME_MISMATCH_THRESHOLD = 0.4;
/** At or above this the model's own decision is corroborated by raw similarity. */
const NAME_MATCH_THRESHOLD = 0.75;

export interface CompanyInput {
  readonly claimedName: string | null;
  readonly cin: string | null;
  readonly primary: EntityMatch | null;
  readonly matches: readonly EntityMatch[];
  readonly modelThreshold: number | null;
}

export function assessCompanyIdentity(input: CompanyInput): CompanyIdentityFindings {
  const signals: Signal[] = [];
  const primary = input.primary;

  if (!primary) {
    return {
      status: "unknown",
      statusLabel: COMPANY_STATUS_LABELS.unknown,
      claimedName: input.claimedName,
      legalName: null,
      cin: null,
      cinMatchesName: null,
      classification: null,
      layer: null,
      regionalOffice: null,
      address: null,
      acceptsPublicDeposits: null,
      signals,
    };
  }

  const entity = primary.entity;

  // --- does the CIN point at the same company as the name? -----------------
  let cinMatchesName: boolean | null = null;
  if (input.cin && input.claimedName) {
    const byCin = input.matches.find((match) => match.identifiedBy === "cin");
    if (byCin) {
      const similarity = trigramSimilarity(byCin.entity.nameCore, normaliseClaim(input.claimedName));
      cinMatchesName = similarity >= NAME_MISMATCH_THRESHOLD;
      if (!cinMatchesName) {
        signals.push(
          signal({
            id: "cin_name_conflict",
            category: "company_identity",
            severity: "high",
            origin: "regulatory_fact",
            title: "The CIN belongs to a different company than the name given",
            explanation:
              "The Corporate Identification Number supplied is registered to a company whose name bears " +
              "no resemblance to the name you were given. A legitimate lender's CIN and name agree. " +
              "Resolve this before proceeding.",
            evidence: `${input.cin} is registered to ${byCin.entity.name}`,
            source: "RBI registered lists",
          }),
        );
      } else {
        signals.push(
          signal({
            id: "cin_name_agree",
            category: "company_identity",
            severity: "positive",
            origin: "regulatory_fact",
            title: "The CIN and the company name agree",
            explanation:
              "The CIN supplied is registered against a company of the name you were given. A CIN is " +
              "unique, so this identifies the entity rather than merely resembling it.",
            evidence: `${input.cin} — ${byCin.entity.name}`,
            source: "RBI registered lists",
          }),
        );
      }
    }
  }

  // --- how firmly was the entity identified? -------------------------------
  const nameSimilarity =
    input.claimedName !== null
      ? trigramSimilarity(normaliseClaim(input.claimedName), entity.nameCore)
      : null;

  const status = resolveStatus(input, primary, nameSimilarity, cinMatchesName);

  if (primary.identifiedBy === "cin" || primary.identifiedBy === "exact_name") {
    signals.push(
      signal({
        id: "identity_established",
        category: "company_identity",
        severity: "positive",
        origin: "regulatory_fact",
        title:
          primary.identifiedBy === "cin"
            ? "Identified by CIN"
            : "The name matches the registered legal name exactly",
        explanation:
          primary.identifiedBy === "cin"
            ? "A CIN is a unique identifier issued by the Ministry of Corporate Affairs, so this is an identification rather than a resemblance."
            : "Once punctuation and letter case are set aside, the name given matches the entity's registered name exactly. Company names are not unique or protected, so this is strong evidence rather than proof — a CIN would settle it.",
        evidence: entity.name,
        source: "RBI reference data",
      }),
    );
  } else if (primary.identifiedBy === "former_name") {
    signals.push(
      signal({
        id: "identity_former_name",
        category: "company_identity",
        severity: "positive",
        origin: "regulatory_fact",
        title: "Matches a former name the RBI records for this entity",
        explanation:
          "The RBI lists this company under a newer name and records the name you were given as a " +
          "previous one. A lender still trading under an old name is common after a rebrand, but " +
          "it is worth knowing that the current legal name is different.",
        evidence: `${input.claimedName} → ${entity.name}`,
        source: "RBI reference data",
      }),
    );
  } else if (status === "partial") {
    signals.push(
      signal({
        id: "identity_probable_only",
        category: "company_identity",
        severity: "medium",
        origin: "model",
        title: "Identity rests on name similarity alone",
        explanation:
          "No CIN, exact name or RBI-published website tied the lender to this record. The match was " +
          "made by the entity-matching model from the name alone, and company names are neither " +
          "unique nor protected. Ask the lender for its CIN.",
        evidence: `${input.claimedName ?? "(no name given)"} → ${entity.name}`,
        source: "Entity-matching model",
        confidence: primary.matchProbability,
      }),
    );
  } else if (status === "mismatch") {
    signals.push(
      signal({
        id: "identity_not_established",
        category: "company_identity",
        severity: "high",
        origin: "model",
        title: "The name given does not correspond to any entity on record",
        explanation:
          "The closest record in the RBI data is not close enough for the entity-matching model to " +
          "accept it as the same institution. The lender's legal identity could not be established.",
        evidence: `closest record on file: ${entity.name}`,
        source: "Entity-matching model",
        confidence: primary.matchProbability,
      }),
    );
  }

  return {
    status,
    statusLabel: COMPANY_STATUS_LABELS[status],
    claimedName: input.claimedName,
    legalName: entity.name,
    cin: entity.cin,
    cinMatchesName,
    classification: entity.attributes.classification ?? entity.attributes.bankCategory ?? null,
    layer: entity.attributes.layer ?? null,
    regionalOffice: entity.attributes.regionalOffice ?? null,
    address: entity.attributes.address ?? null,
    acceptsPublicDeposits: entity.attributes.acceptsPublicDeposits ?? null,
    signals,
  };
}

function normaliseClaim(name: string): string {
  // The claim is compared against `nameCore`, so it has to be reduced the same
  // way. Importing nameCore here rather than re-implementing it keeps the two
  // in step.
  return name
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+(PRIVATE\s+LIMITED|PVT\s*LTD|LIMITED|LTD|LLP|INC|CORP)\s*$/g, "")
    .trim();
}

function resolveStatus(
  input: CompanyInput,
  primary: EntityMatch,
  nameSimilarity: number | null,
  cinMatchesName: boolean | null,
): CompanyIdentityStatus {
  if (cinMatchesName === false) return "mismatch";

  if (primary.identifiedBy === "cin" || primary.identifiedBy === "exact_name") return "match";
  if (primary.identifiedBy === "former_name" || primary.identifiedBy === "official_website") return "match";

  if (!input.claimedName) return "unknown";
  if (!primary.acceptedByModel) return "mismatch";

  return nameSimilarity !== null && nameSimilarity >= NAME_MATCH_THRESHOLD ? "match" : "partial";
}
