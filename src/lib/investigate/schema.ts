/**
 * The contract with the model, and the guard rails around it.
 *
 * Two halves:
 *
 *   INVESTIGATION_RESPONSE_SCHEMA   what Gemini is asked to return, as a
 *                     response schema, so the answer arrives as JSON rather
 *                     than as prose that has to be parsed hopefully.
 *   sanitizeInvestigation   what is done to that JSON before anyone sees it.
 *
 * The second half is the important one. A schema constrains the SHAPE of a
 * model's answer and says nothing about its truth: a model can return a
 * perfectly well-formed object containing a company that does not exist, a
 * registration number it invented and a URL it has never seen. So every claim
 * that can be checked mechanically is checked here, against the text actually
 * retrieved during the investigation:
 *
 *   - a source URL survives only if it is one of the pages the investigation
 *     actually fetched, or a source the search tool actually returned;
 *   - a registration reference survives only if that string appears in the
 *     retrieved text;
 *   - a legal entity name survives only if it was grounded in something that
 *     was actually read, or in a page the model actually opened;
 *   - "confirmed" regulatory status survives only if a regulator, or an RBI
 *     dataset lookup that POSITIVELY MATCHED, is among the evidence. A lookup
 *     that found nothing is a real finding and is shown, but it corroborates
 *     nothing and may never make a claim authoritative;
 *   - VERIFIED survives only if both of the above hold.
 *
 * Anything that fails is removed and recorded as a notice, never silently
 * kept. The last rule in this file is the product's founding one: an
 * investigation that found nothing returns UNVERIFIED, and UNVERIFIED always
 * carries the sentence saying that absence of evidence is not evidence of
 * fraud.
 *
 * Pure functions, no SDK import, so this is unit-testable without a key.
 */

import type { IdentityConfidence } from "./risk";
import {
  INVESTIGATION_STATUS_LABELS,
  type DomainRelationship,
  type EvidenceSourceType,
  type IdentifiedEntity,
  type InvestigationEvidence,
  type InvestigationStatus,
  type RegulatoryFinding,
} from "./types";

// ---------------------------------------------------------------------------
// What the model is asked for
// ---------------------------------------------------------------------------

const STRING = { type: "STRING" } as const;
const NULLABLE_STRING = { type: "STRING", nullable: true } as const;

/**
 * A Gemini response schema. Written as a plain object rather than with the
 * SDK's enums so this module stays dependency-free; it is cast at the call
 * site. Deliberately contains no numeric field of any kind.
 */
export const INVESTIGATION_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    entityName: {
      ...NULLABLE_STRING,
      description: "Trading or brand name the website operates under. Null if the site does not say.",
    },
    entityLegalName: {
      ...NULLABLE_STRING,
      description: "Registered legal name, exactly as written in a source. Null if no source states one.",
    },
    aliases: {
      type: "ARRAY",
      items: STRING,
      description: "Other names the sources use for the same operator.",
    },
    identityConfidence: {
      type: "STRING",
      enum: ["high", "medium", "low", "none"],
      description:
        "How firmly the material identifies the LEGAL entity operating this website. high: a " +
        "legal document, disclosure or registration statement names it. medium: the site names " +
        "it, for example in a copyright line, without a legal document. low: only inferred from " +
        "a brand name or an unofficial source. none: no legal entity could be identified.",
    },
    identityBasis: {
      ...NULLABLE_STRING,
      description:
        "Where the legal entity name was read: the page, disclosure or document. Null if none.",
    },
    regulatoryStatus: {
      type: "STRING",
      enum: ["confirmed", "not_confirmed", "unknown"],
      description:
        "confirmed only when a regulator or the RBI dataset shows this entity is authorised.",
    },
    regulator: {
      ...NULLABLE_STRING,
      description: "The regulator named by a source, for example Reserve Bank of India.",
    },
    registrationReference: {
      ...NULLABLE_STRING,
      description:
        "Registration or licence number, copied character for character from a source. Null if no source states one.",
    },
    domainRelationshipStatus: {
      type: "STRING",
      enum: ["established", "likely", "uncertain", "contradicted"],
      description: "How well the evidence ties this domain to the identified entity.",
    },
    domainRelationshipExplanation: {
      ...STRING,
      description:
        "One or two sentences saying what ties the domain to the entity, or what is missing.",
    },
    evidence: {
      type: "ARRAY",
      description: "Every claim above, with the source it rests on. Omit anything you cannot source.",
      items: {
        type: "OBJECT",
        properties: {
          claim: STRING,
          sourceTitle: STRING,
          sourceUrl: NULLABLE_STRING,
          sourceType: {
            type: "STRING",
            enum: [
              "regulator",
              "official_website",
              "company_document",
              "lenderlens_dataset",
              "search_result",
              "other",
            ],
          },
          supportingText: {
            ...STRING,
            description: "What the source says, quoted or closely paraphrased.",
          },
          kind: { type: "STRING", enum: ["fact", "inference"] },
        },
        required: ["claim", "sourceTitle", "sourceType", "supportingText", "kind"],
      },
    },
    findings: {
      type: "ARRAY",
      items: STRING,
      description: "What was established, in plain sentences.",
    },
    conflicts: {
      type: "ARRAY",
      items: STRING,
      description: "Sources that disagree, stated as disagreements.",
    },
    warnings: {
      type: "ARRAY",
      items: STRING,
      description: "What a reader should be careful of. Never an accusation.",
    },
    recommendedStatus: { type: "STRING", enum: ["VERIFIED", "CAUTION", "UNVERIFIED"] },
  },
  required: [
    "regulatoryStatus",
    "domainRelationshipStatus",
    "domainRelationshipExplanation",
    "evidence",
    "findings",
    "recommendedStatus",
  ],
} as const;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_EVIDENCE = 8;
const MAX_FINDINGS = 6;
const MAX_CONFLICTS = 4;
const MAX_WARNINGS = 5;
const MAX_ALIASES = 4;
const MAX_LINE = 400;
const MAX_NAME = 160;

