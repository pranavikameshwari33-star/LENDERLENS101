/**
 * Score the exported entity-matching model.
 *
 * `ml/artifacts/model.json` is written by `ml/train.py`, which refuses to write
 * it unless this representation reproduces scikit-learn's own probabilities on
 * the whole test split to within 1e-9. That check is what makes the published
 * precision and recall apply to the model the application actually serves,
 * rather than to one that only ever existed inside a Python process.
 *
 * Two artifact shapes are supported, because the trainer compares three models
 * and exports whichever wins on the validation split:
 *
 *   logistic_regression   standardise, dot with the coefficients, sigmoid
 *   tree_ensemble         either the mean leaf probability across trees
 *                         (random forest) or a boosted sum of leaf logits
 *                         (gradient boosting)
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { FEATURE_NAMES } from "./features";

export const MODEL_FILE_PATH = "ml/artifacts/model.json";
export const METRICS_FILE_PATH = "ml/artifacts/metrics.json";

export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

interface LogisticExport {
  readonly kind: "logistic_regression";
  readonly coefficients: readonly number[];
  readonly intercept: number;
  readonly standardisation: { readonly mean: readonly number[]; readonly scale: readonly number[] };
}

interface ExportedTree {
  readonly feature: readonly number[];
  readonly threshold: readonly number[];
  readonly left: readonly number[];
  readonly right: readonly number[];
  readonly value: readonly number[];
}

interface TreeEnsembleExport {
  readonly kind: "tree_ensemble";
  readonly aggregation: "mean_probability" | "logit_sum";
  readonly baseScore: number;
  readonly learningRate: number;
  readonly trees: readonly ExportedTree[];
}

interface ModelArtifact {
  readonly modelVersion: string;
  readonly algorithm: string;
  readonly trainedAt: string;
  readonly featureNames: readonly string[];
  readonly threshold: number;
  readonly model: LogisticExport | TreeEnsembleExport;
}

export interface EntityMatchModel {
  readonly version: string;
  readonly algorithm: string;
  readonly trainedAt: string;
  /** The operating point chosen on the validation split by `ml/train.py`. */
  readonly threshold: number;
  readonly featureNames: readonly string[];
  /** Probability in [0, 1] that the pair is the same institution. */
  score(features: readonly number[]): number;
}

let cached: EntityMatchModel | null = null;

export function modelFilePath(root: string = process.cwd()): string {
  return path.join(root, MODEL_FILE_PATH);
}

export function isModelBuilt(root?: string): boolean {
  return existsSync(modelFilePath(root));
}

/** Test seam: forget the memoised model. */
export function resetModelCache(): void {
  cached = null;
}

export function loadEntityMatchModel(root?: string): EntityMatchModel {
  if (cached) return cached;

  const file = modelFilePath(root);
  if (!existsSync(file)) {
    throw new ModelUnavailableError(
      `The entity-matching model has not been trained. Run \`npm run ml:all\` to produce ${MODEL_FILE_PATH}.`,
    );
  }

  let artifact: ModelArtifact;
  try {
    artifact = JSON.parse(readFileSync(file, "utf8")) as ModelArtifact;
  } catch (error) {
    throw new ModelUnavailableError(
      `${MODEL_FILE_PATH} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  assertFeatureOrder(artifact.featureNames);

  const score = artifact.model.kind === "logistic_regression"
    ? logisticScorer(artifact.model)
    : ensembleScorer(artifact.model);

  cached = {
    version: artifact.modelVersion,
    algorithm: artifact.algorithm,
    trainedAt: artifact.trainedAt,
    threshold: artifact.threshold,
    featureNames: artifact.featureNames,
    score,
  };

  return cached;
}

/**
 * A model whose features were computed in a different order would still return
 * a confident number — just a meaningless one. This refuses to load it.
 */
function assertFeatureOrder(names: readonly string[]): void {
  if (names.length !== FEATURE_NAMES.length || names.some((name, i) => name !== FEATURE_NAMES[i])) {
    throw new ModelUnavailableError(
      "The trained model expects a different feature order than src/lib/ml/features.ts produces. " +
        "Re-run `npm run ml:all` after any change to the feature extractor.",
    );
  }
}

function sigmoid(value: number): number {
  return value >= 0
    ? 1 / (1 + Math.exp(-value))
    : Math.exp(value) / (1 + Math.exp(value));
}

function logisticScorer(model: LogisticExport): (features: readonly number[]) => number {
  const { mean, scale } = model.standardisation;
  return (features) => {
    let z = model.intercept;
    for (let i = 0; i < model.coefficients.length; i += 1) {
      z += ((features[i] - mean[i]) / scale[i]) * model.coefficients[i];
    }
    return sigmoid(z);
  };
}

function evaluateTree(tree: ExportedTree, features: readonly number[]): number {
  let node = 0;
  while (tree.left[node] !== -1) {
    node = features[tree.feature[node]] <= tree.threshold[node] ? tree.left[node] : tree.right[node];
  }
  return tree.value[node];
}

function ensembleScorer(model: TreeEnsembleExport): (features: readonly number[]) => number {
  const { trees, aggregation, baseScore, learningRate } = model;

  if (aggregation === "mean_probability") {
    return (features) => {
      let total = 0;
      for (const tree of trees) total += evaluateTree(tree, features);
      return trees.length > 0 ? total / trees.length : 0;
    };
  }

  return (features) => {
    let raw = baseScore;
    for (const tree of trees) raw += learningRate * evaluateTree(tree, features);
    return sigmoid(raw);
  };
}
