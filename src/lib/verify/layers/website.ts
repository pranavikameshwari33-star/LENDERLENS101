import "server-only";

/**
 * LAYER 3 — Website / domain identity.
 *
 * The question is NOT "does this website look trustworthy". A professional
 * template costs nothing, and plenty of legitimate Indian NBFCs run plain,
 * dated sites. The question is:
 *
 *     Does this domain actually belong to the institution being claimed?
 *
 * Three sources of evidence answer it, in descending order of strength:
 *
 *   1. THE RBI'S OWN PUBLISHED WEBSITE. For banks — and only for banks — the
 *      RBI publishes the institution's official address, largely on the
 *      regulated `.bank.in` domain. When a domain is claimed for a bank, this
 *      is a lookup with a definite answer, and a wrong answer here is the
 *      strongest impersonation signal the product can produce.
 *
 *   2. THE RBI'S PUBLISHED CONTACT E-MAIL DOMAIN. The NBFC and ARC sheets carry
 *      a contact address per entity. A site on the same domain is corroborated;
 *      a site on a different one is not disproved, because companies routinely
 *      separate marketing and e-mail domains.
 *
 *   3. RESEMBLANCE between the domain label and the company name. Weak, and
 *      treated as weak: `bajaj-finance-loan-apply.xyz` resembles the name too.
 *
 * When none of these can settle it — the common case for an NBFC — the layer
 * returns UNCORROBORATED, not INCONSISTENT. Saying "inconsistent" because the
 * RBI happens not to publish websites for NBFCs would be inventing a finding.
 */

import { domainLabel, domainsRelated, trigramSimilarity } from "../../normalize";
import { loadEntityIndex } from "../../index/store";
import { findByOfficialHostname } from "../../index/search";
import type { IndexedEntity } from "../../index/types";
import { lookupDomainAge } from "../../website/domain-age";
import { checkWebsite } from "../../website/site-check";
import { signal, type Signal } from "../signals";
import { DIGITAL_STATUS_LABELS, type DigitalIdentityStatus, type WebsiteFindings } from "../types";

/** Below this, a domain label and a company name are unrelated. */
const NAME_DOMAIN_MATCH_THRESHOLD = 0.45;
/** Domains younger than this are a caution for an established-sounding lender. */
const RECENT_DOMAIN_DAYS = 365;
const ESTABLISHED_DOMAIN_DAYS = 3 * 365;

/**
 * Top-level domains that are cheap, disposable and heavily over-represented in
 * lending fraud. Presence here is a prompt to look closer, never a verdict:
 * legitimate businesses use them too.
 */
const HIGH_ABUSE_TLDS = new Set([
  "xyz", "top", "click", "link", "buzz", "icu", "cfd", "sbs", "rest", "quest",
  "monster", "loan", "work", "gq", "cf", "tk", "ml", "ga",
]);

export interface WebsiteInput {
  readonly hostname: string | null;
  /** True when the hostname came from an e-mail address rather than a website. */
  readonly derivedFromEmail: boolean;
  readonly matchedEntity: IndexedEntity | null;
  readonly claimedName: string | null;
  readonly skipNetwork: boolean;
}