const SOURCE_TYPES: readonly EvidenceSourceType[] = [
  "regulator",
  "official_website",
  "company_document",
  "lenderlens_dataset",
  "search_result",
  "other",
];

export const ABSENCE_IS_NOT_FRAUD =
  "Nothing here says this website is fraudulent. It says the evidence needed to identify the " +
  "lender behind it could not be found — many lawful lenders are regulated outside the RBI lists " +
  "LenderLens holds, and a small or new operator may leave very little public trace.";

// ---------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------

export interface SanitizeContext {
  readonly domain: string;
  /** Every URL the investigation actually retrieved or was given by search. */
  readonly retrievedUrls: readonly string[];
  /**
   * Everything the investigation actually read, concatenated.
   *
   * Never includes the model's own answer. A claim has to be checkable against
   * something independent of the thing making it; feeding the response back in
   * as its own corpus lets any invented name or reference number corroborate
   * itself simply by having been asserted.
   */
  readonly retrievedText: string;
  /**
   * Whether the RBI lookups actually MATCHED something.
   *
   * This exists because of a specific and dangerous confusion. The dataset
   * summary handed to the model includes negative results — "no record matched
   * this domain" — and the model quite reasonably cites them as evidence with
   * sourceType "lenderlens_dataset". Without this flag, that citation made
   * `hasAuthoritative` true, and a lookup that FAILED to find a lender was
   * counted as authoritative corroboration that one exists. A negative dataset
   * result is a real finding and worth showing, but it corroborates nothing.
   */
  readonly hasPositiveDatasetMatch: boolean;
  /**
   * Pages the model opened for itself during the call.
   *
   * The API reports which URLs the retrieval tool successfully read, but not
   * what was on them, so this is the most that can be known about a claim
   * sourced from one. A legal entity name is therefore allowed to stand on it —
   * the name is shown but its confidence is floored, which keeps it out of a
   * LOW RISK outcome — while a registration number, which is quoted to a user
   * as a checkable fact, is not: an unverifiable reference number is dropped.
   */
  readonly modelOpenedPages: boolean;
}

export interface SanitizedInvestigation {
  readonly identifiedEntity: IdentifiedEntity;
  /** How firmly the legal entity is established, after grounding checks. */
  readonly identityConfidence: IdentityConfidence;
  /** Where the legal name was read, when a source was given for it. */
  readonly identityBasis: string | null;
  readonly regulatoryStatus: RegulatoryFinding;
  readonly domainRelationship: DomainRelationship;
  readonly evidence: readonly InvestigationEvidence[];
  readonly findings: readonly string[];
  readonly conflicts: readonly string[];
  readonly warnings: readonly string[];
  readonly recommendedStatus: InvestigationStatus;
  readonly recommendedStatusLabel: string;
  /** What was dropped and why. Surfaced to the user as a notice. */
  readonly notices: readonly string[];
}

