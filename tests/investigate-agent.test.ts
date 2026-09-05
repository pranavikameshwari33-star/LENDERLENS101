import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";

import { choosePages, investigate } from "../src/lib/investigate/agent.ts";
import { GeminiUnavailableError } from "../src/lib/investigate/gemini.ts";
import type { GeminiCallOptions, GeminiCallResult } from "../src/lib/investigate/gemini.ts";
import type { RetrievedPage } from "../src/lib/investigate/site-evidence.ts";

/**
 * The pipeline itself, driven with a fake model and a fake page fetcher.
 *
 * Four properties are being pinned down here, and they are the four the
 * investigation kept getting wrong.
 *
 * ONE GEMINI CALL. Not one per agent, not one per evidence source — one per
 * investigation, and none at all when there is nothing to reason over. The
 * counter in each test is the assertion that matters.
 *
 * A DOMAIN IS NOT AN ENTITY. The RBI publishes lists of companies, so the
 * dataset lookup that decides the outcome has to run under the COMPANY name
 * the investigation resolved, not under the domain the user typed. The tests
 * below assert the lookup name explicitly.
 *
 * RESOLUTION IS NOT VERIFICATION. Working out which company operates a website
 * says nothing about whether that company is registered. A test asserts that a
 * confidently identified company with no RBI record still comes out HIGH RISK.
 *
 * A FAILED CALL IS NOT AN ABSENCE OF EVIDENCE. Every AI failure must leave the
 * evidence where it was and report itself as an AI failure — and must still be
 * HIGH RISK, because an unfinished check is not a clean one.
 *
 * The real RBI index is used, so the entity named below is a real record in it.
 * That is test data, not a special case: the agent looks up whatever name it
 * resolves, and a test at the end asserts there is no hard-coded mapping.
 *
 * Run under --conditions=react-server: the agent is a `server-only` module.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A real, registered record in the compiled RBI index. */
const REGISTERED_ENTITY = "RNVP Technology Private Limited";

const HOME_TEXT =
  "QuickPaisa gives you instant personal loans. Loans on QuickPaisa are disbursed by " +
  `${REGISTERED_ENTITY}, a company registered with the Reserve Bank of India. ` +
  "© 2026 Quick Paisa Technologies Private Limited. All rights reserved.";

/** A site that names no company at all, in any form. */
const ANONYMOUS_TEXT =
  "Fast cash today. Apply in two minutes. No paperwork. Money in your account within the hour. " +
  "Download the app and get started right now.";

function page(url: string, text: string = HOME_TEXT): RetrievedPage {
  return {
    url,
    ok: true,
    title: "QuickPaisa — instant personal loans",
    text,
    links: [
      { url: "https://quickpaisa.example/blog", label: "Blog" },
      { url: "https://quickpaisa.example/privacy-policy", label: "Privacy Policy" },
      { url: "https://quickpaisa.example/careers", label: "Careers" },
      { url: "https://quickpaisa.example/grievance-redressal", label: "Grievance Redressal" },
      { url: "https://quickpaisa.example/about-us", label: "About us" },
    ],
    error: null,
  };
}

const UNREACHABLE: RetrievedPage = {
  url: "https://nothing-here-at-all.example/",
  ok: false,
  title: null,
  text: "",
  links: [],
  error: "The page could not be reached.",
};

/** A well-formed answer, so the success path exercises the real sanitiser. */
function answer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    entityName: "QuickPaisa",
    entityLegalName: REGISTERED_ENTITY,
    identityConfidence: "high",
    identityBasis: "the grievance-redressal page",
    aliases: [],
    regulatoryStatus: "unknown",
    regulator: null,
    registrationReference: null,
    domainRelationshipStatus: "established",
    domainRelationshipExplanation: `The site names ${REGISTERED_ENTITY} as the lender of record.`,
    evidence: [
      {
        claim: `The website is operated by ${REGISTERED_ENTITY}`,
        sourceTitle: "QuickPaisa home page",
        sourceUrl: "https://quickpaisa.example/",
        sourceType: "official_website",
        supportingText: `Loans on QuickPaisa are disbursed by ${REGISTERED_ENTITY}.`,
        kind: "fact",
      },
    ],
    findings: ["The site names a company as the lender of record."],
    conflicts: [],
    warnings: [],
    recommendedStatus: "UNVERIFIED",
    ...overrides,
  });
}

