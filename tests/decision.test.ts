import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decide } from "../src/lib/verify/decision.ts";
import { signal, type Signal } from "../src/lib/verify/signals.ts";
import type {
  CompanyIdentityFindings,
  EmailFindings,
  LoanTermsFindings,
  RegulatoryFindings,
  ScamSignalFindings,
  WebsiteFindings,
} from "../src/lib/verify/types.ts";

/**
 * The verdict engine is where the product's promises are either kept or broken.
 * These tests pin down the four that matter most:
 *
 *   - a cancelled registration is red, whatever else is true
 *   - "not found" is grey, never red and never amber on its own
 *   - a real registered entity plus a contradicted digital identity is red,
 *     because that is the impersonation case the product exists for
 *   - green requires positive corroboration, not merely an absence of bad news
 */

function regulatory(overrides: Partial<RegulatoryFindings> = {}): RegulatoryFindings {
  return {
    status: "not_verified",
    statusLabel: "Not verified",
    primary: null,
    registered: [],
    cancelled: [],
    cancellationRecords: [],
    banks: [],
    primaryStanding: null,
    signals: [],
    ...overrides,
  };
}

function company(overrides: Partial<CompanyIdentityFindings> = {}): CompanyIdentityFindings {
  return {
    status: "unknown",
    statusLabel: "Unknown",
    claimedName: "Example Finance Limited",
    legalName: null,
    cin: null,
    cinMatchesName: null,
    classification: null,
    layer: null,
    regionalOffice: null,
    address: null,
    acceptsPublicDeposits: null,
    signals: [],
    ...overrides,
  };
}

function website(overrides: Partial<WebsiteFindings> = {}): WebsiteFindings {
  return {
    status: "not_provided",
    statusLabel: "Not provided",
    hostname: null,
    checked: false,
    site: null,
    domainAge: null,
    officialHostnames: [],
    domainBelongsTo: null,
    nameSimilarity: null,
    matchesRegisteredEmailDomain: false,
    signals: [],
    ...overrides,
  };
}

function email(overrides: Partial<EmailFindings> = {}): EmailFindings {
  return {
    status: "not_provided",
    statusLabel: "Not provided",
    address: null,
    domain: null,
    isFreeMailProvider: false,
    registeredDomains: [],
    matchesRegisteredDomain: false,
    matchesWebsiteDomain: null,
    signals: [],
    ...overrides,
  };
}

function loanTerms(overrides: Partial<LoanTermsFindings> = {}): LoanTermsFindings {
  return {
    status: "not_provided",
    statusLabel: "Not provided",
    provided: false,
    terms: null,
    impliedAnnualRate: null,
    upfrontTotal: null,
    signals: [],
    ...overrides,
  };
}

function scamSignals(overrides: Partial<ScamSignalFindings> = {}): ScamSignalFindings {
  return {
    level: "not_assessed",
    levelLabel: "Not assessed",
    assessed: false,
    signals: [],
    ...overrides,
  };
}

function build(parts: {
  regulatory?: RegulatoryFindings;
  company?: CompanyIdentityFindings;
  website?: WebsiteFindings;
  email?: EmailFindings;
  loanTerms?: LoanTermsFindings;
  scamSignals?: ScamSignalFindings;
  extraSignals?: Signal[];
}) {
  const layers = {
    regulatory: parts.regulatory ?? regulatory(),
    company: parts.company ?? company(),
    website: parts.website ?? website(),
    email: parts.email ?? email(),
    loanTerms: parts.loanTerms ?? loanTerms(),
    scamSignals: parts.scamSignals ?? scamSignals(),
  };

  return decide({
    ...layers,
    claimedName: "Example Finance Limited",
    allSignals: [
      ...layers.regulatory.signals,
      ...layers.company.signals,
      ...layers.website.signals,
      ...layers.email.signals,
      ...layers.loanTerms.signals,
      ...layers.scamSignals.signals,
      ...(parts.extraSignals ?? []),
    ],
  });
}

const cancelledSignal = signal({
  id: "rbi_cancelled_exact",
  category: "regulatory",
  severity: "critical",
  origin: "regulatory_fact",
  title: "Appears on the RBI's cancelled-registration list",
  explanation: "…",
  source: "RBI cancelled-registration list",
});

const notFoundSignal = signal({
  id: "not_in_rbi_data",
  category: "regulatory",
  severity: "medium",
  origin: "regulatory_fact",
  title: "Not found in the RBI reference data",
  explanation: "…",
  source: "RBI reference datasets",
});

describe("a cancelled registration", () => {
  it("is red", () => {
    const decision = build({
      regulatory: regulatory({ status: "cancelled", signals: [cancelledSignal] }),
      company: company({ status: "match", legalName: "Example Finance Limited" }),
    });
    assert.equal(decision.verdict, "red");
    assert.match(decision.reasons.join(" "), /cancelled-registration list/);
  });

  it("stays red even when every other layer is clean", () => {
    const decision = build({
      regulatory: regulatory({ status: "cancelled", signals: [cancelledSignal] }),
      company: company({ status: "match", legalName: "Example Finance Limited" }),
      website: website({ status: "consistent", statusLabel: "Consistent", hostname: "example.com" }),
      email: email({ status: "consistent", statusLabel: "Consistent", domain: "example.com" }),
      loanTerms: loanTerms({ status: "low_concern", provided: true }),
      scamSignals: scamSignals({ level: "low", assessed: true }),
    });
    assert.equal(decision.verdict, "red");
  });
});

