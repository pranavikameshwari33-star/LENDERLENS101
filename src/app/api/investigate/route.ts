import { NextResponse } from "next/server";

import { extractHostname, InvalidInputError } from "@/lib/verify/input";
import {
  checkRateLimit,
  clientIdentifier,
  rateLimitHeaders,
  type RateLimitOptions,
} from "@/lib/security/rate-limit";
import { investigate, InvestigationUnavailableError } from "@/lib/investigate/agent";
import { isGeminiConfigured } from "@/lib/investigate/gemini";
import { searchKnownEntities } from "@/lib/investigate/knowledge";
import { domainsRelated } from "@/lib/normalize";
import type {
  InvestigationInputType,
  InvestigationResponse,
  InvestigationResult,
} from "@/lib/investigate/types";

/**
 * POST /api/investigate
 *
 * The fallback path. `/api/verify` answers first and always; this endpoint is
 * called only for the domains that verification could not resolve, and only
 * ever from the server — the Gemini key is read inside the agent, in a module
 * the `server-only` package keeps out of the client graph entirely.
 *
 * The endpoint has no error status for an investigation that did not work. A
 * user is looking at a completed verification when this runs, and a failure
 * here must change nothing about it, so every degradation answers 200 with
 * `available: false` and a sentence that is safe to show. Raw SDK errors and
 * the API key never leave the server.
 *
 * `available: false` is now reserved for an investigation that never STARTED —
 * no key, rate limited, a domain the RBI data already identifies. A Gemini
 * failure is not one of those: the agent returns the evidence it gathered with
 * an AI_* status, and that comes back as `available: true` so the user sees the
 * evidence and a plain statement that the AI, not the evidence, was missing.
 *
 * Three controls keep this inside the Gemini free tier: a tighter rate limit
 * than /api/verify, a short-lived cache keyed on the normalised domain, and
 * the hard budget of ONE Gemini call inside the agent itself.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 4 * 1024;

/** Deliberately tight: each allowed request is at most one Gemini call. */
const INVESTIGATE_RATE_LIMIT: RateLimitOptions = { limit: 6, windowMs: 60_000 };

const CACHE_TTL_MS = 30 * 60_000;
const CACHE_MAX_ENTRIES = 50;

const cache = new Map<string, { readonly expiresAt: number; readonly result: InvestigationResult }>();

function cached(key: string): InvestigationResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

/**
 * What is worth remembering.
 *
 * A completed investigation, obviously. And an exhausted daily quota, because
 * the answer will not change until the allowance resets and re-asking spends a
 * request to be told so again. A busy model or an aborted request is transient
 * and is never cached: the next attempt should be a real one.
 */
function cacheable(result: InvestigationResult): boolean {
  return result.status === "SUCCESS" || result.status === "AI_QUOTA_EXCEEDED";
}

function remember(key: string, result: InvestigationResult): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result });
}

function unavailable(reason: string, headers: Record<string, string>): Response {
  return NextResponse.json({ available: false, reason } satisfies InvestigationResponse, {
    status: 200,
    headers: { ...headers, "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const decision = checkRateLimit(clientIdentifier(request), INVESTIGATE_RATE_LIMIT);
  const headers = rateLimitHeaders(decision);

  if (!decision.allowed) {
    return unavailable(
      `Too many investigations from this connection. Try again in ${decision.retryAfterSeconds} seconds.`,
      headers,
    );
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Request body is too large." }, { status: 413, headers });
    }
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400, headers });
  }

  const source = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const rawDomain = typeof source.domain === "string" ? source.domain : "";
  const claimedName =
    typeof source.companyName === "string" && source.companyName.trim().length > 0
      ? source.companyName.trim().slice(0, 300)
      : null;

  // Which search bar the user used. Sent explicitly by the form rather than
  // guessed here: the interface already knows, and a regex that has to tell a
  // company name from a domain will eventually get one of them wrong.
  const inputType: InvestigationInputType = source.inputType === "COMPANY" ? "COMPANY" : "WEBSITE";
  const originalInput =
    typeof source.originalInput === "string" && source.originalInput.trim().length > 0
      ? source.originalInput.trim().slice(0, 300)
      : null;

  if (rawDomain.length === 0 || rawDomain.length > 300) {
    return NextResponse.json({ error: "A domain is required." }, { status: 400, headers });
  }

  // The same normalisation the verification uses: www., https:// and a path
  // are all accepted, and anything that is not an address is rejected here.
  let hostname: string | null;
  try {
    hostname = extractHostname(rawDomain);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers });
    }
    throw error;
  }

  if (!hostname) {
    return NextResponse.json(
      { error: `"${rawDomain}" is not a website address this service can read.` },
      { status: 400, headers },
    );
  }

  if (!isGeminiConfigured()) {
    return unavailable(
      "The AI investigation is not configured on this deployment, so only the checks above were run.",
      headers,
    );
  }

  // The architecture, enforced server-side as well as in the client: a domain
  // the RBI data itself identifies never reaches Gemini. This applies only to a
  // WEBSITE search — on a company search the domain was discovered from the RBI
  // record in the first place, so of course it resolves, and refusing on that
  // basis would answer a question the user did not ask.
  if (inputType === "WEBSITE") {
    try {
      const known = searchKnownEntities({ hostname });
      const resolved = known.matches.find((match) =>
        match.hostnames.some((published) => domainsRelated(published, hostname)),
      );
      if (resolved) {
        return unavailable(
          `The RBI's own data identifies this website as ${resolved.name}, so no investigation was needed.`,
          headers,
        );
      }
    } catch {
      // The reference data being unreadable is not a reason to refuse; the
      // agent reports it as a notice of its own.
    }
  }

  const key = `${inputType}|${hostname}|${claimedName ?? ""}`;
  const hit = cached(key);
  if (hit) {
    return NextResponse.json({ available: true, investigation: hit } satisfies InvestigationResponse, {
      status: 200,
      headers: { ...headers, "Cache-Control": "no-store" },
    });
  }

  try {
    const investigation = await investigate({
      hostname,
      claimedName,
      inputType,
      originalInput,
    });
    if (cacheable(investigation)) remember(key, investigation);

    return NextResponse.json(
      { available: true, investigation } satisfies InvestigationResponse,
      { status: 200, headers: { ...headers, "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof InvestigationUnavailableError) {
      return unavailable(`${error.message} The checks above are unaffected.`, headers);
    }

    console.error("investigation failed", error);
    return unavailable(
      "The investigation could not be completed. The checks above are unaffected.",
      headers,
    );
  }
}
