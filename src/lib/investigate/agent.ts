import "server-only";

/**
 * The investigation agent.
 *
 * One agent, three tools, a fixed budget. It runs only for cases the
 * deterministic verification could not settle (see `trigger.ts`), and it
 * answers one question:
 *
 *     who operates this lending website, and can that operator be tied to
 *     anything authoritative?
 *
 * Not "is this a scam". The distinction is the product.
 *
 * A DOMAIN IS NOT AN ENTITY. This is the reason the pipeline is shaped the way
 * it is. The RBI publishes lists of COMPANIES, so looking up `i2ifunding.com`
 * in them finds nothing and always will — the company that owns that website is
 * RNVP Technology Private Limited, and that is the name the RBI holds a record
 * for. Searching an entity dataset with a domain and reporting the miss as
 * "insufficient evidence" is answering a question nobody asked. So a website
 * search resolves the operator FIRST and looks the operator up SECOND.
 *
 * The shape is agentic RAG, and being agentic is not the same as calling a
 * language model at every step. Most of the work here is deterministic, local
 * and free; the model is asked exactly once, for the one thing only a model can
 * do — read the evidence, name the legal entity behind the brand, and reason.
 *
 *   1. RETRIEVE   what does LenderLens already know about this domain or name?
 *   2. RETRIEVE   read the website itself.
 *   3. DECIDE     choose which further pages are worth opening, from links that
 *                 actually exist on the page. A rule, not a model call: the
 *                 pages that name a legal operator announce themselves —
 *                 privacy policy, terms, grievance officer, partner lender.
 *   4. RETRIEVE   open those pages.
 *   5. RETRIEVE   check every company name found in the text against the RBI
 *                 data. Local, free, and enough on its own for a plain HTML
 *                 site that names its NBFC in the footer.
 *   6. REASON     ONE Gemini call. It gets the whole evidence bundle, it may
 *                 open authoritative pages of its own, and it returns the
 *                 brand name, the LEGAL ENTITY name and the result schema.
 *   7. LOOK UP    the legal entity the model resolved, in the RBI data. Local,
 *                 free, deterministic, and the step that turns a resolved
 *                 company into a regulatory answer.
 *   8. ASSESS     the risk, from those two facts. Deterministic. See risk.ts.
 *
 * Step 7 is deliberately AFTER the model and deliberately not done BY it.
 * Resolution and verification are different acts: the model may propose that
 * this website belongs to RNVP Technology Private Limited, but whether that
 * company is registered is answered by the dataset, not by the thing that
 * proposed the name.
 *
 * ONE Gemini call per investigation, at most: retrieval and structuring are the
 * same request, because the retrieval tool and a response schema combine. Three
 * page fetches at most, a dozen dataset lookups — which cost nothing, being
 * local. No loop that can run away, no unbounded tool use, and no retry.
 *
 * When that one call fails, the investigation does NOT fail. Everything
 * gathered in steps 1-5 is returned with a status saying the AI was
 * unavailable — which is a fact about LenderLens, and must never be printed as
 * "insufficient evidence", which is a fact about a website. See `failure.ts`.
 * The user-facing risk is HIGH either way, because an unfinished check is not a
 * clean one.
 */

import { websiteUrlFor } from "../verify/input";
import {
  callGemini,
  geminiModel,
  GeminiUnavailableError,
  isGeminiConfigured,
  parseJsonResponse,
  searchGroundingEnabled,
} from "./gemini";
import {
  classifyGeminiFailure,
  geminiFailure,
  INVESTIGATION_RUN_STATUS_LABELS,
  statusForFailure,
  type GeminiFailure,
} from "./failure";
import { describeKnownEntities, searchKnownEntities, type KnownEntitySearch } from "./knowledge";
import { assessRisk, unresolvedRisk, type IdentityConfidence, type InvestigationRisk } from "./risk";
import { INVESTIGATION_RESPONSE_SCHEMA, sanitizeInvestigation } from "./schema";
import { retrievePage, type PageLink, type RetrievedPage } from "./site-evidence";
import {
  type DatasetLookupEvidence,
  type DatasetMatchEvidence,
  type EvidenceBundle,
  type InvestigationAnalysis,
  type InvestigationInputType,
  type InvestigationResult,
  type InvestigationStep,
  type PageEvidence,
  type RegulatoryEvidence,
  type ResolvedIdentity,
} from "./types";

/** Thrown only when the investigation could not START. Never for AI failures. */
export class InvestigationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvestigationUnavailableError";
  }
}

/** The budget. Nothing in this file may exceed these. */
const MAX_EXTRA_PAGES = 2;
/** Names checked against the RBI data. Local lookups: no model, no cost. */
const MAX_NAME_LOOKUPS = 8;
const MAX_PAGE_TEXT_IN_PROMPT = 4_000;
/** Below this, a page rendered almost nothing to the fetcher. */
const THIN_PAGE_CHARS = 600;
/**
 * How long the one call may take.
 *
 * Two budgets, because the work is not the same size in both cases. When the
 * site rendered plain HTML, its text is already in the prompt and the model
 * mostly has to read and structure it. When the site builds itself in the
 * browser and handed our fetcher a hundred characters, the model has to go and
 * open the pages itself before it can name anyone — that is real retrieval,
 * over several round trips, and 45 seconds is not enough for it. Being mean
 * here does not save a call: it spends one and throws the answer away.
 */
