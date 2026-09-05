/**
 * Turn whatever the user supplied into a structured verification request.
 *
 * The form accepts far more than a name now — a website, an e-mail, the loan
 * being offered and a short list of things the lender has asked for — but the
 * first field still takes free text and works out what it is, because a user
 * who has been sent a link and a name should not have to classify it first.
 *
 * Pure functions only: no database, no network. That keeps validation cheap to
 * test and keeps the rules identical wherever they run.
 */

import {
  cleanText,
  emailDomain,
  isValidCin,
  normalizeCin,
  normalizeHostname,
} from "../normalize";

export type InputKind = "cin" | "email" | "website" | "company_name";

/**
 * The loan being offered.
 *
 * Every field is optional. A user who has a screenshot of an offer can type in
 * what it says; a user who has only a phone call can skip the whole section and
 * still get a regulatory and identity verification. Nothing here is ever
 * guessed or filled in on the user's behalf — an absent number is reported as
 * absent.
 */
export interface LoanTermsInput {
  readonly loanAmount: number | null;
  /** Interest rate as advertised, per cent per annum. */
  readonly interestRatePercent: number | null;
  /** All-in APR as quoted by the lender, per cent per annum. */
  readonly aprPercent: number | null;
  readonly processingFee: number | null;
  /** Money demanded before any loan is disbursed. */
  readonly upfrontPayment: number | null;
  readonly totalRepayment: number | null;
  /** Loan tenure in months. */
  readonly tenureMonths: number | null;
  readonly lateFee: number | null;
  readonly prepaymentCharge: number | null;
  readonly collateralDemanded: string | null;
  readonly otherTerms: string | null;
}

export const EMPTY_LOAN_TERMS: LoanTermsInput = {
  loanAmount: null,
  interestRatePercent: null,
  aprPercent: null,
  processingFee: null,
  upfrontPayment: null,
  totalRepayment: null,
  tenureMonths: null,
  lateFee: null,
  prepaymentCharge: null,
  collateralDemanded: null,
  otherTerms: null,
};

/**
 * Things the lender has said or asked for.
 *
 * These are checkboxes rather than free text on purpose. Each one corresponds
 * to a documented rule, so the user can see exactly which of their answers
 * produced which signal — and none of them requires the user to hand over the
 * message itself.
 */
export const DISCLOSURE_KEYS = [
  "paymentBeforeDisbursement",
  "requestedOtpOrPin",
  "requestedBankCredentials",
  "askedToInstallApkOutsideStore",
  "paymentToPersonalAccount",
  "guaranteedApprovalNoChecks",
  "pressuredToActImmediately",
  "requestedContactsOrGalleryAccess",
  "threatenedOrAbusive",
  "noWrittenAgreement",
] as const;

export type DisclosureKey = (typeof DISCLOSURE_KEYS)[number];

export type Disclosures = Readonly<Record<DisclosureKey, boolean>>;

export const EMPTY_DISCLOSURES: Disclosures = Object.freeze(
  Object.fromEntries(DISCLOSURE_KEYS.map((key) => [key, false])) as Record<DisclosureKey, boolean>,
);

export interface ParsedInput {
  readonly raw: string;
  readonly kind: InputKind;
  readonly companyName: string | null;
  readonly cin: string | null;
  /** True when a CIN is present but not in the 21-character MCA format. */
  readonly cinLooksMalformed: boolean;
  readonly email: string | null;
  readonly hostname: string | null;
  readonly websiteUrl: string | null;
  readonly loanTerms: LoanTermsInput;
  readonly loanTermsProvided: boolean;
  readonly disclosures: Disclosures;
  readonly disclosuresProvided: boolean;
  /** True when any disclosure question was answered, including all-negative. */
  readonly disclosuresAnswered: boolean;
}

export interface VerificationRequest {
  readonly query?: string;
  readonly companyName?: string;
  readonly cin?: string;
  readonly website?: string;
  readonly email?: string;
  readonly loanTerms?: Partial<Record<keyof LoanTermsInput, unknown>>;
  readonly disclosures?: Partial<Record<DisclosureKey, unknown>>;
  /** Set when the disclosure questions were shown, even if all were "no". */
  readonly disclosuresAnswered?: boolean;
}

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

const MAX_INPUT_LENGTH = 300;
const MAX_FREE_TEXT_LENGTH = 1_000;
/** Above this a figure is a data-entry slip, not a loan. ₹100 crore. */
const MAX_AMOUNT = 1_000_000_000;
const MAX_PERCENT = 10_000;
const MAX_TENURE_MONTHS = 600;

/** Anything that looks like a bare CIN: 21 alphanumerics starting with L or U. */
const CIN_SHAPE = /^[LU][A-Z0-9]{20}$/;

/**
 * Hostnames only — a label, a dot, and a 2+ letter TLD. Deliberately strict so
 * that a company name containing a full stop ("A.C. Fincom Pvt Ltd") is not
 * mistaken for a website.
 */
const BARE_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

