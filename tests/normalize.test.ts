import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cleanText,
  domainLabel,
  domainsRelated,
  emailDomains,
  isValidCin,
  nameCore,
  normalizeCin,
  normalizeHostname,
  normalizeName,
  parseCompanyName,
  parseEmails,
  parseFlexibleDate,
  parseInteger,
  parseYesNo,
  trigramSimilarity,
} from "../src/lib/normalize.ts";

/**
 * These rules are shared by the importer and by every lookup, so a change here
 * silently breaks exact matching against 15,000 already-imported rows. Each
 * case below is drawn from a value that actually appears in the RBI workbooks.
 */

describe("cleanText", () => {
  it("strips the leading newline every cancelled-list name carries", () => {
    assert.equal(cleanText("\nAGROHA SAVINGS LIMITED"), "AGROHA SAVINGS LIMITED");
  });

  it("replaces non-breaking spaces and collapses runs of whitespace", () => {
    assert.equal(cleanText("Sugan Leasing  Private   Limited "), "Sugan Leasing Private Limited");
  });

  it("returns an empty string for null and undefined", () => {
    assert.equal(cleanText(null), "");
    assert.equal(cleanText(undefined), "");
  });
});

describe("normalizeName", () => {
  it("is case-insensitive", () => {
    assert.equal(normalizeName("bajaj finance limited"), normalizeName("BAJAJ FINANCE LIMITED"));
  });

  it("ignores surrounding and repeated whitespace", () => {
    assert.equal(normalizeName("   Bajaj    Finance  Limited  "), "BAJAJ FINANCE LIMITED");
  });

  it("reduces punctuation and spells out ampersands", () => {
    assert.equal(normalizeName("A.C. Choksi & Co."), "A C CHOKSI AND CO");
  });

  it("strips diacritics", () => {
    assert.equal(normalizeName("Sánchez Finance"), "SANCHEZ FINANCE");
  });
});

describe("nameCore", () => {
  it("removes trailing legal-form words", () => {
    assert.equal(nameCore("Bajaj Finance Limited"), "BAJAJ FINANCE");
    assert.equal(nameCore("Zoho Finance Private Limited"), "ZOHO FINANCE");
  });

  it("removes stacked suffixes and the conjunction they leave behind", () => {
    assert.equal(nameCore("A. C. Choksi & Co. Pvt. Ltd."), "A C CHOKSI");
  });

  it("falls back to the full name when every word is a suffix", () => {
    assert.equal(nameCore("Private Limited"), "PRIVATE LIMITED");
  });

  it("lets a short name match its fully-suffixed form", () => {
    assert.equal(nameCore("Bajaj Finance"), nameCore("Bajaj Finance Private Limited"));
  });
});

describe("parseCompanyName", () => {
  it("lifts a former name out of the parenthetical", () => {
    const parsed = parseCompanyName(
      "121 Finance Private Limited (Formerly: Yerrow Finance and Investments Private Limited)",
    );
    assert.equal(parsed.displayName, "121 Finance Private Limited");
    assert.deepEqual(parsed.alternateNames, ["Yerrow Finance and Investments Private Limited"]);
  });

  it("splits two former names but not a single name containing 'and'", () => {
    const parsed = parseCompanyName(
      "360 ONE Prime Limited (Formerly: IIFL Wealth Prime Limited and IIFL Wealth Finance Limited)",
    );
    assert.deepEqual(parsed.alternateNames, [
      "IIFL Wealth Prime Limited",
      "IIFL Wealth Finance Limited",
    ]);
  });

  it("handles the 'Name as per MCA' form", () => {
    const parsed = parseCompanyName(
      "A C Steels & Holdings Private Limited (Name as per MCA - A.C. Fincom Private Limited)",
    );
    assert.deepEqual(parsed.alternateNames, ["A.C. Fincom Private Limited"]);
  });

  it("leaves parentheses that are part of the name alone", () => {
    const parsed = parseCompanyName("Muthoot Finance (India) Limited");
    assert.equal(parsed.displayName, "Muthoot Finance (India) Limited");
    assert.deepEqual(parsed.alternateNames, []);
  });
});

