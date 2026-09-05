import { NextResponse } from "next/server";

import { loadEntityIndex, EntityIndexUnavailableError } from "@/lib/index/store";
import { retrieveCandidates } from "@/lib/index/search";
import { buildIdfContext, buildQueryProfile, extractFeatures } from "@/lib/ml/features";
import { loadEntityMatchModel, ModelUnavailableError } from "@/lib/ml/model";
import {
  checkRateLimit,
  clientIdentifier,
  rateLimitHeaders,
  SEARCH_RATE_LIMIT,
} from "@/lib/security/rate-limit";
import { InvalidInputError } from "@/lib/verify/input";
import { entitySourceLabel } from "@/lib/verify/types";

/**
 * GET /api/search?q=<name>&source=<key>&limit=<n>
 *
 * Entity lookup with no verdict attached. Unlike `/api/verify` this makes no
 * judgement: it returns the candidates the blocking stage found and the model's
 * probability for each, so a caller — or a judge — can see the retrieval and
 * scoring stages separately from the decision logic built on top of them.
 *
 * The probability answers "are these the same institution", nothing else. It is
 * not a risk score and is never presented as one.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SOURCES = [
  "registered_nbfc",
  "registered_arc",
  "cancelled_company",
  "cancelled_record",
  "bank",
  "all",
] as const;
type SourceParam = (typeof SOURCES)[number];

const MAX_LIMIT = 25;

export async function GET(request: Request): Promise<Response> {
  const decision = checkRateLimit(clientIdentifier(request), SEARCH_RATE_LIMIT);
  const headers = rateLimitHeaders(decision);
  if (!decision.allowed) {
    return NextResponse.json(
      { error: `Too many searches. Try again in ${decision.retryAfterSeconds} seconds.` },
      { status: 429, headers },
    );
  }

  const params = new URL(request.url).searchParams;

  try {
    const query = (params.get("q") ?? "").trim();
    if (query.length < 2) {
      throw new InvalidInputError("Provide a search term of at least two characters via ?q=");
    }
    if (query.length > 300) {
      throw new InvalidInputError("Search term is too long (limit 300 characters).");
    }

    const source = readSource(params.get("source"));
    const limit = readLimit(params.get("limit"));

    const index = loadEntityIndex();
    const idfContext = buildIdfContext(index.idf, index.totalDocuments);
    const profile = buildQueryProfile(query);

    let model: ReturnType<typeof loadEntityMatchModel> | null = null;
    let modelNote = "Probabilities come from the entity-matching model.";
    try {
      model = loadEntityMatchModel();
    } catch (error) {
      modelNote =
        error instanceof ModelUnavailableError
          ? `${error.message} Results are ordered by blocking score only.`
          : "The model is unavailable; results are ordered by blocking score only.";
    }

    const candidates = retrieveCandidates(query, { maxCandidates: 80 }, index)
      .filter((candidate) => source === "all" || candidate.entity.source === source)
      .map((candidate) => {
        const probability = model
          ? model.score(extractFeatures(profile, candidate.entity, idfContext))
          : null;
        return { candidate, probability };
      })
      .sort((a, b) => (b.probability ?? b.candidate.blockingScore) - (a.probability ?? a.candidate.blockingScore))
      .slice(0, limit);

    return NextResponse.json(
      {
        query,
        source,
        model: model
          ? { version: model.version, algorithm: model.algorithm, threshold: model.threshold }
          : null,
        note:
          "The probability is the model's estimate that the name searched for and the candidate " +
          "record refer to the same institution. It says nothing about risk, and a high value is " +
          "not an endorsement.",
        modelNote,
        count: candidates.length,
        results: candidates.map(({ candidate, probability }) => ({
          id: candidate.entity.id,
          name: candidate.entity.name,
          source: candidate.entity.source,
          sourceLabel: entitySourceLabel(candidate.entity),
          standing: candidate.entity.standing,
          cin: candidate.entity.cin,
          classification:
            candidate.entity.attributes.classification ??
            candidate.entity.attributes.bankCategory ??
            null,
          emailDomains: candidate.entity.emailDomains,
          hostnames: candidate.entity.hostnames,
          matchProbability: probability === null ? null : Math.round(probability * 10000) / 10000,
          acceptedByModel: probability !== null && model !== null ? probability >= model.threshold : null,
          routes: candidate.routes,
        })),
      },
      { headers: { ...headers, "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof InvalidInputError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers });
    }
    if (error instanceof EntityIndexUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503, headers });
    }

    console.error("search failed", error);
    return NextResponse.json({ error: "The search could not be completed." }, { status: 500, headers });
  }
}

function readSource(value: string | null): SourceParam {
  if (!value) return "all";
  const found = SOURCES.find((source) => source === value);
  if (!found) {
    throw new InvalidInputError(`Unknown source "${value}". Choose one of: ${SOURCES.join(", ")}`);
  }
  return found;
}

function readLimit(value: string | null): number {
  if (value === null) return 10;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new InvalidInputError(`"${value}" is not a number.`);
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}
