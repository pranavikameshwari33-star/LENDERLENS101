import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessRisk } from "../src/lib/investigate/risk.ts";
import { sanitizeInvestigation } from "../src/lib/investigate/schema.ts";

/**
 * Company identity, and the safety rule that hangs off it.
 *
 * Two things are being pinned down here, and they are the two the pipeline
 * used to get wrong.
 *
 * A NEGATIVE DATASET LOOKUP IS NOT CORROBORATION. The dataset summary handed
 * to the model contains negative results — "no record matched this domain" —
 * and the model cites them, quite reasonably, as evidence of type
 * "lenderlens_dataset". Counting that as authoritative turned a lookup that
 * FAILED to find a lender into confirmation that one exists, which is how an
 * unverified website came to wear a VERIFIED badge.
 *
 * LOW RISK HAS TO BE EARNED. A user who cannot be told a lender is legitimate
 * must be told the opposite of "fine", not something neutral. Every path
 * through `assessRisk` that does not positively establish both facts has to
 * come out HIGH RISK, including the ones where LenderLens itself is what
 * failed.
 *
 * Both modules are pure, so this needs no key and no network.
 */

const CONTEXT = {
  domain: "example.com",
  retrievedUrls: ["https://example.com/", "https://example.com/privacy-policy"],
  retrievedText:
    "Example Finance Private Limited is a company registered with the Reserve Bank of India " +
    "under Certificate of Registration N-14.03268 and operates example.com.",
  hasPositiveDatasetMatch: true,
  modelOpenedPages: false,
};

// ---------------------------------------------------------------------------
// The dataset is only corroboration when it actually matched something
// ---------------------------------------------------------------------------

describe("the sanitiser's treatment of the RBI dataset", () => {
  const datasetOnly = {
    regulatoryStatus: "confirmed",
    recommendedStatus: "VERIFIED",
    domainRelationshipStatus: "established",
    evidence: [
      {
        claim: "No record matched this domain",
        sourceTitle: "LenderLens RBI dataset",
        sourceType: "lenderlens_dataset",
        supportingText: "No record in the RBI reference data LenderLens holds matched example.com.",
        kind: "fact",
      },
    ],
  };

  it("refuses to treat a lookup that matched nothing as authoritative", () => {
    const result = sanitizeInvestigation(datasetOnly, {
      ...CONTEXT,
      hasPositiveDatasetMatch: false,
    });

    assert.equal(result.regulatoryStatus.status, "unknown");
    assert.notEqual(result.recommendedStatus, "VERIFIED");
    assert.ok(result.notices.some((notice) => /found no matching record/i.test(notice)));
  });

  it("does treat a lookup that found a record as authoritative", () => {
    const result = sanitizeInvestigation(
      {
        ...datasetOnly,
        evidence: [
          {
            claim: "Example Finance Private Limited holds a Certificate of Registration",
            sourceTitle: "LenderLens RBI dataset",
            sourceType: "lenderlens_dataset",
            supportingText: "Example Finance Private Limited, registered NBFC.",
            kind: "fact",
          },
        ],
      },
      { ...CONTEXT, hasPositiveDatasetMatch: true },
    );

    assert.equal(result.regulatoryStatus.status, "confirmed");
  });
});

// ---------------------------------------------------------------------------
// Brand names, legal entities, and where a name has to come from
// ---------------------------------------------------------------------------

describe("the sanitiser's treatment of company identity", () => {
  it("keeps the brand and the legal entity apart", () => {
    const result = sanitizeInvestigation(
      {
        entityName: "I2I Funding",
        entityLegalName: "Example Finance Private Limited",
        identityConfidence: "high",
        identityBasis: "the privacy policy",
        evidence: [],
      },
      CONTEXT,
    );

    assert.equal(result.identifiedEntity.name, "I2I Funding");
    assert.equal(result.identifiedEntity.legalName, "Example Finance Private Limited");
    assert.equal(result.identityConfidence, "high");
    assert.equal(result.identityBasis, "the privacy policy");
  });

  it("floors the confidence of a legal name that appears in nothing that was read", () => {
    const result = sanitizeInvestigation(
      {
        entityLegalName: "Entirely Invented Holdings Private Limited",
        identityConfidence: "high",
        evidence: [],
      },
      { ...CONTEXT, modelOpenedPages: false },
    );

    // Still shown, because it may well be right and hiding it helps nobody —
    // but never at a confidence that could reach a LOW RISK outcome.
    assert.equal(result.identifiedEntity.legalName, "Entirely Invented Holdings Private Limited");
    assert.equal(result.identityConfidence, "low");
    assert.ok(result.notices.some((notice) => /appears in nothing it actually read/i.test(notice)));
  });

  it("accepts a legal name the model read on a page it actually opened", () => {
    const result = sanitizeInvestigation(
      {
        entityLegalName: "Another Finance Private Limited",
        identityConfidence: "high",
        evidence: [],
      },
      { ...CONTEXT, modelOpenedPages: true },
    );

    assert.equal(result.identityConfidence, "high");
  });

  it("reports no confidence at all when no legal entity was named", () => {
    const result = sanitizeInvestigation(
      { entityName: "SomeBrand", entityLegalName: null, identityConfidence: "high", evidence: [] },
      CONTEXT,
    );

    assert.equal(result.identityConfidence, "none");
  });
});

