/**
 * Text normalisation shared by the RBI importer and the verification APIs.
 *
 * This module has NO dependencies on Next.js, Supabase or the filesystem so
 * that the import script and the request path apply byte-identical rules. If
 * these two ever diverged, exact-match lookups would silently start missing.
 */

/** Unicode space characters that appear throughout the RBI workbooks. */
const UNICODE_SPACES = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g;

/**
 * Legal-form suffixes stripped from the tail of a company name to build its
 * "core" name. Longest forms first so that "PRIVATE LIMITED" is consumed
 * before "LIMITED" can nibble at it.
 */
const LEGAL_SUFFIXES: readonly string[] = [
  "LIMITED LIABILITY PARTNERSHIP",
  "PRIVATE LIMITED",
  "PRIVATE LTD",
  "PVT LIMITED",
  "PVT LTD",
  "AND COMPANY",
  "AND CO",
  "INCORPORATED",
  "CORPORATION",
  "COMPANY",
  "LIMITED",
  "PUBLIC",
  "PRIVATE",
  "CORP",
  "LLP",
  "PLC",
  "PVT",
  "LTD",
  "INC",
  "CO",
];

/** A CIN is 21 characters: L/U + 5 industry digits + 2 state + 4 year + 3 ownership + 6 registration. */
const CIN_PATTERN = /^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/;

const EMAIL_PATTERN = /^[^\s@,;<>()[\]]+@[^\s@,;<>()[\]]+\.[A-Za-z]{2,}$/;

/**
 * Collapse whitespace and strip the stray newlines / non-breaking spaces the
 * RBI workbooks are full of. Every cancelled-company name, for example, begins
 * with a literal "\n".
 */
export function cleanText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  return text.replace(UNICODE_SPACES, " ").replace(/\s+/g, " ").trim();
}

/** `cleanText`, but an empty result becomes `null` so it lands as SQL NULL. */
export function cleanTextOrNull(value: unknown): string | null {
  const cleaned = cleanText(value);
  return cleaned.length > 0 ? cleaned : null;
}

/** Strip diacritics so "Sanchez" and "Sánchez" normalise alike. */
function stripDiacritics(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Canonical form used for exact matching and trigram similarity:
 * upper case, ampersands spelled out, punctuation reduced to spaces.
 */
export function normalizeName(value: unknown): string {
  return stripDiacritics(cleanText(value))
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The normalised name with trailing legal-form words removed, so that a user
 * typing "Bajaj Finance" still matches "Bajaj Finance Limited".
 *
 * Stripping is repeated because names stack suffixes ("... Pvt Ltd"). If every
 * word turns out to be a suffix the full normalised name is returned instead,
 * rather than an empty string that would match everything.
 */
export function nameCore(value: unknown): string {
  let core = normalizeName(value);
  if (core.length === 0) return "";

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (core === suffix) break;
      if (core.endsWith(` ${suffix}`)) {
        core = core.slice(0, -(suffix.length + 1)).trim();
        changed = true;
        break;
      }
    }
    // "A C Choksi & Co Pvt Ltd" reduces to "A C CHOKSI AND"; drop the dangling
    // conjunction the stripped suffix left behind.
    if (core.endsWith(" AND")) {
      core = core.slice(0, -4).trim();
      changed = true;
    }
  }

  return core.length > 0 ? core : normalizeName(value);
}

/** Whether a name already ends in a legal-form word such as "Limited" or "LLP". */
function endsWithLegalSuffix(value: string): boolean {
  const normalized = normalizeName(value);
  return LEGAL_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(` ${suffix}`),
  );
}

export interface ParsedCompanyName {
  /** The raw cell contents, whitespace-cleaned. */
  readonly raw: string;
  /** The name with parenthetical aliases removed. */
  readonly displayName: string;
  /** Former / MCA names lifted out of the parentheses. */
  readonly alternateNames: readonly string[];
}

/**
 * The RBI embeds aliases inside the name cell, in two shapes:
 *   "121 Finance Private Limited (Formerly: Yerrow Finance ... Private Limited)"
 *   "A C Steels & Holdings Private Limited (Name as per MCA - A.C. Fincom Private Limited)"
 *
 * Both are pulled out so a search for the old name still finds the company.
 * Parentheses that are part of the name itself ("(India)") are left alone.
 */
