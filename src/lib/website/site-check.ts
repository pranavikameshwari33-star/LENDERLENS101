import "server-only";

import dns from "node:dns/promises";
import net from "node:net";

import { cleanText, normalizeHostname, parseEmails } from "../normalize";

/**
 * A single, polite look at a website.
 *
 * Scope is deliberately narrow. One request to the site's home page, a short
 * timeout, a small download cap, no crawling, no attempt to get past any
 * protection. Everything that fails degrades into "signal unavailable" rather
 * than an error, because a site being slow or blocking bots says nothing about
 * whether a company is registered.
 */

export type { SiteCheckResult } from "./types";

import type { SiteCheckResult } from "./types";

const REQUEST_TIMEOUT_MS = 6_000;
const MAX_BYTES = 512 * 1024;
const USER_AGENT =
  "BuildABankVerifier/1.0 (financial-company verification demo; +https://localhost)";

function unavailable(hostname: string, error: string): SiteCheckResult {
  return {
    hostname,
    reachable: false,
    httpsWorks: false,
    redirectedElsewhere: false,
    finalUrl: null,
    statusCode: null,
    title: null,
    description: null,
    siteName: null,
    emails: [],
    emailDomains: [],
    error,
  };
}

/**
 * Refuse to fetch anything that resolves to a private, loopback or link-local
 * address. Without this, the verification endpoint would happily fetch
 * `http://169.254.169.254/` on behalf of whoever typed it into the box.
 */
async function resolvesToPublicAddress(hostname: string): Promise<boolean> {
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    return false;
  }

  if (addresses.length === 0) return false;
  return addresses.every((entry) => isPublicAddress(entry.address));
}

export function isPublicAddress(address: string): boolean {
  const version = net.isIP(address);

  if (version === 4) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return false;
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;            // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;  // carrier-grade NAT
    if (a >= 224) return false;                          // multicast and reserved
    return true;
  }

  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return false;
    if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) return false;
    // IPv4-mapped addresses are checked as IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]);
    return true;
  }

  return false;
}

export async function checkWebsite(rawHostname: string): Promise<SiteCheckResult> {
  const hostname = normalizeHostname(rawHostname);
  if (!hostname) return unavailable(cleanText(rawHostname), "Not a readable website address.");

  if (!(await resolvesToPublicAddress(hostname))) {
    return unavailable(
      hostname,
      "The domain does not resolve to a public internet address, so it was not contacted.",
    );
  }

  const httpsAttempt = await fetchHomePage(`https://${hostname}/`);
  if (httpsAttempt.ok) {
    return buildResult(hostname, httpsAttempt, true);
  }

  // A site that only answers on http is itself worth reporting.
  const httpAttempt = await fetchHomePage(`http://${hostname}/`);
  if (httpAttempt.ok) {
    return buildResult(hostname, httpAttempt, false);
  }

  return unavailable(hostname, httpsAttempt.error ?? httpAttempt.error ?? "The site did not respond.");
}

interface FetchAttempt {
  readonly ok: boolean;
  readonly status: number | null;
  readonly finalUrl: string | null;
  readonly html: string;
  readonly error: string | null;
}

async function fetchHomePage(url: string): Promise<FetchAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-IN,en;q=0.9",
      },
      cache: "no-store",
    });

    const contentType = response.headers.get("content-type") ?? "";
    const html = contentType.includes("html") ? await readCapped(response) : "";

    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url || url,
      html,
      error: response.ok ? null : `The site responded with HTTP ${response.status}.`,
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `The site did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds.`
        : "The site could not be reached.";
    return { ok: false, status: null, finalUrl: null, html: "", error: message };
  } finally {
    clearTimeout(timer);
  }
}

/** Read at most MAX_BYTES so a huge or endless response cannot exhaust memory. */
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
    merged.set(chunk.subarray(0, Math.min(chunk.byteLength, total - offset)), offset);
    offset += chunk.byteLength;
    if (offset >= total) break;
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

function buildResult(
  hostname: string,
  attempt: FetchAttempt,
  viaHttps: boolean,
): SiteCheckResult {
  const finalHost = attempt.finalUrl ? normalizeHostname(safeHost(attempt.finalUrl)) : null;
  const emails = extractEmails(attempt.html);

  return {
    hostname,
    reachable: true,
    httpsWorks: viaHttps,
    redirectedElsewhere: finalHost !== null && finalHost !== hostname,
    finalUrl: attempt.finalUrl,
    statusCode: attempt.status,
    title: extractTitle(attempt.html),
    description: extractMeta(attempt.html, "description"),
    siteName: extractMeta(attempt.html, "og:site_name"),
    emails,
    emailDomains: [...new Set(emails.map((email) => email.split("@")[1]).filter(Boolean))],
    error: null,
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Minimal HTML scraping — a title, two meta tags and any mailto: addresses.
 * A parser dependency would buy nothing here and the input is untrusted, so
 * everything extracted is length-capped and treated as plain text.
 */
function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  if (!match) return null;
  const title = decodeEntities(cleanText(stripTags(match[1])));
  return title.length > 0 ? title.slice(0, 200) : null;
}

function extractMeta(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<meta[^>]+(?:name|property)\\s*=\\s*["']${escaped}["'][^>]*>`,
    "i",
  );
  const tag = pattern.exec(html);
  if (!tag) return null;

  const content = /content\s*=\s*["']([\s\S]{0,500}?)["']/i.exec(tag[0]);
  if (!content) return null;

  const value = decodeEntities(cleanText(content[1]));
  return value.length > 0 ? value.slice(0, 300) : null;
}

function extractEmails(html: string): string[] {
  const found = new Set<string>();

  for (const match of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    for (const email of parseEmails(decodeURIComponent(match[1]))) found.add(email);
    if (found.size >= 10) break;
  }

  // Fall back to addresses printed in the page text.
  if (found.size < 10) {
    const text = stripTags(html);
    for (const match of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      for (const email of parseEmails(match[0])) found.add(email);
      if (found.size >= 10) break;
    }
  }

  return [...found].slice(0, 10);
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}
