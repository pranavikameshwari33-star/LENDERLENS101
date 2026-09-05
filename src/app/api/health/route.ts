import { NextResponse } from "next/server";

import { isEntityIndexBuilt, loadEntityIndex } from "@/lib/index/store";
import { areMetricsAvailable, loadModelMetrics } from "@/lib/ml/artifacts";
import { isModelBuilt, loadEntityMatchModel } from "@/lib/ml/model";
import { isPepperEphemeral } from "@/lib/security/rate-limit";
import { getSupabaseAdmin, isSupabaseConfigured } from "@/lib/supabase-admin";

/**
 * GET /api/health
 *
 * Answers "is this deployment actually set up?" without opening a dashboard:
 * which datasets are loaded, whether the model is present, whether Supabase is
 * reachable, and whether the rate limiter has a configured pepper.
 *
 * It never reports a credential — only whether one is present. Nothing here
 * reveals a value, a key or a connection string.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const checks: Record<string, unknown> = {};
  let ready = true;

  // --- the entity index (required) ----------------------------------------
  if (!isEntityIndexBuilt()) {
    ready = false;
    checks.entityIndex = {
      ok: false,
      message: "Not built. Run `npm run build:data`.",
    };
  } else {
    try {
      const index = loadEntityIndex();
      checks.entityIndex = {
        ok: true,
        builtAt: index.builtAt,
        entities: index.entities.length,
        counts: index.countsByStanding,
        datasets: index.file.datasets.map((dataset) => ({
          key: dataset.key,
          label: dataset.label,
          count: dataset.count,
          asOf: dataset.asOf,
          asOfIsFetchDate: dataset.asOfIsFetchDate,
          source: dataset.sourceUrl ?? dataset.sourceFile,
        })),
      };
    } catch (error) {
      ready = false;
      checks.entityIndex = {
        ok: false,
        message: error instanceof Error ? error.message : "The entity index could not be read.",
      };
    }
  }

  // --- the model (required for full-strength matching) --------------------
  if (!isModelBuilt()) {
    ready = false;
    checks.model = { ok: false, message: "Not trained. Run `npm run ml:all`." };
  } else {
    try {
      const model = loadEntityMatchModel();
      checks.model = {
        ok: true,
        version: model.version,
        algorithm: model.algorithm,
        trainedAt: model.trainedAt,
        threshold: model.threshold,
        features: model.featureNames.length,
      };
    } catch (error) {
      ready = false;
      checks.model = {
        ok: false,
        message: error instanceof Error ? error.message : "The model could not be loaded.",
      };
    }
  }

  // --- the evaluation artifacts (required for the technical page) ---------
  const metrics = areMetricsAvailable() ? loadModelMetrics() : null;
  checks.metrics = metrics
    ? {
        ok: true,
        modelVersion: metrics.modelVersion,
        heldOutTestPairs: metrics.dataset.splits.test.pairs,
        precision: metrics.test.precision,
        recall: metrics.test.recall,
      }
    : { ok: false, message: "No evaluation artifact. Run `npm run ml:all`." };

  // --- Supabase (optional at request time) --------------------------------
  if (!isSupabaseConfigured()) {
    checks.supabase = {
      ok: false,
      required: false,
      message:
        "Not configured. Verification still works: Supabase holds the durable copy of the RBI " +
        "corpus, the model registry and the audit log, none of which are on a request's critical path.",
    };
  } else {
    try {
      const client = getSupabaseAdmin();

      // `head: true` on a missing table can come back without an error, which
      // would let this endpoint report "connected" about a database that has
      // no schema at all. Selecting a row makes the failure visible.
      const [migrations, banks, models] = await Promise.all([
        client.from("schema_migrations").select("version"),
        client.from("rbi_bank").select("*", { count: "exact" }).limit(1),
        client.from("ml_model").select("model_version").eq("is_active", true).limit(1),
      ]);

      const applied = (migrations.data ?? [])
        .map((row) => (typeof row.version === "string" ? row.version : null))
        .filter((version): version is string => version !== null);

      const schemaReady = !migrations.error && !banks.error;

      checks.supabase = {
        ok: schemaReady,
        required: false,
        migrationsApplied: applied,
        bankRows: banks.count ?? 0,
        activeModel: models.data?.[0]?.model_version ?? null,
        message: schemaReady
          ? (banks.count ?? 0) > 0
            ? "Connected, schema applied, RBI data imported."
            : "Connected and schema applied, but no rows imported. Run `npm run import:rbi`."
          : "Reachable, but the schema has not been applied. Run the files in " +
            "supabase/migrations/ in the SQL Editor, then `npm run import:rbi`. " +
            "Verification is unaffected — it reads the compiled index on disk.",
      };
    } catch (error) {
      checks.supabase = {
        ok: false,
        required: false,
        message: error instanceof Error ? error.message : "Could not reach Supabase.",
      };
    }
  }

  // --- rate limiting -------------------------------------------------------
  checks.rateLimiter = {
    ok: true,
    pepperConfigured: !isPepperEphemeral(),
    message: isPepperEphemeral()
      ? "Using a per-process random pepper. Set RATE_LIMIT_PEPPER so buckets survive a restart."
      : "Using the configured RATE_LIMIT_PEPPER.",
  };

  return NextResponse.json(
    { ready, checks },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
