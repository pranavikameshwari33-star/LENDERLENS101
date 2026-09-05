"""
Train and evaluate the LenderLens entity-matching model.

    npm run ml:train        (or: python ml/train.py)

Inputs
------
    ml/data/pairs.csv       written by `npm run ml:pairs`

Outputs
-------
    ml/artifacts/model.json     the selected model, in a form TypeScript can score
    ml/artifacts/metrics.json   every number the technical dashboard displays

What this script does NOT do
---------------------------
It does not compute a single feature. The feature vectors arrive in the CSV,
already produced by `src/lib/ml/features.ts` — the same code the live request
path runs. That removes the usual source of train/serve skew: there is only one
implementation of every feature, in one language.

It also does not choose its own splits. The `split` column was assigned by the
dataset builder over *groups* of near-identical company names, so that a name
seen in training cannot reappear in the test set wearing a different suffix.
This script only checks that the groups really are disjoint and then respects
them.

The task
--------
Binary classification over (claimed lender name, candidate RBI entity):

    y = 1   the two refer to the same institution
    y = 0   they refer to different institutions

This is identity resolution, not fraud detection. No label in this dataset says
anything about fraud, and the model is never presented as if it did.
"""

from __future__ import annotations

import csv
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    confusion_matrix,
    precision_recall_fscore_support,
    roc_auc_score,
)
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parent.parent
PAIRS_CSV = ROOT / "ml" / "data" / "pairs.csv"
ARTIFACTS = ROOT / "ml" / "artifacts"

RANDOM_SEED = 20260629

# ---------------------------------------------------------------------------
# Cost model
#
# These are ASSUMED RELATIVE COSTS used to pick a decision threshold. They are
# not measured money and are never presented as such.
#
# The positive class is "same institution", so:
#
#   FALSE POSITIVE   LenderLens announces that the lender in front of the user
#                    matches a real RBI-registered entity when it does not.
#                    That is a false reassurance handed to someone who is about
#                    to part with money. It is the expensive error here.
#
#   FALSE NEGATIVE   LenderLens fails to connect a genuine lender to its RBI
#                    record. The result degrades to "could not be verified"
#                    (GRAY) rather than to a wrong answer: the user is told to
#                    check further. Costly in friction, not in loss.
#
# The reverse framing (a missed fraud costing 10x a false alarm) is the usual
# one for a fraud detector. It is reported alongside, so the trade-off can be
# read either way, but the threshold this product ships with optimises the
# framing above.
# ---------------------------------------------------------------------------
PRIMARY_COST = {"name": "false_reassurance_weighted", "false_positive": 10.0, "false_negative": 1.0}
ALTERNATE_COST = {"name": "missed_detection_weighted", "false_positive": 1.0, "false_negative": 10.0}

THRESHOLD_GRID = [round(0.01 * i, 2) for i in range(1, 100)]


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Dataset:
    feature_names: list[str]
    X: np.ndarray
    y: np.ndarray
    split: np.ndarray
    group: np.ndarray
    variant: np.ndarray
    source: np.ndarray


def load_pairs(path: Path) -> Dataset:
    if not path.exists():
        raise SystemExit(
            f"{path} does not exist. Run `npm run ml:pairs` first — it writes the feature vectors."
        )

    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        header = next(reader)
        meta_columns = ["split", "group", "variant", "query", "entity_id", "entity_source", "label"]
        if header[: len(meta_columns)] != meta_columns:
            raise SystemExit(f"Unexpected columns in {path}: {header[:len(meta_columns)]}")
        feature_names = header[len(meta_columns) :]

        splits: list[str] = []
        groups: list[str] = []
        variants: list[str] = []
        sources: list[str] = []
        labels: list[int] = []
        rows: list[list[float]] = []

        for row in reader:
            if not row:
                continue
            splits.append(row[0])
            groups.append(row[1])
            variants.append(row[2])
            sources.append(row[5])
            labels.append(int(row[6]))
            rows.append([float(value) for value in row[len(meta_columns) :]])

    return Dataset(
        feature_names=feature_names,
        X=np.asarray(rows, dtype=np.float64),
        y=np.asarray(labels, dtype=np.int64),
        split=np.asarray(splits),
        group=np.asarray(groups),
        variant=np.asarray(variants),
        source=np.asarray(sources),
    )