// ---------------------------------------------------------------------------
// The safety rule
// ---------------------------------------------------------------------------

describe("the user-facing risk assessment", () => {
  const verified = {
    aiCompleted: true,
    legalEntityName: "RNVP Technology Private Limited",
    identityConfidence: "high" as const,
    regulatoryIdentified: true,
    regulatoryStanding: "registered",
    domainTied: true,
    conflicts: 0,
  };

  it("is LOW RISK only when identity and registration both hold", () => {
    const risk = assessRisk(verified);

    assert.equal(risk.level, "LOW_RISK");
    assert.equal(risk.identityEstablished, true);
    assert.equal(risk.regulatoryEstablished, true);
  });

  it("is HIGH RISK when no legal entity could be tied to the website", () => {
    const risk = assessRisk({
      ...verified,
      legalEntityName: null,
      identityConfidence: "none",
      regulatoryIdentified: false,
      regulatoryStanding: null,
    });

    assert.equal(risk.level, "HIGH_RISK");
    assert.match(risk.reason, /no legal entity could be reliably tied/i);
  });

  it("is HIGH RISK when the company was identified but is not in the RBI data", () => {
    // The case the whole redesign turns on: resolution succeeded, verification
    // did not. Finding the company is not the same as finding it authorised.
    const risk = assessRisk({ ...verified, regulatoryIdentified: false, regulatoryStanding: null });

    assert.equal(risk.level, "HIGH_RISK");
    assert.equal(risk.identityEstablished, true);
    assert.equal(risk.regulatoryEstablished, false);
    assert.match(risk.reason, /not the same as finding it authorised/i);
  });

  it("is HIGH RISK when only a similarly named record came back", () => {
    // Scored as similar by the model, but not reached by an identifier. A
    // similar name is not the same company.
    const risk = assessRisk({ ...verified, regulatoryIdentified: false });

    assert.equal(risk.level, "HIGH_RISK");
  });

  it("is HIGH RISK when the registration is cancelled", () => {
    const risk = assessRisk({ ...verified, regulatoryStanding: "cancelled" });

    assert.equal(risk.level, "HIGH_RISK");
    assert.match(risk.reason, /cancelled-registration list/i);
  });

  it("is HIGH RISK when a registered company cannot be tied to this domain", () => {
    const risk = assessRisk({ ...verified, domainTied: false });

    assert.equal(risk.level, "HIGH_RISK");
    assert.match(risk.reason, /impersonation/i);
  });

  it("is HIGH RISK when the sources contradict each other", () => {
    assert.equal(assessRisk({ ...verified, conflicts: 2 }).level, "HIGH_RISK");
  });

  it("is HIGH RISK when the investigation did not finish and nothing else established the facts", () => {
    const risk = assessRisk({
      ...verified,
      aiCompleted: false,
      legalEntityName: null,
      identityConfidence: "none",
      regulatoryIdentified: false,
      regulatoryStanding: null,
    });

    assert.equal(risk.level, "HIGH_RISK");
    assert.match(risk.reason, /could not be completed/i);
  });

  it("stays HIGH RISK on an unfinished investigation when only the identity was established", () => {
    const risk = assessRisk({
      ...verified,
      aiCompleted: false,
      regulatoryIdentified: false,
      regulatoryStanding: null,
    });

    assert.equal(risk.level, "HIGH_RISK");
  });

  it("is LOW RISK when an unfinished investigation had both facts already established without it", () => {
    // The AI being unavailable is a statement about LenderLens. It must not
    // overrule an RBI registration the deterministic evidence positively
    // confirmed for the identified operating company.
    const risk = assessRisk({ ...verified, aiCompleted: false });

    assert.equal(risk.level, "LOW_RISK");
    assert.equal(risk.identityEstablished, true);
    assert.equal(risk.regulatoryEstablished, true);
  });

  it("still refuses LOW RISK on an unfinished investigation with a cancelled registration", () => {
    assert.equal(
      assessRisk({ ...verified, aiCompleted: false, regulatoryStanding: "cancelled" }).level,
      "HIGH_RISK",
    );
  });

  it("never returns LOW RISK on a merely inferred identity", () => {
    for (const confidence of ["low", "none"] as const) {
      assert.equal(assessRisk({ ...verified, identityConfidence: confidence }).level, "HIGH_RISK");
    }
  });
});
