import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractHostname,
  InvalidInputError,
  parseVerificationRequest,
} from "../src/lib/verify/input.ts";

/**
 * The single search box has to tell four kinds of input apart without ever
 * asking. Getting this wrong is quiet and expensive: a company name read as a
 * domain would trigger an outbound HTTP request to nowhere and drop the name
 * search entirely.
 */

describe("extractHostname", () => {
  it("reads a full URL", () => {
    assert.equal(extractHostname("https://www.Bajajfinserv.in/loans"), "bajajfinserv.in");
  });

  it("reads a bare domain", () => {
    assert.equal(extractHostname("example.co.in"), "example.co.in");
  });

  it("does not mistake a punctuated company name for a domain", () => {
    assert.equal(extractHostname("A.C. Fincom Private Limited"), null);
    assert.equal(extractHostname("Bajaj Finance Limited"), null);
  });

  it("refuses non-web schemes", () => {
    assert.equal(extractHostname("mailto:someone@example.com"), null);
    assert.equal(extractHostname("javascript:alert(1)"), null);
    assert.equal(extractHostname("file:///etc/passwd"), null);
  });
});

describe("parseVerificationRequest", () => {
  it("recognises a CIN typed into the free-text box", () => {
    const parsed = parseVerificationRequest({ query: "U65990MH1994PLC080646" });
    assert.equal(parsed.kind, "cin");
    assert.equal(parsed.cin, "U65990MH1994PLC080646");
    assert.equal(parsed.cinLooksMalformed, false);
    assert.equal(parsed.companyName, null);
  });

  it("flags a CIN-shaped value that is not a valid CIN", () => {
    const parsed = parseVerificationRequest({ query: "U64910RJ2023PT0086204" });
    assert.equal(parsed.kind, "cin");
    assert.equal(parsed.cinLooksMalformed, true);
  });

  it("recognises an e-mail address and derives its domain", () => {
    const parsed = parseVerificationRequest({ query: "grievance@360.one" });
    assert.equal(parsed.kind, "email");
    assert.equal(parsed.email, "grievance@360.one");
    assert.equal(parsed.hostname, "360.one");
  });

  it("recognises a website and builds a canonical URL", () => {
    const parsed = parseVerificationRequest({ query: "https://bajajfinserv.in/loans" });
    assert.equal(parsed.kind, "website");
    assert.equal(parsed.hostname, "bajajfinserv.in");
    assert.equal(parsed.websiteUrl, "https://bajajfinserv.in/");
  });

  it("treats anything else as a company name", () => {
    const parsed = parseVerificationRequest({ query: "  Bajaj Finance Limited  " });
    assert.equal(parsed.kind, "company_name");
    assert.equal(parsed.companyName, "Bajaj Finance Limited");
    assert.equal(parsed.hostname, null);
  });

  it("keeps all three explicit fields when the detailed form is used", () => {
    const parsed = parseVerificationRequest({
      companyName: "Bajaj Finance Limited",
      cin: "U65990MH1994PLC080646",
      website: "bajajfinserv.in",
    });
    assert.equal(parsed.companyName, "Bajaj Finance Limited");
    assert.equal(parsed.cin, "U65990MH1994PLC080646");
    assert.equal(parsed.hostname, "bajajfinserv.in");
  });

  it("rejects an empty request", () => {
    assert.throws(() => parseVerificationRequest({}), InvalidInputError);
    assert.throws(() => parseVerificationRequest({ query: "   " }), InvalidInputError);
  });

  it("rejects an over-long value", () => {
    assert.throws(
      () => parseVerificationRequest({ query: "a".repeat(301) }),
      InvalidInputError,
    );
  });

  it("rejects control characters", () => {
    assert.throws(
      () => parseVerificationRequest({ companyName: "Bajaj\u0000Finance" }),
      InvalidInputError,
    );
  });

  it("rejects a website field that is not a website", () => {
    assert.throws(
      () => parseVerificationRequest({ website: "not a website at all" }),
      InvalidInputError,
    );
  });
});
