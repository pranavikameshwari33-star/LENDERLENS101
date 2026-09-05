import "server-only";

/**
 * Reading the website itself.
 *
 * The existing site check (`lib/website/site-check.ts`) answers "is this site
 * up, and what does its home page announce itself as?" — a title, a couple of
 * meta tags, any contact address. That is the right amount for a signal.
 *
 * An investigation needs more: the paragraph in the footer that names the
 * NBFC actually lending the money, the line in the privacy policy that gives
 * the registered legal name, the licence sentence on the terms page. So this
 * module reads a page as TEXT, and returns the links it found so that the
 * investigation can decide which page to open next. That decision is the
 * agentic part of the pipeline — it is made by the model, from links that
 * genuinely exist on the page, not from a hard-coded list of guesses.
 *
 * The safety properties of the original check are kept exactly:
 *
 *   - only http(s), only hosts that resolve to public addresses, so the
 *     endpoint cannot be turned into a probe of the deployment's own network;
 *   - one request per page, a short timeout, a hard byte cap, no crawling
 *     beyond the pages named, and no attempt to defeat any protection;
 *   - every failure degrades to "could not read", never to an exception.
 */

import dns from "node:dns/promises";

import { domainsRelated, normalizeHostname } from "../normalize";
import { isPublicAddress } from "../website/site-check";

const REQUEST_TIMEOUT_MS = 7_000;
const MAX_BYTES = 512 * 1024;
/** How much page text is kept. Head and tail, because footers carry the law. */
const MAX_TEXT_CHARS = 6_000;
const MAX_LINKS = 40;

const USER_AGENT =
  "LenderLensInvestigator/1.0 (lending-website verification; +https://localhost)";

export interface PageLink {
  readonly url: string;
  readonly label: string;
}

export interface RetrievedPage {
  readonly url: string;
  readonly ok: boolean;
  readonly title: string | null;
  /** Visible text, whitespace-collapsed and capped. Empty when unreadable. */
  readonly text: string;
  readonly links: readonly PageLink[];
  readonly error: string | null;
}

function failed(url: string, error: string): RetrievedPage {
  return { url, ok: false, title: null, text: "", links: [], error };
}

async function resolvesToPublicAddress(hostname: string): Promise<boolean> {
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    return addresses.length > 0 && addresses.every((entry) => isPublicAddress(entry.address));
  } catch {
    return false;
  }
}

/**
 * Fetch one page and reduce it to text and links.
 *
 * `allowedHost` confines the fetch to the site under investigation: a link on
 * the page pointing somewhere else is reported to the model but never followed
 * by this function.
 */
export async function retrievePage(rawUrl: string, allowedHost: string): Promise<RetrievedPage> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return failed(rawUrl, "Not a readable address.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return failed(rawUrl, "Only http and https addresses are read.");
  }

  const host = normalizeHostname(url.hostname);
  if (!host || !domainsRelated(host, allowedHost)) {
    return failed(url.toString(), `Not part of ${allowedHost}, so it was not opened.`);
  }

  if (!(await resolvesToPublicAddress(url.hostname))) {
    return failed(
      url.toString(),
      "The address does not resolve to a public internet address, so it was not contacted.",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-IN,en;q=0.9",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return failed(url.toString(), `The page responded with HTTP ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) {
      return failed(url.toString(), "The address did not return a web page.");
    }

    const html = await readCapped(response);
    const finalUrl = response.url || url.toString();

    return {
      url: finalUrl,
      ok: true,
      title: extractTitle(html),
      text: extractText(html),
      links: extractLinks(html, finalUrl, allowedHost),
      error: null,
    };
  } catch (error) {
    return failed(
      url.toString(),
      error instanceof Error && error.name === "AbortError"
        ? `The page did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds.`
        : "The page could not be reached.",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= total) break;
    merged.set(chunk.subarray(0, Math.min(chunk.byteLength, total - offset)), offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d{2,5});/g, (_match, code: string) => {
      const point = Number(code);
      return point > 31 && point < 0x10ffff ? String.fromCodePoint(point) : " ";
    });
}

function collapse(value: string): string {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  if (!match) return null;
  const title = collapse(stripTags(match[1]));
  return title.length > 0 ? title.slice(0, 200) : null;
}

/**
 * Page text, head and tail.
 *
 * On a long marketing page the operating entity is almost never in the first
 * screen; it is in the footer, beside the copyright line. Keeping both ends of
 * the document is what makes "who actually lends the money" findable within a
 * token budget that stays inside the free tier.
 */
function extractText(html: string): string {
  const text = collapse(stripTags(html));
  if (text.length <= MAX_TEXT_CHARS) return text;

  const half = Math.floor(MAX_TEXT_CHARS / 2);
  return `${text.slice(0, half)} […] ${text.slice(-half)}`;
}

function extractLinks(html: string, baseUrl: string, allowedHost: string): PageLink[] {
  const links: PageLink[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    let resolved: URL;
    try {
      resolved = new URL(match[1], baseUrl);
    } catch {
      continue;
    }

    if (resolved.protocol !== "https:" && resolved.protocol !== "http:") continue;

    const host = normalizeHostname(resolved.hostname);
    if (!host || !domainsRelated(host, allowedHost)) continue;

    resolved.hash = "";
    const url = resolved.toString();
    if (seen.has(url)) continue;
    seen.add(url);

    const label = collapse(stripTags(match[2])).slice(0, 80);
    links.push({ url, label: label.length > 0 ? label : resolved.pathname });

    if (links.length >= MAX_LINKS) break;
  }

  return links;
}
