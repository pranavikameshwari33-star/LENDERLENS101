import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  FEATURE_COUNT,
  FEATURE_NAMES,
  buildIdfContext,
  buildQueryProfile,
  extractFeatures,
} from "../src/lib/ml/features.ts";
import { loadEntityMatchModel, isModelBuilt } from "../src/lib/ml/model.ts";

/**
 * The two ends of the model pipeline.
 *
 *   1. The features are what the model sees. If one of them is miscomputed the
 *      model still returns a confident number, so the properties each feature
 *      is supposed to have are asserted directly.
 *
 *   2. Parity. `ml/train.py` writes a fixture of feature vectors with the
 *      probability scikit-learn assigned to each. This suite scores the same
 *      vectors with the TypeScript implementation that actually serves
 *      requests. Together with the Python-side check that the exported artifact
 *      equals scikit-learn, that closes the loop from the model that was
 *      measured to the model that runs.
 */

const FIXTURE_PATH = path.join(process.cwd(), "ml", "artifacts", "parity-fixture.json");

const idf = buildIdfContext(
  new Map([
    ["BAJAJ", 7.2],
    ["FINANCE", 1.4],
    ["HOUSING", 5.1],
    ["YERROW", 9.5],
  ]),
  15_000,
);

function featuresFor(query: string, candidateName: string, alternates: string[] = []): number[] {
  return extractFeatures(
    buildQueryProfile(query),
    {
      nameNormalized: candidateName.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim(),
      nameCore: candidateName
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .replace(/\s+(PRIVATE LIMITED|LIMITED|LTD)\s*$/, "")
        .trim(),
      alternateNames: alternates,
    },
    idf,
  );
}

function feature(vector: readonly number[], name: (typeof FEATURE_NAMES)[number]): number {
  return vector[FEATURE_NAMES.indexOf(name)];
}

describe("feature extraction", () => {
  it("produces one value per declared feature, all finite and in [0, 1]", () => {
    const vector = featuresFor("Bajaj Finance Ltd", "Bajaj Finance Limited");
    assert.equal(vector.length, FEATURE_COUNT);
    for (const [index, value] of vector.entries()) {
      assert.ok(Number.isFinite(value), `${FEATURE_NAMES[index]} was ${value}`);
      assert.ok(value >= 0 && value <= 1, `${FEATURE_NAMES[index]} was ${value}`);
    }
  });

  it("flags an exact core match when only the legal form differs", () => {
    const vector = featuresFor("Bajaj Finance Ltd", "Bajaj Finance Limited");
    assert.equal(feature(vector, "exact_core_match"), 1);
    assert.equal(feature(vector, "first_token_match"), 1);
  });

  it("recognises a former name the RBI records", () => {
    const vector = featuresFor("Yerrow Finance", "121 Finance Private Limited", ["YERROW FINANCE"]);
    assert.equal(feature(vector, "alternate_name_match"), 1);
  });

  it("penalises an unmatched rare word — the Bajaj Housing case", () => {
    const sameCompany = featuresFor("Bajaj Finance", "Bajaj Finance Limited");
    const differentCompany = featuresFor("Bajaj Finance", "Bajaj Housing Finance Limited");

    // HOUSING is rare and appears on only one side, which is exactly the
    // evidence that these are two different Bajaj entities.
    assert.equal(feature(sameCompany, "unmatched_rare_entity_token"), 0);
    assert.ok(feature(differentCompany, "unmatched_rare_entity_token") > 0.4);
  });

  it("does not treat agreement on a common word as evidence", () => {
    const vector = featuresFor("Something Finance", "Another Finance");
    // FINANCE has low IDF, so the shared-rare-token feature must stay low.
    assert.ok(feature(vector, "shared_rare_token") < 0.3);
  });

  it("spots an initialism", () => {
    const vector = featuresFor("BFL", "Bajaj Finance Limited");
    assert.equal(feature(vector, "acronym_match"), 1);
  });

  it("distinguishes numeric tokens", () => {
    const agree = featuresFor("121 Finance", "121 Finance Private Limited");
    const disagree = featuresFor("121 Finance", "360 Finance Private Limited");
    assert.equal(feature(agree, "digit_token_agreement"), 1);
    assert.equal(feature(disagree, "digit_token_agreement"), 0);
  });
});

describe("model artifact", () => {
  it("is present and declares the same feature order as the extractor", (t) => {
    if (!isModelBuilt()) {
      t.skip("model not trained — run `npm run ml:all`");
      return;
    }
    const model = loadEntityMatchModel();
    assert.deepEqual([...model.featureNames], [...FEATURE_NAMES]);
    assert.ok(model.threshold > 0 && model.threshold < 1);
  });

  it("scores a clear match above the threshold and an unrelated name below it", (t) => {
    if (!isModelBuilt()) {
      t.skip("model not trained — run `npm run ml:all`");
      return;
    }
    const model = loadEntityMatchModel();

    const same = model.score(featuresFor("Bajaj Finance Ltd", "Bajaj Finance Limited"));
    const different = model.score(featuresFor("Rapid Cash Instant Loans", "Bajaj Finance Limited"));

    assert.ok(same >= model.threshold, `same-institution pair scored ${same}`);
    assert.ok(different < model.threshold, `unrelated pair scored ${different}`);
  });
});

describe("train / serve parity", () => {
  it("reproduces scikit-learn's probabilities to within the recorded tolerance", (t) => {
    if (!existsSync(FIXTURE_PATH) || !isModelBuilt()) {
      t.skip("no parity fixture — run `npm run ml:all`");
      return;
    }

    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
      modelVersion: string;
      tolerance: number;
      cases: { features: number[]; expectedScore: number }[];
    };

    const model = loadEntityMatchModel();
    assert.equal(
      model.version,
      fixture.modelVersion,
      "the fixture was written by a different training run than the model on disk",
    );
    assert.ok(fixture.cases.length > 0);

    let worst = 0;
    for (const testCase of fixture.cases) {
      const drift = Math.abs(model.score(testCase.features) - testCase.expectedScore);
      if (drift > worst) worst = drift;
    }

    assert.ok(
      worst <= fixture.tolerance,
      `TypeScript scoring drifted from scikit-learn by ${worst}, tolerance ${fixture.tolerance}`,
    );
  });
});
