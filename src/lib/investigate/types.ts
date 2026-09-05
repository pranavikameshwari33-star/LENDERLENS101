/**
 * The shape of an AI investigation.
 *
 * LenderLens answers from the RBI's published lists whenever it can. When it
 * cannot — an unknown domain, no matching record, nothing to tie the site to a
 * lender — the deterministic answer is GRAY, and GRAY is honest but thin. The
 * investigation layer exists to make GRAY less thin: it goes and looks, then
 * hands back what it found in this shape.
 *
 * Three rules are baked into the type itself:
 *
 *   1. There is no score. Not a percentage, not a confidence, not a risk
 *      number. Every field below is either a categorical status or a piece of
 *      quoted evidence with a source, because that is what a person can check.
 *   2. Nothing is asserted without a place it came from. `evidence` carries the
 *      source, and `kind` separates what a source actually said from what the
 *      investigation inferred by putting two sources together.
 *   3. "Not found" is its own outcome. `UNVERIFIED` means the evidence was not
 *      there. It does not mean fraud, and no field here can be used to say so.
 *
 * Plain JSON, no server-only imports: the same object crosses the API boundary
 * and is rendered by a Client Component.
 *
 * A fourth rule was added when the AI layer turned out to be the least reliable
 * part of the pipeline: the deterministic evidence and the AI's reading of it
 * are separate fields. `evidenceBundle` is what LenderLens itself established —
 * RBI lookups, pages read, company names found — and it is ALWAYS present.
 * `aiAnalysis` is the model's synthesis of that bundle, and it is null whenever
 * the model could not be reached. A quota error therefore costs the reader the
 * synthesis and nothing else; the evidence is still on the screen, and `status`
 * says plainly that it was the AI that failed and not the search for evidence.
 */

import type { InvestigationRunStatus } from "./failure";
import type { IdentityConfidence, InvestigationRisk } from "./risk";

export type { InvestigationRunStatus } from "./failure";
export type { IdentityConfidence, InvestigationRisk, InvestigationRiskLevel } from "./risk";

/**
 * What the user actually typed into.
 *
 * The two search bars are equivalent but they are not the same question. A
 * COMPANY search already names the entity, so the RBI lookup is the first
 * thing that happens and no model is needed to work out who is being asked
 * about. A WEBSITE search names only a domain, and a domain is not an entity —
 * `i2ifunding.com` is not a company, it is a website belonging to RNVP
 * Technology Private Limited — so the operator has to be resolved from the
 * website before the RBI lookup means anything at all.
 */
export type InvestigationInputType = "COMPANY" | "WEBSITE";

/** What LenderLens should tell the user, given the evidence gathered. */
export type InvestigationStatus = "VERIFIED" | "CAUTION" | "UNVERIFIED";

export const INVESTIGATION_STATUS_LABELS: Record<InvestigationStatus, string> = {
  VERIFIED: "Evidence establishes the lender behind this website",
  CAUTION: "Evidence found, but it does not line up",
  UNVERIFIED: "Not enough evidence to establish who is behind this website",
};

/** Where a piece of evidence came from, in descending order of authority. */
export type EvidenceSourceType =
  | "regulator"
  | "official_website"
  | "company_document"
  | "lenderlens_dataset"
  | "search_result"
  | "other";

export const EVIDENCE_SOURCE_LABELS: Record<EvidenceSourceType, string> = {
  regulator: "Regulator",
  official_website: "Official website",
  company_document: "Company document",
  lenderlens_dataset: "LenderLens RBI dataset",
  search_result: "Web search result",
  other: "Other source",
};

export interface InvestigationEvidence {
  /** The claim this source supports, in one line. */
  readonly claim: string;
  readonly sourceTitle: string;
  /**
   * The URL the evidence was read from. Null when the source has no URL, or
   * when the model supplied one that was not among the pages actually
   * retrieved — an unverifiable URL is dropped rather than shown.
   */
  readonly sourceUrl: string | null;
  readonly sourceType: EvidenceSourceType;
  /** What the source says, quoted or closely paraphrased. */
  readonly supportingText: string;
  /**
   * `fact` — a source states this.
   * `inference` — the investigation concluded it by combining sources.
   */
  readonly kind: "fact" | "inference";
}

