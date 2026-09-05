/**
 * The shape of a verification result.
 *
 * Plain JSON throughout, so the same object is produced by the engine, returned
 * by `/api/verify`, and rendered by a Server or Client Component without a
 * translation layer.
 *
 * The important design decision here is that a verification has SEVEN outcomes,
 * not one. Six of them are layer verdicts — regulatory, company, website,
 * e-mail, loan terms, scam signals — and the seventh is the overall one, which
 * is derived from them by explicit rules. A single score would be easier to
 * render and would destroy the product: the whole point is that a lender can be
 * a real registered NBFC *and* the party contacting the user can still be an
 * impersonator, and only a per-layer answer can say that.
 */

import type { EntityStanding, IndexedEntity } from "../index/types";
import type { RetrievalRoute } from "../index/search";
import type { DomainAgeResult, SiteCheckResult } from "../website/types";
import type { Signal } from "./signals";
import type { InputKind, LoanTermsInput } from "./input";

// ---------------------------------------------------------------------------
// Overall verdict
// ---------------------------------------------------------------------------

export type Verdict = "green" | "amber" | "red" | "gray";

export const VERDICT_LABELS: Record<Verdict, string> = {
  green: "Low risk — consistent with RBI records",
  amber: "Caution — inconsistencies found",
  red: "High risk — serious contradictions or risk signals",
  gray: "Insufficient evidence to reach a conclusion",
};

export const VERDICT_SHORT: Record<Verdict, string> = {
  green: "LOW RISK",
  amber: "CAUTION",
  red: "HIGH RISK",
  gray: "INSUFFICIENT EVIDENCE",
};

// ---------------------------------------------------------------------------
// Layer verdicts
// ---------------------------------------------------------------------------

/** Regulatory standing of the claimed institution in the RBI reference data. */
export type RegulatoryStatus =
  | "verified"       // matched an entity holding a current registration
  | "cancelled"      // matched an entity on the cancelled-registration list
  | "conflicting"    // registered and cancelled records both matched
  | "not_verified"   // nothing in the reference data corroborates the claim
  | "unknown";       // no name was supplied to check

export type CompanyIdentityStatus = "match" | "partial" | "mismatch" | "unknown";
export type DigitalIdentityStatus = "consistent" | "inconsistent" | "uncorroborated" | "not_provided";
export type LoanTermsStatus = "low_concern" | "caution" | "high_concern" | "not_provided";
export type ScamSignalLevel = "low" | "medium" | "high" | "not_assessed";

export const REGULATORY_STATUS_LABELS: Record<RegulatoryStatus, string> = {
  verified: "Verified",
  cancelled: "Cancelled",
  conflicting: "Conflicting",
  not_verified: "Not verified",
  unknown: "Unknown",
};

export const COMPANY_STATUS_LABELS: Record<CompanyIdentityStatus, string> = {
  match: "Match",
  partial: "Partial",
  mismatch: "Mismatch",
  unknown: "Unknown",
};

export const DIGITAL_STATUS_LABELS: Record<DigitalIdentityStatus, string> = {
  consistent: "Consistent",
  inconsistent: "Inconsistent",
  uncorroborated: "Uncorroborated",
  not_provided: "Not provided",
};

export const LOAN_TERMS_STATUS_LABELS: Record<LoanTermsStatus, string> = {
  low_concern: "Low concern",
  caution: "Caution",
  high_concern: "High concern",
  not_provided: "Not provided",
};

export const SCAM_LEVEL_LABELS: Record<ScamSignalLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  not_assessed: "Not assessed",
};

// ---------------------------------------------------------------------------
// Matched entities
// ---------------------------------------------------------------------------

/**
 * One candidate the matcher considered, with the model's opinion of it.
 *
 * `route` records how the candidate was reached, because the difference
 * between "found by CIN" and "found by looking like the name you typed" is the
 * difference between an identification and a coincidence.
 */
export interface EntityMatch {
  readonly entity: IndexedEntity;
  /** Model probability that this entity is the institution the user named. */
  readonly matchProbability: number;
  /** True when the probability is at or above the model's shipped threshold. */
  readonly acceptedByModel: boolean;
  readonly routes: readonly RetrievalRoute[];
  /** Set when an identifier settled the match without the model's help. */
  readonly identifiedBy:
    | "cin"
    | "exact_name"
    | "former_name"
    | "official_website"
    | "contact_domain"
    | null;
  /** Wording for the user. Never "is" — always "appears to". */
  readonly confidenceLabel: string;
}

// ---------------------------------------------------------------------------
// Layer results
// ---------------------------------------------------------------------------

export interface RegulatoryFindings {
  readonly status: RegulatoryStatus;
  readonly statusLabel: string;
  /** The record the verification is primarily about, if one was established. */
  readonly primary: EntityMatch | null;
  readonly registered: readonly EntityMatch[];
  readonly cancelled: readonly EntityMatch[];
  readonly cancellationRecords: readonly EntityMatch[];
  readonly banks: readonly EntityMatch[];
  /** The RBI list the primary record belongs to, in words. */
  readonly primaryStanding: EntityStanding | null;
  readonly signals: readonly Signal[];
}

export interface CompanyIdentityFindings {
  readonly status: CompanyIdentityStatus;
  readonly statusLabel: string;
  readonly claimedName: string | null;
  readonly legalName: string | null;
  readonly cin: string | null;
  readonly cinMatchesName: boolean | null;
  readonly classification: string | null;
  readonly layer: string | null;
  readonly regionalOffice: string | null;
  readonly address: string | null;
  readonly acceptsPublicDeposits: boolean | null;
  readonly signals: readonly Signal[];
}