describe("CIN handling", () => {
  it("normalises case and stray separators", () => {
    assert.equal(normalizeCin(" u64990gj2023ptc146103 "), "U64990GJ2023PTC146103");
  });

  it("accepts a well-formed CIN", () => {
    assert.equal(isValidCin(normalizeCin("U65990MH1994PLC080646")), true);
  });

  it("rejects the malformed CIN present in the registered list", () => {
    // Row 5539 of "List of NBFCs": "PT0" where "PTC" belongs.
    assert.equal(isValidCin(normalizeCin("U64910RJ2023PT0086204")), false);
  });

  it("treats an empty value as absent rather than invalid", () => {
    assert.equal(normalizeCin("   "), null);
    assert.equal(isValidCin(null), false);
  });
});

describe("parseEmails", () => {
  it("splits the multi-address cells the NBFC sheet contains", () => {
    const emails = parseEmails(
      "akbajaj31@gmail.com; maheshratra@amritcorp.com; akbajaj@amritcorp.com;",
    );
    assert.deepEqual(emails, [
      "akbajaj31@gmail.com",
      "maheshratra@amritcorp.com",
      "akbajaj@amritcorp.com",
    ]);
  });

  it("repairs a space beside the dot", () => {
    assert.deepEqual(
      parseEmails("ABHFL.grievancehead@adityabirlacapital. com"),
      ["abhfl.grievancehead@adityabirlacapital.com"],
    );
  });

  it("decodes [at] / [dot] obfuscation", () => {
    assert.deepEqual(parseEmails("onkarharkin[at]gmail[dot]com"), ["onkarharkin@gmail.com"]);
  });

  it("strips surrounding quotes", () => {
    assert.deepEqual(
      parseEmails("'nbfccompliance@rmoneyindia.co.in'"),
      ["nbfccompliance@rmoneyindia.co.in"],
    );
  });

  it("reports genuinely absent addresses as none, rather than guessing", () => {
    assert.deepEqual(parseEmails("-NA-"), []);
    assert.deepEqual(parseEmails("Not Applicable"), []);
    assert.deepEqual(parseEmails("SAGAR MAL NAHATA"), []);
  });

  it("derives distinct domains", () => {
    assert.deepEqual(
      emailDomains(["a@amritcorp.com", "b@amritcorp.com", "c@gmail.com"]),
      ["amritcorp.com", "gmail.com"],
    );
  });
});

describe("parseFlexibleDate", () => {
  it("reads the three shapes the Record sheet mixes", () => {
    assert.equal(parseFlexibleDate(new Date(Date.UTC(2018, 7, 13))), "2018-08-13");
    assert.equal(parseFlexibleDate("27-Mar-1998"), "1998-03-27");
    assert.equal(parseFlexibleDate("September 14, 2018"), "2018-09-14");
    assert.equal(parseFlexibleDate("2018-06-21 00:00:00"), "2018-06-21");
  });

  it("returns null rather than a wrong date for unusable values", () => {
    assert.equal(parseFlexibleDate(""), null);
    assert.equal(parseFlexibleDate("List of NBFCs removed from this list"), null);
    assert.equal(parseFlexibleDate(null), null);
  });
});

describe("hostname helpers", () => {
  it("normalises a hostname", () => {
    assert.equal(normalizeHostname("WWW.Example.CO.IN."), "example.co.in");
  });

  it("rejects things that are not hostnames", () => {
    assert.equal(normalizeHostname("no-dot"), null);
    assert.equal(normalizeHostname("has space.com"), null);
  });

  it("finds the registrable label, including under multi-part suffixes", () => {
    assert.equal(domainLabel("bajajfinserv.co.in"), "bajajfinserv");
    assert.equal(domainLabel("pay.example.com"), "example");
  });

  it("treats a sub-domain as related to its parent", () => {
    assert.equal(domainsRelated("mail.example.com", "example.com"), true);
    assert.equal(domainsRelated("example.com", "example.org"), false);
    assert.equal(domainsRelated(null, "example.com"), false);
  });
});

describe("misc parsers", () => {
  it("maps the deposit column", () => {
    assert.equal(parseYesNo("Yes"), true);
    assert.equal(parseYesNo("no"), false);
    assert.equal(parseYesNo("-"), null);
  });

  it("parses serial numbers arriving as text or numbers", () => {
    assert.equal(parseInteger("8561"), 8561);
    assert.equal(parseInteger(27), 27);
    assert.equal(parseInteger("N/A"), null);
  });

  it("scores trigram similarity between 0 and 1", () => {
    assert.equal(trigramSimilarity("bajaj finance", "bajaj finance"), 1);
    assert.ok(trigramSimilarity("bajajfinserv", "bajaj finserv") > 0.5);
    assert.ok(trigramSimilarity("bajaj finance", "zoho finance") < 0.5);
  });
});
