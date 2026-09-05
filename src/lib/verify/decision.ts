/**
 * The verdict engine.
 *
 * Six layer verdicts go in; one overall verdict, a set of reasons and a set of
 * recommended actions come out. The rules are written out longhand below
 * rather than folded into a weighted sum, for three reasons:
 *
 *   1. A weighted sum cannot express "a cancelled registration is red no matter
 *      what else is true", and that is the most important rule in the product.
 *   2. Every verdict has to be explainable as a rule that fired, in the order
 *      it fired, not as arithmetic that happened to cross a line.
 *   3. Adding a layer must not silently redistribute the weight of the others.
 *
 * The engine reads only layer verdicts and signal severities. It never sees the
 * model's probability, so a confident model cannot argue its way past a
 * regulatory fact — the ordering of the rules is what enforces that, and the
 * cancelled-registration rule is deliberately the first one.
 *
 * GRAY is a first-class outcome. When there is not enough evidence, saying so
 * is the correct answer; "probably fine" and "probably a scam" are both worse.
 */

import type { Signal } from "./signals";
import type {
  CompanyIdentityFindings,
  EmailFindings,
  LoanTermsFindings,
  RegulatoryFindings,
  ScamSignalFindings,
  Verdict,
  VerificationMatrixRow,
  WebsiteFindings,
} from "./types";
import {
  COMPANY_STATUS_LABELS,
  DIGITAL_STATUS_LABELS,
  LOAN_TERMS_STATUS_LABELS,
  REGULATORY_STATUS_LABELS,
  SCAM_LEVEL_LABELS,
  VERDICT_LABELS,
  VERDICT_SHORT,
} from "./types";

export interface DecisionInput {
  readonly regulatory: RegulatoryFindings;
  readonly company: CompanyIdentityFindings;
  readonly website: WebsiteFindings;
  readonly email: EmailFindings;
  readonly loanTerms: LoanTermsFindings;
  readonly scamSignals: ScamSignalFindings;
  readonly claimedName: string | null;
  readonly allSignals: readonly Signal[];
}

export interface Decision {
  readonly verdict: Verdict;
  readonly verdictLabel: string;
  readonly verdictShort: string;
  readonly headline: string;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly recommendedActions: readonly string[];
  readonly matrix: readonly VerificationMatrixRow[];
}

/**
 * What the verdict is *about*, in words.
 *
 * A user who typed only a website has given us no name to use, so the website
 * itself is the subject — "example.com raised inconsistencies" reads far better
 * than "this lender raised inconsistencies", and it keeps the thing being
 * judged in front of the reader. Two forms are carried because the fallback
 * needs a capital at the start of a sentence and a lower-case one inside it,
 * while a real name or a domain must never be re-cased at all.
 */
interface Subject {
  /** For use inside a sentence. */
  readonly named: string;
  /** For use at the start of a sentence. */
  readonly opener: string;
}

function subjectOf(input: DecisionInput): Subject {
  const known = input.company.legalName ?? input.claimedName ?? input.website.hostname ?? null;
  return known === null ? { named: "this lender", opener: "This lender" } : { named: known, opener: known };
}

