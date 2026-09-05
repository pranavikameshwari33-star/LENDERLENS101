/**
 * LAYER 4 — E-mail identity.
 *
 * Purely defensive analysis of an address the user was contacted from. Nothing
 * is sent, nothing is authenticated, no mailbox is touched. The address is
 * compared against three things:
 *
 *   - the contact e-mail domain the RBI publishes for the matched entity
 *   - the website domain the user was given
 *   - the population of free consumer mail providers
 *
 * The free-mail check is the one that does real work. A registered NBFC's
 * lending correspondence does not arrive from a gmail.com address, and this is
 * the cheapest inconsistency for a user to verify on their own.
 */

import { domainsRelated, emailDomain } from "../../normalize";
import type { IndexedEntity } from "../../index/types";
import { signal, type Signal } from "../signals";
import { DIGITAL_STATUS_LABELS, type DigitalIdentityStatus, type EmailFindings } from "../types";

/**
 * Consumer mail providers. A lender using one is not committing a crime — a
 * genuine sole-proprietor moneylender might — but a party claiming to be a
 * registered NBFC or a bank and writing from one is contradicting itself.
 */
const FREE_MAIL_PROVIDERS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.in",
  "outlook.com", "hotmail.com", "live.com", "msn.com",
  "rediffmail.com", "rediff.com", "aol.com", "icloud.com", "me.com",
  "protonmail.com", "proton.me", "zoho.com", "zohomail.com",
  "mail.com", "gmx.com", "yandex.com", "inbox.com", "ymail.com",
]);

/** Providers whose whole purpose is to be untraceable. */
const DISPOSABLE_MAIL_PROVIDERS = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
  "temp-mail.org", "throwawaymail.com", "yopmail.com", "getnada.com",
  "trashmail.com", "sharklasers.com", "maildrop.cc", "dispostable.com",
]);

export interface EmailInput {
  readonly address: string | null;
  readonly websiteHostname: string | null;
  readonly matchedEntity: IndexedEntity | null;
  /** True when the lender claims to be a bank or a registered NBFC / ARC. */
  readonly claimsRegulatedStatus: boolean;
}

