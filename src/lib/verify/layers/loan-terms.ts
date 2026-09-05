/**
 * LAYER 5a — Loan terms.
 *
 * What is actually being offered, and does the arithmetic hold together?
 *
 * The single most useful question in this whole layer is the first one: is the
 * borrower being asked to send money before receiving any. That is the
 * defining mechanic of an advance-fee lending scam, and it is a structural
 * observation rather than a judgement about a rate being high.
 *
 * The rest is arithmetic on the numbers the user typed in. Where the figures
 * contradict each other — an advertised rate that cannot produce the quoted
 * repayment — the contradiction is reported with both numbers shown, so the
 * user can check it themselves rather than take the application's word for it.
 *
 * Nothing here is financial advice, and a high rate on its own is not called
 * fraud: small-ticket unsecured credit in India is genuinely expensive.
 */

import type { LoanTermsInput } from "../input";
import { signal, type Signal } from "../signals";
import { LOAN_TERMS_STATUS_LABELS, type LoanTermsFindings, type LoanTermsStatus } from "../types";

/**
 * RBI-registered lenders must disclose an annualised rate. Above this, a
 * consumer loan is far outside what registered NBFCs publish — worth flagging,
 * still not proof of anything.
 */
const EXTREME_ANNUAL_RATE = 100;
const HIGH_ANNUAL_RATE = 50;
/** A processing fee above this share of the principal is unusual. */
const HIGH_FEE_SHARE = 0.1;