const EMAIL_SHAPE = /^[^\s@,;<>()[\]]+@[^\s@,;<>()[\]]+\.[A-Za-z]{2,}$/;

function assertPrintable(value: string, field: string): void {
  // Control characters have no place in any of these fields.
  if (/\p{Cc}/u.test(value)) {
    throw new InvalidInputError(`${field} contains characters that are not allowed.`);
  }
}

function assertLength(value: string, field: string, limit = MAX_INPUT_LENGTH): void {
  if (value.length > limit) {
    throw new InvalidInputError(`${field} is too long (limit ${limit} characters).`);
  }
}

/**
 * Extract a hostname from anything URL-shaped: a full URL, a bare domain, or a
 * domain with a path. Returns null when the text is not a website.
 */
export function extractHostname(value: string): string | null {
  const text = cleanText(value);
  if (text.length === 0 || /\s/.test(text)) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  // Only web URLs are meaningful here; mailto:, javascript: and friends are not.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host = normalizeHostname(parsed.hostname);
  if (!host) return null;

  // Guard against a company name being read as a domain: require the original
  // text to have looked like a host, or to have carried an explicit scheme.
  const hadScheme = withScheme !== `https://${text}`;
  const hostPart = text.split("/")[0].toLowerCase();
  if (!hadScheme && !BARE_DOMAIN.test(hostPart)) return null;

  return host;
}

export function websiteUrlFor(hostname: string): string {
  return `https://${hostname}/`;
}

function classifyFreeText(text: string): InputKind {
  const compactCin = normalizeCin(text);
  if (compactCin && compactCin.length === 21 && CIN_SHAPE.test(compactCin)) return "cin";

  if (text.includes("@") && !/\s/.test(text)) return "email";
  if (extractHostname(text) !== null) return "website";

  return "company_name";
}

// ---------------------------------------------------------------------------
// Loan terms and disclosures
// ---------------------------------------------------------------------------

/**
 * Read a numeric field. Accepts what a person types — "₹25,000", "2.5 lakh",
 * "18%" — and refuses anything it cannot read rather than guessing a value
 * that would then be reasoned about as though the user had said it.
 */
export function parseAmount(value: unknown, field: string, limit = MAX_AMOUNT): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InvalidInputError(`${field} is not a number.`);
    return check(value, field, limit);
  }
  if (typeof value !== "string") return null;

  let text = cleanText(value).toLowerCase();
  if (text.length === 0) return null;
  assertLength(text, field, 40);

  let multiplier = 1;
  if (/\blakhs?\b|\blacs?\b/.test(text)) multiplier = 100_000;
  else if (/\bcrores?\b|\bcr\b/.test(text)) multiplier = 10_000_000;
  else if (/\bk\b/.test(text)) multiplier = 1_000;

  text = text.replace(/[₹$,%\s]/g, "").replace(/lakhs?|lacs?|crores?|cr|k|rs\.?|inr/g, "");
  if (text.length === 0) return null;

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw new InvalidInputError(`"${cleanText(String(value))}" is not a number this form can read.`);
  }

  return check(parsed * multiplier, field, limit);
}

function check(value: number, field: string, limit: number): number {
  if (value < 0) throw new InvalidInputError(`${field} cannot be negative.`);
  if (value > limit) throw new InvalidInputError(`${field} is larger than this form accepts.`);
  return value;
}

function parseLoanTerms(input: VerificationRequest["loanTerms"]): LoanTermsInput {
  if (!input || typeof input !== "object") return EMPTY_LOAN_TERMS;

  const collateral = cleanText(typeof input.collateralDemanded === "string" ? input.collateralDemanded : "");
  const other = cleanText(typeof input.otherTerms === "string" ? input.otherTerms : "");
  if (collateral.length > 0) assertLength(collateral, "Collateral", MAX_FREE_TEXT_LENGTH);
  if (other.length > 0) assertLength(other, "Other terms", MAX_FREE_TEXT_LENGTH);

  return {
    loanAmount: parseAmount(input.loanAmount, "Loan amount"),
    interestRatePercent: parseAmount(input.interestRatePercent, "Interest rate", MAX_PERCENT),
    aprPercent: parseAmount(input.aprPercent, "APR", MAX_PERCENT),
    processingFee: parseAmount(input.processingFee, "Processing fee"),
    upfrontPayment: parseAmount(input.upfrontPayment, "Upfront payment"),
    totalRepayment: parseAmount(input.totalRepayment, "Total repayment"),
    tenureMonths: parseAmount(input.tenureMonths, "Tenure", MAX_TENURE_MONTHS),
    lateFee: parseAmount(input.lateFee, "Late fee"),
    prepaymentCharge: parseAmount(input.prepaymentCharge, "Prepayment charge"),
    collateralDemanded: collateral.length > 0 ? collateral : null,
    otherTerms: other.length > 0 ? other : null,
  };
}

export function hasAnyLoanTerm(terms: LoanTermsInput): boolean {
  return Object.values(terms).some((value) => value !== null);
}

