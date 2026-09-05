/**
 * LAYER 5b — Behavioural scam signals.
 *
 * The other five layers examine what the lender *is*. This one examines what
 * the lender has *done* — the ten things the user was asked in the form.
 *
 * Every rule here maps one answered question to one signal, so a user can trace
 * any finding back to the box they ticked. There is no free-text analysis and
 * no model: this is a lookup table with reasoning attached, which is exactly
 * what it should be. A model here would add opacity and no accuracy.
 *
 * These are the behaviours the RBI's own guidance on digital lending, and the
 * documented pattern of Indian loan-app fraud, single out. Several of them are
 * conclusive on their own: no lawful lender in India has any use for your OTP.
 */

import type { DisclosureKey, Disclosures } from "../input";
import { signal, type Signal } from "../signals";
import { SCAM_LEVEL_LABELS, type ScamSignalFindings, type ScamSignalLevel } from "../types";

interface Rule {
  readonly severity: Signal["severity"];
  readonly title: string;
  readonly explanation: string;
}

const RULES: Readonly<Record<DisclosureKey, Rule>> = {
  paymentBeforeDisbursement: {
    severity: "critical",
    title: "Money was demanded before the loan was released",
    explanation:
      "This is the core mechanic of advance-fee lending fraud. A registered lender recovers its " +
      "charges from the amount it disburses; it does not ask you to pay first. Whatever the payment " +
      "is called — processing, GST, insurance, verification, file charges, a refundable security " +
      "deposit — the pattern is the same and the loan does not follow.",
  },
  requestedOtpOrPin: {
    severity: "critical",
    title: "An OTP, PIN or password was requested",
    explanation:
      "Nobody legitimate ever needs these — not your bank, not an NBFC, not the RBI, not a recovery " +
      "agent. An OTP authorises a transaction on your account. Handing one over is authorising " +
      "whatever the other party is doing at that moment.",
  },
  requestedBankCredentials: {
    severity: "critical",
    title: "Net-banking or card credentials were requested",
    explanation:
      "A lender needs your account number to send money to you. It never needs your net-banking " +
      "login, your card's CVV or your UPI PIN, all of which exist to move money out.",
  },
  askedToInstallApkOutsideStore: {
    severity: "critical",
    title: "An app was to be installed from a link rather than an app store",
    explanation:
      "Sideloaded lending apps are the standard delivery mechanism for the harvesting of contacts, " +
      "photos and messages that drives loan-app blackmail in India. Apps distributed this way have " +
      "passed no store review and can request permissions a listed app would be refused. Regulated " +
      "digital lenders publish through the official stores.",
  },
  paymentToPersonalAccount: {
    severity: "critical",
    title: "Payment was to a personal account, UPI ID or wallet",
    explanation:
      "A registered NBFC or bank collects into a company current account in its own name. A request " +
      "to pay an individual's UPI ID, a personal savings account or a wallet means the money is not " +
      "reaching the institution being named — and is essentially unrecoverable.",
  },
  guaranteedApprovalNoChecks: {
    severity: "high",
    title: "Guaranteed approval with no credit check was promised",
    explanation:
      "Regulated lenders in India are required to assess creditworthiness, and every one of them " +
      "reserves the right to decline. A guarantee made before any assessment is a sales hook, not " +
      "a credit decision.",
  },
  pressuredToActImmediately: {
    severity: "high",
    title: "Pressure to act immediately, or an expiring offer",
    explanation:
      "Manufactured urgency exists to stop you checking. A genuine sanctioned loan offer is valid " +
      "for days and survives you reading it. Anything that cannot survive an hour's delay is not a " +
      "loan offer.",
  },
  requestedContactsOrGalleryAccess: {
    severity: "critical",
    title: "Access to contacts, photos or messages was requested",
    explanation:
      "This has no lending purpose whatsoever. It is the harvesting step in the loan-app extortion " +
      "pattern: the contacts and photos are taken first and used later to shame the borrower into " +
      "paying. The RBI's Digital Lending Guidelines bar regulated lenders from collecting it.",
  },
  threatenedOrAbusive: {
    severity: "critical",
    title: "Threats, shaming or abusive contact",
    explanation:
      "The RBI's Fair Practices Code prohibits this outright for every regulated lender and their " +
      "recovery agents. It is also a criminal matter. Complaints can be raised with the RBI's " +
      "Ombudsman scheme and with the National Cyber Crime Reporting Portal at cybercrime.gov.in.",
  },
  noWrittenAgreement: {
    severity: "high",
    title: "No written agreement or sanction letter was provided",
    explanation:
      "Regulated lenders must issue a sanction letter and a Key Fact Statement setting out the " +
      "amount, the annual percentage rate, all charges and the recovery mechanism. A refusal to put " +
      "the terms in writing removes both your evidence and your recourse.",
  },
};

export function assessScamSignals(
  disclosures: Disclosures,
  answered: boolean,
): ScamSignalFindings {
  if (!answered) {
    return {
      level: "not_assessed",
      levelLabel: SCAM_LEVEL_LABELS.not_assessed,
      assessed: false,
      signals: [],
    };
  }

  const signals: Signal[] = [];

  for (const [key, rule] of Object.entries(RULES) as [DisclosureKey, Rule][]) {
    if (!disclosures[key]) continue;
    signals.push(
      signal({
        id: `behaviour_${key}`,
        category: "scam_behaviour",
        severity: rule.severity,
        origin: "heuristic",
        title: rule.title,
        explanation: rule.explanation,
        evidence: "Reported by you",
        source: "Your answers to the lender-behaviour questions",
      }),
    );
  }

  if (signals.length === 0) {
    signals.push(
      signal({
        id: "behaviour_none_reported",
        category: "scam_behaviour",
        severity: "positive",
        origin: "heuristic",
        title: "None of the high-risk behaviours were reported",
        explanation:
          "You answered no to all ten questions. That removes the strongest single class of evidence " +
          "against this lender — it does not establish that the lender is legitimate, which is what " +
          "the regulatory and identity layers are for.",
        evidence: null,
        source: "Your answers to the lender-behaviour questions",
      }),
    );
  }

  return {
    level: resolveLevel(signals),
    levelLabel: SCAM_LEVEL_LABELS[resolveLevel(signals)],
    assessed: true,
    signals,
  };
}

function resolveLevel(signals: readonly Signal[]): ScamSignalLevel {
  const critical = signals.filter((item) => item.severity === "critical").length;
  const high = signals.filter((item) => item.severity === "high").length;

  if (critical > 0) return "high";
  if (high >= 2) return "high";
  if (high === 1) return "medium";
  return "low";
}
