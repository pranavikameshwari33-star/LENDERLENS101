import "server-only";

/**
 * Domain age lookup, behind a provider interface.
 *
 * Domain registration dates are not free data, so this signal is optional. The
 * whole feature is gated on an environment variable: with no key configured,
 * every lookup returns `available: false` and the scoring engine simply leaves
 * the signal out. It never breaks a verification, and it never blocks one for
 * long — the request is capped at a few seconds.
 *
 * Configure with:
 *   WHOIS_API_PROVIDER=whoisxmlapi
 *   WHOIS_API_KEY=<your key>
 */

export type { DomainAgeProvider, DomainAgeResult } from "./types";

import type { DomainAgeProvider, DomainAgeResult } from "./types";

const LOOKUP_TIMEOUT_MS = 5_000;

function unavailable(hostname: string, reason: string, provider: string | null): DomainAgeResult {
  return {
    hostname,
    available: false,
    createdAt: null,
    ageInDays: null,
    unavailableReason: reason,
    provider,
  };
}

/**
 * WhoisXMLAPI's WHOIS endpoint. Chosen because it exposes a plain JSON
 * `createdDate` and needs no account-specific host.
 */
function whoisXmlApiProvider(apiKey: string): DomainAgeProvider {
  return {
    name: "whoisxmlapi",
    async lookup(hostname: string): Promise<DomainAgeResult> {
      const url = new URL("https://www.whoisxmlapi.com/whoisserver/WhoisService");
      url.searchParams.set("apiKey", apiKey);
      url.searchParams.set("domainName", hostname);
      url.searchParams.set("outputFormat", "JSON");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

      try {
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) {
          return unavailable(
            hostname,
            `The domain-age provider returned HTTP ${response.status}.`,
            "whoisxmlapi",
          );
        }

        const createdAt = extractCreatedDate(await response.json());
        if (!createdAt) {
          return unavailable(
            hostname,
            "The provider did not report a registration date for this domain.",
            "whoisxmlapi",
          );
        }

        const created = new Date(createdAt);
        const ageInDays = Math.floor((Date.now() - created.getTime()) / 86_400_000);

        return {
          hostname,
          available: true,
          createdAt: created.toISOString().slice(0, 10),
          ageInDays,
          unavailableReason: null,
          provider: "whoisxmlapi",
        };
      } catch (error) {
        const reason =
          error instanceof Error && error.name === "AbortError"
            ? "The domain-age lookup timed out."
            : "The domain-age lookup could not be completed.";
        return unavailable(hostname, reason, "whoisxmlapi");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Walk the provider's JSON without trusting its shape. */
function extractCreatedDate(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;

  const record = root.WhoisRecord;
  if (typeof record !== "object" || record === null) return null;
  const whois = record as Record<string, unknown>;

  const direct = whois.createdDate ?? whois.createdDateNormalized;
  if (typeof direct === "string" && !Number.isNaN(Date.parse(direct))) return direct;

  const registry = whois.registryData;
  if (typeof registry === "object" && registry !== null) {
    const nested = (registry as Record<string, unknown>).createdDate;
    if (typeof nested === "string" && !Number.isNaN(Date.parse(nested))) return nested;
  }

  return null;
}

/** The configured provider, or null when the feature is switched off. */
export function getDomainAgeProvider(): DomainAgeProvider | null {
  const apiKey = process.env.WHOIS_API_KEY?.trim();
  if (!apiKey) return null;

  const provider = (process.env.WHOIS_API_PROVIDER ?? "whoisxmlapi").trim().toLowerCase();
  if (provider === "whoisxmlapi") return whoisXmlApiProvider(apiKey);

  return null;
}

export async function lookupDomainAge(hostname: string): Promise<DomainAgeResult> {
  const provider = getDomainAgeProvider();
  if (!provider) {
    // Worded for the person reading the result, not the person deploying the
    // app: this string is shown to users as a limit of the check that ran.
    // Whether the lookup is configured at all is reported by /api/health.
    return unavailable(
      hostname,
      "We could not find out when this website's address was first registered, so how long it has existed is unknown.",
      null,
    );
  }
  return provider.lookup(hostname);
}