describe("absence of evidence", () => {
  it("is grey, not red", () => {
    const decision = build({
      regulatory: regulatory({ status: "not_verified", signals: [notFoundSignal] }),
    });
    assert.equal(decision.verdict, "gray");
  });

  it("is still grey when the behaviour questions were answered with nothing to report", () => {
    const decision = build({
      regulatory: regulatory({ status: "not_verified", signals: [notFoundSignal] }),
      scamSignals: scamSignals({ level: "low", levelLabel: "Low", assessed: true }),
    });
    assert.equal(decision.verdict, "gray");
  });

  it("says so in words rather than implying wrongdoing", () => {
    const decision = build({
      regulatory: regulatory({ status: "not_verified", signals: [notFoundSignal] }),
    });
    assert.match(decision.reasons.join(" "), /not evidence of wrongdoing/i);
  });

  it("becomes amber once something else is actually wrong", () => {
    const decision = build({
      regulatory: regulatory({ status: "not_verified", signals: [notFoundSignal] }),
      loanTerms: loanTerms({
        status: "caution",
        provided: true,
        signals: [
          signal({
            id: "high_processing_fee",
            category: "loan_terms",
            severity: "medium",
            origin: "heuristic",
            title: "The processing fee is a large share of the loan",
            explanation: "…",
            source: "Loan terms you supplied",
          }),
        ],
      }),
    });
    assert.equal(decision.verdict, "amber");
  });
});

describe("the impersonation case", () => {
  it("is red when a verified entity has a contradicted website", () => {
    const decision = build({
      regulatory: regulatory({ status: "verified" }),
      company: company({ status: "match", legalName: "Example Finance Limited" }),
      website: website({
        status: "inconsistent",
        statusLabel: "Inconsistent",
        hostname: "quick-loan.xyz",
        officialHostnames: ["example.bank.in"],
      }),
    });
    assert.equal(decision.verdict, "red");
    assert.match(decision.headline, /may not be it/);
  });

  it("is red when a verified entity has a contradicted e-mail", () => {
    const decision = build({
      regulatory: regulatory({ status: "verified" }),
      company: company({ status: "match", legalName: "Example Finance Limited" }),
      email: email({
        status: "inconsistent",
        statusLabel: "Inconsistent",
        domain: "gmail.com",
        isFreeMailProvider: true,
      }),
    });
    assert.equal(decision.verdict, "red");
  });

  it("explains that the company may be genuine while the contact is not", () => {
    const decision = build({
      regulatory: regulatory({ status: "verified" }),
      company: company({ status: "match", legalName: "Example Finance Limited" }),
      website: website({ status: "inconsistent", statusLabel: "Inconsistent", hostname: "x.xyz" }),
    });
    assert.match(decision.summary, /regulated company appears to be genuine/i);
  });
});

describe("a clean verified lender", () => {
  it("is green", () => {
    const decision = build({
      regulatory: regulatory({ status: "verified" }),
      company: company({ status: "match", legalName: "Example Finance Limited" }),
      website: website({ status: "consistent", statusLabel: "Consistent", hostname: "example.com" }),
      email: email({ status: "consistent", statusLabel: "Consistent", domain: "example.com" }),
      scamSignals: scamSignals({ level: "low", levelLabel: "Low", assessed: true }),
    });
    assert.equal(decision.verdict, "green");
  });

  it("is not green when the identity rests on similarity alone", () => {
    const decision = build({
      regulatory: regulatory({ status: "verified" }),
      company: company({ status: "partial", legalName: "Example Finance Limited" }),
    });
    assert.notEqual(decision.verdict, "green");
  });

  it("never claims the lender is safe", () => {
    const decision = build({
      regulatory: regulatory({ status: "verified" }),
      company: company({ status: "match", legalName: "Example Finance Limited" }),
      scamSignals: scamSignals({ level: "low", levelLabel: "Low", assessed: true }),
    });
    assert.doesNotMatch(decision.summary, /\bsafe\b|guarantee|approved by the rbi/i);
    assert.match(decision.summary, /not an endorsement/i);
  });
});

describe("conclusive behaviour", () => {
  it("is red on a single critical signal, whatever the regulatory status", () => {
    const decision = build({
      regulatory: regulatory({ status: "verified" }),
      company: company({ status: "match", legalName: "Example Finance Limited" }),
      scamSignals: scamSignals({
        level: "high",
        levelLabel: "High",
        assessed: true,
        signals: [
          signal({
            id: "behaviour_requestedOtpOrPin",
            category: "scam_behaviour",
            severity: "critical",
            origin: "heuristic",
            title: "An OTP, PIN or password was requested",
            explanation: "…",
            source: "Your answers",
          }),
        ],
      }),
    });
    assert.equal(decision.verdict, "red");
    assert.match(decision.reasons.join(" "), /OTP/);
  });
});

describe("the matrix and the actions", () => {
  it("always reports all six layers", () => {
    const decision = build({});
    assert.equal(decision.matrix.length, 6);
    assert.deepEqual(
      decision.matrix.map((row) => row.key),
      ["regulatory", "company", "website", "email", "loan_terms", "scam_signals"],
    );
  });

  it("always carries the affiliation disclaimer", () => {
    for (const decision of [
      build({}),
      build({ regulatory: regulatory({ status: "verified" }), company: company({ status: "match" }) }),
      build({ regulatory: regulatory({ status: "cancelled", signals: [cancelledSignal] }) }),
    ]) {
      assert.match(
        decision.recommendedActions.join(" "),
        /not affiliated with the\s+Reserve Bank of India/i,
      );
    }
  });

  it("tells a user at risk not to send anything yet", () => {
    const decision = build({
      regulatory: regulatory({ status: "cancelled", signals: [cancelledSignal] }),
    });
    assert.match(decision.recommendedActions[0], /Do not transfer money/i);
  });
});
