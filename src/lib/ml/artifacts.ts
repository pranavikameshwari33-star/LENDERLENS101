/**
 * Read the evaluation artifacts produced by `ml/train.py`.
 *
 * Nothing in the interface may state a metric that did not come through here.
 * The technical dashboard renders this object directly, so if the model gets
 * worse the page gets worse — which is the only arrangement under which the
 * numbers mean anything.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { METRICS_FILE_PATH } from "./model";

export interface ClassificationMetrics {
  readonly threshold: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly accuracy: number;
  readonly truePositives: number;
  readonly trueNegatives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly supportPositive: number;
  readonly supportNegative: number;
  readonly rocAuc: number | null;
  readonly prAuc: number | null;
  readonly relativeCost: Readonly<Record<string, number>>;
}

export interface SplitSummary {
  readonly pairs: number;
  readonly positive: number;
  readonly negative: number;
  readonly positiveShare: number;
  readonly groups: number;
}

export interface CostModel {
  readonly disclaimer: string;
  readonly primary: { readonly name: string; readonly false_positive: number; readonly false_negative: number };
  readonly primaryRationale: string;
  readonly alternate: { readonly name: string; readonly false_positive: number; readonly false_negative: number };
  readonly alternateRationale: string;
}

/** One row of the threshold sweep. Same shape as any other measurement. */
export type ThresholdRow = ClassificationMetrics;

export interface ModelMetrics {
  readonly modelVersion: string;
  readonly algorithm: string;
  readonly trainedAt: string;
  readonly task: {
    readonly name: string;
    readonly positiveClass: string;
    readonly negativeClass: string;
    readonly notFraudDetection: string;
  };
  readonly dataset: {
    readonly pairs: number;
    readonly features: number;
    readonly featureNames: readonly string[];
    readonly randomSeed: number;
    readonly splitStrategy: string;
    readonly labelRule: string;
    readonly splits: Readonly<Record<"train" | "validation" | "test", SplitSummary>>;
  };
  readonly selection: {
    readonly criterion: string;
    readonly selected: string;
    readonly candidates: readonly {
      readonly model: string;
      readonly description: string;
      readonly hyperparameters: Readonly<Record<string, unknown>>;
      readonly selected_threshold: number;
      readonly validation: ClassificationMetrics;
    }[];
  };
  readonly costModel: CostModel;
  readonly threshold: { readonly value: number; readonly chosenOn: string; readonly sweep: readonly ThresholdRow[] };
  readonly validation: ClassificationMetrics;
  readonly test: ClassificationMetrics;
  readonly testBreakdown: {
    readonly byQueryVariant: readonly { variant: string; positive_pairs: number; recalled: number; recall: number }[];
    readonly byEntitySource: readonly { source: string; positive_pairs: number; recalled: number; recall: number }[];
  };
  readonly exportParity: { readonly maxAbsoluteDifference: number; readonly note: string };
}

let cached: ModelMetrics | null = null;

export function metricsFilePath(root: string = process.cwd()): string {
  return path.join(root, METRICS_FILE_PATH);
}

export function areMetricsAvailable(root?: string): boolean {
  return existsSync(metricsFilePath(root));
}

/** Test seam: forget the memoised metrics. */
export function resetMetricsCache(): void {
  cached = null;
}

/** Returns null rather than throwing: a missing model must not break a page. */
export function loadModelMetrics(root?: string): ModelMetrics | null {
  if (cached) return cached;

  const file = metricsFilePath(root);
  if (!existsSync(file)) return null;

  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as RawMetrics;
    cached = normalise(raw);
    return cached;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The artifact uses Python's snake_case; the interface uses camelCase.
// ---------------------------------------------------------------------------

interface RawClassification {
  threshold: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  true_positives: number;
  true_negatives: number;
  false_positives: number;
  false_negatives: number;
  support_positive: number;
  support_negative: number;
  roc_auc?: number;
  pr_auc?: number;
  relative_cost: Record<string, number>;
}

type RawMetrics = Omit<ModelMetrics, "validation" | "test" | "threshold" | "selection"> & {
  validation: RawClassification;
  test: RawClassification;
  threshold: { value: number; chosenOn: string; sweep: RawClassification[] };
  selection: {
    criterion: string;
    selected: string;
    candidates: {
      model: string;
      description: string;
      hyperparameters: Record<string, unknown>;
      selected_threshold: number;
      validation: RawClassification;
    }[];
  };
};

function finite(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function classification(raw: RawClassification): ClassificationMetrics {
  return {
    threshold: raw.threshold,
    precision: raw.precision,
    recall: raw.recall,
    f1: raw.f1,
    accuracy: raw.accuracy,
    truePositives: raw.true_positives,
    trueNegatives: raw.true_negatives,
    falsePositives: raw.false_positives,
    falseNegatives: raw.false_negatives,
    supportPositive: raw.support_positive,
    supportNegative: raw.support_negative,
    rocAuc: finite(raw.roc_auc),
    prAuc: finite(raw.pr_auc),
    relativeCost: raw.relative_cost,
  };
}

function normalise(raw: RawMetrics): ModelMetrics {
  return {
    ...raw,
    validation: classification(raw.validation),
    test: classification(raw.test),
    threshold: {
      value: raw.threshold.value,
      chosenOn: raw.threshold.chosenOn,
      sweep: raw.threshold.sweep.map(classification),
    },
    selection: {
      criterion: raw.selection.criterion,
      selected: raw.selection.selected,
      candidates: raw.selection.candidates.map((candidate) => ({
        ...candidate,
        validation: classification(candidate.validation),
      })),
    },
  };
}
