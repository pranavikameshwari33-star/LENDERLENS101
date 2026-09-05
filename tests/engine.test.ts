import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isEntityIndexBuilt } from "../src/lib/index/store.ts";
import { verify } from "../src/lib/verify/engine.ts";
import { parseVerificationRequest } from "../src/lib/verify/input.ts";
import { buildDemoCases } from "../scripts/demo-cases.ts";

/**
 * End to end, with the network turned off.
 *
 * This runs the demonstration cases — the same ones the README and the home
 * page use — through the real engine against the real compiled index. It is the
 * test that would catch a layer silently returning nothing, a verdict rule
 * inverting, or a demo case drifting away from the data it was built from.
 *
 * Requires `npm run build:data`; every case skips without it rather than
 * failing, so a fresh clone can still run the pure-function suites.
 *
 * Run with `npm run test:engine` (it needs the react-server condition, because
 * the engine is marked server-only).
 */

const built = isEntityIndexBuilt();

async function runCase(id: string) {
  const demo = buildDemoCases().find((item) => item.id === id);
  assert.ok(demo, `demo case "${id}" has gone away`);
  return verify(parseVerificationRequest(demo.request), { skipWebsiteCheck: true });
}

describe("the verification engine", () => {
  it("verifies a registered NBFC checked against its own details", async (t) => {
    if (!built) return t.skip("index not built — run `npm run build:data`");

    const result = await runCase("registered");
    assert.equal(result.verdict, "green");
    assert.equal(result.regulatory.status, "verified");
    assert.equal(result.company.status, "match");
    assert.ok(result.regulatory.primary);
    assert.ok(result.company.cin);
  });

  it("returns red for an entity on the cancelled-registration list", async (t) => {
    if (!built) return t.skip("index not built");

    const result = await runCase("cancelled");
    assert.equal(result.verdict, "red");
    assert.equal(result.regulatory.status, "cancelled");
    assert.ok(
      result.signals.some((signal) => signal.id.startsWith("rbi_cancelled")),
      "no cancellation signal was produced",
    );
  });

  it("returns grey — not red — for a lender absent from every source", async (t) => {
    if (!built) return t.skip("index not built");

    const result = await runCase("unknown");
    assert.equal(result.verdict, "gray");
    assert.equal(result.regulatory.status, "not_verified");
    assert.equal(result.regulatory.primary, null);
  });

  it("catches the impersonation of a real registered NBFC", async (t) => {
    if (!built) return t.skip("index not built");

    const result = await runCase("impersonation");

    // The regulated company is genuine …
    assert.equal(result.regulatory.status, "verified");
    assert.equal(result.company.status, "match");
    // … and the contact details are not.
    assert.equal(result.website.status, "inconsistent");
    assert.equal(result.email.status, "inconsistent");
    assert.equal(result.loanTerms.status, "high_concern");
    assert.equal(result.scamSignals.level, "high");
    assert.equal(result.verdict, "red");
    assert.match(result.headline, /may not be it/);
  });

  it("verifies a bank, which appears in no NBFC list", async (t) => {
    if (!built) return t.skip("index not built");

    const result = await runCase("bank");
    assert.equal(result.regulatory.status, "verified");
    assert.equal(result.regulatory.primary?.entity.source, "bank");
    assert.equal(result.website.status, "consistent");
    assert.equal(result.verdict, "green");
  });

  it("catches a bank's name on another bank's RBI-published domain", async (t) => {
    if (!built) return t.skip("index not built");

    const result = await runCase("bank_impersonation");
    assert.equal(result.verdict, "red");
    assert.equal(result.website.status, "inconsistent");
    assert.ok(
      result.signals.some((signal) => signal.id === "domain_belongs_to_other_institution"),
      "the RBI-published-website contradiction was not detected",
    );
  });
});

describe("result invariants", () => {
  it("always reports six layers, whatever was supplied", async (t) => {
    if (!built) return t.skip("index not built");

    for (const id of ["registered", "cancelled", "unknown", "impersonation", "bank"]) {
      const result = await runCase(id);
      assert.equal(result.matrix.length, 6, `case ${id}`);
      assert.ok(result.recommendedActions.length > 0, `case ${id}`);
      assert.ok(result.reasons.length > 0, `case ${id}`);
    }
  });

  it("still works with the website removed entirely", async (t) => {
    if (!built) return t.skip("index not built");

    const demo = buildDemoCases().find((item) => item.id === "registered");
    assert.ok(demo);

    const { website, email, ...withoutDigitalIdentity } = demo.request;
    void website;
    void email;

    const result = await verify(parseVerificationRequest(withoutDigitalIdentity), {
      skipWebsiteCheck: true,
    });

    // The point of the exercise: five layers still produced a real answer.
    assert.equal(result.website.status, "not_provided");
    assert.equal(result.email.status, "not_provided");
    assert.equal(result.regulatory.status, "verified");
    assert.equal(result.company.status, "match");
    assert.ok(result.regulatory.primary);
    assert.ok(result.signals.length > 0);
  });

  it("never claims RBI endorsement or certainty", async (t) => {
    if (!built) return t.skip("index not built");

    for (const id of ["registered", "cancelled", "unknown", "impersonation", "bank"]) {
      const result = await runCase(id);
      const prose = [
        result.headline,
        result.summary,
        ...result.reasons,
        ...result.recommendedActions,
        ...result.signals.map((signal) => signal.explanation),
      ].join(" ");

      assert.doesNotMatch(prose, /RBI[- ]approved|approved by the RBI|RBI guarantees/i, `case ${id}`);
      assert.doesNotMatch(prose, /100% safe|completely safe|definitely a scam/i, `case ${id}`);
    }
  });

  it("reports the model's probability alongside its threshold, never as a fact", async (t) => {
    if (!built) return t.skip("index not built");

    const result = await runCase("registered");
    if (result.model.available) {
      assert.ok(result.model.threshold !== null);
      assert.ok(result.model.bestScore !== null);
      assert.ok((result.model.bestScore as number) >= 0 && (result.model.bestScore as number) <= 1);
    }
  });

  it("completes a warm check quickly enough to feel immediate", async (t) => {
    if (!built) return t.skip("index not built");

    // The first check in a process also parses a 9.4 MB index and loads the
    // model, which is startup cost rather than per-check cost. Measuring that
    // would make this assertion both wrong and flaky, so the caches are warmed
    // first and the second check is the one timed.
    await runCase("registered");

    const result = await runCase("registered");
    assert.ok(result.durationMs < 1_000, `warm check took ${result.durationMs} ms`);
  });
});
