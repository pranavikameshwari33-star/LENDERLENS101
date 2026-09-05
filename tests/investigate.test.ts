import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyGeminiFailure,
  isAiFailure,
  statusForFailure,
} from "../src/lib/investigate/failure.ts";
import { investigationTrigger } from "../src/lib/investigate/trigger.ts";
import { ABSENCE_IS_NOT_FRAUD, sanitizeInvestigation } from "../src/lib/investigate/schema.ts";
import type { VerificationResult } from "../src/lib/verify/types.ts";
import type { Signal } from "../src/lib/verify/signals.ts";

/**
 * The two halves of the investigation layer that can be tested without a key:
 * when it is allowed to run, and what happens to what the model says.
 *
 * Both are where the product's rules live. The trigger is what keeps a known
 * lender deterministic and free; the sanitiser is what stops a well-formed
 * answer from becoming a well-formed fabrication.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function verification(overrides: {
  hostname?: string | null;
  verdict?: VerificationResult["verdict"];
  regulatoryStatus?: VerificationResult["regulatory"]["status"];
  hasPrimary?: boolean;
  primaryHostnames?: readonly string[];
  primaryEmailDomains?: readonly string[];
  websiteStatus?: VerificationResult["website"]["status"];
  signals?: readonly Signal[];
}): VerificationResult {
  return {
    query: { companyName: null },
    verdict: overrides.verdict ?? "gray",
    regulatory: {
      status: overrides.regulatoryStatus ?? "not_verified",
      primary: overrides.hasPrimary
        ? {
            entity: {
              name: "Example Finance Limited",
              hostnames: overrides.primaryHostnames ?? [],
              emailDomains: overrides.primaryEmailDomains ?? [],
            },
          }
        : null,
    },
    website: {
      hostname: overrides.hostname === undefined ? "example.com" : overrides.hostname,
      status: overrides.websiteStatus ?? "uncorroborated",
    },
    signals: overrides.signals ?? [],
  } as unknown as VerificationResult;
}

function criticalSignal(): Signal {
  return {
    id: "otp_requested",
    category: "scam_behaviour",
    severity: "critical",
    origin: "heuristic",
    title: "You were asked for an OTP",
    explanation: "No lender needs one.",
    evidence: null,
    source: "What you told us",
    confidence: null,
  };
}

const CONTEXT = {
  domain: "example.com",
  retrievedUrls: ["https://example.com/", "https://example.com/privacy-policy"],
  retrievedText:
    "Example Finance Private Limited is a company registered with the Reserve Bank of India " +
    "under Certificate of Registration N-14.03268 and operates example.com.",
  // This fixture describes a lookup that FOUND the company, so a dataset
  // citation in it is genuine corroboration. The opposite case — a lookup that
  // matched nothing — has its own tests below.
  hasPositiveDatasetMatch: true,
  modelOpenedPages: false,
};

// ---------------------------------------------------------------------------
// When the agent runs
// ---------------------------------------------------------------------------

describe("the investigation trigger", () => {
  it("does not run without a website, when the RBI records publish none either", () => {
    assert.equal(investigationTrigger(verification({ hostname: null })).investigate, false);
  });

  it("investigates the website the RBI publishes when only a company name was searched", () => {
    // A company-name search has no domain of its own. The RBI record may carry
    // one, and that is discovery: free, deterministic, and no model is asked
    // where a company's website is.
    const trigger = investigationTrigger(
      verification({
        hostname: null,
        hasPrimary: true,
        primaryHostnames: ["examplefinance.in"],
        regulatoryStatus: "verified",
        verdict: "green",
      }),
    );

    assert.equal(trigger.investigate, true);
    assert.equal(trigger.hostname, "examplefinance.in");
    assert.equal(trigger.discovered, true);
  });

  it("falls back to the contact domain the RBI publishes for the lender", () => {
    // The RBI records a website for very few entities but an address for most,
    // and the address's domain is the best pointer there is to where a lender
    // lives on the web.
    const trigger = investigationTrigger(
      verification({
        hostname: null,
        hasPrimary: true,
        primaryEmailDomains: ["examplefinance.in"],
        regulatoryStatus: "verified",
        verdict: "green",
      }),
    );

    assert.equal(trigger.investigate, true);
    assert.equal(trigger.hostname, "examplefinance.in");
    assert.equal(trigger.discovered, true);
  });

  it("does not mistake a lender's mail provider for its website", () => {
    const trigger = investigationTrigger(
      verification({
        hostname: null,
        hasPrimary: true,
        primaryEmailDomains: ["gmail.com"],
        regulatoryStatus: "verified",
        verdict: "green",
      }),
    );

    assert.equal(trigger.investigate, false);
    assert.equal(trigger.hostname, null);
  });

  it("passes the user's own domain through untouched when there is one", () => {
    const trigger = investigationTrigger(verification({ hostname: "example.com" }));

    assert.equal(trigger.hostname, "example.com");
    assert.equal(trigger.discovered, false);
  });

  it("runs for an unresolved domain that the RBI data does not contain", () => {
    const trigger = investigationTrigger(verification({ verdict: "gray" }));
    assert.equal(trigger.investigate, true);
    assert.match(trigger.reason, /not in the RBI data/i);
  });

  it("does not run when a cancelled registration has already settled the answer", () => {
    assert.equal(
      investigationTrigger(
        verification({ verdict: "red", regulatoryStatus: "cancelled", hasPrimary: true }),
      ).investigate,
      false,
    );
  });

  it("does not run when the user reported something conclusive on its own", () => {
    assert.equal(
      investigationTrigger(verification({ verdict: "red", signals: [criticalSignal()] })).investigate,
      false,
    );
  });

  it("does not run when the RBI data already ties the domain to a lender", () => {
    assert.equal(
      investigationTrigger(
        verification({
          verdict: "green",
          regulatoryStatus: "verified",
          hasPrimary: true,
          websiteStatus: "consistent",
        }),
      ).investigate,
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// What the model is allowed to claim
// ---------------------------------------------------------------------------

describe("the investigation sanitiser", () => {
  it("keeps a source link that points at a page the investigation retrieved", () => {
    const result = sanitizeInvestigation(
      {
        evidence: [
          {
            claim: "The privacy policy names the operator",
            sourceTitle: "Privacy policy",
            sourceUrl: "https://www.example.com/privacy-policy/",
            sourceType: "official_website",
            supportingText: "Example Finance Private Limited operates example.com.",
            kind: "fact",
          },
        ],
      },
      CONTEXT,
    );

    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].sourceUrl, "https://www.example.com/privacy-policy/");
    assert.equal(result.notices.length, 0);
  });

  it("removes a source link to a page it never retrieved", () => {
    const result = sanitizeInvestigation(
      {
        evidence: [
          {
            claim: "The RBI lists the company",
            sourceTitle: "RBI",
            sourceUrl: "https://rbi.org.in/made-up-page",
            sourceType: "regulator",
            supportingText: "Registered.",
            kind: "fact",
          },
        ],
      },
      CONTEXT,
    );

    assert.equal(result.evidence[0].sourceUrl, null);
    assert.match(result.notices.join(" "), /did not match any page it actually retrieved/i);
  });

  it("removes a registration reference that appears in nothing it read", () => {
    const result = sanitizeInvestigation(
      { registrationReference: "B-99.99999", evidence: [] },
      CONTEXT,
    );

    assert.equal(result.regulatoryStatus.registrationReference, null);
    assert.match(result.notices.join(" "), /appears in none of the material retrieved/i);
  });

  it("keeps a registration reference it actually read, however it is punctuated", () => {
    const result = sanitizeInvestigation(
      { registrationReference: "N-14.03268", evidence: [] },
      CONTEXT,
    );

    assert.equal(result.regulatoryStatus.registrationReference, "N-14.03268");
  });

  it("reduces a confirmed regulatory status that cites no authoritative source", () => {
    const result = sanitizeInvestigation(
      {
        regulatoryStatus: "confirmed",
        evidence: [
          {
            claim: "A blog says the company is an NBFC",
            sourceTitle: "A blog",
            sourceType: "search_result",
            supportingText: "They are an NBFC.",
            kind: "fact",
          },
        ],
      },
      CONTEXT,
    );

    assert.equal(result.regulatoryStatus.status, "unknown");
    assert.match(result.notices.join(" "), /reduced to unknown/i);
  });

  it("refuses a verified outcome its own evidence does not support", () => {
    const result = sanitizeInvestigation(
      {
        recommendedStatus: "VERIFIED",
        regulatoryStatus: "confirmed",
        domainRelationshipStatus: "established",
        evidence: [
          {
            claim: "The site says so",
            sourceTitle: "Home page",
            sourceUrl: "https://example.com/",
            sourceType: "official_website",
            supportingText: "We are an RBI-registered NBFC.",
            kind: "fact",
          },
        ],
      },
      CONTEXT,
    );

    assert.notEqual(result.recommendedStatus, "VERIFIED");
    assert.match(result.notices.join(" "), /does not support/i);
  });

  it("allows a verified outcome backed by the RBI dataset and a domain link", () => {
    const result = sanitizeInvestigation(
      {
        recommendedStatus: "VERIFIED",
        regulatoryStatus: "confirmed",
        domainRelationshipStatus: "established",
        evidence: [
          {
            claim: "The RBI reference data holds the company",
            sourceTitle: "LenderLens RBI data",
            sourceType: "lenderlens_dataset",
            supportingText: "Example Finance Private Limited, registered NBFC.",
            kind: "fact",
          },
          {
            claim: "The privacy policy ties the domain to that company",
            sourceTitle: "Privacy policy",
            sourceUrl: "https://example.com/privacy-policy",
            sourceType: "official_website",
            supportingText: "Example Finance Private Limited operates example.com.",
            kind: "fact",
          },
        ],
      },
      CONTEXT,
    );

    assert.equal(result.recommendedStatus, "VERIFIED");
    assert.equal(result.regulatoryStatus.status, "confirmed");
  });

  it("returns CAUTION when sources conflict, and says what conflicts", () => {
    const result = sanitizeInvestigation(
      {
        recommendedStatus: "UNVERIFIED",
        conflicts: ["The site names one company; the app store lists another."],
        evidence: [
          {
            claim: "The site names a company",
            sourceTitle: "Home page",
            sourceUrl: "https://example.com/",
            sourceType: "official_website",
            supportingText: "Operated by Example Finance Private Limited.",
            kind: "fact",
          },
        ],
      },
      CONTEXT,
    );

    assert.equal(result.recommendedStatus, "CAUTION");
    assert.equal(result.conflicts.length, 1);
  });

  it("returns UNVERIFIED with no evidence, and never calls that fraud", () => {
    const result = sanitizeInvestigation(
      { recommendedStatus: "CAUTION", evidence: [] },
      CONTEXT,
    );

    assert.equal(result.recommendedStatus, "UNVERIFIED");
    assert.ok(result.warnings.includes(ABSENCE_IS_NOT_FRAUD));
    assert.equal(result.domainRelationship.status, "uncertain");
  });

  it("survives a response that is not an object at all", () => {
    const result = sanitizeInvestigation("no", CONTEXT);

    assert.equal(result.recommendedStatus, "UNVERIFIED");
    assert.equal(result.evidence.length, 0);
    assert.equal(result.identifiedEntity.name, null);
  });
});

// ---------------------------------------------------------------------------
// Telling an API failure apart from an absence of evidence
// ---------------------------------------------------------------------------

/**
 * The rule under test is one sentence long: no failure of the AI service, of
 * any kind, may ever be reported as INSUFFICIENT_EVIDENCE. One is a fact about
 * LenderLens and the other is a fact about a lending website, and printing the
 * second when the first happened is the bug this layer exists to prevent.
 */
