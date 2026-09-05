import { NextResponse } from "next/server";

import { loadModelMetrics } from "@/lib/ml/artifacts";

/**
 * GET /api/model
 *
 * The evaluation artifact, served verbatim.
 *
 * It exists so that every number on the technical page can be checked against
 * its source without reading the React that renders it: same JSON, same file,
 * written by `ml/train.py`. If the model gets worse, this gets worse.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const metrics = loadModelMetrics();

  if (!metrics) {
    return NextResponse.json(
      {
        error:
          "No evaluation artifact is present. Run `npm run ml:all` to build the training pairs and " +
          "train the model; it writes ml/artifacts/metrics.json.",
      },
      { status: 503 },
    );
  }

  return NextResponse.json(metrics, {
    headers: { "Cache-Control": "no-store" },
  });
}