const REASONING_TIMEOUT_MS = 45_000;
const THIN_SITE_REASONING_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// System instruction
// ---------------------------------------------------------------------------

const SYSTEM_INSTRUCTION = `You are the LenderLens investigation agent.

Your job is to gather and organise EVIDENCE about lending websites. You are not
a chatbot, you give no advice, and you never decide on your own authority
whether a website is safe.

You investigate four things, in this order:
1. the domain;
2. the organisation operating it;
3. that organisation's regulatory or otherwise authoritative standing;
4. whether the evidence ties the domain to that organisation.

A BRAND IS NOT A COMPANY. A lending website is marketed under a name nobody
registers, and operated by a company whose name appears only in a legal
document — a short app-like brand in the logo, a "... Private Limited" in the
footer of the privacy policy. Report both, separately, and never put the brand
where the legal name belongs. The legal name is the one a regulator would hold
a record for, so if a page, footer, policy or disclosure gives it, that is the
single most valuable thing you can return.

Rules that override anything else:
- Never invent a company name, a registration or licence number, a regulatory
  status, a source, a quotation or a URL. If you did not read it in the
  material provided to you, or on a page you opened yourself, it does not
  exist. Say so with identityConfidence "none" rather than guessing.
- Absence is not guilt. A domain missing from a dataset, or a company you can
  find nothing about, is UNVERIFIED. It is never evidence of fraud, and you must
  not describe it as such.
- Where sources disagree, say so explicitly rather than choosing one.
- Prefer primary and authoritative sources: a regulator, a government register,
  the company's own legal documents. A blog, a forum or an SEO listing never
  outweighs an authoritative source that contradicts it.
- Separate fact from inference. A fact is something a source states. An
  inference is a conclusion you drew by putting sources together.
- Never produce a score, a percentage, a rating or a confidence number.
- Be concise. Every sentence must carry evidence.`;

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

export interface InvestigationInput {
  /** Normalised hostname, from the existing input parser. */
  readonly hostname: string;
  /** The lender name the user supplied, if any. */
  readonly claimedName?: string | null;
  /** Which search bar the user used. Defaults to WEBSITE. */
  readonly inputType?: InvestigationInputType;
  /** Exactly what the user typed. Kept for display; never normalised away. */
  readonly originalInput?: string | null;
}

/**
 * Seams for the tests. Both default to the real thing; the tests supply fakes
 * so quota, overload and abort can be exercised without an API key and without
 * touching the network.
 */
export interface InvestigationDeps {
  readonly callModel?: typeof callGemini;
  readonly fetchPage?: typeof retrievePage;
}

