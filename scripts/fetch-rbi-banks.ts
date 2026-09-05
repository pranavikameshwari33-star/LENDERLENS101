/**
 * Fetch and parse the RBI's "Banks in India" page into a local snapshot.
 *
 *   npm run fetch:banks
 *
 * Source: https://www.rbi.org.in/commonman/english/scripts/BanksInIndia.aspx
 *
 * Why this exists
 * ---------------
 * The NBFC / ARC workbooks cover only non-banking finance companies. A user
 * asking about "HDFC Bank" or "Airtel Payments Bank" would otherwise fall into
 * the "not found" hole, which this application must never confuse with "not
 * legitimate". The RBI's own Banks-in-India page is the authoritative list.
 *
 * It also carries something the workbooks do not: for most banks the RBI links
 * the bank's OFFICIAL WEBSITE (largely on the regulated `.bank.in` domain).
 * That turns "does this domain belong to the institution it claims to be?"
 * from a guess into a lookup, which is the strongest digital-identity signal
 * available anywhere in this project.
 *
 * The page is 2000s-era ASP.NET HTML: nested tables, no ids, section headings
 * carried in `class="tableheader"` cells. The parser therefore walks the
 * document in order, tracking the most recent heading, and refuses to write a
 * snapshot if the shape it expects has gone away.
 *
 * Nothing here is invented. Every field is either read from the page or
 * derived from it by normalisation, and the snapshot records where and when.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

import { cleanText, nameCore, normalizeHostname, normalizeName } from "../src/lib/normalize.ts";
import {
  BANKS_SNAPSHOT_FILE,
  BANKS_SOURCE_URL,
  bankCategoryForHeading,
  type BankCategory,
} from "../src/lib/rbi/dataset.ts";
import type { BankRecord, BankSnapshot } from "../src/lib/rbi/types.ts";

const DATA_DIR = path.join(process.cwd(), "data");
const FETCH_TIMEOUT_MS = 30_000;

/** Below these the page has changed shape and the snapshot must not be trusted. */
const MIN_EXPECTED_BANKS = 120;
const MIN_EXPECTED_WEBSITES = 100;

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchPage(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(BANKS_SOURCE_URL, {
      signal: controller.signal,
      headers: {
        "User-Agent": "LenderLens/1.0 (RBI reference-data snapshot builder)",
        Accept: "text/html",
      },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`RBI returned HTTP ${response.status} for ${BANKS_SOURCE_URL}`);
    }
    // The page declares iso-8859-1 in its meta tag but is actually served as
    // UTF-8 (its en-dashes are two-byte sequences). Decoding it strictly as
    // UTF-8 fails loudly if that ever stops being true, rather than quietly
    // writing mojibake into the snapshot.
    const buffer = await response.arrayBuffer();
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      console.warn("  ! page is not valid UTF-8; falling back to ISO-8859-1");
      return new TextDecoder("iso-8859-1").decode(buffer);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/gi, "'")
    .replace(/&ndash;|&mdash;/gi, "-");
}

function textOf(html: string): string {
  return cleanText(decodeEntities(html.replace(/<[^>]*>/g, " ")));
}

