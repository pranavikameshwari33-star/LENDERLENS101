/**
 * When does the deterministic system hand over?
 *
 * The rule this file encodes is the whole architecture in one function: the
 * RBI lookup runs first and always, and the AI is asked only about the domains
 * the lookup could not settle. Two things follow, and both matter more than
 * they look:
 *
 *   - A known lender never reaches Gemini. The green and red paths are
 *     deterministic, reproducible and free, and they stay that way.
 *   - An investigation is never allowed to reopen a settled fact. A cancelled
 *     Certificate of Registration and a critical behavioural signal are
 *     conclusions from published data and from what the user themselves
 *     reported; there is nothing for a language model to add to either.
 *
 * Pure, and free of server-only imports, so the client can ask the same
 * question the server does and skip a pointless round trip.
 */

import { isMailProviderDomain } from "../normalize";
import type { VerificationResult } from "../verify/types";


/**
 * Where does this lender live, according to the RBI's own record?
 *
 * A published website first, since that is unambiguous. Failing that, the
 * domain of the contact address the RBI holds: `grievance@examplefinance.in`
 * says where Example Finance is on the web about as reliably as anything can.
 */
function publishedWebsiteFor(result: VerificationResult): string | null {
  const entity = result.regulatory.primary?.entity;
  if (!entity) return null;

  const published = entity.hostnames?.[0];
  if (published) return published;

  const contact = (entity.emailDomains ?? []).find((domain) => !isMailProviderDomain(domain));
  return contact ?? null;
}

export interface InvestigationTrigger {
  readonly investigate: boolean;
  /** Why, in one line. Shown while the investigation runs. */
  readonly reason: string;
  /**
   * The domain to investigate.
   *
   * Usually the one the user typed. For a company-name search it may instead
   * be a website the RBI itself publishes for the matched record — the
   * dataset's own answer to "where does this lender live", which costs nothing
   * to look up and needs no model to discover.
   */
  readonly hostname: string | null;
  /** True when the hostname came from the RBI record rather than the user. */
  readonly discovered: boolean;
}

export function investigationTrigger(result: VerificationResult): InvestigationTrigger {
  const no = (reason: string): InvestigationTrigger => ({
    investigate: false,
    reason,
    hostname: result.website.hostname,
    discovered: false,
  });

  // A published regulatory fact. Settled, and not the AI's business — whether
  // the user searched by name or by website.
  if (result.regulatory.status === "cancelled" || result.regulatory.status === "conflicting") {
    return no("The RBI's own lists already answer this.");
  }

  const hostname = result.website.hostname;

  if (!hostname) {
    // A COMPANY-NAME search with no website. The RBI record may publish one,
    // and if it does that is the site to check: it is where the lender lives
    // according to the regulator, so a live check of it is worth running.
    // Discovery, deterministic and free — no model is asked where a company's
    // website is.
    const published = publishedWebsiteFor(result);
    if (published) {
      return {
        investigate: true,
        reason: `The RBI publishes ${published} for this lender, so that website is being checked.`,
        hostname: published,
        discovered: true,
      };
    }
    return no("No website address was supplied, and the RBI records publish none for this lender.");
  }

  // The user reported something conclusive on its own — an OTP request, an
  // advance fee, a sideloaded app. No amount of company research changes that.
  if (result.signals.some((signal) => signal.severity === "critical")) {
    return no("What you were asked for is conclusive on its own.");
  }

  // The domain is already tied to a specific RBI record. Nothing to discover.
  const tiedToRecord =
    result.regulatory.primary !== null &&
    (result.website.status === "consistent" || result.website.status === "inconsistent");
  if (tiedToRecord) {
    return no("The RBI's records already tie this website to a lender.");
  }

  if (result.verdict === "gray" || result.regulatory.primary === null) {
    return {
      investigate: true,
      reason: "This website is not in the RBI data LenderLens holds, so it is being investigated.",
      hostname,
      discovered: false,
    };
  }

  return no("The deterministic checks resolved this website.");
}

export function shouldInvestigate(result: VerificationResult): boolean {
  return investigationTrigger(result).investigate;
}
