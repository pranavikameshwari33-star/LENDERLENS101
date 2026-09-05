/**
 * Telling "the AI could not run" apart from "there is nothing to find".
 *
 * These are different facts about the world and LenderLens must never print
 * one when it means the other. A user reading INSUFFICIENT EVIDENCE has been
 * told something about a lending website; a user reading AI INVESTIGATION
 * UNAVAILABLE has been told something about LenderLens. Collapsing the second
 * into the first is a lie about a website, and it is the one mistake this
 * layer exists to prevent.
 *
 * So every failure of the Gemini call is classified here, once, into a kind,
 * and every kind maps to its own run status. Quota exhaustion, an overloaded
 * model and an aborted request are all reported as themselves, and the
 * deterministic evidence gathered before the failure survives all three.
 *
 * Pure: no SDK import, no `server-only`, no environment. That is deliberate —
 * it is the part of the pipeline most worth unit-testing, and it can be tested
 * without an API key.
 */

/** What the investigation as a whole ended up being able to do. */
export type InvestigationRunStatus =
  /** Evidence was gathered and the model reasoned over it. */
  | "SUCCESS"
  /** Nothing was found to reason about. A fact about the website. */
  | "INSUFFICIENT_EVIDENCE"
  /** The model was reachable but would not serve. A fact about LenderLens. */
  | "AI_UNAVAILABLE"
  /** The API allowance ran out. A fact about LenderLens. */
  | "AI_QUOTA_EXCEEDED"
  /** The request aborted, timed out or came back unreadable. */
  | "AI_REQUEST_FAILED";

export const INVESTIGATION_RUN_STATUS_LABELS: Record<InvestigationRunStatus, string> = {
  SUCCESS: "Investigation complete",
  INSUFFICIENT_EVIDENCE: "Not enough evidence was found to investigate this website",
  AI_UNAVAILABLE: "AI investigation unavailable",
  AI_QUOTA_EXCEEDED: "AI investigation unavailable — the daily allowance is used up",
  AI_REQUEST_FAILED: "AI investigation did not complete",
};

/** True when the status describes LenderLens failing, not the evidence. */
export function isAiFailure(status: InvestigationRunStatus): boolean {
  return (
    status === "AI_UNAVAILABLE" ||
    status === "AI_QUOTA_EXCEEDED" ||
    status === "AI_REQUEST_FAILED"
  );
}

export type GeminiFailureKind =
  /** 429 / RESOURCE_EXHAUSTED. The free-tier allowance is spent. */
  | "quota"
  /** 503 / UNAVAILABLE / overloaded. Temporary, on Google's side. */
  | "unavailable"
  /** AbortError, TimeoutError, or a deadline we set ourselves. */
  | "aborted"
  /** 401 / 403. This deployment's key is wrong or unauthorised. */
  | "credentials"
  /** Anything else, including an answer that could not be parsed. */
  | "failed";

export interface GeminiFailure {
  readonly kind: GeminiFailureKind;
  /** One sentence, safe to put in front of a user. Never the raw SDK error. */
  readonly message: string;
  /**
   * Whether trying again in a moment could plausibly work. Recorded for
   * honesty in logs; nothing in this pipeline retries, because the standing
   * requirement is the fewest possible API calls and a retry is one more.
   */
  readonly retryable: boolean;
}

const MESSAGES: Record<GeminiFailureKind, string> = {
  quota: "The AI investigation service has used up its free daily allowance.",
  unavailable: "The AI investigation service is busy and could not answer.",
  aborted: "The AI investigation took too long and was stopped.",
  credentials: "The AI investigation service rejected this deployment's credentials.",
  failed: "The AI investigation service could not be reached.",
};

const RETRYABLE: Record<GeminiFailureKind, boolean> = {
  quota: false,
  unavailable: true,
  aborted: true,
  credentials: false,
  failed: false,
};

export function geminiFailure(kind: GeminiFailureKind): GeminiFailure {
  return { kind, message: MESSAGES[kind], retryable: RETRYABLE[kind] };
}

/**
 * Read an error thrown by the Gemini SDK.
 *
 * The SDK raises `ApiError` with a numeric `status`, but a transport-level
 * failure arrives as a plain `Error`, and a timed-out `AbortSignal` arrives as
 * a `DOMException` named `TimeoutError` or `AbortError`. The status is also
 * repeated inside the message as a JSON blob, so the message is read as a
 * fallback rather than trusted as the primary signal.
 */
export function classifyGeminiFailure(error: unknown): GeminiFailure {
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") return geminiFailure("aborted");

  const status = numericStatus(error);
  if (status === 429) return geminiFailure("quota");
  if (status === 503 || status === 500 || status === 502 || status === 504) {
    return geminiFailure("unavailable");
  }
  if (status === 401 || status === 403) return geminiFailure("credentials");

  const message = (error instanceof Error ? error.message : String(error ?? "")).toUpperCase();
  if (message.includes("RESOURCE_EXHAUSTED") || message.includes("QUOTA")) {
    return geminiFailure("quota");
  }
  if (message.includes("UNAVAILABLE") || message.includes("OVERLOADED")) {
    return geminiFailure("unavailable");
  }
  if (message.includes("ABORT") || message.includes("TIMEOUT") || message.includes("TIMED OUT")) {
    return geminiFailure("aborted");
  }
  if (
    message.includes("PERMISSION_DENIED") ||
    message.includes("UNAUTHENTICATED") ||
    message.includes("API_KEY_INVALID")
  ) {
    return geminiFailure("credentials");
  }

  return geminiFailure("failed");
}

function numericStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") return status;
  if (typeof status === "string" && /^\d{3}$/.test(status)) return Number(status);
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number") return code;
  return null;
}

/**
 * The run status for a failed model call.
 *
 * The one rule that matters: this never returns INSUFFICIENT_EVIDENCE. How
 * much evidence was gathered is irrelevant to why the model would not answer,
 * and the two must never be conflated.
 */
export function statusForFailure(kind: GeminiFailureKind): InvestigationRunStatus {
  switch (kind) {
    case "quota":
      return "AI_QUOTA_EXCEEDED";
    case "unavailable":
      return "AI_UNAVAILABLE";
    case "aborted":
    case "credentials":
    case "failed":
      return "AI_REQUEST_FAILED";
  }
}