export interface WebsiteFindings {
  readonly status: DigitalIdentityStatus;
  readonly statusLabel: string;
  readonly hostname: string | null;
  readonly checked: boolean;
  readonly site: SiteCheckResult | null;
  readonly domainAge: DomainAgeResult | null;
  /** The official website the RBI publishes for the matched institution. */
  readonly officialHostnames: readonly string[];
  /** The institution the supplied domain actually belongs to, if known. */
  readonly domainBelongsTo: string | null;
  /** Similarity between the domain label and the matched company's name. */
  readonly nameSimilarity: number | null;
  readonly matchesRegisteredEmailDomain: boolean;
  readonly signals: readonly Signal[];
}

export interface EmailFindings {
  readonly status: DigitalIdentityStatus;
  readonly statusLabel: string;
  readonly address: string | null;
  readonly domain: string | null;
  readonly isFreeMailProvider: boolean;
  /** The e-mail domains the RBI publishes for the matched entity. */
  readonly registeredDomains: readonly string[];
  readonly matchesRegisteredDomain: boolean;
  readonly matchesWebsiteDomain: boolean | null;
  readonly signals: readonly Signal[];
}

export interface LoanTermsFindings {
  readonly status: LoanTermsStatus;
  readonly statusLabel: string;
  readonly provided: boolean;
  readonly terms: LoanTermsInput | null;
  /** Effective annual cost implied by the figures supplied, when computable. */
  readonly impliedAnnualRate: number | null;
  readonly upfrontTotal: number | null;
  readonly signals: readonly Signal[];
}

export interface ScamSignalFindings {
  readonly level: ScamSignalLevel;
  readonly levelLabel: string;
  readonly assessed: boolean;
  readonly signals: readonly Signal[];
}

export interface ModelFindings {
  readonly available: boolean;
  readonly version: string | null;
  readonly algorithm: string | null;
  readonly threshold: number | null;
  /** Probability for the best candidate. Null when nothing was scored. */
  readonly bestScore: number | null;
  readonly bestEntityName: string | null;
  readonly candidatesScored: number;
  readonly unavailableReason: string | null;
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

export interface VerificationMatrixRow {
  readonly key: string;
  readonly layer: string;
  readonly status: string;
  readonly tone: "positive" | "caution" | "negative" | "neutral";
  readonly evidence: string;
}

export interface VerificationResult {
  readonly query: {
    readonly raw: string;
    readonly interpretedAs: InputKind;
    readonly interpretedAsLabel: string;
    readonly companyName: string | null;
    readonly cin: string | null;
    readonly email: string | null;
    readonly hostname: string | null;
    readonly loanTermsProvided: boolean;
    readonly disclosuresProvided: boolean;
  };

  readonly verdict: Verdict;
  readonly verdictLabel: string;
  readonly verdictShort: string;
  readonly headline: string;
  readonly summary: string;
  /** The reasons, in the verdict engine's own words, worst first. */
  readonly reasons: readonly string[];
  readonly recommendedActions: readonly string[];

  readonly regulatory: RegulatoryFindings;
  readonly company: CompanyIdentityFindings;
  readonly website: WebsiteFindings;
  readonly email: EmailFindings;
  readonly loanTerms: LoanTermsFindings;
  readonly scamSignals: ScamSignalFindings;
  readonly model: ModelFindings;

  /** Every signal from every layer, worst first. */
  readonly signals: readonly Signal[];
  readonly matrix: readonly VerificationMatrixRow[];

  readonly dataset: {
    readonly nbfcAsOf: string | null;
    readonly banksFetchedAt: string | null;
    readonly counts: Readonly<Record<string, number>>;
    readonly sources: readonly string[];
  };

  /** Non-fatal problems: a check that could not be run, a source unavailable. */
  readonly notices: readonly string[];
  readonly checkedAt: string;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function entitySourceLabel(entity: IndexedEntity): string {
  switch (entity.source) {
    case "registered_nbfc":
      return "RBI list of registered NBFCs";
    case "registered_arc":
      return "RBI list of registered ARCs";
    case "cancelled_company":
      return "RBI cancelled-registration list";
    case "cancelled_record":
      return "RBI cancellation / restoration record";
    case "bank":
      return "RBI Banks in India";
  }
}

export function standingLabel(standing: EntityStanding): string {
  switch (standing) {
    case "registered":
      return "Certificate of Registration on record";
    case "cancelled":
      return "Certificate of Registration cancelled";
    case "cancellation_record":
      return "Appears in the cancellation / restoration record";
    case "bank":
      return "Listed by the RBI as a bank operating in India";
  }
}

/**
 * Wording for how sure a match is. Deliberately hedged: a name similarity is
 * evidence about strings, not proof about companies.
 */
export function confidenceLabelFor(
  identifiedBy: EntityMatch["identifiedBy"],
  probability: number,
): string {
  if (identifiedBy === "cin") return "identified by CIN";
  if (identifiedBy === "official_website") return "identified by the RBI-published website";
  if (identifiedBy === "contact_domain") {
    return "identified by the contact address the RBI publishes for this company";
  }
  if (identifiedBy === "exact_name") return "exact name match";
  if (identifiedBy === "former_name") return "matches a former name on the RBI record";
  if (probability >= 0.9) return "very likely the same institution";
  if (probability >= 0.6) return "possibly the same institution";
  return "similar name only";
}