export async function investigate(
  input: InvestigationInput,
  deps: InvestigationDeps = {},
): Promise<InvestigationResult> {
  if (!isGeminiConfigured() && deps.callModel === undefined) {
    throw new InvestigationUnavailableError("The investigation service is not configured.");
  }

  const callModel = deps.callModel ?? callGemini;
  const fetchPage = deps.fetchPage ?? retrievePage;

  const startedAt = Date.now();
  const hostname = input.hostname;
  const claimedName = input.claimedName ?? null;
  const inputType: InvestigationInputType = input.inputType ?? "WEBSITE";
  const originalInput = input.originalInput ?? (inputType === "COMPANY" ? (claimedName ?? hostname) : hostname);

  const steps: InvestigationStep[] = [];
  const notices: string[] = [];
  const record = (action: string, detail: string, outcome: string): void => {
    steps.push({ order: steps.length + 1, action, detail, outcome });
  };

  console.info(
    `[LenderLens] Investigation started | input_type=${inputType} | original_input=${originalInput} | normalized_domain=${hostname}`,
  );

  // --- STEP 1: what do we already know? ------------------------------------
  //
  // For a COMPANY search this is the real lookup: the user named the entity, so
  // the entity dataset is searched under that name straight away and no model
  // is needed to work out who is being asked about. For a WEBSITE search this
  // is only a cheap first try — the RBI publishes a website for very few
  // records, so a miss here means nothing and the operator still has to be
  // resolved from the site itself.
  let firstLookup: KnownEntitySearch;
  try {
    firstLookup = searchKnownEntities({ hostname, organizationName: claimedName });
    record(
      inputType === "COMPANY"
        ? "Search LenderLens RBI data for the company you named"
        : "Search LenderLens RBI data",
      `domain ${hostname}${claimedName ? `, name "${claimedName}"` : ""}`,
      firstLookup.matches.length > 0
        ? `${firstLookup.matches.length} record(s): ${firstLookup.matches.map((m) => m.name).join(", ")}`
        : "No matching RBI record",
    );
  } catch {
    firstLookup = {
      query: { hostname, organizationName: claimedName },
      matches: [],
      datasetAsOf: null,
    };
    notices.push("The RBI reference data could not be read during this investigation.");
    record("Search LenderLens RBI data", hostname, "Reference data unavailable");
  }

  // Who does the RBI say this DOMAIN belongs to?
  //
  // Asked with the domain alone, deliberately. `searchKnownEntities` will not
  // let a domain identify a record in a search that also carries a company
  // name — that would answer a question about one company with a record that
  // matched a URL — so when the user supplied a name, this question has to be
  // put separately to be put at all. Local index lookups, so asking twice costs
  // nothing and no model is involved.
  let domainOwnerLookup: KnownEntitySearch = firstLookup;
  if (claimedName !== null) {
    try {
      domainOwnerLookup = searchKnownEntities({ hostname });
      record(
        "Ask the RBI data who this domain belongs to",
        `domain ${hostname} alone, without the name you supplied`,
        domainOwnerLookup.matches.length > 0
          ? `${domainOwnerLookup.matches.length} record(s): ${domainOwnerLookup.matches
              .map((m) => `${m.name} (${m.foundBy})`)
              .join("; ")}`
          : "The RBI data publishes no website or contact address on this domain",
      );
    } catch {
      // Already reported by the lookup above; the domain question simply goes
      // unanswered rather than failing the investigation.
    }
  }

  // --- STEP 2: read the website --------------------------------------------
  const homePage = await fetchPage(websiteUrlFor(hostname), hostname);
  record(
    "Open the website",
    websiteUrlFor(hostname),
    homePage.ok
      ? `Read ${homePage.text.length} characters; ${homePage.links.length} internal links found`
      : (homePage.error ?? "Could not be read"),
  );

  const pages: RetrievedPage[] = homePage.ok ? [homePage] : [];
  const pageEvidence: PageEvidence[] = [describePage(homePage)];

  if (!homePage.ok) {
    notices.push(
      `The website could not be read (${homePage.error ?? "no response"}), so the investigation ` +
        "worked from the domain name alone.",
    );
  }

  // A site that renders in the browser gives a plain fetcher almost nothing.
  // Worth knowing, worth telling the user, and worth telling the model — it is
  // the difference between "this site discloses no operator" and "this site
  // discloses nothing to us".
  const thinSite =
    homePage.ok && homePage.text.length < THIN_PAGE_CHARS && homePage.links.length === 0;
  if (thinSite) {
    notices.push(
      "The website builds its pages in the browser, so almost no text could be read from it " +
        "directly. What the investigation knows about it therefore comes from pages opened during " +
        "the reasoning step rather than from the site as fetched.",
    );
  }

  // --- STEP 3: choose the pages worth opening next -------------------------
  //
  // This used to be a model call. It is a rule now, and the rule is as good,
  // because the pages that name a legal operating entity are the ones with
  // conventional names: a privacy policy, terms and conditions, a grievance
  // officer page, a partner-lender disclosure. Scoring the site's own link
  // text and paths finds them, costs nothing, and cannot invent a link that is
  // not on the page.
  const chosen = homePage.ok ? choosePages(homePage.links) : [];
  if (homePage.ok) {
    record(
      "Choose which further pages to open",
      `${homePage.links.length} internal link(s) considered`,
      chosen.length > 0
        ? chosen.map((link) => link.url).join(", ")
        : "No page on the site looked likely to name the operator",
    );
  }

  // --- STEP 4: open them ---------------------------------------------------
  for (const link of chosen) {
    const page = await fetchPage(link.url, hostname);
    if (page.ok) pages.push(page);
    pageEvidence.push(describePage(page));
    record(
      "Open a page likely to name the operator",
      link.url,
      page.ok ? `Read ${page.text.length} characters` : (page.error ?? "Could not be read"),
    );
  }

  // --- STEP 5: look up every company name the site actually names ----------
  //
  // Indian company names are self-announcing — they end in Limited, Ltd or Pvt
  // Ltd — and on a plain HTML site the NBFC that lends the money is named in
  // the footer or the FAQ. Where that is true this finds the regulated lender
  // behind an unknown brand for nothing, before any model is involved.
  const mentionedNames = extractCompanyNames(pages.map((page) => page.text).join(" "));
  const alreadyAsked = new Set([hostname, claimedName ?? ""].map((value) => value.toLowerCase()));
  const namesToLookUp = mentionedNames
    .filter((name) => !alreadyAsked.has(name.toLowerCase()))
    .slice(0, MAX_NAME_LOOKUPS);

  const nameLookups: { readonly name: string; readonly search: KnownEntitySearch }[] = [];
  for (const name of namesToLookUp) {
    const search = lookUpCompany(name);
    if (search && search.matches.length > 0) nameLookups.push({ name, search });
  }

  if (namesToLookUp.length > 0) {
    const found = nameLookups.flatMap((lookup) => lookup.search.matches.map((m) => m.name));
    record(
      "Search LenderLens RBI data under every company name the site names",
      namesToLookUp.map((name) => `"${name}"`).join(", "),
      found.length > 0
        ? `${found.length} record(s): ${[...new Set(found)].join(", ")}`
        : "No matching RBI record",
    );
  }

  const rbiLookups: DatasetLookupEvidence[] = [
    {
      query: `domain ${hostname}${claimedName ? ` and the name "${claimedName}"` : ""}`,
      matches: firstLookup.matches.map(describeMatch),
    },
    ...nameLookups.map((lookup) => ({
      query: `"${lookup.name}", a company named on the site`,
      matches: lookup.search.matches.map(describeMatch),
    })),
  ];

  // --- what is known WITHOUT the model, for every failure path below -------
  //
  // A company search already has its entity: the user typed it. A website
  // search may already have one too, if the site's own text named a company
  // that the RBI data then matched by identifier. Either way this is Fact A
  // established deterministically, and it survives an AI failure.
  const deterministicIdentity = resolveDeterministically({
    inputType,
    claimedName,
    domainOwnerLookup,
    nameLookups,
  });

  // Fact B for every path that does not reach the model.
  //
  // When Fact A was established deterministically — the user named the company,
  // the site printed it, or the RBI publishes this domain for it — the entity
  // lookup that answers Fact B does not depend on the model either, so it is
  // done here as well as in step 7. Without this an AI failure showed a
  // resolved operator beside "no company name could be established, so there
  // was nothing to look up", which is not what happened. The risk stays HIGH
  // on this path regardless: an unfinished check is not a clean one, and that
  // is `aiCompleted`, not this.
  let deterministicRegulatory = regulatoryEvidenceFor(deterministicIdentity.legalEntityName, {
    firstLookup,
    nameLookups,
  });

  if (deterministicIdentity.legalEntityName !== null && deterministicRegulatory.lookupName === null) {
    const search = lookUpCompany(deterministicIdentity.legalEntityName);
    if (search) deterministicRegulatory = describeRegulatory(deterministicIdentity.legalEntityName, search);
  }

  console.info(
    `[LenderLens] Evidence sources queried: ${
      1 + pageEvidence.filter((page) => page.read).length + nameLookups.length
    }`,
  );

  const bundleFor = (
    identity: ResolvedIdentity,
    regulatory: RegulatoryEvidence,
    relationshipBasis: string | null,
  ): EvidenceBundle => ({
    inputType,
    originalInput,
    submittedDomain: hostname,
    claimedName,
    identity,
    regulatory,
    relationshipBasis,
    datasetAsOf: firstLookup.datasetAsOf,
    rbiLookups,
    rbiMatchCount: rbiLookups.reduce((total, lookup) => total + lookup.matches.length, 0),
    pages: pageEvidence,
    companyNamesFound: mentionedNames,
    siteReachable: homePage.ok,
  });

  const finish = (
    status: InvestigationResult["status"],
    statusDetail: string | null,
    risk: InvestigationRisk,
    evidenceBundle: EvidenceBundle,
    aiAnalysis: InvestigationAnalysis | null,
    extraNotices: readonly string[],
    geminiCalls: number,
  ): InvestigationResult => {
    logOutcome(evidenceBundle, risk, status, geminiCalls);
    return {
      status,
      statusLabel: INVESTIGATION_RUN_STATUS_LABELS[status],
      statusDetail,
      domain: hostname,
      risk,
      evidenceBundle,
      aiAnalysis,
      steps,
      notices: [...notices, ...extraNotices],
      investigatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      model: geminiModel(),
      geminiCalls,
    };
  };

  const degraded = (
    status: InvestigationResult["status"],
    statusDetail: string | null,
    riskReason: string,
    extraNotices: readonly string[],
    geminiCalls: number,
  ): InvestigationResult => {
    // The evidence gathered before the model was ever asked is graded by the
    // same rules as the evidence gathered after it. Where that evidence alone
    // established the operating company AND a current RBI registration for it,
    // the AI being unavailable does not turn a verified lender into a risky
    // one. Where it did not, this returns HIGH RISK and the path's own reason —
    // the one that says what actually went wrong — is the one shown.
    const deterministicRisk = assessRisk({
      aiCompleted: false,
      legalEntityName: deterministicIdentity.legalEntityName,
      identityConfidence: deterministicIdentity.confidence,
      regulatoryIdentified: deterministicRegulatory.identified,
      regulatoryStanding: deterministicRegulatory.standing,
      // The same tie the model is not needed for: the RBI publishing this
      // domain for the company, or the company being named on the site itself
      // and then found in the RBI data by identifier.
      domainTied:
        deterministicIdentity.source === "rbi_published_domain" ||
        deterministicIdentity.source === "website_text",
      conflicts: 0,
    });

    return finish(
      status,
      statusDetail,
      deterministicRisk.level === "LOW_RISK" ? deterministicRisk : unresolvedRisk(riskReason),
      bundleFor(deterministicIdentity, deterministicRegulatory, null),
      null,
      extraNotices,
      geminiCalls,
    );
  };

  // --- nothing to reason about? then do not spend a call at all ------------
  //
  // The site did not answer, the RBI data holds nothing, no company name was
  // found anywhere and the user gave no name. There is no evidence for a model
  // to reason over, so none is asked. This is the one case where INSUFFICIENT
  // EVIDENCE is the honest internal status — and it is still HIGH RISK, because
  // a lender nobody can identify is not a lender anybody should pay.
  const somethingToReasonAbout =
    homePage.ok || rbiLookups.some((lookup) => lookup.matches.length > 0) || claimedName !== null;

  if (!somethingToReasonAbout) {
    record(
      "Reason over the evidence (Gemini)",
      "not attempted",
      "Nothing was retrieved to reason over, so no AI call was made",
    );
    console.info("[LenderLens] Gemini status: NOT_ATTEMPTED");

    return degraded(
      "INSUFFICIENT_EVIDENCE",
      null,
      "The website did not respond and no company could be identified from anywhere, so nothing " +
        "about this lender could be verified. An unverifiable lending website is treated as high " +
        "risk.",
      [
        "The website did not respond and no company name could be recovered from anywhere, so " +
          "there was nothing for the investigation to work from. That is a statement about what " +
          "could be found, and nothing more.",
      ],
      0,
    );
  }

  // --- STEP 6: the one Gemini call -----------------------------------------
  //
  // Retrieval, identification and structuring in a single request. The
  // URL-context tool lets the model open pages it considers authoritative — a
  // regulator, the operator's own legal documents — and the API reports which
  // of those it actually managed to read, which is what makes citing them safe:
  // a URL the model merely wrote down comes back as a failed retrieval and is
  // dropped by the sanitiser.
  if (searchGroundingEnabled()) {
    notices.push(
      "Google Search grounding is enabled on this deployment but cannot be combined with the " +
        "structured answer this investigation requires, so the investigation opened pages " +
        "directly instead of searching.",
    );
  }

  const datasetSummary = [
    `Lookup by domain${claimedName ? " and the name supplied by the user" : ""}:`,
    describeKnownEntities(firstLookup),
    ...nameLookups.map(
      (lookup) =>
        `\nLookup by "${lookup.name}" (a company name found in the material read):\n${describeKnownEntities(lookup.search)}`,
    ),
  ].join("\n");

  const siteSummary =
    pages.length > 0
      ? pages
          .map(
            (page) =>
              `PAGE ${page.url}\nTITLE: ${page.title ?? "(none)"}\nTEXT: ${page.text.slice(0, MAX_PAGE_TEXT_IN_PROMPT)}`,
          )
          .join("\n\n")
      : "The website could not be read.";

  const prompt = `Domain under investigation: ${hostname}
The user searched by ${inputType === "COMPANY" ? "COMPANY NAME" : "WEBSITE URL"}, and typed: ${originalInput}
${claimedName ? `The user says the lender is called "${claimedName}".\n` : ""}
=== LENDERLENS RBI REFERENCE DATA (already retrieved; do not look it up again) ===
${datasetSummary}

=== THE WEBSITE, AS READ (already retrieved; do not fetch these pages again) ===
${siteSummary}
${
  thinSite
    ? `\nNOTE: this site builds its pages in the browser, so the text above is nearly empty. That is
a limitation of how it was fetched, NOT evidence that the site discloses nothing. Open
https://${hostname}/ and its legal pages — about, terms, privacy policy, grievance redressal,
partner lenders — yourself to find the operating company.\n`
    : ""
}
Two tasks, in one answer.

FIRST, identify WHO OPERATES this website, and establish what authoritative
sources say about that operator.

  - entityName is the BRAND the site trades under.
  - entityLegalName is the REGISTERED COMPANY behind it — the "XYZ Private
    Limited" named in a footer, a policy, a disclosure or a registration
    statement. These are usually different names, and the legal one is the one
    that matters. Do not put the brand here.
  - identityConfidence says how firmly the material supports that legal name,
    and identityBasis says which page or document you read it from.
  - If no legal entity can be established, entityLegalName is null and
    identityConfidence is "none". That is an acceptable and useful answer. It is
    far better than a plausible guess.

The material above may already answer it. Where it does not, open the pages you
consider authoritative and report what they actually say — preferring, in this
order: the Reserve Bank of India or another official regulator or government
register; the operator's own official website and its legal documents; then
reputable secondary reporting. If a page does not open, move on and do not
describe its contents.

SECOND, structure everything into the required JSON.

Requirements:
- Cite only URLs that appear in the material above or that you actually opened
  and read during this request. A URL you cannot see and did not open must be
  null.
- Use sourceType "lenderlens_dataset" for anything taken from the RBI reference
  data section, with a null URL. Note that a lookup reporting NO match is not
  evidence that a lender is unregistered, nor that it is registered.
- regulatoryStatus is "confirmed" only if a regulator, a government register or
  a POSITIVE match in the RBI reference data shows this operator is authorised;
  otherwise "not_confirmed" when a source positively fails to corroborate it, or
  "unknown" when nothing was found either way.
- domainRelationshipStatus describes how strongly the evidence ties ${hostname}
  to the entity you have identified — "established" only when a source ties the
  domain and the legal entity together directly.
- recommendedStatus: VERIFIED only with authoritative regulatory evidence AND an
  established or likely domain relationship; CAUTION when evidence conflicts or
  raises an unresolved concern; UNVERIFIED when the evidence is simply not
  there. UNVERIFIED is a statement about the evidence, never an accusation.`;

  let response;
  try {
    response = await callModel({
      systemInstruction: SYSTEM_INSTRUCTION,
      prompt,
      maxOutputTokens: 2_400,
      timeoutMs: thinSite ? THIN_SITE_REASONING_TIMEOUT_MS : REASONING_TIMEOUT_MS,
      readUrls: true,
      responseSchema: INVESTIGATION_RESPONSE_SCHEMA,
    });
  } catch (error) {
    // The single most important branch in this file. A model that would not
    // answer is a fact about LenderLens; the evidence gathered above is
    // untouched by it, and is returned in full.
    const failure: GeminiFailure =
      error instanceof GeminiUnavailableError
        ? geminiFailure(error.kind)
        : classifyGeminiFailure(error);

    record("Reason over the evidence (Gemini)", "one consolidated call", failure.message);
    console.info(`[LenderLens] Gemini status: ${failure.kind.toUpperCase()}`);

    return degraded(
      statusForFailure(failure.kind),
      failure.message,
      "The investigation could not be completed, so this website has not been verified. An " +
        "unfinished check is not a clean one: treat this lender as unverified until it can be run " +
        "again.",
      [
        `${failure.message} The evidence LenderLens gathered itself is shown in full and is ` +
          "unaffected — none of this means the evidence was missing.",
      ],
      1,
    );
  }

  const payload = parseJsonResponse(response.text);
  if (payload === null) {
    record(
      "Reason over the evidence (Gemini)",
      "one consolidated call",
      "The structured answer could not be read",
    );
    console.info("[LenderLens] Gemini status: UNREADABLE");

    return degraded(
      statusForFailure("failed"),
      "The AI investigation returned an answer that could not be read.",
      "The investigation could not be completed, so this website has not been verified. Treat " +
        "this lender as unverified until the check can be run again.",
      [
        "The AI investigation answered in a form LenderLens could not read, so its reasoning is " +
          "not shown. The evidence gathered above is unaffected.",
      ],
      1,
    );
  }

  record(
    "Reason over the evidence and name the operating company (Gemini)",
    "RBI records, website text, and pages the investigation opened itself",
    "Structured result produced" +
      (response.sources.length > 0 ? `; ${response.sources.length} external page(s) opened` : "") +
      (response.failedUrls.length > 0
        ? `; ${response.failedUrls.length} could not be opened and were discarded`
        : ""),
  );
  console.info("[LenderLens] Gemini status: SUCCESS");

  const sanitized = sanitizeInvestigation(payload, {
    domain: hostname,
    retrievedUrls: [...pages.map((page) => page.url), ...response.sources.map((s) => s.url)],
    // Deliberately WITHOUT response.text. The corpus exists to check the
    // model's claims against something independent, and the model's own answer
    // is not independent of itself: including it let a company name or a
    // registration number corroborate itself simply by being asserted.
    retrievedText: [
      datasetSummary,
      ...pages.map((page) => page.text),
      ...response.sources.map((source) => `${source.title} ${source.url}`),
    ].join("\n"),
    // Corroboration requires a lookup that actually FOUND something. See
    // schema.ts: without this, "no record matched" counted as authoritative.
    hasPositiveDatasetMatch: rbiLookups.some((lookup) => lookup.matches.length > 0),
    modelOpenedPages: response.sources.length > 0,
  });

  // --- STEP 7: look the RESOLVED COMPANY up in the RBI data ---------------
  //
  // The step the whole redesign is for. The model has just named a legal
  // entity; that name — never the domain — is now the key into an entity
  // dataset. Local, free, deterministic, and emphatically not done by the
  // thing that proposed the name: resolution and verification are separate
  // acts, and a model must not be allowed to mark its own work.
  const identity = resolveIdentity({
    inputType,
    claimedName,
    sanitized,
    deterministicIdentity,
  });

  let regulatory = regulatoryEvidenceFor(identity.legalEntityName, { firstLookup, nameLookups });

  if (
    identity.legalEntityName !== null &&
    regulatory.lookupName === null &&
    !alreadyAsked.has(identity.legalEntityName.toLowerCase())
  ) {
    const search = lookUpCompany(identity.legalEntityName);
    if (search) {
      regulatory = describeRegulatory(identity.legalEntityName, search);
      rbiLookups.push({
        query: `"${identity.legalEntityName}", the company the investigation identified`,
        matches: search.matches.map(describeMatch),
      });
      record(
        "Look the identified company up in the RBI data",
        `"${identity.legalEntityName}" (not the domain — the RBI publishes lists of companies)`,
        search.matches.length > 0
          ? `${search.matches.length} record(s): ${search.matches
              .map((m) => `${m.name} — ${m.standingLabel} (${m.foundBy})`)
              .join("; ")}`
          : "No matching RBI record",
      );
    }
  }

  // --- STEP 8: the risk, from the two facts, deterministically ------------
  const risk = assessRisk({
    aiCompleted: true,
    legalEntityName: identity.legalEntityName,
    identityConfidence: identity.confidence,
    regulatoryIdentified: regulatory.identified,
    regulatoryStanding: regulatory.standing,
    // Either the evidence read during this investigation ties the domain to the
    // company, or the RBI's own record does. The second does not depend on the
    // model having managed to read a site that renders in the browser.
    domainTied:
      identity.source === "rbi_published_domain" ||
      sanitized.domainRelationship.status === "established" ||
      sanitized.domainRelationship.status === "likely",
    conflicts: sanitized.conflicts.length,
  });

  return finish(
    "SUCCESS",
    null,
    risk,
    bundleFor(identity, regulatory, sanitized.domainRelationship.explanation),
    {
      identifiedEntity: sanitized.identifiedEntity,
      identityConfidence: sanitized.identityConfidence,
      identityBasis: sanitized.identityBasis,
      regulatoryStatus: sanitized.regulatoryStatus,
      domainRelationship: sanitized.domainRelationship,
      evidence: sanitized.evidence,
      findings: sanitized.findings,
      conflicts: sanitized.conflicts,
      warnings: sanitized.warnings,
      recommendedStatus: sanitized.recommendedStatus,
      recommendedStatusLabel: sanitized.recommendedStatusLabel,
    },
    sanitized.notices,
    1,
  );
}