export interface IdentifiedEntity {
  /** Trading or brand name the site presents itself under. */
  readonly name: string | null;
  /** Registered legal name, if the site or a document names one. */
  readonly legalName: string | null;
  readonly aliases: readonly string[];
}

export interface RegulatoryFinding {
  readonly status: "confirmed" | "not_confirmed" | "unknown";
  readonly regulator: string | null;
  /** A registration or licence reference, only ever quoted from a source. */
  readonly registrationReference: string | null;
}

export interface DomainRelationship {
  readonly status: "established" | "likely" | "uncertain" | "contradicted";
  readonly explanation: string;
}

/** One action the agent took. Kept so the investigation can be audited. */
export interface InvestigationStep {
  readonly order: number;
  /** The tool used: dataset lookup, page fetch, model call. */
  readonly action: string;
  /** What it was asked for. */
  readonly detail: string;
  /** What came back, in one line. */
  readonly outcome: string;
}

/**
 * The model's reading of the evidence.
 *
 * Null on the result whenever the one Gemini call did not return a usable
 * answer. Every field here is post-sanitiser; see `schema.ts`.
 */
export interface InvestigationAnalysis {
  readonly identifiedEntity: IdentifiedEntity;
  /** How firmly the legal entity is established, after grounding checks. */
  readonly identityConfidence: IdentityConfidence;
  /** Where the legal name was read: which page, disclosure or document. */
  readonly identityBasis: string | null;
  readonly regulatoryStatus: RegulatoryFinding;
  readonly domainRelationship: DomainRelationship;
  readonly evidence: readonly InvestigationEvidence[];
  /** What was established, in plain sentences. */
  readonly findings: readonly string[];
  /** Sources that disagree with each other, stated as disagreements. */
  readonly conflicts: readonly string[];
  /** Things a reader should be careful about. Never a scam accusation. */
  readonly warnings: readonly string[];
  readonly recommendedStatus: InvestigationStatus;
  readonly recommendedStatusLabel: string;
}

// ---------------------------------------------------------------------------
// The deterministic half — gathered without the model, kept whatever it does
// ---------------------------------------------------------------------------

/** One RBI record, flattened for display. No score, by design. */
export interface DatasetMatchEvidence {
  readonly name: string;
  /** "RBI list of registered NBFCs", and so on. */
  readonly sourceLabel: string;
  /** "Certificate of Registration on record", and so on. */
  readonly standingLabel: string;
  readonly cin: string | null;
  readonly classification: string | null;
  /** Websites the RBI itself publishes for this record. */
  readonly publishedHostnames: readonly string[];
  /**
   * True when this record was reached by an identifier — an exact name, a
   * former name, a CIN, a published website — rather than by name similarity.
   * A similar name is not the same company, and only this may corroborate.
   */
  readonly identified: boolean;
  /** How it was reached, in words: "exact name match", and so on. */
  readonly foundBy: string;
}

export interface DatasetLookupEvidence {
  /** What was looked up: a domain, or a name and where it came from. */
  readonly query: string;
  readonly matches: readonly DatasetMatchEvidence[];
}

export interface PageEvidence {
  readonly url: string;
  readonly title: string | null;
  readonly read: boolean;
  /** How much text was recovered. Zero when the page could not be read. */
  readonly characters: number;
  /** Why it could not be read. Null when it was. */
  readonly error: string | null;
}

/**
 * FACT A — who this website appears to belong to.
 *
 * Resolution, not verification. Establishing that i2ifunding.com is operated by
 * RNVP Technology Private Limited says only that: it says nothing whatever
 * about whether that company is registered, and the two must never be collapsed
 * into one another. `regulatory` below is the separate answer to the separate
 * question.
 */
export interface ResolvedIdentity {
  /** The trading name the site presents itself under: "I2I Funding". */
  readonly brandName: string | null;
  /** The registered company: "RNVP Technology Private Limited". */
  readonly legalEntityName: string | null;
  readonly confidence: IdentityConfidence;
  /** Which page, disclosure or document the legal name was read from. */
  readonly basis: string | null;
  /**
   * How it was resolved.
   *
   * `rbi_published_domain` is the regulator's own answer: the RBI's record for
   * that company publishes this domain as its website or its contact address,
   * so the tie between the two is stated by the RBI and not inferred from the
   * site. It is the strongest of these, and the only one available for a site
   * that renders in the browser and hands a fetcher nothing to read.
   */
  readonly source:
    | "rbi_published_domain"
    | "website_text"
    | "ai_identification"
    | "user_supplied"
    | "unresolved";
}

