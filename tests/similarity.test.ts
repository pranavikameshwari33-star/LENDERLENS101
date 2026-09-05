import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  acronymOf,
  charNgrams,
  commonPrefixLength,
  jaroWinkler,
  levenshtein,
  nameTokens,
  normalizedEditSimilarity,
  tokenContainment,
  tokenJaccard,
  weightedTokenOverlap,
} from "../src/lib/normalize.ts";

/**
 * The string-similarity primitives are the raw material of every feature the
 * model learns from. A subtle error here would not crash anything — it would
 * quietly change what the model was trained on and what it sees at request
 * time, in the same direction, so the metrics would still look fine.
 */

describe("levenshtein", () => {
  it("is zero for identical strings and symmetric", () => {
    assert.equal(levenshtein("BAJAJ", "BAJAJ"), 0);
    assert.equal(levenshtein("BAJAJ", "BAJAJJ"), levenshtein("BAJAJJ", "BAJAJ"));
  });

  it("counts single edits", () => {
    assert.equal(levenshtein("FINANCE", "FINANCF"), 1); // substitution
    assert.equal(levenshtein("FINANCE", "FINANC"), 1); // deletion
    assert.equal(levenshtein("FINANCE", "FINANCEE"), 1); // insertion
  });

  it("handles an empty side", () => {
    assert.equal(levenshtein("", "ABC"), 3);
    assert.equal(levenshtein("ABC", ""), 3);
    assert.equal(levenshtein("", ""), 0);
  });
});

describe("normalizedEditSimilarity", () => {
  it("is 1 for identical strings and 0 for wholly different ones", () => {
    assert.equal(normalizedEditSimilarity("ABC", "ABC"), 1);
    assert.equal(normalizedEditSimilarity("AAA", "BBB"), 0);
  });

  it("stays within [0, 1]", () => {
    for (const [a, b] of [["BAJAJ FINANCE", "BAJAJ HOUSING FINANCE"], ["A", "ZZZZZZZZ"]]) {
      const value = normalizedEditSimilarity(a, b);
      assert.ok(value >= 0 && value <= 1, `${a} vs ${b} gave ${value}`);
    }
  });
});

describe("jaroWinkler", () => {
  it("is 1 for identical strings", () => {
    assert.equal(jaroWinkler("BAJAJFINANCE", "BAJAJFINANCE"), 1);
  });

  it("rewards a shared prefix, which is how impersonation reads", () => {
    // Both differ from the target by the same number of characters, but the one
    // that keeps the recognisable start scores higher — which is the point.
    const keepsPrefix = jaroWinkler("bajajfinanc", "bajajfinance");
    const losesPrefix = jaroWinkler("ajajfinance", "bajajfinance");
    assert.ok(keepsPrefix > losesPrefix);
  });

  it("is 0 when nothing matches", () => {
    assert.equal(jaroWinkler("AAAA", "ZZZZ"), 0);
  });

  it("handles empty input without throwing", () => {
    assert.equal(jaroWinkler("", "ABC"), 0);
    assert.equal(jaroWinkler("", ""), 1);
  });
});

describe("token measures", () => {
  it("splits a normalised name into tokens", () => {
    assert.deepEqual(nameTokens("BAJAJ FINANCE"), ["BAJAJ", "FINANCE"]);
    assert.deepEqual(nameTokens("   "), []);
  });

  it("tokenJaccard penalises the extra word, tokenContainment does not", () => {
    const jaccard = tokenJaccard("BAJAJ FINANCE", "BAJAJ FINANCE LIMITED");
    const containment = tokenContainment("BAJAJ FINANCE", "BAJAJ FINANCE LIMITED");
    assert.ok(jaccard < 1);
    assert.equal(containment, 1);
  });

  it("is 0 when either side is empty", () => {
    assert.equal(tokenJaccard("", "BAJAJ"), 0);
    assert.equal(tokenContainment("BAJAJ", ""), 0);
  });

  it("weights a rare shared token above a common one", () => {
    // FINANCE is everywhere; YERROW is not. Sharing YERROW should count more.
    const idf = new Map([
      ["FINANCE", 1.0],
      ["BAJAJ", 6.0],
      ["YERROW", 9.0],
      ["LIMITED", 1.0],
    ]);

    const common = weightedTokenOverlap("FINANCE LIMITED", "FINANCE BAJAJ", idf, 9);
    const rare = weightedTokenOverlap("YERROW LIMITED", "YERROW BAJAJ", idf, 9);
    assert.ok(rare > common, `rare ${rare} should exceed common ${common}`);
  });
});

describe("acronymOf", () => {
  it("takes the initials", () => {
    assert.equal(acronymOf("BAJAJ FINANCE LIMITED"), "BFL");
    assert.equal(acronymOf("HDFC"), "H");
    assert.equal(acronymOf(""), "");
  });
});

describe("charNgrams", () => {
  it("produces overlapping windows", () => {
    assert.deepEqual(charNgrams("ABCD", 3), ["ABC", "BCD"]);
  });

  it("returns the whole string when it is shorter than the window", () => {
    assert.deepEqual(charNgrams("AB", 3), ["AB"]);
    assert.deepEqual(charNgrams("", 3), []);
  });
});

describe("commonPrefixLength", () => {
  it("counts the shared head", () => {
    assert.equal(commonPrefixLength("bajajfinance", "bajajfinserv"), 8);
    assert.equal(commonPrefixLength("abc", "abc"), 3);
    assert.equal(commonPrefixLength("abc", "xyz"), 0);
  });
});