// ---------------------------------------------------------------------------
// Fact A — who does this website belong to?
// ---------------------------------------------------------------------------

interface DeterministicInput {
  readonly inputType: InvestigationInputType;
  readonly claimedName: string | null;
  /** The RBI lookup made under the DOMAIN alone. Never carries a name. */
  readonly domainOwnerLookup: KnownEntitySearch;
  readonly nameLookups: readonly { readonly name: string; readonly search: KnownEntitySearch }[];
}

const UNRESOLVED: ResolvedIdentity = {
  brandName: null,
  legalEntityName: null,
  confidence: "none",
  basis: null,
  source: "unresolved",
};

/**
 * What can be said about the operator without asking a model anything.
 *
 * A company search has its answer already: the user typed the entity name. A
 * website search may have one too, when the site's own text named a company
 * and the RBI data then matched that name by identifier — a plain HTML site
 * that names its NBFC in the footer needs no AI at all. Anything weaker stays
 * unresolved, and unresolved never reaches a LOW RISK outcome.
 */
function resolveDeterministically(input: DeterministicInput): ResolvedIdentity {
  if (input.inputType === "COMPANY" && input.claimedName !== null) {
    return {
      brandName: null,
      legalEntityName: input.claimedName,
      // The user named the company; that is what is being checked, and it is
      // not in doubt. Whether it is REGISTERED is Fact B and a separate matter.
      confidence: "high",
      basis: "the company name you entered",
      source: "user_supplied",
    };
  }

  // The regulator's own tie between this domain and a company.
  //
  // The RBI publishes, for most of its records, a contact address, and for a
  // few, a website. Either states that a domain belongs to a named company, and
  // the RBI stating it is stronger than a footer saying it and far stronger
  // than a model inferring it. For a site that renders in the browser — which
  // hands a fetcher an empty shell and gives the model's URL reader the same —
  // it is frequently the only tie that exists anywhere.
  //
  // This is NOT looking a website up in an entity dataset, which is the mistake
  // the whole pipeline is shaped to avoid. The dataset is not being asked "is
  // this domain registered"; it is being read for an identifier the regulator
  // published, which proposes a COMPANY NAME. That name is then looked up on
  // its own, separately, in step 7 — the entity lookup that produces Fact B.
  //
  // Exactly one match, or none: two companies publishing the same domain is an
  // ambiguity, and picking one of them arbitrarily would be a guess.
  const byPublishedDomain = input.domainOwnerLookup.matches.filter(
    (match) =>
      match.identifiedBy === "official_website" || match.identifiedBy === "contact_domain",
  );
  if (byPublishedDomain.length === 1) {
    const match = byPublishedDomain[0];
    return {
      brandName: null,
      legalEntityName: match.name,
      confidence: "high",
      basis:
        match.identifiedBy === "official_website"
          ? `the RBI's own record for ${match.name}, which publishes this website for it`
          : `the RBI's own record for ${match.name}, which publishes a contact address on this domain`,
      source: "rbi_published_domain",
    };
  }

  const identifiedByName = input.nameLookups.find((lookup) =>
    lookup.search.matches.some((match) => match.identified),
  );
  if (identifiedByName) {
    return {
      brandName: null,
      legalEntityName: identifiedByName.name,
      confidence: "medium",
      basis: "a company name printed on the website itself",
      source: "website_text",
    };
  }

  return UNRESOLVED;
}

