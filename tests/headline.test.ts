import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveHeadline } from "../src/lib/verify/headline.ts";
import { assessRisk, unresolvedRisk } from "../src/lib/investigate/risk.ts";
import type { VerificationResult } from "../src/lib/verify/types.ts";

/**
 * Which engine gets the banner.
 *
 * The bug these tests exist to prevent: the deterministic verification says
 * gray, the investigation it then triggers says LOW RISK, and the page keeps
 * printing INSUFFICIENT EVIDENCE because it is reading the first engine's
 * field. The rule is that whenever an investigation answered, its risk is the
 * headline — and that INSUFFICIENT EVIDENCE is never shown to a user at all.
 */

function verification(overrides: {
  verdict?: VerificationResult["verdict"];
  verdictShort?: string;
}): VerificationResult {
  const verdict = overrides.verdict ?? "gray";
  return {
    query: { raw: "liquiloans.com", hostname: "liquiloans.com", companyName: null },
    verdict,
    verdictShort:
      overrides.verdictShort ??
      ({
        green: "LOW RISK",
        amber: "CAUTION",
        red: "HIGH RISK",
        gray: "INSUFFICIENT EVIDENCE",
      }[verdict] as string),
    headline: "LenderLens could not verify this website from the available evidence",
    summary: "There is not enough evidence to reach a reliable conclusion.",
    reasons: ["LenderLens could not gather enough evidence to reach a conclusion."],
  } as unknown as VerificationResult;
}

const VERIFIED_LENDER = assessRisk({
  aiCompleted: true,
  legalEntityName: "NDX P2P Private Limited",
  identityConfidence: "high",
  regulatoryIdentified: true,
  regulatoryStanding: "registered",
  domainTied: true,
  conflicts: 0,
});

const SIMILAR_NAMES_ONLY = assessRisk({
  aiCompleted: true,
  legalEntityName: "Innofin Solutions Private Limited",
  identityConfidence: "high",
  regulatoryIdentified: false,
  regulatoryStanding: null,
  domainTied: true,
  conflicts: 0,
});

describe("the banner the user reads", () => {
  it("shows the investigation's LOW RISK over the verification's gray verdict", () => {
    const headline = resolveHeadline(verification({}), VERIFIED_LENDER);

    assert.equal(headline.short, "LOW RISK");
    assert.equal(headline.tone, "green");
    assert.equal(headline.source, "investigation");
    assert.equal(headline.detail, VERIFIED_LENDER.reason);
  });

  it("shows HIGH RISK when the investigation could not confirm the registration", () => {
    const headline = resolveHeadline(verification({}), SIMILAR_NAMES_ONLY);

    assert.equal(headline.short, "HIGH RISK");
    assert.equal(headline.tone, "red");
    assert.equal(headline.source, "investigation");
  });

  it("shows HIGH RISK when the investigation itself failed", () => {
    const headline = resolveHeadline(
      verification({}),
      unresolvedRisk("The investigation could not be completed."),
    );

    assert.equal(headline.short, "HIGH RISK");
    assert.equal(headline.source, "investigation");
  });

  it("never shows INSUFFICIENT EVIDENCE, investigation or no investigation", () => {
    for (const risk of [null, VERIFIED_LENDER, SIMILAR_NAMES_ONLY]) {
      for (const investigating of [true, false]) {
        const headline = resolveHeadline(verification({}), risk, { investigating });
        assert.notEqual(headline.short, "INSUFFICIENT EVIDENCE");
      }
    }
  });

  it("settles on exactly one of the two risk states once nothing is in flight", () => {
    for (const risk of [null, VERIFIED_LENDER, SIMILAR_NAMES_ONLY]) {
      const headline = resolveHeadline(verification({}), risk, { investigating: false });
      assert.ok(headline.short === "LOW RISK" || headline.short === "HIGH RISK");
    }
  });

  it("reports an unresolved verification as HIGH RISK before any investigation answers", () => {
    const headline = resolveHeadline(verification({}), null);

    assert.equal(headline.short, "HIGH RISK");
    assert.equal(headline.source, "verification");
  });

  it("shows neither risk state while the investigation is in flight", () => {
    // The risk has not been decided yet. Printing either answer here states a
    // conclusion LenderLens has not reached, and is then replaced by the real
    // one, which reads as the product changing its mind.
    const headline = resolveHeadline(verification({}), null, { investigating: true });

    assert.match(headline.short, /^INVESTIGATING/);
    assert.notEqual(headline.short, "HIGH RISK");
    assert.notEqual(headline.short, "LOW RISK");
    assert.match(headline.line, /investigating this lender/i);
  });

  it("shows INVESTIGATING in flight whatever the deterministic verdict was", () => {
    // The trigger also investigates verdicts that are not gray, so the wait
    // state cannot be a special case of the gray branch.
    for (const verdict of ["green", "amber", "red", "gray"] as const) {
      const headline = resolveHeadline(verification({ verdict }), null, { investigating: true });
      assert.match(headline.short, /^INVESTIGATING/);
    }
  });

  it("replaces INVESTIGATING with the investigation's own risk once it answers", () => {
    const pendingHeadline = resolveHeadline(verification({}), null, { investigating: true });
    const answered = resolveHeadline(verification({}), VERIFIED_LENDER, { investigating: false });

    assert.match(pendingHeadline.short, /^INVESTIGATING/);
    assert.equal(answered.short, "LOW RISK");
    assert.equal(answered.source, "investigation");
  });

  it("leaves a settled deterministic verdict exactly as the verification wrote it", () => {
    for (const verdict of ["green", "amber", "red"] as const) {
      const result = verification({ verdict });
      const headline = resolveHeadline(result, null);

      assert.equal(headline.short, result.verdictShort);
      assert.equal(headline.tone, verdict);
      assert.equal(headline.detail, result.summary);
      assert.equal(headline.source, "verification");
    }
  });
});