interface Recorder {
  calls: GeminiCallOptions[];
  readonly callModel: (options: GeminiCallOptions) => Promise<GeminiCallResult>;
}

function answering(text: string): Recorder {
  const calls: GeminiCallOptions[] = [];
  return {
    calls,
    callModel: async (options) => {
      calls.push(options);
      return { text, sources: [], failedUrls: [], searchQueries: [] };
    },
  };
}

function failingWith(error: unknown): Recorder {
  const calls: GeminiCallOptions[] = [];
  return {
    calls,
    callModel: async (options) => {
      calls.push(options);
      throw error;
    },
  };
}

const fetchReachable = async (url: string): Promise<RetrievedPage> => page(url);
const fetchAnonymous = async (url: string): Promise<RetrievedPage> => page(url, ANONYMOUS_TEXT);
const fetchNothing = async (): Promise<RetrievedPage> => UNREACHABLE;

const SUBJECT = { hostname: "quickpaisa.example" };

// ---------------------------------------------------------------------------
// Test 1 — a normal investigation
// ---------------------------------------------------------------------------

describe("a successful investigation", () => {
  it("makes exactly one Gemini call for one investigation", async () => {
    const model = answering(answer());
    const result = await investigate(SUBJECT, {
      callModel: model.callModel,
      fetchPage: fetchReachable,
    });

    assert.equal(model.calls.length, 1);
    assert.equal(result.geminiCalls, 1);
    assert.equal(result.status, "SUCCESS");
  });

  it("does the retrieval, the identification and the structuring in one request", async () => {
    const model = answering(answer());
    await investigate(SUBJECT, { callModel: model.callModel, fetchPage: fetchReachable });

    const [only] = model.calls;
    assert.equal(only.readUrls, true, "the one call must be able to open pages");
    assert.notEqual(only.responseSchema, undefined, "the one call must return the schema");
    assert.match(only.prompt, /entityLegalName is the REGISTERED COMPANY/);
  });

  it("gathers the evidence before asking the model, and puts it in the prompt", async () => {
    const model = answering(answer());
    await investigate(SUBJECT, { callModel: model.callModel, fetchPage: fetchReachable });

    const prompt = model.calls[0].prompt;
    assert.match(prompt, /LENDERLENS RBI REFERENCE DATA/);
    assert.match(prompt, /THE WEBSITE, AS READ/);
    assert.match(prompt, /RNVP Technology Private Limited/);
  });

  it("opens the pages that name an operator and ignores the blog", async () => {
    const opened: string[] = [];
    await investigate(SUBJECT, {
      callModel: answering(answer()).callModel,
      fetchPage: async (url) => {
        opened.push(url);
        return page(url);
      },
    });

    // The home page plus the two pages the rule chose. Never more.
    assert.equal(opened.length, 3);
    assert.ok(opened.some((url) => url.includes("grievance")));
    assert.ok(opened.some((url) => url.includes("privacy")));
    assert.ok(!opened.some((url) => url.includes("blog")));
  });

  it("does not lose an unreadable answer's evidence", async () => {
    const result = await investigate(SUBJECT, {
      callModel: answering("this is not JSON at all").callModel,
      fetchPage: fetchReachable,
    });

    assert.equal(result.status, "AI_REQUEST_FAILED");
    assert.equal(result.aiAnalysis, null);
    assert.ok(result.evidenceBundle.companyNamesFound.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — website in, company out, RBI looked up under the COMPANY
// ---------------------------------------------------------------------------

describe("a website search", () => {
  it("resolves the operating company from the website", async () => {
    const result = await investigate(SUBJECT, {
      callModel: answering(answer()).callModel,
      fetchPage: fetchReachable,
    });

    const identity = result.evidenceBundle.identity;
    assert.equal(identity.legalEntityName, REGISTERED_ENTITY);
    assert.equal(identity.brandName, "QuickPaisa");
    assert.notEqual(identity.legalEntityName, identity.brandName);
    assert.equal(identity.confidence, "high");
  });

  it("looks the RBI data up under the COMPANY name, never under the domain", async () => {
    const result = await investigate(SUBJECT, {
      callModel: answering(answer()).callModel,
      fetchPage: fetchReachable,
    });

    const regulatory = result.evidenceBundle.regulatory;
    assert.equal(regulatory.lookupName, REGISTERED_ENTITY);
    assert.notEqual(regulatory.lookupName, "quickpaisa.example");
    assert.equal(regulatory.identified, true, "the company must be found by an identifier");
    assert.equal(regulatory.standing, "registered");
    assert.equal(regulatory.entityType, "P2P");
  });

  it("keeps the identification and the regulatory answer as separate facts", async () => {
    const result = await investigate(SUBJECT, {
      callModel: answering(answer()).callModel,
      fetchPage: fetchReachable,
    });

    // Fact A is about the website. Fact B is about the company. They are
    // reported in different fields because they are different claims.
    assert.equal(result.risk.identityEstablished, true);
    assert.equal(result.risk.regulatoryEstablished, true);
    assert.notEqual(result.evidenceBundle.identity, result.evidenceBundle.regulatory);
    assert.equal(result.risk.level, "LOW_RISK");
  });

  it("records the company lookup as its own step when the name is new", async () => {
    // The site's own text names nobody, so the company comes only from the
    // reasoning step and has to be looked up after it.
    const result = await investigate(SUBJECT, {
      callModel: answering(answer()).callModel,
      fetchPage: fetchAnonymous,
    });

    const lookup = result.steps.find((step) => /Look the identified company up/.test(step.action));
    assert.ok(lookup, "the post-reasoning company lookup must be recorded");
    assert.match(lookup.detail, /RNVP Technology Private Limited/);
    assert.match(lookup.detail, /not the domain/);
    assert.match(lookup.outcome, /RNVP Technology Private Limited/);
  });

  it("reuses a lookup already made rather than repeating it", async () => {
    // The site named the company in plain HTML, so step 5 already asked. The
    // answer cannot have changed, so it is not asked again.
    const result = await investigate(SUBJECT, {
      callModel: answering(answer()).callModel,
      fetchPage: fetchReachable,
    });

    assert.equal(result.evidenceBundle.regulatory.lookupName, REGISTERED_ENTITY);
    assert.equal(
      result.steps.filter((step) => /Look the identified company up/.test(step.action)).length,
      0,
    );
  });

  it("still spends only one Gemini call doing all of that", async () => {
    const model = answering(answer());
    const result = await investigate(SUBJECT, {
      callModel: model.callModel,
      fetchPage: fetchReachable,
    });

    assert.equal(model.calls.length, 1);
    assert.equal(result.geminiCalls, 1);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — a company that resolves but cannot be verified
// ---------------------------------------------------------------------------

describe("resolution without verification", () => {
  it("is HIGH RISK when the identified company is in no RBI list", async () => {
    const result = await investigate(SUBJECT, {
      callModel: answering(
        answer({ entityLegalName: "Quick Paisa Technologies Private Limited" }),
      ).callModel,
      fetchPage: fetchReachable,
    });

    assert.equal(result.evidenceBundle.identity.legalEntityName, "Quick Paisa Technologies Private Limited");
    assert.equal(result.risk.identityEstablished, true);
    assert.equal(result.evidenceBundle.regulatory.identified, false);
    assert.equal(result.risk.regulatoryEstablished, false);
    assert.equal(result.risk.level, "HIGH_RISK");
  });

  it("is HIGH RISK when no company can be tied to the website at all", async () => {
    const result = await investigate(SUBJECT, {
      callModel: answering(
        answer({
          entityLegalName: null,
          identityConfidence: "none",
          domainRelationshipStatus: "uncertain",
        }),
      ).callModel,
      fetchPage: fetchAnonymous,
    });

    assert.equal(result.evidenceBundle.identity.legalEntityName, null);
    assert.equal(result.evidenceBundle.regulatory.lookupName, null);
    assert.equal(result.risk.level, "HIGH_RISK");
    assert.match(result.risk.reason, /no legal entity could be reliably tied/i);
  });

  it("is HIGH RISK when the company is only inferred, not read anywhere", async () => {
    // Nothing in the fetched text names it and the model opened no page, so
    // the sanitiser floors the confidence and the risk rule refuses LOW RISK.
    const result = await investigate(SUBJECT, {
      callModel: answering(answer({ entityLegalName: "Some Other Finance Limited" })).callModel,
      fetchPage: fetchAnonymous,
    });

    assert.equal(result.evidenceBundle.identity.confidence, "low");
    assert.equal(result.risk.level, "HIGH_RISK");
  });
});

// ---------------------------------------------------------------------------
// Test 1b — a company-name search
// ---------------------------------------------------------------------------

describe("a company-name search", () => {
  const COMPANY = {
    hostname: "quickpaisa.example",
    claimedName: REGISTERED_ENTITY,
    inputType: "COMPANY" as const,
    originalInput: REGISTERED_ENTITY,
  };

  it("takes the entity from the user rather than asking the model for it", async () => {
    const result = await investigate(COMPANY, {
      callModel: answering(answer({ entityLegalName: "Something Else Entirely Limited" })).callModel,
      fetchPage: fetchReachable,
    });

    // The user said what they are asking about. A model does not overrule it.
    assert.equal(result.evidenceBundle.identity.legalEntityName, REGISTERED_ENTITY);
    assert.equal(result.evidenceBundle.identity.source, "user_supplied");
  });

  it("checks that company against the RBI data, independent of any domain", async () => {
    const result = await investigate(COMPANY, {
      callModel: answering(answer()).callModel,
      fetchPage: fetchReachable,
    });

    assert.equal(result.evidenceBundle.regulatory.lookupName, REGISTERED_ENTITY);
    assert.equal(result.evidenceBundle.regulatory.identified, true);
    assert.equal(result.evidenceBundle.regulatory.standing, "registered");
  });

  it("converges on the same pipeline and the same one call", async () => {
    const model = answering(answer());
    const result = await investigate(COMPANY, {
      callModel: model.callModel,
      fetchPage: fetchReachable,
    });

    assert.equal(model.calls.length, 1);
    assert.equal(result.evidenceBundle.inputType, "COMPANY");
    assert.equal(result.evidenceBundle.originalInput, REGISTERED_ENTITY);
    assert.equal(result.status, "SUCCESS");
  });

  it("still reaches the RBI record when the website says nothing at all", async () => {
    const result = await investigate(COMPANY, {
      callModel: answering(answer({ entityLegalName: null, identityConfidence: "none" })).callModel,
      fetchPage: fetchAnonymous,
    });

    assert.equal(result.evidenceBundle.regulatory.identified, true);
    assert.equal(result.evidenceBundle.regulatory.standing, "registered");
  });
});

// ---------------------------------------------------------------------------
// Tests 4-5 — the AI fails, the evidence does not, the risk stays high
// ---------------------------------------------------------------------------

const AI_FAILURES: readonly { name: string; error: unknown; expected: string }[] = [
  {
    name: "a 429 quota exhaustion",
    error: Object.assign(new Error("RESOURCE_EXHAUSTED: You exceeded your current quota."), {
      status: 429,
    }),
    expected: "AI_QUOTA_EXCEEDED",
  },
  {
    name: "a 503 from an overloaded model",
    error: Object.assign(new Error("UNAVAILABLE: high demand"), { status: 503 }),
    expected: "AI_UNAVAILABLE",
  },
  {
    name: "an aborted request",
    error: Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    expected: "AI_REQUEST_FAILED",
  },
  {
    name: "a quota error already classified by the client",
    error: new GeminiUnavailableError("The service has used up its allowance.", "quota"),
    expected: "AI_QUOTA_EXCEEDED",
  },
];

describe("when the AI call fails", () => {
  for (const failure of AI_FAILURES) {
    it(`reports ${failure.name} as ${failure.expected}, never as insufficient evidence`, async () => {
      const result = await investigate(SUBJECT, {
        callModel: failingWith(failure.error).callModel,
        fetchPage: fetchReachable,
      });

      assert.equal(result.status, failure.expected);
      assert.notEqual(result.status, "INSUFFICIENT_EVIDENCE");
    });

    it(`keeps every piece of deterministic evidence through ${failure.name}`, async () => {
      const result = await investigate(SUBJECT, {
        callModel: failingWith(failure.error).callModel,
        fetchPage: fetchReachable,
      });

      assert.equal(result.aiAnalysis, null);
      assert.equal(result.evidenceBundle.siteReachable, true);
      assert.equal(result.evidenceBundle.pages.filter((p) => p.read).length, 3);
      assert.ok(result.evidenceBundle.companyNamesFound.includes(REGISTERED_ENTITY));
      assert.ok(result.evidenceBundle.rbiLookups.length > 0);
      assert.ok(result.steps.length > 0);
    });

    it(`keeps the company the site named, and its RBI record, through ${failure.name}`, async () => {
      // The site named a company in plain HTML and the dataset matched it, all
      // without a model. None of that is lost because the model would not run.
      const result = await investigate(SUBJECT, {
        callModel: failingWith(failure.error).callModel,
        fetchPage: fetchReachable,
      });

      assert.equal(result.evidenceBundle.identity.legalEntityName, REGISTERED_ENTITY);
      assert.equal(result.evidenceBundle.identity.source, "website_text");
      assert.equal(result.evidenceBundle.regulatory.identified, true);
    });

    it(`keeps the deterministic RBI verdict through ${failure.name}, without claiming the AI verified anything`, async () => {
      // The site named the company in plain HTML and the RBI data identified
      // it as currently registered — both facts established before the model
      // was asked anything. The model failing afterwards says nothing about
      // this lender, so it does not turn a verified one into a risky one. What
      // it must never do is let an AI conclusion be shown: there is none.
      const result = await investigate(SUBJECT, {
        callModel: failingWith(failure.error).callModel,
        fetchPage: fetchReachable,
      });

      assert.equal(result.risk.level, "LOW_RISK");
      assert.equal(result.risk.regulatoryEstablished, true);
      assert.equal(result.aiAnalysis, null, "no AI conclusion may be presented");
    });

    it(`is HIGH RISK after ${failure.name} when nothing else established the facts`, async () => {
      const result = await investigate(SUBJECT, {
        callModel: failingWith(failure.error).callModel,
        fetchPage: fetchAnonymous,
      });

      assert.equal(result.risk.level, "HIGH_RISK");
      assert.match(result.risk.reason, /could not be completed/i);
      assert.equal(result.aiAnalysis, null, "no AI conclusion may be presented");
    });

    it(`says why, in words that are safe to show, after ${failure.name}`, async () => {
      const result = await investigate(SUBJECT, {
        callModel: failingWith(failure.error).callModel,
        fetchPage: fetchReachable,
      });

      assert.ok(result.statusDetail && result.statusDetail.length > 0);
      assert.ok(!/insufficient/i.test(result.statusDetail));
      assert.ok(!/insufficient/i.test(result.statusLabel));
    });

    it(`spends one call and does not retry after ${failure.name}`, async () => {
      const model = failingWith(failure.error);
      const result = await investigate(SUBJECT, {
        callModel: model.callModel,
        fetchPage: fetchReachable,
      });

      assert.equal(model.calls.length, 1);
      assert.equal(result.geminiCalls, 1);
    });
  }
});

// ---------------------------------------------------------------------------
// Evidence genuinely absent
// ---------------------------------------------------------------------------

describe("when there is genuinely nothing to investigate", () => {
  it("reports insufficient evidence without spending a Gemini call", async () => {
    const model = answering(answer());
    const result = await investigate(
      { hostname: "nothing-here-at-all.example" },
      { callModel: model.callModel, fetchPage: fetchNothing },
    );

    assert.equal(result.status, "INSUFFICIENT_EVIDENCE");
    assert.equal(model.calls.length, 0);
    assert.equal(result.geminiCalls, 0);
    assert.equal(result.aiAnalysis, null);
    assert.equal(result.evidenceBundle.siteReachable, false);
  });

  it("is HIGH RISK, because a lender nobody can identify is not a safe one", async () => {
    const result = await investigate(
      { hostname: "nothing-here-at-all.example" },
      { callModel: answering(answer()).callModel, fetchPage: fetchNothing },
    );

    assert.equal(result.risk.level, "HIGH_RISK");
    assert.equal(result.risk.identityEstablished, false);
  });

  it("still asks the model when the user supplied a name to work from", async () => {
    const model = answering(answer());
    const result = await investigate(
      { hostname: "nothing-here-at-all.example", claimedName: REGISTERED_ENTITY },
      { callModel: model.callModel, fetchPage: fetchNothing },
    );

    assert.equal(model.calls.length, 1);
    assert.notEqual(result.status, "INSUFFICIENT_EVIDENCE");
  });
});

// ---------------------------------------------------------------------------
// No special cases
// ---------------------------------------------------------------------------

describe("the resolution mechanism", () => {
  it("contains no hard-coded domain-to-company mapping", () => {
    // The i2ifunding.com case has to fall out of the general mechanism. A
    // lookup table would pass a demo and fail every other lending website.
    for (const file of [
      "src/lib/investigate/agent.ts",
      "src/lib/investigate/knowledge.ts",
      "src/lib/investigate/risk.ts",
      "src/lib/investigate/schema.ts",
    ]) {
      const source = fs.readFileSync(file, "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      assert.ok(!/i2ifunding/i.test(code), `${file} must not special-case a domain`);
      assert.ok(!/RNVP/i.test(code), `${file} must not special-case a company`);
    }
  });
});

// ---------------------------------------------------------------------------
// The step that stopped being a model call
// ---------------------------------------------------------------------------

describe("choosing which pages to open", () => {
  it("prefers the pages a lender is obliged to publish", () => {
    const chosen = choosePages([
      { url: "https://x.example/blog", label: "Blog" },
      { url: "https://x.example/about", label: "About us" },
      { url: "https://x.example/privacy", label: "Privacy policy" },
      { url: "https://x.example/grievance", label: "Grievance officer" },
    ]);

    assert.deepEqual(
      chosen.map((link) => link.url),
      ["https://x.example/grievance", "https://x.example/privacy"],
    );
  });

  it("reads the link's own words when the path says nothing", () => {
    const chosen = choosePages([
      { url: "https://x.example/p/17", label: "Terms and Conditions" },
      { url: "https://x.example/p/18", label: "Press" },
    ]);

    assert.deepEqual(chosen.map((link) => link.url), ["https://x.example/p/17"]);
  });

  it("opens nothing when nothing on the page looks useful", () => {
    assert.deepEqual(choosePages([{ url: "https://x.example/blog", label: "Blog" }]), []);
  });

  it("never opens more than two", () => {
    const chosen = choosePages([
      { url: "https://x.example/privacy", label: "Privacy" },
      { url: "https://x.example/terms", label: "Terms" },
      { url: "https://x.example/legal", label: "Legal" },
      { url: "https://x.example/grievance", label: "Grievance" },
    ]);

    assert.equal(chosen.length, 2);
  });
});