function parseDisclosures(input: VerificationRequest["disclosures"]): Disclosures {
  const values: Record<DisclosureKey, boolean> = { ...EMPTY_DISCLOSURES };
  if (!input || typeof input !== "object") return values;

  for (const key of DISCLOSURE_KEYS) {
    values[key] = input[key] === true;
  }
  return values;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseVerificationRequest(request: VerificationRequest): ParsedInput {
  const query = cleanText(request.query ?? "");
  const explicitName = cleanText(request.companyName ?? "");
  const explicitCin = cleanText(request.cin ?? "");
  const explicitWebsite = cleanText(request.website ?? "");
  const explicitEmail = cleanText(request.email ?? "");

  for (const [value, field] of [
    [query, "Search text"],
    [explicitName, "Lender name"],
    [explicitCin, "CIN"],
    [explicitWebsite, "Website"],
    [explicitEmail, "E-mail"],
  ] as const) {
    if (value.length > 0) {
      assertPrintable(value, field);
      assertLength(value, field);
    }
  }

  if (
    query.length === 0 && explicitName.length === 0 && explicitCin.length === 0 &&
    explicitWebsite.length === 0 && explicitEmail.length === 0
  ) {
    throw new InvalidInputError(
      "Enter the lender's name, or a CIN, e-mail address or website, to run a check.",
    );
  }

  if (explicitEmail.length > 0 && !EMAIL_SHAPE.test(explicitEmail.toLowerCase())) {
    throw new InvalidInputError(`"${explicitEmail}" is not an e-mail address this form can read.`);
  }

  const freeTextKind = query.length > 0 ? classifyFreeText(query) : null;

  const cinSource = explicitCin.length > 0 ? explicitCin : freeTextKind === "cin" ? query : "";
  const cin = cinSource.length > 0 ? normalizeCin(cinSource) : null;

  const emailSource = explicitEmail.length > 0 ? explicitEmail : freeTextKind === "email" ? query : "";
  const email = emailSource.length > 0 ? emailSource.toLowerCase() : null;

  const websiteSource =
    explicitWebsite.length > 0 ? explicitWebsite : freeTextKind === "website" ? query : "";
  const hostnameFromWebsite = websiteSource.length > 0 ? extractHostname(websiteSource) : null;

  if (explicitWebsite.length > 0 && hostnameFromWebsite === null) {
    throw new InvalidInputError(`"${explicitWebsite}" is not a website address this form can read.`);
  }

  // An e-mail address also names a domain worth checking.
  const hostname = hostnameFromWebsite ?? (email ? emailDomain(email) : null);

  const companyName =
    explicitName.length > 0 ? explicitName : freeTextKind === "company_name" ? query : null;

  const kind: InputKind =
    explicitName.length > 0
      ? "company_name"
      : explicitCin.length > 0
        ? "cin"
        : explicitWebsite.length > 0
          ? "website"
          : explicitEmail.length > 0
            ? "email"
            : (freeTextKind ?? "company_name");

  const loanTerms = parseLoanTerms(request.loanTerms);
  const disclosures = parseDisclosures(request.disclosures);
  const anyDisclosure = DISCLOSURE_KEYS.some((key) => disclosures[key]);

  return {
    raw: query.length > 0 ? query : (explicitName || explicitCin || explicitWebsite || explicitEmail),
    kind,
    companyName,
    cin,
    cinLooksMalformed: cin !== null && !isValidCin(cin),
    email,
    hostname,
    websiteUrl: hostnameFromWebsite ? websiteUrlFor(hostnameFromWebsite) : null,
    loanTerms,
    loanTermsProvided: hasAnyLoanTerm(loanTerms),
    disclosures,
    disclosuresProvided: anyDisclosure,
    disclosuresAnswered: request.disclosuresAnswered === true || anyDisclosure,
  };
}

export const INPUT_KIND_LABELS: Record<InputKind, string> = {
  cin: "Corporate Identification Number",
  email: "E-mail address",
  website: "Website",
  company_name: "Lender name",
};

export const DISCLOSURE_QUESTIONS: Readonly<Record<DisclosureKey, string>> = {
  paymentBeforeDisbursement: "Were you asked to pay anything before the loan is released?",
  requestedOtpOrPin: "Were you asked for an OTP, PIN or password?",
  requestedBankCredentials: "Were you asked for net-banking or card details?",
  askedToInstallApkOutsideStore: "Were you asked to install an app from a link rather than an app store?",
  paymentToPersonalAccount: "Were you asked to pay a personal account, UPI ID or wallet?",
  guaranteedApprovalNoChecks: "Were you promised guaranteed approval with no credit check?",
  pressuredToActImmediately: "Were you pressed to decide immediately, or told the offer expires?",
  requestedContactsOrGalleryAccess: "Were you asked for access to your contacts, photos or messages?",
  threatenedOrAbusive: "Have you been threatened, shamed or spoken to abusively?",
  noWrittenAgreement: "Have you been refused a written loan agreement or a sanction letter?",
};