describe("classifying a Gemini failure", () => {
  it("reads a 429 as an exhausted quota, not as missing evidence", () => {
    const failure = classifyGeminiFailure(Object.assign(new Error("quota"), { status: 429 }));

    assert.equal(failure.kind, "quota");
    assert.equal(failure.retryable, false);
    assert.equal(statusForFailure(failure.kind), "AI_QUOTA_EXCEEDED");
  });

  it("reads RESOURCE_EXHAUSTED in the message when no status is attached", () => {
    const failure = classifyGeminiFailure(
      new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"You exceeded ' +
        'your current quota. Quota exceeded for metric generate_content_free_tier_requests"}}'),
    );

    assert.equal(failure.kind, "quota");
    assert.equal(statusForFailure(failure.kind), "AI_QUOTA_EXCEEDED");
  });

  it("reads a 503 as the model being busy", () => {
    const failure = classifyGeminiFailure(Object.assign(new Error("busy"), { status: 503 }));

    assert.equal(failure.kind, "unavailable");
    assert.equal(statusForFailure(failure.kind), "AI_UNAVAILABLE");
  });

  it("reads UNAVAILABLE in the message as the model being busy", () => {
    const failure = classifyGeminiFailure(
      new Error('{"error":{"code":503,"status":"UNAVAILABLE","message":"This model is currently ' +
        'experiencing high demand. Please try again later."}}'),
    );

    assert.equal(failure.kind, "unavailable");
    assert.equal(statusForFailure(failure.kind), "AI_UNAVAILABLE");
  });

  it("reads an AbortError as a failed request", () => {
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    const failure = classifyGeminiFailure(aborted);

    assert.equal(failure.kind, "aborted");
    assert.equal(statusForFailure(failure.kind), "AI_REQUEST_FAILED");
  });

  it("reads a timed-out AbortSignal as a failed request", () => {
    const timedOut = new Error("The operation timed out");
    timedOut.name = "TimeoutError";

    assert.equal(statusForFailure(classifyGeminiFailure(timedOut).kind), "AI_REQUEST_FAILED");
  });

  it("reads rejected credentials as a failed request, never as missing evidence", () => {
    const failure = classifyGeminiFailure(Object.assign(new Error("nope"), { status: 403 }));

    assert.equal(failure.kind, "credentials");
    assert.equal(statusForFailure(failure.kind), "AI_REQUEST_FAILED");
  });

  it("falls back to a failed request for anything it cannot recognise", () => {
    assert.equal(statusForFailure(classifyGeminiFailure(new Error("socket hang up")).kind), "AI_REQUEST_FAILED");
    assert.equal(statusForFailure(classifyGeminiFailure(null).kind), "AI_REQUEST_FAILED");
  });

  it("never turns any failure into INSUFFICIENT_EVIDENCE", () => {
    const failures = [
      Object.assign(new Error("a"), { status: 429 }),
      Object.assign(new Error("b"), { status: 503 }),
      Object.assign(new Error("c"), { status: 401 }),
      Object.assign(new Error("d"), { name: "AbortError" }),
      new Error("something else entirely"),
      "not even an error",
      undefined,
    ];

    for (const error of failures) {
      const status = statusForFailure(classifyGeminiFailure(error).kind);
      assert.notEqual(status, "INSUFFICIENT_EVIDENCE");
      assert.equal(isAiFailure(status), true);
    }
  });

  it("does not mistake a genuine absence of evidence for an AI failure", () => {
    assert.equal(isAiFailure("INSUFFICIENT_EVIDENCE"), false);
    assert.equal(isAiFailure("SUCCESS"), false);
  });

  it("keeps the raw SDK message out of what a user is shown", () => {
    const raw = 'API key AIzaSyEXAMPLE rejected for project 12345';
    const failure = classifyGeminiFailure(Object.assign(new Error(raw), { status: 403 }));

    assert.ok(!failure.message.includes("AIzaSy"));
    assert.ok(!failure.message.includes("12345"));
  });
});
