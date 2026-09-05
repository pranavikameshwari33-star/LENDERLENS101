/**
 * Publish the trained model's metadata and metrics to Supabase.
 *
 *   npm run ml:publish
 *
 * The application reads its metrics from `ml/artifacts/metrics.json` on disk,
 * so this is not on any critical path. It exists so that the model registry in
 * the database matches what is deployed: a metric shown on the technical page
 * can be traced to a row recording which run produced it, when, on how many
 * pairs, and with what threshold.
 *
 * Nothing is fabricated. Every value written here is read straight out of the
 * artifact; if the artifact is missing, the script refuses rather than
 * inventing a placeholder row.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { requireSupabaseCredentials } from "./lib/script-env.ts";

const METRICS_PATH = path.join(process.cwd(), "ml", "artifacts", "metrics.json");

interface Classification {
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  roc_auc?: number;
  pr_auc?: number;
  true_positives: number;
  true_negatives: number;
  false_positives: number;
  false_negatives: number;
}

interface Metrics {
  modelVersion: string;
  algorithm: string;
  trainedAt: string;
  dataset: {
    features: number;
    featureNames: string[];
    splits: Record<"train" | "validation" | "test", { pairs: number }>;
  };
  costModel: Record<string, unknown>;
  threshold: { value: number };
  test: Classification;
}

async function main(): Promise<void> {
  if (!existsSync(METRICS_PATH)) {
    throw new Error(
      `${METRICS_PATH} does not exist. Run \`npm run ml:all\` before publishing — there is nothing to publish.`,
    );
  }

  const metrics = JSON.parse(readFileSync(METRICS_PATH, "utf8")) as Metrics;
  const { url, serviceRoleKey } = requireSupabaseCredentials();
  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log("LenderLens :: publishing model metadata");
  console.log(`  model     ${metrics.modelVersion}`);
  console.log(`  algorithm ${metrics.algorithm}`);
  console.log(`  trained   ${metrics.trainedAt}`);
  console.log(`  test      precision ${metrics.test.precision.toFixed(4)}  recall ${metrics.test.recall.toFixed(4)}`);

  // Only one model is active at a time; stand the previous one down first.
  const standDown = await client
    .from("ml_model")
    .update({ is_active: false })
    .eq("is_active", true)
    .select("id");

  if (standDown.error) {
    throw new Error(`Could not deactivate the previous model: ${standDown.error.message}`);
  }
  if ((standDown.data?.length ?? 0) > 0) {
    console.log(`  deactivated ${standDown.data?.length} previously active model(s)`);
  }

  const { error } = await client.from("ml_model").upsert(
    {
      model_version: metrics.modelVersion,
      algorithm: metrics.algorithm,
      task: "entity_identity_resolution",
      trained_at: metrics.trainedAt,
      feature_count: metrics.dataset.features,
      feature_names: metrics.dataset.featureNames,
      threshold: metrics.threshold.value,
      train_pairs: metrics.dataset.splits.train.pairs,
      validation_pairs: metrics.dataset.splits.validation.pairs,
      test_pairs: metrics.dataset.splits.test.pairs,
      test_precision: metrics.test.precision,
      test_recall: metrics.test.recall,
      test_f1: metrics.test.f1,
      test_accuracy: metrics.test.accuracy,
      test_roc_auc: metrics.test.roc_auc ?? null,
      test_pr_auc: metrics.test.pr_auc ?? null,
      test_true_positives: metrics.test.true_positives,
      test_true_negatives: metrics.test.true_negatives,
      test_false_positives: metrics.test.false_positives,
      test_false_negatives: metrics.test.false_negatives,
      metrics,
      cost_model: metrics.costModel,
      is_active: true,
      published_at: new Date().toISOString(),
    },
    { onConflict: "model_version,trained_at" },
  );

  if (error) {
    throw new Error(
      `Could not write to ml_model: ${error.message}` +
        (error.code === "42P01"
          ? " — the table does not exist; apply supabase/migrations/0003_lenderlens_schema.sql"
          : error.code === "42501"
            ? " — permission denied; migration 0003 grants the service role access to this table"
            : ""),
    );
  }

  console.log("\n  published and marked active.");
}

main().catch((error: unknown) => {
  console.error("\nPUBLISH FAILED");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
