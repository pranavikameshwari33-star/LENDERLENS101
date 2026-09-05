import "server-only";

/**
 * The Gemini client, and the only place in the application that touches it.
 *
 * Server-only by construction: `GEMINI_API_KEY` is read here and nowhere else,
 * there is no `NEXT_PUBLIC_` variant of it, and the `server-only` package makes
 * importing this module from a Client Component a build error rather than a
 * leaked key.
 *
 * Everything here is written for the Gemini API's free tier:
 *
 *   - a Flash-class model, configurable, defaulted to one that is available to
 *     new API keys without billing;
 *   - retrieval through the URL-context tool, which the free tier covers.
 *     Grounding with Google Search is supported here too but is OFF by
 *     default, because a free-tier key without a search allowance answers a
 *     grounded request with a quota error rather than an answer;
 *   - thinking set to minimal, so a call is fast and cheap in tokens;
 *   - short output budgets and temperature 0, because this is an extraction
 *     and evidence-structuring job, not a writing one;
 *   - a hard timeout, and no retries at all. A slow answer is worth less than
 *     a fast admission that the investigation could not run.
 *
 * Every failure is converted to `GeminiUnavailableError`, whose message is safe
 * to show a user: the raw SDK error is logged server-side and never returned.
 * It also carries a `kind` — quota, unavailable, aborted, credentials — because
 * the caller has to be able to say WHICH of those happened without ever calling
 * it an absence of evidence. See `failure.ts`.
 */

import { GoogleGenAI } from "@google/genai";

import { classifyGeminiFailure, type GeminiFailureKind } from "./failure";

/**
 * The default model.
 *
 * A current Flash-class model that a newly issued free-tier API key can call,
 * and that supports the two capabilities the agent needs together: a JSON
 * response schema and the URL-context retrieval tool. Override with
 * GEMINI_MODEL; the older 2.5 Flash models are no longer offered to new keys.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

/**
 * How long a single call may take.
 *
 * Generous, because the cost of being mean here is the whole investigation
 * failing: a larger model with a retrieval tool attached can spend twenty
 * seconds opening pages before it says anything. The default model answers in
 * a few seconds; this ceiling exists for the ones that do not.
 */
const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * A call that did not produce an answer, carrying WHY in a machine-readable
 * form. The `kind` is what stops a quota error further up the pipeline from
 * being reported to a user as an absence of evidence; see `failure.ts`.
 */
export class GeminiUnavailableError extends Error {
  readonly kind: GeminiFailureKind;

  constructor(message: string, kind: GeminiFailureKind = "failed") {
    super(message);
    this.name = "GeminiUnavailableError";
    this.kind = kind;
  }
}

export function geminiApiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export function isGeminiConfigured(): boolean {
  return geminiApiKey() !== null;
}

export function geminiModel(): string {
  const configured = process.env.GEMINI_MODEL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_GEMINI_MODEL;
}

/**
 * Whether to add Grounding with Google Search to retrieval calls.
 *
 * Off unless GEMINI_ENABLE_SEARCH_GROUNDING is set, because a free-tier key
 * with no search allowance refuses a grounded request outright. Where a key
 * does have the allowance, turning this on gives the investigation a general
 * web search on top of the URL reading it already does.
 */
export function searchGroundingEnabled(): boolean {
  return process.env.GEMINI_ENABLE_SEARCH_GROUNDING?.trim().toLowerCase() === "true";
}

let client: GoogleGenAI | null = null;