export async function assessWebsite(input: WebsiteInput): Promise<WebsiteFindings> {
  const signals: Signal[] = [];

  if (!input.hostname || input.derivedFromEmail) {
    return {
      status: "not_provided",
      statusLabel: DIGITAL_STATUS_LABELS.not_provided,
      hostname: null,
      checked: false,
      site: null,
      domainAge: null,
      officialHostnames: input.matchedEntity?.hostnames ?? [],
      domainBelongsTo: null,
      nameSimilarity: null,
      matchesRegisteredEmailDomain: false,
      signals,
    };
  }

  const hostname = input.hostname;
  const entity = input.matchedEntity;
  const officialHostnames = entity?.hostnames ?? [];

  // --- 1. the RBI's own published website ---------------------------------
  const index = loadEntityIndex();
  const ownedBy = findByOfficialHostname(hostname, index);
  const domainBelongsTo = ownedBy[0]?.name ?? null;

  const matchesOfficial = officialHostnames.some((official) => domainsRelated(official, hostname));
  const belongsToSomeoneElse =
    ownedBy.length > 0 && entity !== null && !ownedBy.some((owner) => owner.id === entity.id);

  if (matchesOfficial) {
    signals.push(
      signal({
        id: "domain_is_official",
        category: "website_identity",
        severity: "positive",
        origin: "regulatory_fact",
        title: "This is the website the RBI publishes for this institution",
        explanation:
          "The RBI's Banks-in-India directory lists this exact domain as the institution's own " +
          "website. This is the strongest digital-identity confirmation available in this product.",
        evidence: hostname,
        source: "RBI Banks in India",
      }),
    );
  } else if (belongsToSomeoneElse) {
    signals.push(
      signal({
        id: "domain_belongs_to_other_institution",
        category: "website_identity",
        severity: "critical",
        origin: "regulatory_fact",
        title: "This domain is published by the RBI as a different institution's website",
        explanation:
          `The RBI lists ${domainBelongsTo} at this domain, not the institution you were told about. ` +
          "Either the name you were given is wrong, or the party contacting you is not who they say.",
        evidence: `${hostname} → ${domainBelongsTo}`,
        source: "RBI Banks in India",
      }),
    );
  } else if (officialHostnames.length > 0) {
    signals.push(
      signal({
        id: "domain_is_not_official",
        category: "website_identity",
        severity: "high",
        origin: "regulatory_fact",
        title: "This is not the website the RBI publishes for this institution",
        explanation:
          `The RBI lists ${officialHostnames.join(", ")} as this institution's website. The domain ` +
          "you were given is a different one. Banks do run additional domains, but for a lending " +
          "offer this discrepancy should be resolved before you act on it — reach the institution " +
          "through the RBI-listed address instead.",
        evidence: `given ${hostname}, RBI lists ${officialHostnames.join(", ")}`,
        source: "RBI Banks in India",
      }),
    );
  }

  // --- 2. the RBI's published contact e-mail domain ------------------------
  const registeredDomains = entity?.emailDomains ?? [];
  const matchesRegisteredEmailDomain = registeredDomains.some((domain) =>
    domainsRelated(domain, hostname),
  );

  if (matchesRegisteredEmailDomain) {
    signals.push(
      signal({
        id: "domain_matches_rbi_email",
        category: "website_identity",
        severity: "positive",
        origin: "regulatory_fact",
        title: "The domain matches the contact e-mail the RBI holds for this entity",
        explanation:
          "The RBI's record for this entity gives a contact e-mail address on this same domain. For " +
          "an NBFC this is the only link in the published data that ties a domain to a registered " +
          "entity, so it carries real weight.",
        evidence: `${hostname} — RBI contact: ${registeredDomains.join(", ")}`,
        source: "RBI list of registered NBFCs / ARCs",
      }),
    );
  } else if (registeredDomains.length > 0) {
    signals.push(
      signal({
        id: "domain_differs_from_rbi_email",
        category: "website_identity",
        severity: "medium",
        origin: "heuristic",
        title: "The domain differs from the contact e-mail the RBI holds",
        explanation:
          `The RBI record for this entity gives a contact address on ${registeredDomains.join(", ")}. ` +
          "Companies legitimately run separate domains for e-mail and marketing, so this is a " +
          "question to ask rather than a conclusion — but if this domain is where you were asked to " +
          "apply, ask it.",
        evidence: `${hostname} vs ${registeredDomains.join(", ")}`,
        source: "RBI list of registered NBFCs / ARCs",
      }),
    );
  }

  // --- 3. resemblance ------------------------------------------------------
  const label = domainLabel(hostname);
  const comparisonName = entity?.nameCore ?? input.claimedName ?? null;
  const nameSimilarity =
    label && comparisonName
      ? trigramSimilarity(label, comparisonName.replace(/\s+/g, "").toUpperCase().toLowerCase())
      : null;

  if (nameSimilarity !== null && nameSimilarity < NAME_DOMAIN_MATCH_THRESHOLD && !matchesOfficial) {
    signals.push(
      signal({
        id: "domain_name_unrelated",
        category: "website_identity",
        severity: "medium",
        origin: "heuristic",
        title: "The domain bears little resemblance to the company name",
        explanation:
          "The part of the domain before the suffix does not look like it was built from the " +
          "institution's name. That is common for group brands and campaign sites, and it is also " +
          "what an unrelated site looks like.",
        evidence: `${hostname} vs ${entity?.name ?? input.claimedName}`,
        source: "Name / domain comparison",
      }),
    );
  }

  // --- suspicious domain characteristics -----------------------------------
  const tld = hostname.split(".").pop() ?? "";
  if (HIGH_ABUSE_TLDS.has(tld)) {
    signals.push(
      signal({
        id: "high_abuse_tld",
        category: "website_identity",
        severity: "medium",
        origin: "heuristic",
        title: `The domain uses a .${tld} address`,
        explanation:
          "This top-level domain is inexpensive, registered in bulk and disproportionately common in " +
          "lending fraud. Regulated Indian lenders overwhelmingly use .in, .co.in, .com or the " +
          "RBI-administered .bank.in. This is a reason to look closer, not a finding on its own.",
        evidence: hostname,
        source: "Domain characteristics",
      }),
    );
  }

  if (/(?:^|[.-])(?:loan|apply|instant|quick|fast|approval)[.-]/.test(`.${hostname}`)) {
    signals.push(
      signal({
        id: "urgency_domain_wording",
        category: "website_identity",
        severity: "low",
        origin: "heuristic",
        title: "The domain is built around urgency wording",
        explanation:
          "Words like \"instant\", \"quick\" and \"approval\" in a domain are marketing language rather " +
          "than institutional identity. Registered lenders normally use their own name.",
        evidence: hostname,
        source: "Domain characteristics",
      }),
    );
  }

  // --- live checks ---------------------------------------------------------
  if (input.skipNetwork) {
    return finalise(
      hostname, null, null, officialHostnames, registeredDomains, domainBelongsTo, nameSimilarity,
      matchesRegisteredEmailDomain, matchesOfficial, belongsToSomeoneElse, signals, false,
    );
  }

  const [site, domainAge] = await Promise.all([checkWebsite(hostname), lookupDomainAge(hostname)]);

  if (!site.reachable) {
    signals.push(
      signal({
        id: "site_unreachable",
        category: "website_identity",
        severity: "info",
        origin: "heuristic",
        title: "The website could not be reached",
        explanation:
          `${site.error ?? "The site did not respond."} A site can be unreachable for ordinary reasons ` +
          "— maintenance, geography, bot protection — so little weight is placed on this.",
        evidence: hostname,
        source: "Live site check",
      }),
    );
  } else {
    if (!site.httpsWorks) {
      signals.push(
        signal({
          id: "no_https",
          category: "website_identity",
          severity: "high",
          origin: "heuristic",
          title: "The site does not serve HTTPS",
          explanation:
            "The site answered over plain HTTP but not over HTTPS. Anything typed into it — documents, " +
            "identity numbers, bank details — travels unencrypted. No regulated financial institution " +
            "in India runs a public site this way.",
          evidence: hostname,
          source: "Live site check",
        }),
      );
    }

    if (site.redirectedElsewhere && site.finalUrl) {
      signals.push(
        signal({
          id: "site_redirects",
          category: "website_identity",
          severity: "medium",
          origin: "heuristic",
          title: "The address redirects to a different domain",
          explanation:
            "Visiting this address sends the browser somewhere else. That is normal for a rebranded " +
            "business and normal for a parked or resold domain alike, so it is a prompt to look at " +
            "where you actually end up.",
          evidence: site.finalUrl,
          source: "Live site check",
        }),
      );
    }

    // The site's own contact addresses are a second, independent handle on
    // whose site this is.
    const siteDomainsMatchRbi = site.emailDomains.some((domain) =>
      registeredDomains.some((registered) => domainsRelated(registered, domain)),
    );
    if (siteDomainsMatchRbi) {
      signals.push(
        signal({
          id: "site_contact_matches_rbi",
          category: "website_identity",
          severity: "positive",
          origin: "regulatory_fact",
          title: "A contact address on the site matches the RBI record",
          explanation:
            "An e-mail address published on this site is on the same domain the RBI holds for the " +
            "matched entity. Two independent sources agreeing is meaningfully stronger than either alone.",
          evidence: site.emailDomains.join(", "),
          source: "Live site check + RBI registered lists",
        }),
      );
    }
  }

  const age = domainAge.available ? domainAge : null;
  if (age?.ageInDays !== null && age?.ageInDays !== undefined) {
    if (age.ageInDays < RECENT_DOMAIN_DAYS) {
      signals.push(
        signal({
          id: "domain_recent",
          category: "website_identity",
          severity: "high",
          origin: "heuristic",
          title: "The domain was registered recently",
          explanation:
            `This domain was first registered on ${age.createdAt}, about ${Math.max(1, Math.floor(age.ageInDays / 30))} ` +
            "months ago. A new domain is not suspicious in itself, but an established financial " +
            "institution normally has an established domain, and disposable domains are the standard " +
            "tooling of lending fraud.",
          evidence: age.createdAt,
          source: `Domain registration (${age.provider ?? "provider"})`,
        }),
      );
    } else if (age.ageInDays > ESTABLISHED_DOMAIN_DAYS) {
      signals.push(
        signal({
          id: "domain_established",
          category: "website_identity",
          severity: "positive",
          origin: "heuristic",
          title: "The domain has been registered for years",
          explanation:
            `This domain was first registered on ${age.createdAt}, roughly ${Math.floor(age.ageInDays / 365)} ` +
            "years ago. Longevity is consistent with an established business, though it does not " +
            "establish who runs it today.",
          evidence: age.createdAt,
          source: `Domain registration (${age.provider ?? "provider"})`,
        }),
      );
    }
  }

  return finalise(
    hostname, site, domainAge, officialHostnames, registeredDomains, domainBelongsTo, nameSimilarity,
    matchesRegisteredEmailDomain, matchesOfficial, belongsToSomeoneElse, signals, true,
  );
}