/** Text with <br> turned into newlines, so an address keeps its lines. */
function multilineTextOf(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(withBreaks)
    .split("\n")
    .map((line) => cleanText(line))
    .filter((line) => line.length > 0)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface RawEntry {
  readonly name: string;
  readonly category: BankCategory;
  readonly heading: string;
  readonly website: string | null;
  readonly address: string | null;
}

/**
 * Walk the page in document order. Every `class="tableheader"` cell becomes the
 * current section; every data cell after it is attributed to that section.
 *
 * Two cell shapes matter:
 *   1. `<td><a href="https://x.bank.in/">Bank Name</a></td>` — the website lists
 *   2. `<td>Bank Name<br>Address line<br>...</td>`           — the address lists
 *
 * The page marks a heading in two different ways depending on which table it
 * belongs to — `<tr class="tableheader">` around the row in the website lists,
 * `<td class="tableheader">` on the cell itself in the address lists — so both
 * are treated as a heading.
 *
 * Cell contents are read as "everything up to the next structural tag" rather
 * than by matching a closing `</td>`. The address tables nest a whole table
 * inside a `<td>`, so a closing-tag match would swallow every heading in it.
 */
function parse(html: string): { entries: RawEntry[]; headings: string[] } {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  const structural = /<(\/?)(tr|td|th|table)\b([^>]*)>/gi;
  const isHeaderMarkup = (attributes: string): boolean =>
    /class\s*=\s*["']?tableheader/i.test(attributes);

  // Collect the tag positions first so each cell knows where its text stops.
  const tags: { closing: boolean; name: string; attributes: string; start: number; end: number }[] = [];
  let tag: RegExpExecArray | null;
  while ((tag = structural.exec(body)) !== null) {
    tags.push({
      closing: tag[1] === "/",
      name: tag[2].toLowerCase(),
      attributes: tag[3] ?? "",
      start: tag.index,
      end: tag.index + tag[0].length,
    });
  }

  const entries: RawEntry[] = [];
  const headings: string[] = [];
  const seen = new Set<string>();
  let current: { heading: string; category: BankCategory } | null = null;
  let rowIsHeader = false;

  for (let i = 0; i < tags.length; i += 1) {
    const item = tags[i];

    if (item.name === "tr" && !item.closing) {
      rowIsHeader = isHeaderMarkup(item.attributes);
      continue;
    }
    if (item.name !== "td" && item.name !== "th") continue;
    if (item.closing) continue;

    const attributes = item.attributes;
    const inner = body.slice(item.end, tags[i + 1]?.start ?? body.length);

    if (rowIsHeader || isHeaderMarkup(attributes)) {
      const heading = textOf(inner);
      const category = bankCategoryForHeading(heading);
      if (category) {
        current = { heading, category };
        if (!headings.includes(heading)) headings.push(heading);
      }
      continue;
    }

    if (!current) continue;

    // --- shape 1: a linked bank name -------------------------------------
    const link = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(inner);
    if (link) {
      const href = link[1].trim();
      const name = textOf(link[2]);
      if (!/^https?:/i.test(href) || href.includes("rbi.org.in")) continue;
      if (name.length < 3) continue;
      record(entries, seen, {
        name: tidyName(name),
        category: current.category,
        heading: current.heading,
        website: href,
        address: null,
      });
      continue;
    }

    // --- shape 2: a name followed by an address ---------------------------
    const lines = multilineTextOf(inner).split("\n");
    if (lines.length < 2) continue;
    const name = tidyName(lines[0]);
    // Serial-number cells and stray labels are not banks.
    if (!/(bank|nabard|sidbi|exim|finance corporation)/i.test(name)) continue;
    if (name.length < 4 || name.length > 120) continue;

    record(entries, seen, {
      name,
      category: current.category,
      heading: current.heading,
      website: null,
      address: lines.slice(1).join(", "),
    });
  }

  return { entries, headings };
}

/**
 * The address tables put the serial number in the same cell as the name
 * ("17.  Mizoram Rural Bank"), and both lists vary between "Ltd." and
 * "Limited". Only the numbering is stripped here; the legal form is left
 * alone and handled by merging on the suffix-stripped core name.
 */
function tidyName(value: string): string {
  return cleanText(value.replace(/^\s*\d{1,3}\s*[.)]\s*/, "").replace(/[,;]+$/, ""));
}

function record(entries: RawEntry[], seen: Set<string>, entry: RawEntry): void {
  const key = [entry.category, normalizeName(entry.name), entry.website ?? "", entry.address ? "a" : ""].join("|");
  if (seen.has(key)) return;
  seen.add(key);
  entries.push(entry);
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * A bank can appear under both a general and a specific heading. The specific
 * one is the informative label, so it wins.
 */
const CATEGORY_SPECIFICITY: readonly BankCategory[] = [
  "small_finance_bank",
  "payments_bank",
  "local_area_bank",
  "regional_rural_bank",
  "state_cooperative_bank",
  "financial_institution",
  "foreign_bank_subsidiary",
  "foreign_bank",
  "private_sector_bank",
  "public_sector_bank",
];

function pickPrimaryCategory(categories: readonly BankCategory[]): BankCategory {
  for (const candidate of CATEGORY_SPECIFICITY) {
    if (categories.includes(candidate)) return candidate;
  }
  return categories[0];
}

/**
 * The page lists most banks twice — once with an address, once with a website
 * link — under headings that mean the same thing ("Nationalised Banks" and
 * "SBI & Nationalised Banks"). Merging on the normalised name joins the two
 * halves into one record, and keeps every heading the name appeared under so
 * the provenance survives.
 */
function merge(entries: readonly RawEntry[]): BankRecord[] {
  interface Bucket {
    names: string[];
    categories: Set<BankCategory>;
    headings: Set<string>;
    websites: Set<string>;
    address: string | null;
  }

  const byName = new Map<string, Bucket>();

  for (const entry of entries) {
    // The RBI marks a restricted bank with a trailing asterisk; keep the flag
    // out of the name itself.
    const displayName = cleanText(entry.name.replace(/\*+\s*$/, ""));
    // Merge on the suffix-stripped core so that the address list's
    // "Axis Bank Ltd." and the website list's "Axis Bank Limited" become one
    // record rather than two half-populated ones.
    const key = nameCore(displayName) || normalizeName(displayName);
    if (key.length === 0) continue;

    let bucket = byName.get(key);
    if (!bucket) {
      bucket = {
        names: [],
        categories: new Set(),
        headings: new Set(),
        websites: new Set(),
        address: null,
      };
      byName.set(key, bucket);
    }
    if (!bucket.names.includes(displayName)) bucket.names.push(displayName);
    bucket.categories.add(entry.category);
    bucket.headings.add(entry.heading);
    if (entry.website) bucket.websites.add(entry.website);
    if (entry.address && !bucket.address) bucket.address = entry.address;
  }

  const records: BankRecord[] = [];
  for (const [core, bucket] of byName) {
    // Prefer the longest spelling the page used.
    const name = [...bucket.names].sort((a, b) => b.length - a.length)[0];
    const hostnames = [...bucket.websites]
      .map((url) => {
        try {
          return normalizeHostname(new URL(url).hostname);
        } catch {
          return null;
        }
      })
      .filter((host): host is string => host !== null);

    records.push({
      id: `bank_${core.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`,
      name,
      nameNormalized: normalizeName(name),
      nameCore: core,
      category: pickPrimaryCategory([...bucket.categories]),
      categories: [...bucket.categories].sort(),
      websites: [...bucket.websites].sort(),
      hostnames: [...new Set(hostnames)].sort(),
      address: bucket.address,
      sourceHeadings: [...bucket.headings].sort(),
    });
  }

  return records.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("LenderLens :: RBI Banks-in-India snapshot");
  console.log(`  source: ${BANKS_SOURCE_URL}`);

  const html = await fetchPage();
  console.log(`  fetched ${html.length.toLocaleString("en-IN")} bytes`);

  const { entries, headings } = parse(html);
  const banks = merge(entries);
  const withWebsite = banks.filter((bank) => bank.hostnames.length > 0).length;

  console.log(`  sections recognised: ${headings.length}`);
  for (const heading of headings) console.log(`    - ${heading.slice(0, 88)}`);
  console.log(`  raw entries:  ${entries.length}`);
  console.log(`  merged banks: ${banks.length} (with an official website: ${withWebsite})`);

  const byCategory = new Map<string, number>();
  for (const bank of banks) byCategory.set(bank.category, (byCategory.get(bank.category) ?? 0) + 1);
  for (const [category, count] of [...byCategory].sort()) {
    console.log(`    ${category.padEnd(26)} ${count}`);
  }

  if (banks.length < MIN_EXPECTED_BANKS || withWebsite < MIN_EXPECTED_WEBSITES) {
    throw new Error(
      `Refusing to write the snapshot: parsed ${banks.length} banks (${withWebsite} with websites), ` +
        `expected at least ${MIN_EXPECTED_BANKS} and ${MIN_EXPECTED_WEBSITES}. ` +
        "The RBI page layout has probably changed — update scripts/fetch-rbi-banks.ts.",
    );
  }

  const snapshot: BankSnapshot = {
    sourceUrl: BANKS_SOURCE_URL,
    sourceName: "Reserve Bank of India - Banks in India",
    fetchedAt: new Date().toISOString(),
    sectionHeadings: headings,
    counts: {
      total: banks.length,
      withWebsite,
      byCategory: Object.fromEntries([...byCategory].sort()),
    },
    banks,
  };

  const target = path.join(DATA_DIR, BANKS_SNAPSHOT_FILE);
  writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`\n  wrote ${target}`);
}

main().catch((error: unknown) => {
  console.error("\nFETCH FAILED");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