export function assessEmail(input: EmailInput): EmailFindings {
  const signals: Signal[] = [];

  if (!input.address) {
    return {
      status: "not_provided",
      statusLabel: DIGITAL_STATUS_LABELS.not_provided,
      address: null,
      domain: null,
      isFreeMailProvider: false,
      registeredDomains: input.matchedEntity?.emailDomains ?? [],
      matchesRegisteredDomain: false,
      matchesWebsiteDomain: null,
      signals,
    };
  }

  const domain = emailDomain(input.address);
  const registeredDomains = input.matchedEntity?.emailDomains ?? [];
  const officialHostnames = input.matchedEntity?.hostnames ?? [];

  const isFree = domain !== null && FREE_MAIL_PROVIDERS.has(domain);
  const isDisposable = domain !== null && DISPOSABLE_MAIL_PROVIDERS.has(domain);

  const matchesRegisteredDomain =
    domain !== null &&
    (registeredDomains.some((known) => domainsRelated(known, domain)) ||
      officialHostnames.some((known) => domainsRelated(known, domain)));

  const matchesWebsiteDomain =
    domain !== null && input.websiteHostname !== null
      ? domainsRelated(domain, input.websiteHostname)
      : null;

  if (isDisposable) {
    signals.push(
      signal({
        id: "email_disposable_provider",
        category: "email_identity",
        severity: "critical",
        origin: "heuristic",
        title: "The address is on a disposable e-mail service",
        explanation:
          "This domain belongs to a throwaway mail service whose purpose is to be untraceable. No " +
          "lawful lending business corresponds with borrowers from one.",
        evidence: domain,
        source: "Known disposable-provider list",
      }),
    );
  } else if (isFree) {
    signals.push(
      signal({
        id: "email_free_provider",
        category: "email_identity",
        severity: input.claimsRegulatedStatus ? "high" : "medium",
        origin: "heuristic",
        title: "The address is on a free consumer mail provider",
        explanation: input.claimsRegulatedStatus
          ? "A party presenting itself as an RBI-regulated institution is writing from a free consumer " +
            "mailbox rather than its own domain. Regulated lenders correspond from their own domain; " +
            "anyone can open an account on this one in a minute."
          : "This address is on a free consumer mail provider. Anyone can open one, so it carries no " +
            "evidence at all about who is behind it.",
        evidence: domain,
        source: "Known free-provider list",
      }),
    );
  }

  if (matchesRegisteredDomain) {
    signals.push(
      signal({
        id: "email_matches_rbi_record",
        category: "email_identity",
        severity: "positive",
        origin: "regulatory_fact",
        title: "The e-mail domain matches the RBI record",
        explanation:
          "The address is on the same domain the RBI publishes for this institution. This is the " +
          "clearest corroboration available for an e-mail claim.",
        evidence: `${domain} — RBI holds ${[...registeredDomains, ...officialHostnames].join(", ")}`,
        source: "RBI reference data",
      }),
    );
  } else if (registeredDomains.length > 0 && domain && !isFree && !isDisposable) {
    signals.push(
      signal({
        id: "email_differs_from_rbi_record",
        category: "email_identity",
        severity: "high",
        origin: "regulatory_fact",
        title: "The e-mail domain differs from the one the RBI holds",
        explanation:
          `The RBI record for this entity gives a contact address on ${registeredDomains.join(", ")}, ` +
          `but you were contacted from ${domain}. Large groups do run several domains — but this is ` +
          "exactly the shape of an impersonation, so verify through the RBI-listed address before " +
          "sending anything.",
        evidence: `${domain} vs ${registeredDomains.join(", ")}`,
        source: "RBI reference data",
      }),
    );
  }

  if (matchesWebsiteDomain === false && domain && !isFree && !isDisposable) {
    signals.push(
      signal({
        id: "email_website_mismatch",
        category: "email_identity",
        severity: "medium",
        origin: "heuristic",
        title: "The e-mail domain and the website domain are different",
        explanation:
          `You were pointed at ${input.websiteHostname} but written to from ${domain}. The two do not ` +
          "belong to the same domain. That happens legitimately, and it is also how a lookalike site " +
          "and a lookalike mailbox end up not quite matching.",
        evidence: `${domain} vs ${input.websiteHostname}`,
        source: "E-mail / website comparison",
      }),
    );
  } else if (matchesWebsiteDomain === true) {
    signals.push(
      signal({
        id: "email_website_consistent",
        category: "email_identity",
        severity: "positive",
        origin: "heuristic",
        title: "The e-mail and the website are on the same domain",
        explanation:
          "The address you were contacted from is on the same domain as the website you were sent to. " +
          "That is internally consistent — though it says nothing about whether either belongs to the " +
          "institution being claimed.",
        evidence: domain,
        source: "E-mail / website comparison",
      }),
    );
  }

  const status = resolveStatus({
    matchesRegisteredDomain,
    knownDomains: registeredDomains.length > 0 || officialHostnames.length > 0,
    isFree,
    isDisposable,
    signals,
  });

  return {
    status,
    statusLabel: DIGITAL_STATUS_LABELS[status],
    address: input.address,
    domain,
    isFreeMailProvider: isFree || isDisposable,
    registeredDomains,
    matchesRegisteredDomain,
    matchesWebsiteDomain,
    signals,
  };
}

function resolveStatus(context: {
  matchesRegisteredDomain: boolean;
  knownDomains: boolean;
  isFree: boolean;
  isDisposable: boolean;
  signals: readonly Signal[];
}): DigitalIdentityStatus {
  if (context.matchesRegisteredDomain) return "consistent";
  if (context.isDisposable) return "inconsistent";
  if (context.knownDomains) return "inconsistent";
  if (context.isFree) return "inconsistent";
  return "uncorroborated";
}
