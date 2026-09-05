import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isMailProviderDomain } from "../src/lib/normalize.ts";
import { confidenceLabelFor } from "../src/lib/verify/types.ts";
import { searchKnownEntities } from "../src/lib/investigate/knowledge.ts";

/**
 * The identifier the RBI publishes and LenderLens used to throw away.
 *
 * The `byEmailDomain` index was built on every load and never queried: the
 * matcher declared an `emailDomain` input and dropped it, and `knowledge.ts`
 * passed null into it. So a domain the RBI DOES hold — `i2ifunding.com`, which
 * its record for RNVP Technology Private Limited publishes as a contact
 * address — resolved to nothing, the investigation was told "no matching RBI
 * record", and a registered P2P lender came out as HIGH RISK for want of a
 * lookup that was already indexed.
 *
 * These tests run against the real compiled index, because the bug was that
 * real data was not being read. They assert the wiring, not any one company.
 */

describe("the RBI's published contact domain as an identifier", () => {
  it("reaches the record the RBI publishes that domain for", () => {
    const found = searchKnownEntities({ hostname: "i2ifunding.com" });
    const identified = found.matches.filter((match) => match.identifiedBy === "contact_domain");

    assert.equal(identified.length, 1);
    assert.equal(identified[0].name, "RNVP Technology Private Limited");
    assert.equal(identified[0].standing, "registered");
    assert.equal(identified[0].classification, "P2P");
    assert.equal(identified[0].cin, "U74120UP2016PTC076004");
    assert.equal(identified[0].identified, true);
  });

  it("does not resolve a mailbox provider to whoever filed an address there", () => {
    for (const provider of ["gmail.com", "yahoo.co.in", "outlook.com", "rediffmail.com"]) {
      const found = searchKnownEntities({ hostname: provider });
      assert.deepEqual(
        found.matches.filter((match) => match.identifiedBy === "contact_domain"),
        [],
        `${provider} must never identify a lender`,
      );
    }
  });

  it("treats a mailbox provider as one, whatever its form", () => {
    assert.equal(isMailProviderDomain("gmail.com"), true);
    assert.equal(isMailProviderDomain("WWW.Gmail.com"), true);
    assert.equal(isMailProviderDomain("i2ifunding.com"), false);
    assert.equal(isMailProviderDomain(null), false);
  });

  it("finds nothing for a domain the RBI holds no address on", () => {
    const found = searchKnownEntities({ hostname: "example.com" });
    assert.deepEqual(
      found.matches.filter((match) => match.identifiedBy === "contact_domain"),
      [],
    );
  });

  it("says how the record was reached, in words", () => {
    assert.equal(
      confidenceLabelFor("contact_domain", 0),
      "identified by the contact address the RBI publishes for this company",
    );
  });
});

describe("a company name and a domain are never blended", () => {
  /**
   * The hazard this guards. `i2ifunding.com` identifies RNVP Technology
   * Private Limited by the RBI's contact address. If that were allowed to
   * happen inside a search that also carried a company name, a search for a
   * name the RBI has never heard of, made with that URL, would come back
   * reporting an identified registered record — the RBI as having identified
   * the name that was asked about, on the strength of a record that matched
   * the URL instead.
   */
  it("does not let a domain identify a record in a search carrying a name", () => {
    const found = searchKnownEntities({
      hostname: "i2ifunding.com",
      organizationName: "Entirely Unrelated Fictional Lender Private Limited",
    });

    assert.deepEqual(
      found.matches.filter((match) => match.identifiedBy === "contact_domain"),
      [],
    );
    assert.deepEqual(
      found.matches.filter((match) => match.name === "RNVP Technology Private Limited"),
      [],
    );
  });

  it("still answers the domain question when it is asked on its own", () => {
    const found = searchKnownEntities({ hostname: "i2ifunding.com" });
    assert.ok(found.matches.some((match) => match.identifiedBy === "contact_domain"));
  });
});