/**
 * FACT B — what the RBI reference data says about that entity.
 *
 * Looked up under the COMPANY NAME, never under the domain. The domain is
 * website evidence; the company name is the key into an entity dataset.
 */
export interface RegulatoryEvidence {
  /** The name the RBI data was actually searched under. Null if never searched. */
  readonly lookupName: string | null;
  readonly matches: readonly DatasetMatchEvidence[];
  /**
   * True only when a record was reached by an IDENTIFIER — an exact name, a
   * former name, a CIN, a published website — not by name similarity.
   */
  readonly identified: boolean;
  /** "registered", "cancelled", "bank", … from the matched record. */
  readonly standing: string | null;
  /** "P2P", "Investment and Credit Company", … */
  readonly entityType: string | null;
  readonly datasetAsOf: string | null;
}

/**
 * Everything LenderLens established by itself, before any model was asked
 * anything. This survives every AI failure.
 */
export interface EvidenceBundle {
  /** Which search bar the user used. */
  readonly inputType: InvestigationInputType;
  /** Exactly what the user typed, kept for display. Never normalised away. */
  readonly originalInput: string;
  readonly submittedDomain: string;
  /** The lender name the user typed, if any. */
  readonly claimedName: string | null;
  /** Fact A. Filled in after the reasoning step; unresolved before it. */
  readonly identity: ResolvedIdentity;
  /** Fact B. The RBI lookup on the resolved COMPANY name. */
  readonly regulatory: RegulatoryEvidence;
  /** Why the website was associated with the company, in one line. */
  readonly relationshipBasis: string | null;
  /** The date the RBI lists were published, as recorded in the index. */
  readonly datasetAsOf: string | null;
  readonly rbiLookups: readonly DatasetLookupEvidence[];
  readonly rbiMatchCount: number;
  readonly pages: readonly PageEvidence[];
  /** Company names found in the pages read, before any were looked up. */
  readonly companyNamesFound: readonly string[];
  readonly siteReachable: boolean;
}

/** True when there is something worth reasoning over. */
export function bundleHasEvidence(bundle: EvidenceBundle): boolean {
  return (
    bundle.siteReachable ||
    bundle.rbiMatchCount > 0 ||
    bundle.companyNamesFound.length > 0 ||
    bundle.claimedName !== null
  );
}

export interface InvestigationResult {
  /**
   * What the investigation was able to do. An AI_* value means LenderLens
   * failed, never that the website lacks evidence — the two are different
   * facts and this field exists to keep them apart.
   */
  readonly status: InvestigationRunStatus;
  readonly statusLabel: string;
  /** One safe sentence about an AI failure. Null when there was none. */
  readonly statusDetail: string | null;

  readonly domain: string;
  /**
   * What a user may safely conclude. Separate from `status` on purpose: an
   * investigation that could not finish keeps its honest internal reason
   * (AI_QUOTA_EXCEEDED and the rest) AND is HIGH RISK, because an unfinished
   * check is not a clean bill of health. See risk.ts.
   */
  readonly risk: InvestigationRisk;
  /** Always present, whatever the model did. */
  readonly evidenceBundle: EvidenceBundle;
  /** Null whenever the model could not be reached or read. */
  readonly aiAnalysis: InvestigationAnalysis | null;

  readonly steps: readonly InvestigationStep[];
  /** Checks that could not run — no search grounding, site unreachable, etc. */
  readonly notices: readonly string[];
  readonly investigatedAt: string;
  readonly durationMs: number;
  readonly model: string;
  /** Gemini requests this investigation actually made. One, or none. */
  readonly geminiCalls: number;
}

/**
 * What `/api/investigate` returns.
 *
 * There is no error case. An investigation that could not run reports itself
 * unavailable with a reason, because the deterministic verification has
 * already been shown to the user and must not be disturbed by this failing.
 */
export type InvestigationResponse =
  | { readonly available: true; readonly investigation: InvestigationResult }
  | { readonly available: false; readonly reason: string };