/**
 * The operator after the model has read the site.
 *
 * A user-supplied company name always wins: the user is telling us what they
 * are asking about, and a model must not overrule that. Otherwise the model's
 * legal name is used when the sanitiser let it through with real confidence,
 * and the deterministic finding is the fallback.
 */
function resolveIdentity(input: {
  readonly inputType: InvestigationInputType;
  readonly claimedName: string | null;
  readonly sanitized: {
    readonly identifiedEntity: { readonly name: string | null; readonly legalName: string | null };
    readonly identityConfidence: IdentityConfidence;
    readonly identityBasis: string | null;
  };
  readonly deterministicIdentity: ResolvedIdentity;
}): ResolvedIdentity {
  const brandName = input.sanitized.identifiedEntity.name;

  if (input.deterministicIdentity.source === "user_supplied") {
    return { ...input.deterministicIdentity, brandName };
  }

  // The RBI publishing this domain for a company outranks the model reading the
  // site, for two reasons. It is the regulator's own statement rather than an
  // inference over page text; and it gives the legal name in the exact form the
  // RBI holds it, which is the form the entity lookup in step 7 needs. The
  // model still supplies the brand, which the RBI record does not carry.
  if (input.deterministicIdentity.source === "rbi_published_domain") {
    return { ...input.deterministicIdentity, brandName };
  }

  const legalName = input.sanitized.identifiedEntity.legalName;
  if (legalName !== null && input.sanitized.identityConfidence !== "none") {
    return {
      brandName,
      legalEntityName: legalName,
      confidence: input.sanitized.identityConfidence,
      basis: input.sanitized.identityBasis,
      source: "ai_identification",
    };
  }

  if (input.deterministicIdentity.legalEntityName !== null) {
    return { ...input.deterministicIdentity, brandName };
  }

  return { ...UNRESOLVED, brandName };
}

