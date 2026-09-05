import { NextResponse } from "next/server";

import {
  checkRateLimit,
  clientIdentifier,
  rateLimitHeaders,
  VERIFY_RATE_LIMIT,
} from "@/lib/security/rate-limit";
import { recordVerification } from "@/lib/audit/record";
import { verify, VerificationUnavailableError } from "@/lib/verify/engine";
import {
  DISCLOSURE_KEYS,
  InvalidInputError,
  parseVerificationRequest,
  type DisclosureKey,
  type LoanTermsInput,
  type VerificationRequest,
} from "@/lib/verify/input";

/**
 * POST /api/verify
 *
 * Runs the full verification pipeline and returns a VerificationResult.
 *
 * Server-only by construction. The Supabase service-role key never leaves this
 * process, the compiled RBI index is never sent to the browser, and the
 * outbound request to the lender's site is made from here — which is also why
 * the endpoint is rate limited.
 *
 * A raw stack trace is never returned. Configuration problems answer 503 with
 * an actionable message; anything unexpected answers 500 with a generic one and
 * is logged server-side.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: Request): Promise<Response> {
  const decision = checkRateLimit(clientIdentifier(request), VERIFY_RATE_LIMIT);
  if (!decision.allowed) {
    return NextResponse.json(
      {
        error:
          `Too many checks from this connection. Try again in ${decision.retryAfterSeconds} seconds.`,
      },
      { status: 429, headers: rateLimitHeaders(decision) },
    );
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
    }
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  return handle(body, rateLimitHeaders(decision));
}

/** GET /api/verify?q=... — the same check, convenient for links and testing. */
export async function GET(request: Request): Promise<Response> {
  const decision = checkRateLimit(clientIdentifier(request), VERIFY_RATE_LIMIT);
  if (!decision.allowed) {
    return NextResponse.json(
      { error: `Too many checks. Try again in ${decision.retryAfterSeconds} seconds.` },
      { status: 429, headers: rateLimitHeaders(decision) },
    );
  }

  const params = new URL(request.url).searchParams;
  return handle(
    {
      query: params.get("q") ?? undefined,
      companyName: params.get("name") ?? undefined,
      cin: params.get("cin") ?? undefined,
      website: params.get("website") ?? undefined,
      email: params.get("email") ?? undefined,
      skipWebsiteCheck: params.get("skipWebsiteCheck") === "true",
    },
    rateLimitHeaders(decision),
  );
}

async function handle(body: unknown, headers: Record<string, string>): Promise<Response> {
  const fields = readRequestFields(body);

  let parsed;
  try {
    parsed = parseVerificationRequest(fields.request);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers });
    }
    throw error;
  }

  try {
    const result = await verify(parsed, { skipWebsiteCheck: fields.skipWebsiteCheck });

    // Fire-and-forget: an audit write must never delay or fail a verification.
    void recordVerification(result);

    return NextResponse.json(result, {
      headers: { ...headers, "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof VerificationUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503, headers });
    }

    console.error("verification failed", error);
    return NextResponse.json(
      { error: "The verification could not be completed. Please try again." },
      { status: 500, headers },
    );
  }
}

/**
 * Read only the fields we know about, ignoring anything else in the body. An
 * unexpected key is dropped rather than rejected, so a newer client talking to
 * an older deployment degrades instead of failing.
 */
function readRequestFields(body: unknown): {
  request: VerificationRequest;
  skipWebsiteCheck: boolean;
} {
  if (typeof body !== "object" || body === null) {
    return { request: {}, skipWebsiteCheck: false };
  }

  const source = body as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof source[key] === "string" ? source[key] : undefined;

  return {
    request: {
      query: text("query"),
      companyName: text("companyName"),
      cin: text("cin"),
      website: text("website"),
      email: text("email"),
      loanTerms: readLoanTerms(source.loanTerms),
      disclosures: readDisclosures(source.disclosures),
      disclosuresAnswered: source.disclosuresAnswered === true,
    },
    skipWebsiteCheck: source.skipWebsiteCheck === true,
  };
}

const LOAN_TERM_KEYS: readonly (keyof LoanTermsInput)[] = [
  "loanAmount",
  "interestRatePercent",
  "aprPercent",
  "processingFee",
  "upfrontPayment",
  "totalRepayment",
  "tenureMonths",
  "lateFee",
  "prepaymentCharge",
  "collateralDemanded",
  "otherTerms",
];

function readLoanTerms(value: unknown): Partial<Record<keyof LoanTermsInput, unknown>> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const picked: Partial<Record<keyof LoanTermsInput, unknown>> = {};
  for (const key of LOAN_TERM_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

function readDisclosures(value: unknown): Partial<Record<DisclosureKey, unknown>> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const picked: Partial<Record<DisclosureKey, unknown>> = {};
  for (const key of DISCLOSURE_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}
