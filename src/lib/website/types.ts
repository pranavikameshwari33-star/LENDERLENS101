/**
 * Result shapes for the website checks.
 *
 * Kept apart from the modules that produce them, which are `server-only`.
 * The report components need these types to render a result, and a type-only
 * import is erased at compile time — but sharing a module with the fetching
 * code would still drag `node:dns` into the client graph. Splitting them keeps
 * the boundary obvious rather than accidental.
 */

export interface SiteCheckResult {
  readonly hostname: string;
  /** False when the site could not be reached at all. */
  readonly reachable: boolean;
  /** True when https:// served the page successfully. */
  readonly httpsWorks: boolean;
  /** True when the connection was redirected to a different registrable host. */
  readonly redirectedElsewhere: boolean;
  readonly finalUrl: string | null;
  readonly statusCode: number | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly siteName: string | null;
  /** Addresses found in mailto: links and page text, de-duplicated. */
  readonly emails: readonly string[];
  readonly emailDomains: readonly string[];
  /** Present when the check could not be completed; safe to show a user. */
  readonly error: string | null;
}

export interface DomainAgeResult {
  readonly hostname: string;
  /** False when no provider is configured or the lookup failed. */
  readonly available: boolean;
  /** ISO date the domain was first registered. */
  readonly createdAt: string | null;
  readonly ageInDays: number | null;
  /** Why the signal is unavailable, for display. Null when it worked. */
  readonly unavailableReason: string | null;
  readonly provider: string | null;
}

export interface DomainAgeProvider {
  readonly name: string;
  lookup(hostname: string): Promise<DomainAgeResult>;
}