function finalise(
  hostname: string,
  site: WebsiteFindings["site"],
  domainAge: WebsiteFindings["domainAge"],
  officialHostnames: readonly string[],
  registeredEmailDomains: readonly string[],
  domainBelongsTo: string | null,
  nameSimilarity: number | null,
  matchesRegisteredEmailDomain: boolean,
  matchesOfficial: boolean,
  belongsToSomeoneElse: boolean,
  signals: Signal[],
  checked: boolean,
): WebsiteFindings {
  const status = resolveStatus({
    matchesOfficial,
    belongsToSomeoneElse,
    officialKnown: officialHostnames.length > 0,
    referenceDomainKnown: registeredEmailDomains.length > 0,
    matchesRegisteredEmailDomain,
    resemblesName: nameSimilarity !== null && nameSimilarity >= NAME_DOMAIN_MATCH_THRESHOLD,
    signals,
  });

  return {
    status,
    statusLabel: DIGITAL_STATUS_LABELS[status],
    hostname,
    checked,
    site,
    domainAge,
    officialHostnames,
    domainBelongsTo,
    nameSimilarity,
    matchesRegisteredEmailDomain,
    signals,
  };
}

/**
 * CONSISTENT requires positive corroboration, not merely the absence of a
 * problem. UNCORROBORATED is the honest answer when the RBI publishes nothing
 * that could confirm or deny the claim, which is the usual case for an NBFC.
 */
function resolveStatus(context: {
  matchesOfficial: boolean;
  belongsToSomeoneElse: boolean;
  officialKnown: boolean;
  referenceDomainKnown: boolean;
  matchesRegisteredEmailDomain: boolean;
  resemblesName: boolean;
  signals: readonly Signal[];
}): DigitalIdentityStatus {
  if (context.belongsToSomeoneElse) return "inconsistent";
  if (context.matchesOfficial || context.matchesRegisteredEmailDomain) return "consistent";

  // The RBI publishes a website for this institution, and this is not it.
  if (context.officialKnown) return "inconsistent";

  // The RBI publishes a contact domain, and the domain supplied is neither that
  // nor anything built from the company's name. A group running a separate
  // marketing domain would at least resemble the name; this resembles nothing.
  if (context.referenceDomainKnown && !context.resemblesName) return "inconsistent";

  const hasSeriousConcern = context.signals.some(
    (item) => item.severity === "critical" || item.severity === "high",
  );
  return hasSeriousConcern ? "inconsistent" : "uncorroborated";
}