// ---------------------------------------------------------------------------
// Fact B — what does the RBI data say about that entity?
// ---------------------------------------------------------------------------

/**
 * Find an RBI lookup already performed for this company name.
 *
 * Reuse rather than repetition: by the time this runs the name may already
 * have been looked up in step 1 (a company search) or step 5 (a name printed
 * on the site), and searching the index again would produce the same answer.
 */
function regulatoryEvidenceFor(
  legalEntityName: string | null,
  lookups: {
    readonly firstLookup: KnownEntitySearch;
    readonly nameLookups: readonly { readonly name: string; readonly search: KnownEntitySearch }[];
  },
): RegulatoryEvidence {
  const empty: RegulatoryEvidence = {
    lookupName: null,
    matches: [],
    identified: false,
    standing: null,
    entityType: null,
    datasetAsOf: lookups.firstLookup.datasetAsOf,
  };

  if (legalEntityName === null) return empty;
  const key = legalEntityName.toLowerCase();

  if (lookups.firstLookup.query.organizationName?.toLowerCase() === key) {
    return describeRegulatory(legalEntityName, lookups.firstLookup);
  }

  const byName = lookups.nameLookups.find((lookup) => lookup.name.toLowerCase() === key);
  if (byName) return describeRegulatory(legalEntityName, byName.search);

  return empty;
}