function text(value: unknown, limit = MAX_LINE): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  const lowered = cleaned.toLowerCase();
  if (cleaned.length === 0 || lowered === "null" || lowered === "n/a" || lowered === "none") {
    return null;
  }
  return cleaned.slice(0, limit);
}

function list(value: unknown, limit: number, lineLimit = MAX_LINE): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const line = text(item, lineLimit);
    if (line && !out.includes(line)) out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

/** Compare URLs by host and path, so a trailing slash is not a difference. */
function urlKey(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.hostname.replace(/^www\./, "")}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Letters and digits only — how a registration number is compared. */
function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function sanitizeInvestigation(
  raw: unknown,
  context: SanitizeContext,
): SanitizedInvestigation {
  const notices: string[] = [];
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

  const allowedUrls = new Set(
    context.retrievedUrls.map(urlKey).filter((key): key is string => key !== null),
  );
  const corpus = compact(context.retrievedText);

  // --- evidence ------------------------------------------------------------
  const evidence: InvestigationEvidence[] = [];
  let droppedUrls = 0;

  if (Array.isArray(source.evidence)) {
    for (const item of source.evidence) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Record<string, unknown>;

      const claim = text(entry.claim);
      const supportingText = text(entry.supportingText, 600);
      if (!claim || !supportingText) continue;

      const rawUrl = text(entry.sourceUrl, 500);
      const key = rawUrl ? urlKey(rawUrl) : null;
      // A URL the investigation never visited cannot be shown as a source.
      const sourceUrl = rawUrl !== null && key !== null && allowedUrls.has(key) ? rawUrl : null;
      if (rawUrl !== null && sourceUrl === null) droppedUrls += 1;

      const sourceTypeValue = text(entry.sourceType, 40);
      const sourceType = SOURCE_TYPES.includes(sourceTypeValue as EvidenceSourceType)
        ? (sourceTypeValue as EvidenceSourceType)
        : "other";

      evidence.push({
        claim,
        sourceTitle: text(entry.sourceTitle, MAX_NAME) ?? "Source",
        sourceUrl,
        sourceType,
        supportingText,
        kind: text(entry.kind, 20) === "inference" ? "inference" : "fact",
      });

      if (evidence.length >= MAX_EVIDENCE) break;
    }
  }

  if (droppedUrls > 0) {
    notices.push(
      `${droppedUrls} source link${droppedUrls === 1 ? "" : "s"} the investigation reported did not ` +
        "match any page it actually retrieved, so the link was removed. The finding is shown " +
        "without it rather than with an address nobody has checked.",
    );
  }

  // A regulator's page is authoritative on its own. A LenderLens dataset
  // citation is authoritative only when the lookup it refers to actually found
  // a record: "no record matched" is evidence of nothing, and counting it here
  // is how an unverified lender used to acquire a confirmed regulatory status.
  const hasAuthoritative = evidence.some(
    (item) =>
      item.sourceType === "regulator" ||
      (item.sourceType === "lenderlens_dataset" && context.hasPositiveDatasetMatch),
  );

  if (
    !context.hasPositiveDatasetMatch &&
    evidence.some((item) => item.sourceType === "lenderlens_dataset")
  ) {
    notices.push(
      "The investigation cited LenderLens's RBI reference data, but that lookup found no matching " +
        "record. A search that returns nothing is not corroboration, so it was not counted as " +
        "authoritative evidence of this lender's standing.",
    );
  }

  // --- entity --------------------------------------------------------------
  //
  // The brand name and the legal name are different things and are kept apart
  // all the way through: a lending app is marketed as "I2I Funding" and
  // operated by "RNVP Technology Private Limited", and only the second is a
  // key into the RBI's records.
  const brandName = text(source.entityName, MAX_NAME);
  const legalName = text(source.entityLegalName, MAX_NAME);

  const claimedConfidence = text(source.identityConfidence, 20);
  let identityConfidence: IdentityConfidence =
    claimedConfidence === "high" || claimedConfidence === "medium" || claimedConfidence === "low"
      ? claimedConfidence
      : "none";

  // A legal entity name is the key the whole regulatory lookup turns on, so it
  // may not simply be asserted. It has to be traceable to something that was
  // read: our own retrieved text, or a page the model opened for itself during
  // the call. Where it is neither, the name is still reported — it may well be
  // right, and hiding it helps nobody — but its confidence is floored, which
  // is what stops it reaching a LOW RISK outcome. See risk.ts.
  const legalNameGrounded =
    legalName !== null &&
    (corpus.includes(compact(legalName)) || context.modelOpenedPages);

  if (legalName !== null && !legalNameGrounded) {
    identityConfidence = "low";
    notices.push(
      `The investigation named "${legalName}" as the operating company, but that name appears in ` +
        "nothing it actually read and it opened no page of its own to read it from. The name is " +
        "shown because it may be correct, but it is treated as unconfirmed.",
    );
  }

  if (legalName === null && identityConfidence !== "none") {
    identityConfidence = "none";
  }

  const identityBasis = text(source.identityBasis, 300);

  const identifiedEntity: IdentifiedEntity = {
    name: brandName,
    legalName,
    aliases: list(source.aliases, MAX_ALIASES, MAX_NAME),
  };

  // --- regulatory ----------------------------------------------------------
  const claimedRegulatory = text(source.regulatoryStatus, 40);
  let regulatoryState: RegulatoryFinding["status"] =
    claimedRegulatory === "confirmed" || claimedRegulatory === "not_confirmed"
      ? claimedRegulatory
      : "unknown";

  if (regulatoryState === "confirmed" && !hasAuthoritative) {
    regulatoryState = "unknown";
    notices.push(
      "The investigation reported a confirmed regulatory status without citing a regulator or the " +
        "RBI dataset, so it was reduced to unknown. Regulatory standing is only ever reported as " +
        "confirmed on the strength of an authoritative source.",
    );
  }

  let registrationReference = text(source.registrationReference, 80);
  if (registrationReference && !corpus.includes(compact(registrationReference))) {
    notices.push(
      `A registration reference ("${registrationReference}") was reported that appears in none of ` +
        "the material retrieved, so it was removed. Reference numbers are shown only when they were " +
        "read from a source.",
    );
    registrationReference = null;
  }

  const regulatoryStatus: RegulatoryFinding = {
    status: regulatoryState,
    regulator: text(source.regulator, MAX_NAME),
    registrationReference,
  };

  // --- domain relationship --------------------------------------------------
  const relationshipValue = text(source.domainRelationshipStatus, 40);
  const relationshipStatus: DomainRelationship["status"] =
    relationshipValue === "established" ||
    relationshipValue === "likely" ||
    relationshipValue === "contradicted"
      ? relationshipValue
      : "uncertain";

  const domainRelationship: DomainRelationship = {
    status: evidence.length === 0 ? "uncertain" : relationshipStatus,
    explanation:
      text(source.domainRelationshipExplanation, 600) ??
      `Nothing retrieved during this investigation ties ${context.domain} to a named lending entity.`,
  };

  // --- the outcome ----------------------------------------------------------
  const findings = list(source.findings, MAX_FINDINGS, 500);
  const conflicts = list(source.conflicts, MAX_CONFLICTS, 500);
  const warnings = list(source.warnings, MAX_WARNINGS, 500);

  const claimedStatus = text(source.recommendedStatus, 20);
  let recommendedStatus: InvestigationStatus =
    claimedStatus === "VERIFIED" || claimedStatus === "CAUTION" ? claimedStatus : "UNVERIFIED";

  const verifiable =
    regulatoryStatus.status === "confirmed" &&
    hasAuthoritative &&
    (domainRelationship.status === "established" || domainRelationship.status === "likely");

  if (recommendedStatus === "VERIFIED" && !verifiable) {
    recommendedStatus = conflicts.length > 0 ? "CAUTION" : "UNVERIFIED";
    notices.push(
      "The investigation proposed a verified outcome that its own evidence does not support — " +
        "verification here requires an authoritative source for the entity's regulatory standing " +
        "and evidence tying this domain to that entity. The weaker outcome is shown instead.",
    );
  }

  if (domainRelationship.status === "contradicted" || conflicts.length > 0) {
    recommendedStatus = "CAUTION";
  }

  if (evidence.length === 0) recommendedStatus = "UNVERIFIED";

  if (recommendedStatus === "UNVERIFIED" && !warnings.includes(ABSENCE_IS_NOT_FRAUD)) {
    warnings.push(ABSENCE_IS_NOT_FRAUD);
  }

  return {
    identifiedEntity,
    identityConfidence,
    identityBasis,
    regulatoryStatus,
    domainRelationship,
    evidence,
    findings,
    conflicts,
    warnings,
    recommendedStatus,
    recommendedStatusLabel: INVESTIGATION_STATUS_LABELS[recommendedStatus],
    notices,
  };
}
