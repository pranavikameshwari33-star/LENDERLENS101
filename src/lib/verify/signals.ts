/**
 * The structured risk-signal model.
 *
 * Everything LenderLens concludes is built from these. A signal is one
 * observation, with its category, its severity, the evidence it rests on and
 * where that evidence came from. The verdict engine reads signals; it never
 * reads raw data. That separation is what makes an explanation possible: the
 * reasons shown to the user are the same objects the decision was made from,
 * not a narrative written afterwards to fit the answer.
 *
 * Three kinds of thing produce signals, and the `origin` field keeps them
 * distinguishable in the interface — because a reader deserves to know which
 * of these they are looking at:
 *
 *   regulatory_fact   a deterministic lookup in published RBI data
 *   heuristic         a documented rule over the evidence
 *   model             the entity-matching model's inference
 *
 * They are never blended into one unexplained number.
 */

/** The six evidence layers a verification is organised around. */
export type SignalCategory =
  | "regulatory"
  | "company_identity"
  | "website_identity"
  | "email_identity"
  | "loan_terms"
  | "scam_behaviour";

export const SIGNAL_CATEGORY_LABELS: Record<SignalCategory, string> = {
  regulatory: "Regulatory identity",
  company_identity: "Company identity",
  website_identity: "Website identity",
  email_identity: "E-mail identity",
  loan_terms: "Loan terms",
  scam_behaviour: "Scam signals",
};

/**
 * How much weight the observation carries.
 *
 *   critical   on its own, enough to drive a red verdict
 *   high       a serious contradiction or a serious risk indicator
 *   medium     worth resolving before proceeding
 *   low        a minor observation
 *   positive   evidence that supports the lender's claim
 *   info       context with no directional meaning
 */
export type SignalSeverity = "critical" | "high" | "medium" | "low" | "positive" | "info";

export type SignalOrigin = "regulatory_fact" | "heuristic" | "model";

export interface Signal {
  readonly id: string;
  readonly category: SignalCategory;
  readonly severity: SignalSeverity;
  readonly origin: SignalOrigin;
  /** One line, readable on its own. */
  readonly title: string;
  /** What it means and what it does not mean. */
  readonly explanation: string;
  /** The specific value observed, when there is one to quote. */
  readonly evidence: string | null;
  /** Where the evidence came from — a dataset, the site, or the user. */
  readonly source: string;
  /**
   * Model confidence in [0, 1], present only for `origin: "model"`. A
   * deterministic lookup has no confidence; calling it 100% would be a
   * category error.
   */
  readonly confidence: number | null;
}

export function signal(input: {
  id: string;
  category: SignalCategory;
  severity: SignalSeverity;
  origin: SignalOrigin;
  title: string;
  explanation: string;
  evidence?: string | null;
  source: string;
  confidence?: number | null;
}): Signal {
  return {
    id: input.id,
    category: input.category,
    severity: input.severity,
    origin: input.origin,
    title: input.title,
    explanation: input.explanation,
    evidence: input.evidence ?? null,
    source: input.source,
    confidence: input.confidence ?? null,
  };
}

/** Ordering used wherever signals are listed: worst first, positives last. */
const SEVERITY_RANK: Record<SignalSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
  positive: 5,
};

export function bySeverity(a: Signal, b: Signal): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
}

export function countSeverity(signals: readonly Signal[], severity: SignalSeverity): number {
  return signals.filter((item) => item.severity === severity).length;
}

export function hasSeverityAtLeast(signals: readonly Signal[], severity: SignalSeverity): boolean {
  const limit = SEVERITY_RANK[severity];
  return signals.some((item) => SEVERITY_RANK[item.severity] <= limit && item.severity !== "positive");
}

export function signalsIn(signals: readonly Signal[], category: SignalCategory): Signal[] {
  return signals.filter((item) => item.category === category).sort(bySeverity);
}