function describeRegulatory(lookupName: string, search: KnownEntitySearch): RegulatoryEvidence {
  // The record that actually identifies the company, if there is one. A
  // similar-name candidate is reported but never treated as the answer.
  const identified = search.matches.find((match) => match.identified) ?? null;

  return {
    lookupName,
    matches: search.matches.map(describeMatch),
    identified: identified !== null,
    standing: identified?.standing ?? null,
    entityType: identified?.classification ?? null,
    datasetAsOf: search.datasetAsOf,
  };
}

/** A dataset lookup that never throws. Reference data may be unreadable. */
function lookUpCompany(name: string): KnownEntitySearch | null {
  try {
    return searchKnownEntities({ organizationName: name });
  } catch {
    // Already reported as a notice by step 1.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logOutcome(
  bundle: EvidenceBundle,
  risk: InvestigationRisk,
  status: InvestigationResult["status"],
  geminiCalls: number,
): void {
  console.info(
    "[LenderLens] " +
      [
        `input_type=${bundle.inputType}`,
        `original_input=${bundle.originalInput}`,
        `normalized_domain=${bundle.submittedDomain}`,
        `identified_brand_name=${bundle.identity.brandName ?? "-"}`,
        `identified_legal_entity=${bundle.identity.legalEntityName ?? "-"}`,
        `identity_confidence=${bundle.identity.confidence}`,
        `identity_source=${bundle.identity.source}`,
        `rbi_lookup_name=${bundle.regulatory.lookupName ?? "-"}`,
        `rbi_match=${bundle.regulatory.identified ? "identified" : bundle.regulatory.matches.length > 0 ? "similar_only" : "none"}`,
        `rbi_entity_type=${bundle.regulatory.entityType ?? "-"}`,
        `rbi_status=${bundle.regulatory.standing ?? "-"}`,
        `final_risk=${risk.level}`,
        `internal_status=${status}`,
        `gemini_calls=${geminiCalls}`,
      ].join(" | "),
  );
}

// ---------------------------------------------------------------------------
// Step 3 — which page names the operator?
// ---------------------------------------------------------------------------

/**
 * Score a site's own links for the likelihood of naming a legal entity.
 *
 * Weighted towards the pages an Indian lending platform is obliged to publish:
 * a grievance-redressal officer, the partner NBFC, a licence statement. Those
 * name a company outright far more often than an "About us" does.
 */
const LINK_HINTS: readonly (readonly [RegExp, number])[] = [
  [/grievance|nodal|ombudsman|partner|lending-partner|nbfc|licen[cs]e|regulat|compliance/i, 3],
  [/privacy|terms|t-and-c|tnc|legal|disclosure|disclaimer|policy/i, 2],
  [/about|company|corporate|who-we-are|contact|imprint/i, 1],
];

export function choosePages(links: readonly PageLink[]): PageLink[] {
  const scored = links
    .map((link, position) => {
      const haystack = `${link.url} ${link.label}`;
      let score = 0;
      for (const [pattern, weight] of LINK_HINTS) {
        if (pattern.test(haystack)) score = Math.max(score, weight);
      }
      return { link, score, position };
    })
    .filter((entry) => entry.score > 0);

  // Equal scores keep the order the page listed them in.
  scored.sort((a, b) => b.score - a.score || a.position - b.position);

  const chosen: PageLink[] = [];
  const seen = new Set<string>();
  for (const entry of scored) {
    if (seen.has(entry.link.url)) continue;
    seen.add(entry.link.url);
    chosen.push(entry.link);
    if (chosen.length >= MAX_EXTRA_PAGES) break;
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Company names mentioned in what was read
// ---------------------------------------------------------------------------

/**
 * Pull company names out of free text.
 *
 * Purely syntactic: an Indian company name announces itself by ending in
 * Limited, Ltd, Private Limited or Pvt Ltd. Whatever this returns is only ever
 * used as a query against the RBI index — a false positive costs one local
 * lookup that finds nothing, and nothing here is shown to a user as a fact or
 * fed back to the model as one.
 */
const COMPANY_NAME_PATTERN =
  /\b((?:[A-Z][\w&.'-]*\s+){1,5}(?:Private\s+|Pvt\.?\s+)?(?:Limited|Ltd\.?))/g;

export function extractCompanyNames(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(COMPANY_NAME_PATTERN)) {
    const name = match[1].replace(/\s+/g, " ").trim();
    if (name.length < 8 || name.length > 120) continue;

    const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (seen.has(key)) continue;
    seen.add(key);

    found.push(name);
    if (found.length >= 12) break;
  }

  return found;
}

// ---------------------------------------------------------------------------
// Flattening, for the evidence bundle
// ---------------------------------------------------------------------------

function describePage(page: RetrievedPage): PageEvidence {
  return {
    url: page.url,
    title: page.title,
    read: page.ok,
    characters: page.text.length,
    error: page.error,
  };
}

function describeMatch(match: KnownEntitySearch["matches"][number]): DatasetMatchEvidence {
  return {
    name: match.name,
    sourceLabel: match.sourceLabel,
    standingLabel: match.standingLabel,
    cin: match.cin,
    classification: match.classification,
    publishedHostnames: match.hostnames,
    identified: match.identified,
    foundBy: match.foundBy,
  };
}
