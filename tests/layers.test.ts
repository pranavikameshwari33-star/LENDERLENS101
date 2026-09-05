import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessEmail } from "../src/lib/verify/layers/email.ts";
import { assessLoanTerms } from "../src/lib/verify/layers/loan-terms.ts";
import { assessScamSignals } from "../src/lib/verify/layers/scam-signals.ts";
import { EMPTY_DISCLOSURES, EMPTY_LOAN_TERMS } from "../src/lib/verify/input.ts";
import type { IndexedEntity } from "../src/lib/index/types.ts";

/**
 * The three layers that do not need the network or the index. Each is a pure
 * function over its input, which is what makes the explanation in the interface
 * trustworthy: the same input always produces the same signals.
 */

function entity(overrides: Partial<IndexedEntity> = {}): IndexedEntity {
  return {
    id: "registered_nbfc:1",
    source: "registered_nbfc",
    standing: "registered",
    name: "Example Finance Limited",
    nameNormalized: "EXAMPLE FINANCE LIMITED",
    nameCore: "EXAMPLE FINANCE",
    alternateNames: [],
    cin: "U65990MH1994PLC080646",
    emailDomains: ["examplefinance.in"],
    hostnames: [],
    clusterKey: "EXAMPLE",
    attributes: {},
    provenance: {
      sourceFile: "List_registered_with_the_RBI.XLSX",
      sourceSheet: "List of NBFCs",
      sourceRowNumber: 3,
      datasetAsOf: "2026-06-30",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Loan terms
// ---------------------------------------------------------------------------

describe("loan terms", () => {
  it("reports not-provided rather than inventing a finding", () => {
    const findings = assessLoanTerms(EMPTY_LOAN_TERMS, false);
    assert.equal(findings.status, "not_provided");
    assert.equal(findings.provided, false);
    assert.equal(findings.signals.length, 0);
  });

  it("treats money demanded before disbursement as critical", () => {
    const findings = assessLoanTerms(
      { ...EMPTY_LOAN_TERMS, loanAmount: 200_000, upfrontPayment: 9_999 },
      true,
    );
    const upfront = findings.signals.find((item) => item.id === "upfront_payment_demanded");
    assert.ok(upfront, "no upfront-payment signal");
    assert.equal(upfront.severity, "critical");
    assert.equal(findings.status, "high_concern");
    assert.equal(findings.upfrontTotal, 9_999);
  });

  it("computes the implied annual cost from the figures given", () => {
    const findings = assessLoanTerms(
      {
        ...EMPTY_LOAN_TERMS,
        loanAmount: 100_000,
        totalRepayment: 120_000,
        tenureMonths: 12,
      },
      true,
    );
    // 20% of principal over exactly one year.
    assert.ok(findings.impliedAnnualRate !== null);
    assert.ok(Math.abs((findings.impliedAnnualRate as number) - 20) < 0.001);
  });

  it("catches an advertised rate that the arithmetic contradicts", () => {
    const findings = assessLoanTerms(
      {
        ...EMPTY_LOAN_TERMS,
        loanAmount: 100_000,
        totalRepayment: 180_000,
        tenureMonths: 6,
        interestRatePercent: 12,
      },
      true,
    );
    assert.ok(
      findings.signals.some((item) => item.id === "advertised_rate_understates_cost"),
      "did not flag the contradiction between the quoted rate and the figures",
    );
  });

  it("flags a processing fee that is a large share of the loan", () => {
    const findings = assessLoanTerms(
      { ...EMPTY_LOAN_TERMS, loanAmount: 50_000, processingFee: 15_000 },
      true,
    );
    assert.ok(findings.signals.some((item) => item.id === "high_processing_fee"));
  });

  it("says so plainly when nothing in the figures is unusual", () => {
    const findings = assessLoanTerms(
      {
        ...EMPTY_LOAN_TERMS,
        loanAmount: 200_000,
        totalRepayment: 224_000,
        tenureMonths: 12,
        processingFee: 2_000,
      },
      true,
    );
    assert.equal(findings.status, "low_concern");
    assert.ok(findings.signals.every((item) => item.severity === "positive"));
  });

  it("does not call a high rate fraud", () => {
    const findings = assessLoanTerms(
      { ...EMPTY_LOAN_TERMS, loanAmount: 10_000, totalRepayment: 13_000, tenureMonths: 1 },
      true,
    );
    const text = findings.signals.map((item) => item.explanation).join(" ");
    assert.doesNotMatch(text, /\bis a scam\b|\bfraudulent\b/i);
  });
});

// ---------------------------------------------------------------------------
// Scam signals
// ---------------------------------------------------------------------------

describe("scam signals", () => {
  it("is not assessed when the questions were not answered", () => {
    const findings = assessScamSignals(EMPTY_DISCLOSURES, false);
    assert.equal(findings.level, "not_assessed");
    assert.equal(findings.assessed, false);
    assert.equal(findings.signals.length, 0);
  });

  it("records an all-negative answer without claiming legitimacy", () => {
    const findings = assessScamSignals(EMPTY_DISCLOSURES, true);
    assert.equal(findings.level, "low");
    assert.equal(findings.signals.length, 1);
    assert.match(findings.signals[0].explanation, /does not establish that the lender is legitimate/i);
  });

  it("treats an OTP request as critical on its own", () => {
    const findings = assessScamSignals({ ...EMPTY_DISCLOSURES, requestedOtpOrPin: true }, true);
    assert.equal(findings.level, "high");
    assert.equal(findings.signals[0].severity, "critical");
  });

  it("escalates two high-severity behaviours to high", () => {
    const findings = assessScamSignals(
      { ...EMPTY_DISCLOSURES, guaranteedApprovalNoChecks: true, pressuredToActImmediately: true },
      true,
    );
    assert.equal(findings.level, "high");
  });

  it("leaves a single high-severity behaviour at medium", () => {
    const findings = assessScamSignals(
      { ...EMPTY_DISCLOSURES, pressuredToActImmediately: true },
      true,
    );
    assert.equal(findings.level, "medium");
  });

  it("emits one signal per reported behaviour and no more", () => {
    const findings = assessScamSignals(
      { ...EMPTY_DISCLOSURES, requestedOtpOrPin: true, threatenedOrAbusive: true },
      true,
    );
    assert.equal(findings.signals.length, 2);
  });
});

// ---------------------------------------------------------------------------
// E-mail identity
// ---------------------------------------------------------------------------

describe("e-mail identity", () => {
  it("reports not-provided when there is no address", () => {
    const findings = assessEmail({
      address: null,
      websiteHostname: null,
      matchedEntity: null,
      claimsRegulatedStatus: false,
    });
    assert.equal(findings.status, "not_provided");
  });

  it("corroborates an address on the domain the RBI holds", () => {
    const findings = assessEmail({
      address: "support@examplefinance.in",
      websiteHostname: null,
      matchedEntity: entity(),
      claimsRegulatedStatus: true,
    });
    assert.equal(findings.status, "consistent");
    assert.ok(findings.matchesRegisteredDomain);
  });

  it("contradicts an address on a different domain than the RBI record", () => {
    const findings = assessEmail({
      address: "loans@example-finance-apply.com",
      websiteHostname: null,
      matchedEntity: entity(),
      claimsRegulatedStatus: true,
    });
    assert.equal(findings.status, "inconsistent");
    assert.ok(findings.signals.some((item) => item.id === "email_differs_from_rbi_record"));
  });

  it("escalates a free provider when the lender claims to be regulated", () => {
    const regulated = assessEmail({
      address: "agent@gmail.com",
      websiteHostname: null,
      matchedEntity: entity(),
      claimsRegulatedStatus: true,
    });
    const unclaimed = assessEmail({
      address: "agent@gmail.com",
      websiteHostname: null,
      matchedEntity: null,
      claimsRegulatedStatus: false,
    });

    const free = (findings: typeof regulated) =>
      findings.signals.find((item) => item.id === "email_free_provider");

    assert.equal(free(regulated)?.severity, "high");
    assert.equal(free(unclaimed)?.severity, "medium");
    assert.ok(regulated.isFreeMailProvider);
  });

  it("treats a disposable mailbox as critical", () => {
    const findings = assessEmail({
      address: "x@mailinator.com",
      websiteHostname: null,
      matchedEntity: null,
      claimsRegulatedStatus: false,
    });
    assert.equal(findings.signals[0].severity, "critical");
    assert.equal(findings.status, "inconsistent");
  });

  it("notes when the e-mail and the website disagree", () => {
    const findings = assessEmail({
      address: "loans@one-domain.com",
      websiteHostname: "another-domain.com",
      matchedEntity: null,
      claimsRegulatedStatus: false,
    });
    assert.equal(findings.matchesWebsiteDomain, false);
    assert.ok(findings.signals.some((item) => item.id === "email_website_mismatch"));
  });

  it("stays uncorroborated when there is nothing to compare against", () => {
    const findings = assessEmail({
      address: "hello@some-nbfc.co.in",
      websiteHostname: null,
      matchedEntity: null,
      claimsRegulatedStatus: false,
    });
    assert.equal(findings.status, "uncorroborated");
  });
});