def assert_no_group_leakage(data: Dataset) -> None:
    """A group must live in exactly one split, or the held-out score is fiction."""
    seen: dict[str, str] = {}
    for group, split in zip(data.group, data.split):
        previous = seen.setdefault(group, split)
        if previous != split:
            raise SystemExit(
                f"Group '{group}' appears in both '{previous}' and '{split}'. "
                "The split is leaking; fix scripts/ml/build-pairs.ts before trusting any metric."
            )


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def metrics_at(y_true: np.ndarray, scores: np.ndarray, threshold: float) -> dict[str, Any]:
    predicted = (scores >= threshold).astype(np.int64)
    tn, fp, fn, tp = confusion_matrix(y_true, predicted, labels=[0, 1]).ravel()
    precision, recall, f1, _ = precision_recall_fscore_support(
        y_true, predicted, average="binary", zero_division=0
    )
    total = len(y_true)

    return {
        "threshold": round(float(threshold), 4),
        "precision": float(precision),
        "recall": float(recall),
        "f1": float(f1),
        "accuracy": float((tp + tn) / total) if total else 0.0,
        "true_positives": int(tp),
        "true_negatives": int(tn),
        "false_positives": int(fp),
        "false_negatives": int(fn),
        "support_positive": int(tp + fn),
        "support_negative": int(tn + fp),
        "relative_cost": {
            PRIMARY_COST["name"]: float(
                fp * PRIMARY_COST["false_positive"] + fn * PRIMARY_COST["false_negative"]
            ),
            ALTERNATE_COST["name"]: float(
                fp * ALTERNATE_COST["false_positive"] + fn * ALTERNATE_COST["false_negative"]
            ),
        },
    }


def ranking_metrics(y_true: np.ndarray, scores: np.ndarray) -> dict[str, float]:
    if len(set(y_true.tolist())) < 2:
        return {"roc_auc": float("nan"), "pr_auc": float("nan")}
    return {
        "roc_auc": float(roc_auc_score(y_true, scores)),
        "pr_auc": float(average_precision_score(y_true, scores)),
    }


def threshold_sweep(y_true: np.ndarray, scores: np.ndarray) -> list[dict[str, Any]]:
    return [metrics_at(y_true, scores, threshold) for threshold in THRESHOLD_GRID]


def choose_threshold(sweep: Iterable[dict[str, Any]]) -> float:
    """
    Lowest assumed relative cost on the VALIDATION split, ties broken by F1.

    Chosen on validation and then applied unchanged to test, so that the
    reported held-out numbers are not the result of tuning against test.
    """
    best = min(
        sweep,
        key=lambda row: (row["relative_cost"][PRIMARY_COST["name"]], -row["f1"]),
    )
    return float(best["threshold"])


# ---------------------------------------------------------------------------
# Model export
# ---------------------------------------------------------------------------


def export_logistic(model: LogisticRegression, scaler: StandardScaler) -> dict[str, Any]:
    return {
        "kind": "logistic_regression",
        "coefficients": [float(value) for value in model.coef_[0]],
        "intercept": float(model.intercept_[0]),
        "standardisation": {
            "mean": [float(value) for value in scaler.mean_],
            "scale": [float(value) for value in scaler.scale_],
        },
    }


def export_tree(tree: Any, value_fn) -> dict[str, Any]:
    inner = tree.tree_
    return {
        "feature": [int(value) for value in inner.feature],
        "threshold": [float(value) for value in inner.threshold],
        "left": [int(value) for value in inner.children_left],
        "right": [int(value) for value in inner.children_right],
        "value": [float(value) for value in value_fn(inner)],
    }


def export_random_forest(model: RandomForestClassifier) -> dict[str, Any]:
    def leaf_probability(inner: Any) -> np.ndarray:
        counts = inner.value.reshape(inner.value.shape[0], -1)
        totals = counts.sum(axis=1)
        totals[totals == 0] = 1.0
        return counts[:, 1] / totals

    return {
        "kind": "tree_ensemble",
        "aggregation": "mean_probability",
        "baseScore": 0.0,
        "learningRate": 1.0,
        "trees": [export_tree(estimator, leaf_probability) for estimator in model.estimators_],
    }


def export_gradient_boosting(model: GradientBoostingClassifier, sample: np.ndarray) -> dict[str, Any]:
    trees = [
        export_tree(stage[0], lambda inner: inner.value.reshape(-1))
        for stage in model.estimators_
    ]
    learning_rate = float(model.learning_rate)

    # sklearn's initial raw prediction is reachable only through a private
    # helper, so it is recovered arithmetically instead: the difference between
    # the model's own decision function and the sum of the exported trees.
    raw = model.decision_function(sample[:1]).ravel()[0]
    contribution = sum(
        evaluate_tree(tree, sample[0]) for tree in trees
    ) * learning_rate
    base_score = float(raw - contribution)

    return {
        "kind": "tree_ensemble",
        "aggregation": "logit_sum",
        "baseScore": base_score,
        "learningRate": learning_rate,
        "trees": trees,
    }