export function parseCompanyName(value: unknown): ParsedCompanyName {
  const raw = cleanText(value);
  const alternates: string[] = [];
  let displayName = raw;

  const aliasPattern = /\(\s*(?:formerly\s*(?:known\s+as)?|name\s+as\s+per\s+mca)\s*[:\-–]?\s*([^)]+)\)/gi;

  displayName = raw
    .replace(aliasPattern, (_match, captured: string) => {
      alternates.push(...splitAliasList(captured));
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();

  if (displayName.length === 0) displayName = raw;

  const seen = new Set<string>();
  const uniqueAlternates = alternates.filter((alternate) => {
    const key = normalizeName(alternate);
    if (key.length === 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { raw, displayName, alternateNames: uniqueAlternates };
}

/**
 * One parenthetical can hold several former names joined by "and":
 *   "IIFL Wealth Prime Limited and IIFL Wealth Finance Limited"  -> two names
 *   "Yerrow Finance and Investments Private Limited"             -> one name
 *
 * The two are told apart by whether the text before "and" already ends in a
 * legal-form word. Splitting on every "and" would shred the second example.
 */
function splitAliasList(captured: string): string[] {
  const names: string[] = [];
  let buffer = "";

  for (const segment of captured.split(/\s+and\s+/i)) {
    buffer = buffer.length > 0 ? `${buffer} and ${segment}` : segment;
    if (endsWithLegalSuffix(buffer)) {
      const candidate = cleanText(buffer);
      if (candidate.length > 0) names.push(candidate);
      buffer = "";
    }
  }

  const remainder = cleanText(buffer);
  if (remainder.length > 0) names.push(remainder);

  return names;
}

/** Upper-case a CIN and drop every separator the spreadsheet may contain. */
export function normalizeCin(value: unknown): string | null {
  const compact = cleanText(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.length > 0 ? compact : null;
}

/**
 * Whether a normalised CIN matches the 21-character MCA format. The registered
 * NBFC sheet contains exactly one value that does not
 * ("U64910RJ2023PT0086204" — "PT0" where "PTC" is expected). Such rows are
 * still imported; they are flagged, never dropped.
 */
export function isValidCin(normalizedCin: string | null): boolean {
  return normalizedCin !== null && CIN_PATTERN.test(normalizedCin);
}

/**
 * Split an e-mail cell into individual addresses. 477 registered-NBFC rows put
 * several addresses in one cell, separated by semicolons, commas or newlines.
 */
export function parseEmails(value: unknown): string[] {
  let cleaned = cleanText(value);
  if (cleaned.length === 0) return [];

  // Repair the three transcription artefacts that actually occur in the sheet:
  //   "grievancehead@adityabirlacapital. com"  -> a space beside the dot
  //   "onkarharkin[at]gmail[dot]com"          -> obfuscated address
  //   "'someone@example.com'"                 -> quoted address
  // Anything beyond these (an address ending in digits, a comma where a dot
  // belongs) is left alone and simply reported as missing, rather than guessed.
  cleaned = cleaned
    .replace(/\s*\.\s*/g, ".")
    .replace(/\[\s*at\s*\]|\(\s*at\s*\)/gi, "@")
    .replace(/\[\s*dot\s*\]|\(\s*dot\s*\)/gi, ".");

  const seen = new Set<string>();
  for (const candidate of cleaned.split(/[;,\s]+/)) {
    const email = candidate
      .trim()
      .toLowerCase()
      .replace(/^["'<(]+/, "")
      .replace(/["'>).,;]+$/, "");
    if (EMAIL_PATTERN.test(email)) seen.add(email);
  }
  return [...seen];
}

/** The domain part of an e-mail address, lower-cased. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

/**
 * Domains that are somebody's mailbox, never somebody's website.
 *
 * The RBI publishes a contact address for most records and a website for very
 * few, so the address's domain is usually the best pointer the regulator gives
 * to where a lender actually lives — `grievance@examplefinance.in` says where
 * Example Finance is on the web about as reliably as anything can. It says that
 * only when the domain belongs to the company. A small NBFC that filed a Gmail
 * address would otherwise make `gmail.com` resolve to a registered lender, and
 * every other lookup keyed on a contact domain would inherit the mistake.
 *
 * Not a special case for any company: a list of things that are definitionally
 * not a lender's own domain.
 */
export const MAIL_PROVIDERS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.in",
  "yahoo.in",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "rediffmail.com",
  "rediff.com",
  "aol.com",
  "icloud.com",
  "protonmail.com",
  "proton.me",
  "zoho.com",
];

/** True when a domain is a public mailbox provider rather than a company's own. */
export function isMailProviderDomain(value: string | null | undefined): boolean {
  if (!value) return false;
  const host = normalizeHostname(value);
  return host !== null && MAIL_PROVIDERS.includes(host);
}

/** Distinct domains across a set of addresses, order preserved. */
export function emailDomains(emails: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const email of emails) {
    const domain = emailDomain(email);
    if (domain) seen.add(domain);
  }
  return [...seen];
}

/**
 * Reduce a hostname to its registrable form for comparison purposes: lower
 * case, no trailing dot, no leading "www.".
 *
 * This deliberately does not consult the public suffix list. Comparisons in
 * this app use `domainsRelated` below, which tolerates the sub-domain
 * differences a PSL would otherwise be needed for.
 */
export function normalizeHostname(value: unknown): string | null {
  let host = cleanText(value).toLowerCase();
  if (host.length === 0) return null;

  host = host.replace(/\.+$/, "").replace(/^www\./, "");
  if (host.length === 0 || !host.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;

  return host;
}

/** True when two hostnames are equal or one is a sub-domain of the other. */
export function domainsRelated(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * The label immediately left of the public suffix, e.g. "bajajfinserv" for
 * "www.bajajfinserv.in" — used to compare a domain against a company name.
 * Multi-part suffixes common in India (.co.in, .org.in, ...) are handled.
 */
export function domainLabel(hostname: string | null): string | null {
  if (!hostname) return null;
  const parts = hostname.split(".").filter((part) => part.length > 0);
  if (parts.length < 2) return null;

  const twoPartSuffixes = new Set([
    "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in", "co.uk",
    "org.uk", "com.au", "co.jp", "com.sg", "co.za", "com.br",
  ]);

  const lastTwo = parts.slice(-2).join(".");
  const index = twoPartSuffixes.has(lastTwo) ? parts.length - 3 : parts.length - 2;
  return index >= 0 ? parts[index] : null;
}

/**
 * Jaccard similarity over character trigrams — the same idea PostgreSQL's
 * pg_trgm uses, reimplemented here so the scoring engine can compare strings
 * (a domain label against a company name, say) without a database round trip.
 * Returns a value in [0, 1].
 */
export function trigramSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 && right.size === 0) return a === b ? 1 : 0;
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const gram of left) if (right.has(gram)) intersection += 1;

  return intersection / (left.size + right.size - intersection);
}

function trigrams(value: string): Set<string> {
  const padded = `  ${value.trim().toLowerCase()} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) grams.add(padded.slice(i, i + 3));
  return grams;
}

/**
 * Parse the dates found in the "Record" sheet, which mixes three shapes:
 * real Excel datetimes, "27-Mar-1998", and "September 14, 2018".
 * Returns an ISO `YYYY-MM-DD` string, or null when the value is unusable.
 */
export function parseFlexibleDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return toIsoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }

  // Excel serial date numbers (days since 1899-12-30).
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const millis = Math.round((value - 25569) * 86400000);
    const date = new Date(millis);
    if (Number.isNaN(date.getTime())) return null;
    return toIsoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  const text = cleanText(value);
  if (text.length === 0) return null;

  // 2018-08-13 or 2018-08-13 00:00:00
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(text);
  if (iso) return toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // 27-Mar-1998 / 27 Mar 1998 / 27/03/1998
  const dayFirst = /^(\d{1,2})[-/ ]([A-Za-z]{3,}|\d{1,2})[-/ ](\d{4})$/.exec(text);
  if (dayFirst) {
    const month = monthNumber(dayFirst[2]);
    if (month) return toIsoDate(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }

  // September 14, 2018 / Sep 14 2018
  const monthFirst = /^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (monthFirst) {
    const month = monthNumber(monthFirst[1]);
    if (month) return toIsoDate(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }

  return null;
}

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function monthNumber(token: string): number | null {
  if (/^\d+$/.test(token)) {
    const month = Number(token);
    return month >= 1 && month <= 12 ? month : null;
  }
  const lower = token.toLowerCase();
  const index = MONTH_NAMES.findIndex((name) => name.startsWith(lower.slice(0, 3)));
  return index >= 0 ? index + 1 : null;
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Map the workbook's "Yes"/"No" deposit column onto a boolean. */
export function parseYesNo(value: unknown): boolean | null {
  const text = cleanText(value).toLowerCase();
  if (text === "yes" || text === "y" || text === "true") return true;
  if (text === "no" || text === "n" || text === "false") return false;
  return null;
}

/** Parse a numeric cell that may arrive as a number or a string. */
export function parseInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const text = cleanText(value).replace(/[^0-9-]/g, "");
  if (text.length === 0) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// String similarity primitives
//
// These exist so that entity matching can be expressed as a set of small,
// independently defensible measurements rather than one opaque distance. They
// are pure functions on strings: the same code computes the features that
// train the model and the features that score a live request, which is the
// only way to be sure the two agree.
// ---------------------------------------------------------------------------

/** Words of a normalised name, in order, without empties. */
export function nameTokens(value: string): string[] {
  return value.split(/\s+/).filter((token) => token.length > 0);
}

/** Overlapping character n-grams, used for typo-tolerant retrieval. */
export function charNgrams(value: string, size = 3): string[] {
  const text = value.trim();
  if (text.length === 0) return [];
  if (text.length <= size) return [text];

  const grams: string[] = [];
  for (let i = 0; i + size <= text.length; i += 1) grams.push(text.slice(i, i + size));
  return grams;
}

/** Jaccard overlap of two token sets. 1 when the sets are equal. */
export function tokenJaccard(a: string, b: string): number {
  const left = new Set(nameTokens(a));
  const right = new Set(nameTokens(b));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Share of the shorter name's tokens that appear in the longer one.
 *
 * This is the measurement that says "Bajaj Finance" is contained in "Bajaj
 * Finance Limited", which Jaccard penalises for the length difference.
 */
export function tokenContainment(a: string, b: string): number {
  const left = new Set(nameTokens(a));
  const right = new Set(nameTokens(b));
  if (left.size === 0 || right.size === 0) return 0;

  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const token of small) if (large.has(token)) shared += 1;
  return shared / small.size;
}

/**
 * IDF-weighted token overlap: agreeing on a rare word ("YERROW") is far more
 * informative than agreeing on a common one ("FINANCE"), and a plain Jaccard
 * cannot tell the two apart.
 *
 * `idf` supplies the weight per token; tokens it does not know are given the
 * corpus maximum, because an unseen token is by definition rare.
 */
export function weightedTokenOverlap(
  a: string,
  b: string,
  idf: ReadonlyMap<string, number>,
  fallbackWeight = 1,
): number {
  const left = new Set(nameTokens(a));
  const right = new Set(nameTokens(b));
  if (left.size === 0 || right.size === 0) return 0;

  const weight = (token: string): number => idf.get(token) ?? fallbackWeight;

  let shared = 0;
  let union = 0;
  for (const token of left) {
    union += weight(token);
    if (right.has(token)) shared += weight(token);
  }
  for (const token of right) {
    if (!left.has(token)) union += weight(token);
  }

  return union > 0 ? shared / union : 0;
}

/** Levenshtein edit distance, computed with a rolling row. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  const current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    const aChar = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current.slice();
  }

  return previous[b.length];
}

/** Edit distance rescaled to [0, 1], where 1 means identical. */
export function normalizedEditSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/**
 * Jaro-Winkler similarity — the standard record-linkage measure. It rewards a
 * shared prefix, which is exactly right for company names: an impersonator
 * usually keeps the recognisable start of a name and changes what follows.
 */
export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
  const jaro = jaroSimilarity(a, b);
  if (jaro === 0) return 0;

  let prefix = 0;
  const limit = Math.min(4, a.length, b.length);
  while (prefix < limit && a[prefix] === b[prefix]) prefix += 1;

  return jaro + prefix * prefixScale * (1 - jaro);
}

function jaroSimilarity(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 1 : 1;
  if (a.length === 0 || b.length === 0) return 0;

  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const from = Math.max(0, i - window);
    const to = Math.min(i + window + 1, b.length);
    for (let j = from; j < to; j += 1) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }

  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }

  const half = transpositions / 2;
  return (matches / a.length + matches / b.length + (matches - half) / matches) / 3;
}

/**
 * The initials of a name: "BAJAJ FINANCE LIMITED" -> "BFL". Used to recognise
 * that "IDFC" and "Infrastructure Development Finance Company" may be the same
 * institution — a claim a fraudulent lender exploits and a matcher must model.
 */
export function acronymOf(value: string): string {
  return nameTokens(value)
    .map((token) => token[0])
    .join("");
}

/** Longest run of characters the two strings share from the start. */
export function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}