export function decide(input: DecisionInput): Decision {
  const reasons: string[] = [];
  const subject = subjectOf(input);

  const criticalSignals = input.allSignals.filter((item) => item.severity === "critical");
  const highSignals = input.allSignals.filter((item) => item.severity === "high");

  // -- RULE 1 -------------------------------------------------------------
  // A cancelled Certificate of Registration is a published regulatory fact.
  // Nothing downstream may soften it.
  const cancelled = input.regulatory.status === "cancelled";
  if (cancelled) {
    reasons.push(
      `The RBI's cancelled-registration list contains a matching entry. An entity whose Certificate ` +
        `of Registration has been cancelled is not authorised to carry on the business of a ` +
        `non-banking financial company.`,
    );
  }

  // -- RULE 2 -------------------------------------------------------------
  // Behaviour that is conclusive on its own: OTP requests, advance fees,
  // sideloaded apps, contact harvesting, threats.
  const criticalBehaviour = input.scamSignals.signals.filter((item) => item.severity === "critical");
  for (const item of criticalBehaviour) reasons.push(item.title + ".");

  // -- RULE 3 -------------------------------------------------------------
  // The impersonation case: the institution is real, but the digital identity
  // in front of the user belongs to someone else.
  const impersonationEvidence =
    input.regulatory.status === "verified" &&
    (input.website.status === "inconsistent" || input.email.status === "inconsistent");

  if (impersonationEvidence) {
    reasons.push(
      `${subject.opener} is a real institution in the RBI's records, but the website or e-mail you were ` +
        `given does not correspond to it. A registered company existing is not the same as the ` +
        `party contacting you being that company.`,
    );
  }

  // -- RULE 4 -------------------------------------------------------------
  const criticalLoanTerms = input.loanTerms.signals.filter((item) => item.severity === "critical");
  for (const item of criticalLoanTerms) {
    if (!reasons.some((reason) => reason.startsWith(item.title))) reasons.push(`${item.title}.`);
  }

  // -- RULE 5 -------------------------------------------------------------
  const cinConflict = input.company.cinMatchesName === false;
  if (cinConflict) {
    reasons.push("The CIN you were given belongs to a different company than the name you were given.");
  }

  // --- assemble the verdict ------------------------------------------------
  const verdict = resolveVerdict({
    input,
    cancelled,
    criticalCount: criticalSignals.length,
    highCount: highSignals.length,
    impersonationEvidence,
    cinConflict,
  });

  if (verdict === "green") {
    reasons.push(
      `${subject.opener} is present in the RBI reference data, the identity details supplied are ` +
        `consistent with that record, and no serious risk signal was raised by the checks that ran.`,
    );
  }

  if (verdict === "gray") {
    reasons.push(
      `LenderLens could not gather enough evidence to reach a conclusion. That is a statement about ` +
        `the available evidence, not about the lender: absence from the RBI's NBFC and ARC lists is ` +
        `not evidence of wrongdoing, and many lawful lenders are regulated elsewhere.`,
    );
  }

  if (verdict === "amber" && reasons.length === 0) {
    const worst = [...input.allSignals]
      .filter((item) => item.severity === "high" || item.severity === "medium")
      .slice(0, 3);
    for (const item of worst) reasons.push(`${item.title}.`);
  }

  return {
    verdict,
    verdictLabel: VERDICT_LABELS[verdict],
    verdictShort: VERDICT_SHORT[verdict],
    headline: headlineFor(verdict, subject, input),
    summary: summaryFor(verdict, subject, input),
    reasons,
    recommendedActions: actionsFor(verdict, input),
    matrix: buildMatrix(input),
  };
}

// ---------------------------------------------------------------------------
// Verdict resolution
// ---------------------------------------------------------------------------

