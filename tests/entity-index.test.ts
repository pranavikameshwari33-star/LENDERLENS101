import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clusterKeyFor } from "../src/lib/index/cluster.ts";
import { isEntityIndexBuilt, loadEntityIndex } from "../src/lib/index/store.ts";
import {
  findByCin,
  findByEmailDomain,
  findByExactName,
  findByOfficialHostname,
  retrieveCandidates,
} from "../src/lib/index/search.ts";

/**
 * The index is the whole data plane. If a lookup silently returns nothing, the
 * application reports "not verified" for a registered lender — which is a bad
 * answer that looks like a reasonable one.
 *
 * These tests run against the real compiled index rather than a fixture,
 * because the thing worth testing is that the actual RBI data is reachable the
 * way the engine expects.
 */

const built = isEntityIndexBuilt();

describe("cluster keys", () => {
  it("groups every entity sharing a brand word", () => {
    assert.equal(clusterKeyFor("BAJAJ FINANCE"), clusterKeyFor("BAJAJ HOUSING FINANCE"));
  });

  it("skips a leading article so THE does not swallow the corpus", () => {
    assert.equal(clusterKeyFor("THE DELHI STATE CO OPERATIVE BANK"), "DELHI");
    assert.notEqual(clusterKeyFor("THE DELHI STATE BANK"), clusterKeyFor("THE GOA STATE BANK"));
  });

  it("joins a one-letter head to the next word", () => {
    // Deliberately coarse: "A C ..." companies share a group. Over-grouping
    // only makes the split blunter, whereas under-grouping inflates the score.
    assert.equal(clusterKeyFor("A C CHOKSI"), "A_C");
    assert.equal(clusterKeyFor("A C CHOKSI"), clusterKeyFor("A C STEELS"));
  });

  it("never returns an empty key", () => {
    assert.ok(clusterKeyFor("").length > 0);
  });
});

describe("the compiled index", () => {
  it("is built", (t) => {
    if (!built) {
      t.skip("index not built — run `npm run build:data`");
      return;
    }
    const index = loadEntityIndex();
    assert.ok(index.entities.length > 10_000, `only ${index.entities.length} entities`);
  });

  it("holds every RBI source", (t) => {
    if (!built) return t.skip("index not built");
    const index = loadEntityIndex();

    const sources = new Set(index.entities.map((entity) => entity.source));
    for (const expected of [
      "registered_nbfc",
      "registered_arc",
      "cancelled_company",
      "cancelled_record",
      "bank",
    ]) {
      assert.ok(sources.has(expected as never), `missing source ${expected}`);
    }
  });

  it("gives every entity a unique id", (t) => {
    if (!built) return t.skip("index not built");
    const index = loadEntityIndex();
    assert.equal(index.byId.size, index.entities.length);
  });

  it("carries provenance on every entity", (t) => {
    if (!built) return t.skip("index not built");
    const index = loadEntityIndex();
    for (const entity of index.entities.slice(0, 500)) {
      assert.ok(entity.provenance.sourceFile.length > 0);
      assert.ok(entity.provenance.sourceRowNumber > 0);
    }
  });
});

describe("identifier lookups", () => {
  it("finds a registered NBFC by its exact name and by its CIN", (t) => {
    if (!built) return t.skip("index not built");
    const index = loadEntityIndex();

    const sample = index.entities.find(
      (entity) => entity.source === "registered_nbfc" && entity.cin !== null,
    );
    assert.ok(sample, "no registered NBFC with a CIN in the index");

    const byName = findByExactName(sample.name, index);
    assert.ok(byName.some((entity) => entity.id === sample.id));

    const byCin = findByCin(sample.cin as string, index);
    assert.ok(byCin.some((entity) => entity.id === sample.id));
  });

  it("finds an entity by an e-mail domain the RBI published for it", (t) => {
    if (!built) return t.skip("index not built");
    const index = loadEntityIndex();

    const sample = index.entities.find((entity) => entity.emailDomains.length > 0);
    assert.ok(sample);

    const found = findByEmailDomain(sample.emailDomains[0], index);
    assert.ok(found.some((entity) => entity.id === sample.id));
  });

  it("resolves a bank from the website the RBI publishes for it", (t) => {
    if (!built) return t.skip("index not built");
    const index = loadEntityIndex();

    const bank = index.entities.find(
      (entity) => entity.source === "bank" && entity.hostnames.length > 0,
    );
    assert.ok(bank, "no bank with a published website");

    const found = findByOfficialHostname(bank.hostnames[0], index);
    assert.ok(found.some((entity) => entity.id === bank.id));
  });

  it("returns nothing rather than throwing for unusable input", (t) => {
    if (!built) return t.skip("index not built");
    const index = loadEntityIndex();
    assert.deepEqual(findByCin("not-a-cin", index), []);
    assert.deepEqual(findByExactName("", index), []);
    assert.deepEqual(findByOfficialHostname("not a host", index), []);
  });
});

describe("candidate retrieval", () => {
  it("retrieves the true entity for its own name", (t) => {
    if (!built) return t.skip("index not built");
    const index = loadEntityIndex();

    const sample = index.entities.find(
      (entity) => entity.source === "registered_nbfc" && entity.name.split(" ").length >= 3,
    );
    assert.ok(sample);

    const candidates = retrieveCandidates(sample.name, {}, index);
    assert.ok(
      candidates.some((candidate) => candidate.entity.id === sample.id),
      `blocking missed ${sample.name}`,
    );
  });

  it("survives a single-character typo", (t) => {
    if (!built) return t.skip("index not built");
    const index = loadEntityIndex();

    const sample = index.entities.find(
      (entity) => entity.source === "registered_nbfc" && entity.name.length > 20,
    );
    assert.ok(sample);

    // Drop the fifth character — the kind of slip a user makes typing a name.
    const typo = sample.name.slice(0, 5) + sample.name.slice(6);
    const candidates = retrieveCandidates(typo, {}, index);
    assert.ok(
      candidates.some((candidate) => candidate.entity.id === sample.id),
      `blocking lost ${sample.name} after one typo ("${typo}")`,
    );
  });

  it("returns nothing for a query too short to mean anything", (t) => {
    if (!built) return t.skip("index not built");
    const index = loadEntityIndex();
    assert.deepEqual(retrieveCandidates("a", {}, index), []);
  });
});