function geminiClient(): GoogleGenAI {
  const apiKey = geminiApiKey();
  if (!apiKey) {
    throw new GeminiUnavailableError(
      "The investigation service is not configured.",
      "credentials",
    );
  }
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

/**
 * A source a retrieval tool actually returned.
 *
 * Either a page the URL-context tool reports as successfully retrieved, or a
 * result the search tool cited. Nothing else ever becomes a source: a URL the
 * model merely wrote down is not evidence that a page exists, and the
 * sanitiser drops any citation that is not in this list.
 */
export interface RetrievedSource {
  readonly title: string;
  readonly url: string;
  readonly domain: string | null;
  readonly via: "url_context" | "search";
}

export interface GeminiCallResult {
  readonly text: string;
  readonly sources: readonly RetrievedSource[];
  /** URLs a retrieval tool tried and failed to open. Reported, not hidden. */
  readonly failedUrls: readonly string[];
  /** Search queries the model actually issued, when grounding was used. */
  readonly searchQueries: readonly string[];
}

export interface GeminiCallOptions {
  readonly systemInstruction: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  /** Defaults to the main model. The free tier counts requests per model. */
  readonly model?: string;
  /** Overrides the default timeout for this call. */
  readonly timeoutMs?: number;
  readonly responseSchema?: unknown;
  /**
   * Let the model open web pages it names, and report which it managed to
   * read. This is the free-tier retrieval capability the investigation relies
   * on; it combines with a response schema, unlike search grounding.
   */
  readonly readUrls?: boolean;
  /** Add Google Search grounding. Requires a key with a search allowance. */
  readonly search?: boolean;
}

export async function callGemini(options: GeminiCallOptions): Promise<GeminiCallResult> {
  const ai = geminiClient();

  const tools = [
    ...(options.search === true ? [{ googleSearch: {} }] : []),
    ...(options.readUrls === true ? [{ urlContext: {} }] : []),
  ];

  try {
    const response = await ai.models.generateContent({
      model: options.model ?? geminiModel(),
      contents: options.prompt,
      config: {
        systemInstruction: options.systemInstruction,
        temperature: 0,
        maxOutputTokens: options.maxOutputTokens,
        abortSignal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        // Free-tier friendly: barely any thinking tokens on extraction work.
        thinkingConfig: { thinkingLevel: "MINIMAL" as never },
        ...(tools.length > 0 ? { tools } : {}),
        ...(options.responseSchema !== undefined
          ? {
              responseMimeType: "application/json",
              // The schema is a plain object by design; see schema.ts.
              responseSchema: options.responseSchema as never,
            }
          : {}),
      },
    });

    const candidate = response.candidates?.[0];
    const metadata = candidate?.groundingMetadata;
    const sources: RetrievedSource[] = [];
    const failedUrls: string[] = [];

    const add = (source: RetrievedSource): void => {
      if (sources.length >= 12) return;
      if (sources.some((item) => item.url === source.url)) return;
      sources.push(source);
    };

    // Pages the URL-context tool actually opened.
    for (const entry of candidate?.urlContextMetadata?.urlMetadata ?? []) {
      if (!entry.retrievedUrl) continue;
      if (entry.urlRetrievalStatus !== "URL_RETRIEVAL_STATUS_SUCCESS") {
        if (failedUrls.length < 6) failedUrls.push(entry.retrievedUrl);
        continue;
      }
      add({
        title: hostOf(entry.retrievedUrl) ?? entry.retrievedUrl,
        url: entry.retrievedUrl,
        domain: hostOf(entry.retrievedUrl),
        via: "url_context",
      });
    }

    // Results search grounding cited, when it is switched on and available.
    for (const chunk of metadata?.groundingChunks ?? []) {
      const web = chunk.web;
      if (!web?.uri) continue;
      add({
        title: web.title ?? web.domain ?? web.uri,
        url: web.uri,
        domain: web.domain ?? null,
        via: "search",
      });
    }

    return {
      text: response.text ?? "",
      sources,
      failedUrls,
      searchQueries: (metadata?.webSearchQueries ?? []).slice(0, 6),
    };
  } catch (error) {
    // The SDK's message can carry request details; it is logged, not returned.
    const failure = classifyGeminiFailure(error);
    console.error(`[LenderLens] Gemini call failed (${failure.kind})`, error);
    throw new GeminiUnavailableError(failure.message, failure.kind);
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Parse a JSON response, tolerating a fenced code block around it. */
export function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