export function assessLoanTerms(terms: LoanTermsInput, provided: boolean): LoanTermsFindings {
  const signals: Signal[] = [];

  if (!provided) {
    return {
      status: "not_provided",
      statusLabel: LOAN_TERMS_STATUS_LABELS.not_provided,
      provided: false,
      terms: null,
      impliedAnnualRate: null,
      upfrontTotal: null,
      signals,
    };
  }

  // --- money demanded before disbursement ---------------------------------
  const upfrontTotal = sum(terms.upfrontPayment);

  if (terms.upfrontPayment !== null && terms.upfrontPayment > 0) {
    const share =
      terms.loanAmount && terms.loanAmount > 0 ? terms.upfrontPayment / terms.loanAmount : null;

    signals.push(
      signal({
        id: "upfront_payment_demanded",
        category: "loan_terms",
        severity: "critical",
        origin: "heuristic",
        title: "Payment is demanded before the loan is disbursed",
        explanation:
          "You are being asked to send money before receiving any. This is the defining mechanic of " +
          "an advance-fee lending scam: the fee is the product, and the loan never arrives. " +
          "Legitimate lenders deduct their charges from the disbursed amount — they do not collect " +
          "them from you first. RBI-regulated lenders are required to disclose all charges and to " +
          "recover them from the disbursement.",
        evidence:
          share !== null
            ? `${formatMoney(terms.upfrontPayment)} demanded up front on a ${formatMoney(terms.loanAmount)} loan (${(share * 100).toFixed(0)}%)`
            : `${formatMoney(terms.upfrontPayment)} demanded up front`,
        source: "Loan terms you supplied",
      }),
    );
  }

  // --- processing fee ------------------------------------------------------
  if (terms.processingFee !== null && terms.loanAmount !== null && terms.loanAmount > 0) {
    const share = terms.processingFee / terms.loanAmount;
    if (share > HIGH_FEE_SHARE) {
      signals.push(
        signal({
          id: "high_processing_fee",
          category: "loan_terms",
          severity: share > 0.25 ? "high" : "medium",
          origin: "heuristic",
          title: "The processing fee is a large share of the loan",
          explanation:
            `The processing fee is ${(share * 100).toFixed(0)}% of the amount being lent. Registered ` +
            "lenders typically charge between 0.5% and 4%. A fee this size changes what the loan " +
            "actually costs and should appear in the APR the lender quotes you.",
          evidence: `${formatMoney(terms.processingFee)} on ${formatMoney(terms.loanAmount)}`,
          source: "Loan terms you supplied",
        }),
      );
    }
  }

  // --- implied cost --------------------------------------------------------
  const impliedAnnualRate = impliedRate(terms);

  if (impliedAnnualRate !== null) {
    if (impliedAnnualRate > EXTREME_ANNUAL_RATE) {
      signals.push(
        signal({
          id: "extreme_implied_rate",
          category: "loan_terms",
          severity: "high",
          origin: "heuristic",
          title: "The figures imply an extremely high annual cost",
          explanation:
            `Repaying ${formatMoney(terms.totalRepayment)} on ${formatMoney(terms.loanAmount)} over ` +
            `${terms.tenureMonths} month(s) works out at roughly ${impliedAnnualRate.toFixed(0)}% a year. ` +
            "Short-tenure lending is expensive, but a figure at this level is far above what " +
            "RBI-registered lenders publish and is characteristic of predatory app-based lending.",
          evidence: `≈ ${impliedAnnualRate.toFixed(0)}% per annum, implied`,
          source: "Computed from the figures you supplied",
        }),
      );
    } else if (impliedAnnualRate > HIGH_ANNUAL_RATE) {
      signals.push(
        signal({
          id: "high_implied_rate",
          category: "loan_terms",
          severity: "medium",
          origin: "heuristic",
          title: "The figures imply a high annual cost",
          explanation:
            `The amounts and tenure you gave work out at roughly ${impliedAnnualRate.toFixed(0)}% a year. ` +
            "That is legal and does happen in small-ticket unsecured credit, but make sure the lender " +
            "has told you this number in writing.",
          evidence: `≈ ${impliedAnnualRate.toFixed(0)}% per annum, implied`,
          source: "Computed from the figures you supplied",
        }),
      );
    }

    // --- does the advertised rate match the arithmetic? --------------------
    const advertised = terms.aprPercent ?? terms.interestRatePercent;
    if (advertised !== null && advertised > 0 && impliedAnnualRate > advertised * 1.5 + 5) {
      signals.push(
        signal({
          id: "advertised_rate_understates_cost",
          category: "loan_terms",
          severity: "high",
          origin: "heuristic",
          title: "The advertised rate does not match what the figures imply",
          explanation:
            `You were quoted ${advertised}% a year, but the amounts and tenure you gave imply about ` +
            `${impliedAnnualRate.toFixed(0)}%. Either charges are being left out of the quoted rate or ` +
            "the figures do not add up. Ask for the all-in APR and the full repayment schedule in " +
            "writing before agreeing to anything.",
          evidence: `quoted ${advertised}% vs implied ≈ ${impliedAnnualRate.toFixed(0)}%`,
          source: "Computed from the figures you supplied",
        }),
      );
    }
  }

  // --- unclear repayment ---------------------------------------------------
  if (terms.loanAmount !== null && terms.totalRepayment === null && terms.tenureMonths === null) {
    signals.push(
      signal({
        id: "repayment_unclear",
        category: "loan_terms",
        severity: "medium",
        origin: "heuristic",
        title: "The repayment terms are not specified",
        explanation:
          "An amount is on the table but no total repayment and no tenure. A lender that will not " +
          "tell you what you owe and by when has not made you an offer you can evaluate. Ask for a " +
          "sanction letter with the schedule before proceeding.",
        evidence: `${formatMoney(terms.loanAmount)} with no stated repayment or tenure`,
        source: "Loan terms you supplied",
      }),
    );
  }

  // --- other charges --------------------------------------------------------
  if (terms.prepaymentCharge !== null && terms.loanAmount !== null && terms.loanAmount > 0) {
    const share = terms.prepaymentCharge / terms.loanAmount;
    if (share > 0.05) {
      signals.push(
        signal({
          id: "high_prepayment_charge",
          category: "loan_terms",
          severity: "low",
          origin: "heuristic",
          title: "The prepayment charge is high",
          explanation:
            "Closing the loan early would cost a large share of the principal. The RBI bars foreclosure " +
            "charges on floating-rate personal loans to individual borrowers; on other loans the charge " +
            "is permitted but must be disclosed up front.",
          evidence: `${formatMoney(terms.prepaymentCharge)} on ${formatMoney(terms.loanAmount)}`,
          source: "Loan terms you supplied",
        }),
      );
    }
  }

  if (terms.collateralDemanded) {
    signals.push(
      signal({
        id: "collateral_demanded",
        category: "loan_terms",
        severity: "info",
        origin: "heuristic",
        title: "Collateral or security is being demanded",
        explanation:
          "Note what is being asked for and whether handing it over is reversible. Original documents " +
          "— property papers, vehicle registration, identity originals — should never leave your hands " +
          "before a written agreement is in place.",
        evidence: terms.collateralDemanded,
        source: "Loan terms you supplied",
      }),
    );
  }

  // --- nothing wrong found -------------------------------------------------
  if (signals.length === 0) {
    signals.push(
      signal({
        id: "loan_terms_no_concern",
        category: "loan_terms",
        severity: "positive",
        origin: "heuristic",
        title: "Nothing unusual in the terms you supplied",
        explanation:
          "The figures you entered raised none of the checks in this layer. That covers only what you " +
          "typed in — a term you did not enter cannot be checked.",
        evidence: null,
        source: "Loan terms you supplied",
      }),
    );
  }

  return {
    status: resolveStatus(signals),
    statusLabel: LOAN_TERMS_STATUS_LABELS[resolveStatus(signals)],
    provided: true,
    terms,
    impliedAnnualRate,
    upfrontTotal,
    signals,
  };
}

/**
 * Total cost expressed as a simple annualised rate:
 *
 *     (repayment - principal) / principal  ×  12 / tenure in months
 *
 * Simple rather than compounded, and stated as such wherever it is shown. The
 * point is to expose an order of magnitude — "this is 400% a year, not 4%" —
 * not to reproduce a lender's amortisation schedule.
 */
function impliedRate(terms: LoanTermsInput): number | null {
  const { loanAmount, totalRepayment, tenureMonths, processingFee, upfrontPayment } = terms;
  if (!loanAmount || loanAmount <= 0 || !totalRepayment || !tenureMonths || tenureMonths <= 0) {
    return null;
  }

  const cost = totalRepayment - loanAmount + (processingFee ?? 0) + (upfrontPayment ?? 0);
  if (cost <= 0) return null;

  return (cost / loanAmount) * (12 / tenureMonths) * 100;
}

function sum(...values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? present.reduce((total, value) => total + value, 0) : null;
}

function formatMoney(value: number | null): string {
  if (value === null) return "an unstated amount";
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function resolveStatus(signals: readonly Signal[]): LoanTermsStatus {
  if (signals.some((item) => item.severity === "critical" || item.severity === "high")) {
    return "high_concern";
  }
  if (signals.some((item) => item.severity === "medium")) return "caution";
  return "low_concern";
}