function resolveVerdict(context: {
  input: DecisionInput;
  cancelled: boolean;
  criticalCount: number;
  highCount: number;
  impersonationEvidence: boolean;
  cinConflict: boolean;
}): Verdict {
  const { input } = context;

  // RED — a published regulatory fact, or a behaviour that is conclusive.
  if (context.cancelled) return "red";
  if (context.criticalCount > 0) return "red";
  if (context.impersonationEvidence) return "red";
  if (context.cinConflict) return "red";
  if (input.scamSignals.level === "high") return "red";
  if (context.highCount >= 3) return "red";

  // GRAY — not enough to say anything either way. Checked before amber so that
  // a thin check is reported as thin rather than dressed up as a caution.
  //
  // The subtle part is the exclusion below. "Not found in the RBI data" is a
  // signal, but it must never on its own tip the verdict into amber: that
  // would quietly convert absence of evidence into suspicion, which is the one
  // failure mode this product is not allowed to have.
  const nothingCorroborated =
    input.regulatory.status === "not_verified" || input.regulatory.status === "unknown";

  const concernsOtherThanAbsence = input.allSignals.filter(
    (item) =>
      item.id !== "not_in_rbi_data" &&
      (item.severity === "critical" || item.severity === "high" || item.severity === "medium"),
  );

  if (nothingCorroborated && concernsOtherThanAbsence.length === 0) return "gray";

  // AMBER — something is corroborated but something else does not line up.
  if (context.highCount > 0) return "amber";
  if (input.regulatory.status === "conflicting") return "amber";
  if (input.company.status === "partial" || input.company.status === "mismatch") return "amber";
  if (input.website.status === "inconsistent" || input.email.status === "inconsistent") return "amber";
  if (input.loanTerms.status === "high_concern" || input.loanTerms.status === "caution") return "amber";
  if (input.scamSignals.level === "medium") return "amber";
  if (concernsOtherThanAbsence.length > 0) return "amber";

  // GREEN — requires positive regulatory corroboration. Absence of bad news is
  // never enough on its own.
  if (input.regulatory.status === "verified" && input.company.status === "match") return "green";

  return "gray";
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

function headlineFor(verdict: Verdict, subject: Subject, input: DecisionInput): string {
  switch (verdict) {
    case "red":
      if (input.regulatory.status === "cancelled") {
        return `${subject.opener} matches an entry on the RBI's cancelled-registration list`;
      }
      if (input.regulatory.status === "verified") {
        return `${subject.opener} is a real institution — but the party contacting you may not be it`;
      }
      return `Serious risk signals were found for ${subject.named}`;
    case "amber":
      return `${subject.opener} raised inconsistencies that should be resolved first`;
    case "green":
      return `${subject.opener} is consistent with the RBI's published records`;
    case "gray":
      return `LenderLens could not verify ${subject.named} from the available evidence`;
  }
}

function summaryFor(verdict: Verdict, subject: Subject, input: DecisionInput): string {
  switch (verdict) {
    case "red":
      if (input.regulatory.status === "verified") {
        return (
          "The regulated company appears to be genuine. The evidence about the party contacting you " +
          "is not consistent with it. Treat the contact as unverified until you have reached the " +
          "institution through details you obtained yourself."
        );
      }
      return (
        "The checks raised contradictions or risk indicators serious enough that you should not send " +
        "money, documents or credentials on the strength of this lender's own assurances."
      );
    case "amber":
      return (
        "Part of the evidence supports this lender and part of it does not. The inconsistencies below " +
        "are worth resolving before you commit to anything — each one names what to ask for."
      );
    case "green":
      return (
        `${subject.opener} appears in the RBI reference data LenderLens uses, and the identity details you ` +
        "supplied line up with that record. This confirms what the published data says. It is not an " +
        "endorsement of any particular offer, and it cannot cover events after the dataset's as-of date."
      );
    case "gray":
      return (
        "There is not enough evidence to reach a reliable conclusion. This is not a finding against " +
        "the lender — it means the checks available here could neither corroborate nor contradict the " +
        "claim. Supplying a CIN, a website or the loan terms would give the check more to work with."
      );
  }
}

// ---------------------------------------------------------------------------
// Recommended actions
// ---------------------------------------------------------------------------

function actionsFor(verdict: Verdict, input: DecisionInput): string[] {
  const actions: string[] = [];

  if (verdict === "red" || verdict === "amber") {
    actions.push(
      "Do not transfer money, share documents or hand over credentials until the lender's identity " +
        "has been confirmed through a channel you found yourself.",
    );
  }

  if (input.regulatory.status === "verified" && input.regulatory.primary) {
    const entity = input.regulatory.primary.entity;
    const contact = [
      entity.hostnames[0] ? `its RBI-listed website (${entity.hostnames[0]})` : null,
      entity.emailDomains[0] ? `the contact address the RBI records (@${entity.emailDomains[0]})` : null,
    ].filter(Boolean);

    if (contact.length > 0) {
      actions.push(
        `Contact ${entity.name} through ${contact.join(" or ")} — obtained from the RBI record rather ` +
          "than from whoever approached you — and ask them to confirm the offer.",
      );
    } else {
      actions.push(
        `Look ${entity.name} up independently on the RBI's own site and contact it through the details ` +
          "published there, rather than through any link or number you were sent.",
      );
    }
  }

  if (input.regulatory.status === "not_verified") {
    actions.push(
      "Ask the lender for its Certificate of Registration number and CIN in writing, then check them " +
        "yourself on the RBI and MCA websites. A registered lender will supply both without hesitation.",
    );
  }

  if (input.regulatory.status === "cancelled") {
    actions.push(
      "Verify the cancellation directly on the RBI's own website before acting. If the company is " +
        "still offering NBFC services under this name, that can be reported to the RBI.",
    );
  }

  if (input.scamSignals.signals.some((item) => item.severity === "critical")) {
    actions.push(
      "If you have already shared an OTP, card or net-banking details, contact your bank now to block " +
        "the account, and report the incident on cybercrime.gov.in or by calling 1930.",
    );
  }

  if (input.company.cinMatchesName === false) {
    actions.push(
      "Ask why the CIN you were given is registered to a different company, and do not proceed until " +
        "that is answered to your satisfaction.",
    );
  }

  if (!input.loanTerms.provided && verdict !== "green") {
    actions.push(
      "Ask for the sanction letter and Key Fact Statement — the amount, the annual percentage rate, " +
        "every charge and the recovery process, in writing — then run this check again with those figures.",
    );
  }

  if (verdict === "green") {
    actions.push(
      "Read the sanction letter and Key Fact Statement before signing, and confirm that the annual " +
        "percentage rate and charges match what you were told verbally.",
    );
  }

  actions.push(
    "LenderLens reports what the RBI's published datasets contain. It is not affiliated with the " +
      "Reserve Bank of India, gives no financial advice, and cannot see anything that happened after " +
      "the dataset's as-of date.",
  );

  return actions;
}

// ---------------------------------------------------------------------------
// The verification matrix
// ---------------------------------------------------------------------------

type Tone = VerificationMatrixRow["tone"];

function buildMatrix(input: DecisionInput): VerificationMatrixRow[] {
  const regulatoryTone: Tone =
    input.regulatory.status === "verified"
      ? "positive"
      : input.regulatory.status === "cancelled"
        ? "negative"
        : input.regulatory.status === "conflicting"
          ? "caution"
          : "neutral";

  const companyTone: Tone =
    input.company.status === "match"
      ? "positive"
      : input.company.status === "mismatch"
        ? "negative"
        : input.company.status === "partial"
          ? "caution"
          : "neutral";

  const digitalTone = (status: WebsiteFindings["status"]): Tone =>
    status === "consistent"
      ? "positive"
      : status === "inconsistent"
        ? "negative"
        : "neutral";

  const loanTone: Tone =
    input.loanTerms.status === "low_concern"
      ? "positive"
      : input.loanTerms.status === "high_concern"
        ? "negative"
        : input.loanTerms.status === "caution"
          ? "caution"
          : "neutral";

  const scamTone: Tone =
    input.scamSignals.level === "low"
      ? "positive"
      : input.scamSignals.level === "high"
        ? "negative"
        : input.scamSignals.level === "medium"
          ? "caution"
          : "neutral";

  return [
    {
      key: "regulatory",
      layer: "RBI regulatory identity",
      status: REGULATORY_STATUS_LABELS[input.regulatory.status],
      tone: regulatoryTone,
      evidence: regulatoryEvidence(input.regulatory),
    },
    {
      key: "company",
      layer: "Company identity",
      status: COMPANY_STATUS_LABELS[input.company.status],
      tone: companyTone,
      evidence: input.company.legalName
        ? `${input.company.legalName}${input.company.cin ? ` · ${input.company.cin}` : ""}`
        : "No legal entity established",
    },
    {
      key: "website",
      layer: "Website identity",
      status: DIGITAL_STATUS_LABELS[input.website.status],
      tone: digitalTone(input.website.status),
      evidence: websiteEvidence(input.website),
    },
    {
      key: "email",
      layer: "E-mail identity",
      status: DIGITAL_STATUS_LABELS[input.email.status],
      tone: digitalTone(input.email.status),
      evidence: input.email.domain ?? "No e-mail address supplied",
    },
    {
      key: "loan_terms",
      layer: "Loan terms",
      status: LOAN_TERMS_STATUS_LABELS[input.loanTerms.status],
      tone: loanTone,
      evidence: input.loanTerms.provided
        ? describeLoanEvidence(input.loanTerms)
        : "No loan terms supplied",
    },
    {
      key: "scam_signals",
      layer: "Scam signals",
      status: SCAM_LEVEL_LABELS[input.scamSignals.level],
      tone: scamTone,
      evidence: input.scamSignals.assessed
        ? `${input.scamSignals.signals.filter((item) => item.severity !== "positive").length} of 10 behaviours reported`
        : "Behaviour questions not answered",
    },
  ];
}

function regulatoryEvidence(regulatory: RegulatoryFindings): string {
  if (!regulatory.primary) return "No matching RBI record";
  const entity = regulatory.primary.entity;
  const parts = [entity.name];
  if (entity.attributes.classification) parts.push(entity.attributes.classification);
  if (entity.attributes.bankCategory) parts.push(entity.attributes.bankCategory.replace(/_/g, " "));
  return parts.join(" · ");
}

function websiteEvidence(website: WebsiteFindings): string {
  if (!website.hostname) return "No website supplied";
  if (website.officialHostnames.length > 0) {
    return `${website.hostname} · RBI lists ${website.officialHostnames.join(", ")}`;
  }
  return website.hostname;
}

function describeLoanEvidence(loanTerms: LoanTermsFindings): string {
  const parts: string[] = [];
  if (loanTerms.terms?.loanAmount) {
    parts.push(`₹${loanTerms.terms.loanAmount.toLocaleString("en-IN")}`);
  }
  if (loanTerms.upfrontTotal) {
    parts.push(`₹${loanTerms.upfrontTotal.toLocaleString("en-IN")} up front`);
  }
  if (loanTerms.impliedAnnualRate !== null) {
    parts.push(`≈${loanTerms.impliedAnnualRate.toFixed(0)}% p.a. implied`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Terms supplied";
}
