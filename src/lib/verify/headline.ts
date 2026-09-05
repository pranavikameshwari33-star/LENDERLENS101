/**
 * The one line the user actually reads.
 *
 * Two engines produce a conclusion about a lender and they run in sequence.
 * The deterministic verification (`decision.ts`) answers first, from the RBI
 * lists alone, and its fourth verdict — `gray`, "INSUFFICIENT EVIDENCE" — means
 * only that those lists could not settle the question. The investigation
 * (`investigate/risk.ts`) is then run on exactly the cases that verdict covers,
 * and it is the one that resolves them: it establishes who operates the site
 * and what the RBI holds on that company, and returns LOW RISK or HIGH RISK.
 *
 * This file decides which of the two is allowed to be the banner, and the rule
 * is short: whenever an investigation ran, its risk IS the answer. The
 * verification's own words stay on the page — every reason, every layer, the
 * whole matrix — but they stop being the headline the moment a later, better
 * informed check has spoken. Leaving INSUFFICIENT EVIDENCE at the top of a page
 * whose investigation says LOW RISK asks the reader to arbitrate between two
 * engines, which is not their job.
 *
 * The second rule follows from the first: INSUFFICIENT EVIDENCE is never a
 * user-facing risk state. It remains a verdict internally, and `verdictShort`
 * is untouched for every other consumer, but a person is told HIGH RISK,
 * because "we could not establish who these people are" and "do not send them
 * money" are the same advice. Not-verified is the definition of high risk here,
 * not a softer neighbour of it.
 *
 * The third rule is about time rather than evidence. While an investigation is
 * still in flight neither risk state may be shown, because neither has been
 * decided yet; the banner says INVESTIGATING and waits. That is not a third
 * risk level — there are still exactly two — it is the absence of one, and it
 * lasts only for the seconds the investigation takes.
 *
 * Pure. No React, no server import: every branch below is a unit test.
 */

import { RISK_LABELS, type InvestigationRisk } from "../investigate/risk";
import type { Verdict, VerificationResult } from "./types";

export interface ResolvedHeadline {
  /** Which palette the banner is painted in. Reuses `VERDICT_STYLES`. */
  readonly tone: Verdict;
  /** The words in the banner. Never "INSUFFICIENT EVIDENCE". */
  readonly short: string;
  /** One line saying what was, or was not, established. */
  readonly line: string;
  /** The paragraph under it. */
  readonly detail: string;
  /** Which engine decided. Kept so the page can say so. */
  readonly source: "investigation" | "verification";
}

export interface HeadlineOptions {
  /** True while the investigation request is still in flight. */
  readonly investigating?: boolean;
}

/**
 * What to print at the top of the report.
 *
 * `risk` is the investigation's deterministic result, or null when no
 * investigation ran, has not finished, or could not start.
 */
export function resolveHeadline(
  result: VerificationResult,
  risk: InvestigationRisk | null,
  options: HeadlineOptions = {},
): ResolvedHeadline {
  if (risk) {
    return {
      tone: risk.level === "LOW_RISK" ? "green" : "red",
      short: risk.label,
      line:
        risk.level === "LOW_RISK"
          ? "LenderLens verified the identity of the lender and found a matching registered " +
            "RBI-regulated entity."
          : "LenderLens could not positively verify this lender.",
      detail: risk.reason,
      source: "investigation",
    };
  }

  // An investigation is running and has not answered yet.
  //
  // Neither risk state may be shown here, and that includes the verification's
  // own verdict. LenderLens has not finished deciding: an investigation was
  // started precisely because the RBI lists alone did not settle this one, and
  // printing HIGH RISK in the seconds before it answers states a conclusion
  // that has not been reached — one that is then replaced, which reads as the
  // product changing its mind rather than as it finishing. There is no final
  // risk yet, so the banner says exactly that and waits. Correctness before
  // speed: this is checked ahead of every verdict branch below, because the
  // trigger also investigates verdicts that are not gray.
  if (options.investigating) {
    return {
      tone: "gray",
      short: "INVESTIGATING…",
      line: "LenderLens is investigating this lender. This may take a few seconds.",
      detail:
        "Nothing in the RBI lists LenderLens holds settles this one, so it is being investigated: " +
        "the site is being read, the company behind it worked out, and the RBI records searched " +
        "under that company's name. The result appears here when that finishes.",
      source: "investigation",
    };
  }

  // No investigation spoke. The verification's own verdict stands — except
  // that gray is reported as what it means rather than as what it is called.
  if (result.verdict === "gray") {
    return {
      tone: "red",
      short: RISK_LABELS.HIGH_RISK,
      line: "LenderLens could not positively verify this lender.",
      detail:
        `${result.summary} An unverified lender is treated as high risk: that is a statement ` +
        "about what could be established, not an accusation against this lender.",
      source: "verification",
    };
  }

  return {
    tone: result.verdict,
    short: result.verdictShort,
    line: `${result.headline}.`,
    detail: result.summary,
    source: "verification",
  };
}