def evaluate_tree(tree: dict[str, Any], features: np.ndarray) -> float:
    node = 0
    while tree["left"][node] != -1:
        node = (
            tree["left"][node]
            if features[tree["feature"][node]] <= tree["threshold"][node]
            else tree["right"][node]
        )
    return float(tree["value"][node])


def score_with_export(export: dict[str, Any], X: np.ndarray) -> np.ndarray:
    """Re-implementation of the exported artifact, used to verify the export."""
    if export["kind"] == "logistic_regression":
        mean = np.asarray(export["standardisation"]["mean"])
        scale = np.asarray(export["standardisation"]["scale"])
        coef = np.asarray(export["coefficients"])
        z = ((X - mean) / scale) @ coef + export["intercept"]
        return 1.0 / (1.0 + np.exp(-z))

    values = np.array(
        [[evaluate_tree(tree, row) for tree in export["trees"]] for row in X],
        dtype=np.float64,
    )
    if export["aggregation"] == "mean_probability":
        return values.mean(axis=1)

    raw = export["baseScore"] + export["learningRate"] * values.sum(axis=1)
    return 1.0 / (1.0 + np.exp(-raw))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    print("LenderLens :: training the entity-matching model")

    data = load_pairs(PAIRS_CSV)
    assert_no_group_leakage(data)

    masks = {name: data.split == name for name in ("train", "validation", "test")}
    for name, mask in masks.items():
        positives = int(data.y[mask].sum())
        total = int(mask.sum())
        share = 100.0 * positives / total if total else 0.0
        print(f"  {name:<11} {total:>7} pairs   {positives:>6} positive ({share:.1f}%)")

    groups_per_split = {name: len(set(data.group[mask].tolist())) for name, mask in masks.items()}
    print(f"  groups        {groups_per_split}")
    print(f"  features      {len(data.feature_names)}")

    X_train, y_train = data.X[masks["train"]], data.y[masks["train"]]
    X_validation, y_validation = data.X[masks["validation"]], data.y[masks["validation"]]
    X_test, y_test = data.X[masks["test"]], data.y[masks["test"]]

    scaler = StandardScaler().fit(X_train)

    candidates: list[dict[str, Any]] = []

    print("\n  fitting candidate models")

    logistic = LogisticRegression(max_iter=2000, C=1.0, random_state=RANDOM_SEED)
    logistic.fit(scaler.transform(X_train), y_train)
    candidates.append(
        {
            "name": "logistic_regression",
            "description": "Logistic regression on standardised features.",
            "hyperparameters": {"C": 1.0, "max_iter": 2000, "standardised": True},
            "validation_scores": logistic.predict_proba(scaler.transform(X_validation))[:, 1],
            "test_scores": logistic.predict_proba(scaler.transform(X_test))[:, 1],
            "export": lambda: export_logistic(logistic, scaler),
        }
    )

    forest = RandomForestClassifier(
        n_estimators=120,
        max_depth=12,
        min_samples_leaf=20,
        n_jobs=-1,
        random_state=RANDOM_SEED,
    )
    forest.fit(X_train, y_train)
    candidates.append(
        {
            "name": "random_forest",
            "description": "Random forest, depth-capped so the exported artifact stays small.",
            "hyperparameters": {"n_estimators": 120, "max_depth": 12, "min_samples_leaf": 20},
            "validation_scores": forest.predict_proba(X_validation)[:, 1],
            "test_scores": forest.predict_proba(X_test)[:, 1],
            "export": lambda: export_random_forest(forest),
        }
    )

    boosting = GradientBoostingClassifier(
        n_estimators=200,
        max_depth=3,
        learning_rate=0.1,
        random_state=RANDOM_SEED,
    )
    boosting.fit(X_train, y_train)
    candidates.append(
        {
            "name": "gradient_boosting",
            "description": "Gradient-boosted decision stumps of depth 3.",
            "hyperparameters": {"n_estimators": 200, "max_depth": 3, "learning_rate": 0.1},
            "validation_scores": boosting.predict_proba(X_validation)[:, 1],
            "test_scores": boosting.predict_proba(X_test)[:, 1],
            "export": lambda: export_gradient_boosting(boosting, X_train),
        }
    )

    comparison = []
    for candidate in candidates:
        validation_ranking = ranking_metrics(y_validation, candidate["validation_scores"])
        sweep = threshold_sweep(y_validation, candidate["validation_scores"])
        threshold = choose_threshold(sweep)
        at_threshold = metrics_at(y_validation, candidate["validation_scores"], threshold)
        candidate["threshold"] = threshold
        candidate["validation_sweep"] = sweep
        candidate["validation_metrics"] = {**at_threshold, **validation_ranking}
        comparison.append(
            {
                "model": candidate["name"],
                "description": candidate["description"],
                "hyperparameters": candidate["hyperparameters"],
                "selected_threshold": threshold,
                "validation": {**at_threshold, **validation_ranking},
            }
        )
        print(
            f"    {candidate['name']:<20} validation PR-AUC {validation_ranking['pr_auc']:.4f}"
            f"  precision {at_threshold['precision']:.4f}"
            f"  recall {at_threshold['recall']:.4f}"
            f"  cost {at_threshold['relative_cost'][PRIMARY_COST['name']]:.0f}"
        )

    # Selection is on validation only. Test is opened once, at the end.
    winner = min(
        candidates,
        key=lambda candidate: (
            candidate["validation_metrics"]["relative_cost"][PRIMARY_COST["name"]],
            -candidate["validation_metrics"]["pr_auc"],
        ),
    )
    print(f"\n  selected: {winner['name']} at threshold {winner['threshold']:.2f}")

    export = winner["export"]()

    # The exported artifact must reproduce sklearn's own scores; if it does
    # not, the application would be serving a different model from the one
    # these metrics describe.
    reproduced = score_with_export(export, X_test)
    drift = float(np.max(np.abs(reproduced - winner["test_scores"])))
    print(f"  export parity: max |sklearn - artifact| = {drift:.3e}")
    if drift > 1e-9:
        raise SystemExit(
            f"The exported model does not reproduce sklearn's scores (drift {drift:.3e}). "
            "Refusing to write an artifact that would serve different numbers than were measured."
        )

    threshold = winner["threshold"]
    test_scores = winner["test_scores"]
    test_metrics = {**metrics_at(y_test, test_scores, threshold), **ranking_metrics(y_test, test_scores)}

    print("\n  HELD-OUT TEST RESULTS")
    print(f"    precision {test_metrics['precision']:.4f}")
    print(f"    recall    {test_metrics['recall']:.4f}")
    print(f"    F1        {test_metrics['f1']:.4f}")
    print(f"    accuracy  {test_metrics['accuracy']:.4f}")
    print(f"    ROC-AUC   {test_metrics['roc_auc']:.4f}")
    print(f"    PR-AUC    {test_metrics['pr_auc']:.4f}")
    print(
        f"    TP {test_metrics['true_positives']}  FP {test_metrics['false_positives']}"
        f"  FN {test_metrics['false_negatives']}  TN {test_metrics['true_negatives']}"
    )

    # Per-variant recall, so an easy case cannot hide inside the average.
    by_variant = []
    test_variants = data.variant[masks["test"]]
    for variant in sorted(set(test_variants.tolist())):
        variant_mask = test_variants == variant
        positives = variant_mask & (y_test == 1)
        if positives.sum() == 0:
            continue
        recalled = int((test_scores[positives] >= threshold).sum())
        by_variant.append(
            {
                "variant": variant,
                "positive_pairs": int(positives.sum()),
                "recalled": recalled,
                "recall": float(recalled / positives.sum()),
            }
        )
        print(f"    recall[{variant:<22}] {recalled}/{int(positives.sum())} = {recalled / positives.sum():.4f}")

    # Per-source recall, so banks and ARCs are not invisible inside the NBFCs.
    by_source = []
    test_sources = data.source[masks["test"]]
    for source in sorted(set(test_sources.tolist())):
        source_mask = test_sources == source
        positives = source_mask & (y_test == 1)
        if positives.sum() == 0:
            continue
        recalled = int((test_scores[positives] >= threshold).sum())
        by_source.append(
            {
                "source": source,
                "positive_pairs": int(positives.sum()),
                "recalled": recalled,
                "recall": float(recalled / positives.sum()),
            }
        )

    ARTIFACTS.mkdir(parents=True, exist_ok=True)

    model_artifact = {
        "modelVersion": f"entity-match-{winner['name']}-1",
        "algorithm": winner["name"],
        "trainedAt": _now(),
        "featureNames": data.feature_names,
        "threshold": threshold,
        "model": export,
    }
    (ARTIFACTS / "model.json").write_text(json.dumps(model_artifact, indent=2) + "\n", encoding="utf-8")

    metrics_artifact = {
        "modelVersion": model_artifact["modelVersion"],
        "algorithm": winner["name"],
        "trainedAt": model_artifact["trainedAt"],
        "task": {
            "name": "entity identity resolution",
            "positiveClass": "the claimed lender name and the candidate RBI entity are the same institution",
            "negativeClass": "they are different institutions",
            "notFraudDetection": (
                "No label in this dataset records fraud. The model resolves identity; "
                "regulatory standing, digital identity, loan terms and scam signals are "
                "decided by deterministic rules elsewhere in the system."
            ),
        },
        "dataset": {
            "pairs": int(len(data.y)),
            "features": len(data.feature_names),
            "featureNames": data.feature_names,
            "randomSeed": RANDOM_SEED,
            "splitStrategy": (
                "Grouped by the first distinctive word of a company name, then groups "
                "assigned to train/validation/test by a seeded hash. Hard negatives are "
                "retrieved from a per-split index, so no pair crosses the boundary."
            ),
            "splits": {
                name: {
                    "pairs": int(mask.sum()),
                    "positive": int(data.y[mask].sum()),
                    "negative": int(mask.sum() - data.y[mask].sum()),
                    "positiveShare": float(data.y[mask].mean()) if mask.sum() else 0.0,
                    "groups": groups_per_split[name],
                }
                for name, mask in masks.items()
            },
            "labelRule": (
                "Two records are the same institution when they share a normalised name "
                "or a CIN. Ground truth therefore comes from the RBI data itself; no "
                "fraud label was invented."
            ),
        },
        "selection": {
            "criterion": (
                "Lowest assumed relative cost on the validation split, ties broken by F1. "
                "The test split was scored once, after selection."
            ),
            "candidates": comparison,
            "selected": winner["name"],
        },
        "costModel": {
            "disclaimer": (
                "Assumed relative costs used for threshold selection. These are not "
                "measured monetary losses and must not be read as such."
            ),
            "primary": PRIMARY_COST,
            "primaryRationale": (
                "A false positive tells a user that the lender in front of them matches a "
                "real registered entity when it does not — a false reassurance. A false "
                "negative degrades the result to 'could not be verified', which asks the "
                "user to check further. The first is the expensive error."
            ),
            "alternate": ALTERNATE_COST,
            "alternateRationale": (
                "The conventional fraud-detection framing, in which a missed detection "
                "costs ten times a false alarm. Reported for comparison; not used to "
                "choose the shipped threshold."
            ),
        },
        "threshold": {
            "value": threshold,
            "chosenOn": "validation",
            "sweep": winner["validation_sweep"],
        },
        "validation": winner["validation_metrics"],
        "test": test_metrics,
        "testBreakdown": {"byQueryVariant": by_variant, "byEntitySource": by_source},
        "exportParity": {
            "maxAbsoluteDifference": drift,
            "note": (
                "The JSON artifact was re-scored over the whole test split and compared "
                "against scikit-learn's own probabilities. The application serves the "
                "artifact, so this is what makes the published metrics apply to it."
            ),
        },
    }
    (ARTIFACTS / "metrics.json").write_text(json.dumps(metrics_artifact, indent=2) + "\n", encoding="utf-8")

    # A fixture the TypeScript test suite scores with its own implementation of
    # the artifact. The Python-side parity check above proves the export equals
    # scikit-learn; this one proves the shipped TypeScript equals the export.
    # Together they close the loop from the measured model to the served one.
    rng = np.random.default_rng(RANDOM_SEED)
    picks = rng.choice(len(X_test), size=min(300, len(X_test)), replace=False)
    fixture = {
        "modelVersion": model_artifact["modelVersion"],
        "tolerance": 1e-9,
        "cases": [
            {
                "features": [float(value) for value in X_test[index]],
                "expectedScore": float(test_scores[index]),
            }
            for index in picks
        ],
    }
    (ARTIFACTS / "parity-fixture.json").write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")

    print(f"\n  wrote {ARTIFACTS / 'model.json'}")
    print(f"  wrote {ARTIFACTS / 'metrics.json'}")
    print(f"  wrote {ARTIFACTS / 'parity-fixture.json'}")


def _now() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:  # pragma: no cover
        sys.exit(130)
