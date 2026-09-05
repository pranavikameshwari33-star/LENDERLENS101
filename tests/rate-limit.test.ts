import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  bucketKey,
  checkRateLimit,
  clientIdentifier,
  rateLimitHeaders,
  resetRateLimits,
} from "../src/lib/security/rate-limit.ts";

/**
 * The verification endpoint fetches a URL on the caller's behalf, so the limiter
 * is a security control rather than a nicety. It also handles an IP address,
 * which is personal data this application has no reason to keep — so the two
 * things worth testing are that it actually limits, and that the address never
 * survives into the key.
 */

const OPTIONS = { limit: 3, windowMs: 60_000 };

describe("bucket keys", () => {
  it("are stable for the same identifier", () => {
    assert.equal(bucketKey("203.0.113.7"), bucketKey("203.0.113.7"));
  });

  it("differ between identifiers", () => {
    assert.notEqual(bucketKey("203.0.113.7"), bucketKey("203.0.113.8"));
  });

  it("never contain the identifier", () => {
    const address = "203.0.113.7";
    const key = bucketKey(address);
    assert.ok(!key.includes(address));
    assert.ok(!key.includes("203"));
    assert.match(key, /^[0-9a-f]{32}$/);
  });
});

describe("client identification", () => {
  it("prefers the first address in x-forwarded-for", () => {
    const request = new Request("https://example.test/", {
      headers: { "x-forwarded-for": "203.0.113.7, 198.51.100.1" },
    });
    assert.equal(clientIdentifier(request), "203.0.113.7");
  });

  it("falls back to a constant rather than failing open", () => {
    assert.equal(clientIdentifier(new Request("https://example.test/")), "unknown");
  });
});

describe("the limiter", () => {
  beforeEach(() => resetRateLimits());

  it("allows requests up to the limit and refuses the next", () => {
    const now = 1_000_000;
    for (let i = 1; i <= OPTIONS.limit; i += 1) {
      const decision = checkRateLimit("client-a", OPTIONS, now);
      assert.equal(decision.allowed, true, `request ${i} should be allowed`);
      assert.equal(decision.remaining, OPTIONS.limit - i);
    }

    const refused = checkRateLimit("client-a", OPTIONS, now);
    assert.equal(refused.allowed, false);
    assert.equal(refused.remaining, 0);
    assert.ok(refused.retryAfterSeconds > 0);
  });

  it("keeps clients in separate buckets", () => {
    const now = 2_000_000;
    for (let i = 0; i < OPTIONS.limit; i += 1) checkRateLimit("client-a", OPTIONS, now);

    assert.equal(checkRateLimit("client-a", OPTIONS, now).allowed, false);
    assert.equal(checkRateLimit("client-b", OPTIONS, now).allowed, true);
  });

  it("opens a fresh window once the old one has passed", () => {
    const now = 3_000_000;
    for (let i = 0; i < OPTIONS.limit + 1; i += 1) checkRateLimit("client-c", OPTIONS, now);
    assert.equal(checkRateLimit("client-c", OPTIONS, now).allowed, false);

    const later = now + OPTIONS.windowMs + 1;
    const decision = checkRateLimit("client-c", OPTIONS, later);
    assert.equal(decision.allowed, true);
    assert.equal(decision.remaining, OPTIONS.limit - 1);
  });

  it("reports Retry-After only when it has refused", () => {
    const now = 4_000_000;
    const allowed = checkRateLimit("client-d", OPTIONS, now);
    assert.equal(rateLimitHeaders(allowed)["Retry-After"], undefined);

    for (let i = 0; i < OPTIONS.limit; i += 1) checkRateLimit("client-d", OPTIONS, now);
    const refused = checkRateLimit("client-d", OPTIONS, now);
    assert.ok(rateLimitHeaders(refused)["Retry-After"]);
    assert.equal(rateLimitHeaders(refused)["RateLimit-Limit"], String(OPTIONS.limit));
  });
});
