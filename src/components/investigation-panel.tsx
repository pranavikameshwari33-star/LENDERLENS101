import {
  EVIDENCE_SOURCE_LABELS,
  type EvidenceBundle,
  type IdentityConfidence,
  type InvestigationAnalysis,
  type InvestigationResult,
  type RegulatoryEvidence,
  type ResolvedIdentity,
} from "@/lib/investigate/types";
import { isAiFailure } from "@/lib/investigate/failure";

import { Callout, Collapsible, Panel, toneStyle } from "./ui";

/**
 * What the investigation found.
 *
 * This sits below the verification, never in place of it, and it is written to
 * read as a continuation of the same sentence: the RBI lists could not settle
 * this website, so here is what looking actually turned up.
 *
 * Three decisions carry the whole panel.
 *
 * There is exactly one verdict on it, and it is the risk line. The model also
 * returns an outcome word of its own, and that word is deliberately not shown:
 * the model answers before the RBI lookup that its own answer triggers, so it
 * cannot know how that lookup went, and printing its stale UNVERIFIED beside a
 * LOW RISK line only asks the reader to arbitrate between them. What the model
 * genuinely adds — the findings, the evidence, the conflicts, and what the open
 * web says about the operator — is all still here.
 *
 * There is no score, no percentage and no confidence anywhere. What a reader
 * gets instead is the evidence itself, each item marked as something a source
 * stated or something the investigation inferred, with a link to the page it
 * was read from wherever one survived checking.
 *
 * And when the AI could not be reached, the panel says exactly that — AI
 * INVESTIGATION UNAVAILABLE — and then shows every piece of evidence LenderLens
 * gathered on its own anyway. A quota error is a fact about LenderLens. It is
 * never allowed to appear as a finding about a lending website.
 *
 * The risk line is the first thing on the panel and the last thing decided. It
 * is not the model's opinion and it is not derived from the evidence badge
 * below it: it is computed from two facts that are shown separately here
 * because they are separately true or false — who this website belongs to, and
 * what the RBI's records say about that company. Establishing the first proves
 * nothing about the second, which is the entire reason both are on the screen.
 */

const REGULATORY_WORDS: Record<InvestigationAnalysis["regulatoryStatus"]["status"], string> = {
  confirmed: "Confirmed by an authoritative source",
  not_confirmed: "Not confirmed",
  unknown: "Nothing found either way",
};

export function InvestigationPanel({ investigation }: { investigation: InvestigationResult }) {
  const analysis = investigation.aiAnalysis;
  const aiFailed = isAiFailure(investigation.status);
  const bundle = investigation.evidenceBundle;
  const riskTone = toneStyle(investigation.risk.level === "LOW_RISK" ? "positive" : "negative");

  return (
    <Panel className="mt-4 overflow-hidden">
      <div className="border-b border-[var(--border)] px-5 py-4">
        <p className="eyebrow">Investigation</p>
        <p className="mt-1.5 text-[0.875rem] leading-relaxed text-[var(--text-secondary)]">
          {bundle.inputType === "COMPANY"
            ? `LenderLens searched its RBI records for ${bundle.originalInput}, then went and looked at the website behind it.`
            : "This website is not in the RBI data LenderLens holds, so LenderLens went and looked: it read the site, worked out which company operates it, and searched its RBI records under that company's name."}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span
            className={`inline-flex items-center gap-2 rounded border px-2.5 py-1 text-[0.8125rem] font-semibold ${riskTone.chip} ${riskTone.text}`}
          >
            <span aria-hidden="true">{riskTone.mark}</span>
            {investigation.risk.label}
          </span>
        </div>
        <p className="mt-2 text-[0.875rem] leading-relaxed text-[var(--text-primary)]">
          {investigation.risk.reason}
        </p>

        {analysis ? null : (
          <div className="mt-4">
            <Callout
              tone={aiFailed ? "warning" : "info"}
              title={aiFailed ? "AI investigation unavailable" : investigation.statusLabel}
            >
              {aiFailed ? (
                <>
                  <p>
                    {investigation.statusDetail ?? investigation.statusLabel} The evidence below was
                    gathered without it and is unaffected.
                  </p>
                  <p className="mt-2">
                    This is a problem with LenderLens, not a finding about this website. It does not
                    mean the evidence was missing, and it says nothing about whether this lender is
                    genuine.
                  </p>
                </>
              ) : (
                <p>
                  Nothing could be retrieved about this website — it did not respond, and no company
                  name was recoverable from anywhere — so there was nothing to investigate. That is a
                  statement about what could be found, and nothing more.
                </p>
              )}
            </Callout>
          </div>
        )}
      </div>

      <TwoFacts
        identity={bundle.identity}
        regulatory={bundle.regulatory}
        domain={bundle.submittedDomain}
        relationshipBasis={bundle.relationshipBasis}
      />

      {analysis ? <AnalysisBody analysis={analysis} /> : null}

      <EvidenceBundleSection bundle={investigation.evidenceBundle} expanded={analysis === null} />

      <div className="border-t border-[var(--border)] p-4">
        <Collapsible
          summary={`How this investigation was carried out (${investigation.steps.length} steps)`}
        >
          <ol className="divide-y divide-[var(--border)]">
            {investigation.steps.map((step) => (
              <li key={step.order} className="px-4 py-3 sm:px-5">
                <p className="text-[0.875rem] text-[var(--text-primary)]">
                  {step.order}. {step.action}
                </p>
                <p className="tabular mt-1 break-all text-xs text-[var(--text-muted)]">
                  {step.detail}
                </p>
                <p className="mt-1 text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
                  {step.outcome}
                </p>
              </li>
            ))}
          </ol>
        </Collapsible>

        {investigation.notices.length > 0 ? (
          <div className="mt-3">
            <Callout tone="info" title="What this investigation could not do">
              <ul className="space-y-1.5">
                {investigation.notices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            </Callout>
          </div>
        ) : null}

        <p className="mt-3 text-center text-xs leading-relaxed text-[var(--text-muted)]">
          {analysis
            ? `Evidence gathered from the website itself and LenderLens’s RBI data, then read by ${investigation.model}. `
            : "Evidence gathered from the website itself and LenderLens’s RBI data, without an AI reading of it. "}
          LenderLens collects evidence; it does not certify a lender, and every source above is
          worth opening yourself before you act on it.
        </p>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The two facts, kept apart
// ---------------------------------------------------------------------------

/**
 * How firmly the operating company was established, in words.
 *
 * Words rather than a grade, and certainly not a number. "Named in a legal
 * document" tells a reader what to check; "confidence: 0.8" tells them a
 * calculation happened that they cannot inspect and that nobody performed.
 */
const CONFIDENCE_WORDS: Record<IdentityConfidence, string> = {
  high: "Named in a legal document or regulatory disclosure",
  medium: "Named on the website itself",
  low: "Only inferred — not confirmed by anything read",
  none: "Could not be established",
};

const IDENTITY_SOURCE_WORDS: Record<ResolvedIdentity["source"], string> = {
  rbi_published_domain: "the RBI's own record, which publishes this domain for that company",
  user_supplied: "the company name you entered",
  website_text: "a company name printed on the website",
  ai_identification: "the investigation reading the website and its legal pages",
  unresolved: "nothing that could be read",
};

function TwoFacts({
  identity,
  regulatory,
  domain,
  relationshipBasis,
}: {
  identity: ResolvedIdentity;
  regulatory: RegulatoryEvidence;
  domain: string;
  relationshipBasis: string | null;
}) {
  const identified = regulatory.matches.find((match) => match.identified) ?? null;

  return (
    <div className="grid grid-cols-1 divide-y divide-[var(--border)] border-t border-[var(--border)] sm:grid-cols-2 sm:divide-x sm:divide-y-0">
      {/* FACT A ------------------------------------------------------------ */}
      <section className="px-5 py-4">
        <p className="eyebrow">Who this website belongs to</p>
        <p className="mt-2 text-[0.875rem] leading-relaxed">
          {identity.legalEntityName ? (
            <span className="font-medium text-[var(--text-primary)]">
              {identity.legalEntityName}
            </span>
          ) : (
            <span className="text-[var(--text-secondary)]">
              No company could be tied to <span className="tabular">{domain}</span>
            </span>
          )}
        </p>

        {identity.brandName && identity.brandName !== identity.legalEntityName ? (
          <p className="mt-1 text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
            Trading as {identity.brandName}. The brand and the registered company are different
            names; only the second is one the RBI holds records under.
          </p>
        ) : null}

        <p className="mt-2 text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
          {CONFIDENCE_WORDS[identity.confidence]}, from {IDENTITY_SOURCE_WORDS[identity.source]}.
        </p>

        {identity.basis && identity.source === "ai_identification" ? (
          <p className="mt-1 text-[0.8125rem] leading-relaxed text-[var(--text-muted)]">
            Read from: {identity.basis}
          </p>
        ) : null}

        {relationshipBasis ? (
          <p className="mt-2 text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
            {relationshipBasis}
          </p>
        ) : null}
      </section>

      {/* FACT B ------------------------------------------------------------ */}
      <section className="px-5 py-4">
        <p className="eyebrow">What the RBI records say about that company</p>

        {regulatory.lookupName === null ? (
          <p className="mt-2 text-[0.875rem] leading-relaxed text-[var(--text-secondary)]">
            No company name could be established, so there was nothing to look up. The RBI publishes
            lists of companies, not of websites, so a domain on its own cannot be checked against
            them.
          </p>
        ) : identified ? (
          <>
            <p className="mt-2 text-[0.875rem] leading-relaxed">
              <span className="font-medium text-[var(--text-primary)]">{identified.name}</span>
              <span className="text-[var(--text-secondary)]"> · {identified.standingLabel}</span>
            </p>
            <p className="mt-1 text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
              {identified.sourceLabel}
              {identified.classification ? ` · ${identified.classification}` : ""}
              {identified.cin ? <span className="tabular"> · {identified.cin}</span> : null}
            </p>
            <p className="mt-1 text-[0.8125rem] leading-relaxed text-[var(--text-muted)]">
              Found by {identified.foundBy}, searching under the company name — not the domain.
            </p>
          </>
        ) : (
          <p className="mt-2 text-[0.875rem] leading-relaxed text-[var(--text-secondary)]">
            Searched for <span className="text-[var(--text-primary)]">{regulatory.lookupName}</span>
            {regulatory.matches.length > 0
              ? ". Only similarly named records came back, and a similar name is not the same company."
              : ". No matching record."}{" "}
            A lookup that finds nothing is not evidence that this lender is unregistered — the lists
            LenderLens holds do not cover every kind of lender — but it is not corroboration either.
          </p>
        )}

        {regulatory.datasetAsOf ? (
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            RBI lists as published on {regulatory.datasetAsOf}.
          </p>
        ) : null}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The AI's reading of the evidence — shown only when there is one
// ---------------------------------------------------------------------------

function AnalysisBody({ analysis }: { analysis: InvestigationAnalysis }) {
  const hasWebRegulatory =
    analysis.regulatoryStatus.status !== "unknown" ||
    analysis.regulatoryStatus.regulator !== null ||
    analysis.regulatoryStatus.registrationReference !== null;

  return (
    <>
      {hasWebRegulatory ? (
        <dl className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
          <Row label="Regulatory sources found on the web">
            {REGULATORY_WORDS[analysis.regulatoryStatus.status]}
            {analysis.regulatoryStatus.regulator ? ` · ${analysis.regulatoryStatus.regulator}` : ""}
            {analysis.regulatoryStatus.registrationReference
              ? ` · ${analysis.regulatoryStatus.registrationReference}`
              : ""}
            <span className="mt-1 block text-[var(--text-secondary)]">
              Read from pages outside LenderLens. Separate from the RBI records above, and weaker
              than them: a company&rsquo;s own page saying it is regulated is a claim, not a
              register.
            </span>
          </Row>
        </dl>
      ) : null}

      {analysis.findings.length > 0 ? (
        <div className="border-t border-[var(--border)] px-5 py-4">
          <p className="eyebrow">What the investigation established</p>
          <ul className="mt-2.5 space-y-2">
            {analysis.findings.map((finding) => (
              <li
                key={finding}
                className="flex gap-2.5 text-[0.875rem] leading-relaxed text-[var(--text-secondary)]"
              >
                <span
                  aria-hidden="true"
                  className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[var(--text-muted)]"
                />
                <span>{finding}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {analysis.conflicts.length > 0 ? (
        <div className="border-t border-[var(--border)] px-5 py-4">
          <Callout tone="warning" title="Sources disagree">
            <ul className="space-y-1.5">
              {analysis.conflicts.map((conflict) => (
                <li key={conflict}>{conflict}</li>
              ))}
            </ul>
          </Callout>
        </div>
      ) : null}

      {analysis.evidence.length > 0 ? (
        <div className="border-t border-[var(--border)] px-5 py-4">
          <p className="eyebrow">Evidence</p>
          <ul className="mt-2.5 space-y-2.5">
            {analysis.evidence.map((item, position) => (
              <li
                key={`${item.claim}-${position}`}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-[0.875rem] font-medium text-[var(--text-primary)]">
                    {item.claim}
                  </span>
                  <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    {item.kind === "fact" ? "Stated by a source" : "Inferred"}
                  </span>
                </div>

                <p className="mt-2 text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
                  “{item.supportingText}”
                </p>

                <p className="mt-2 text-xs text-[var(--text-muted)]">
                  {EVIDENCE_SOURCE_LABELS[item.sourceType]}:{" "}
                  {item.sourceUrl ? (
                    <a
                      href={item.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="break-all text-[var(--accent)] underline decoration-[var(--accent)]/40 underline-offset-4"
                    >
                      {item.sourceTitle}
                    </a>
                  ) : (
                    <span className="text-[var(--text-secondary)]">{item.sourceTitle}</span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {analysis.warnings.length > 0 ? (
        <div className="border-t border-[var(--border)] px-5 py-4">
          <p className="eyebrow">Read this alongside the result</p>
          <ul className="mt-2.5 space-y-2">
            {analysis.warnings.map((warning) => (
              <li
                key={warning}
                className="text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]"
              >
                {warning}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// What LenderLens established by itself — always shown, whatever the AI did
// ---------------------------------------------------------------------------

function EvidenceBundleSection({
  bundle,
  expanded,
}: {
  bundle: EvidenceBundle;
  expanded: boolean;
}) {
  const body = (
    <div className="space-y-4 px-5 py-4">
      <div>
        <p className="eyebrow">RBI records searched</p>
        <ul className="mt-2 space-y-2.5">
          {bundle.rbiLookups.map((lookup) => (
            <li key={lookup.query} className="text-[0.8125rem] leading-relaxed">
              <p className="text-[var(--text-primary)]">Looked up {lookup.query}</p>
              {lookup.matches.length === 0 ? (
                <p className="mt-0.5 text-[var(--text-secondary)]">No matching record</p>
              ) : (
                <ul className="mt-1 space-y-1.5">
                  {lookup.matches.map((match) => (
                    <li
                      key={`${lookup.query}-${match.name}`}
                      className="rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-[var(--text-secondary)]"
                    >
                      <span className="text-[var(--text-primary)]">{match.name}</span> ·{" "}
                      {match.sourceLabel} · {match.standingLabel}
                      {match.cin ? <span className="tabular"> · {match.cin}</span> : null}
                      {match.classification ? ` · ${match.classification}` : null}
                      {match.publishedHostnames.length > 0 ? (
                        <span className="tabular">
                          {" "}
                          · RBI-published website: {match.publishedHostnames.join(", ")}
                        </span>
                      ) : null}
                      <span className="block text-xs text-[var(--text-muted)]">
                        {match.identified
                          ? `Identified by ${match.foundBy}`
                          : `${match.foundBy} — a similar name is not the same company, so this is not treated as a match`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        {bundle.datasetAsOf ? (
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            RBI lists as published on {bundle.datasetAsOf}.
          </p>
        ) : null}
      </div>

      <div>
        <p className="eyebrow">Pages opened</p>
        <ul className="mt-2 space-y-1.5">
          {bundle.pages.map((page) => (
            <li key={page.url} className="text-[0.8125rem] leading-relaxed">
              <span className="tabular break-all text-[var(--text-primary)]">{page.url}</span>
              <span className="text-[var(--text-secondary)]">
                {page.read
                  ? ` — read${page.title ? `, “${page.title}”` : ""}`
                  : ` — ${page.error ?? "could not be read"}`}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {bundle.companyNamesFound.length > 0 ? (
        <div>
          <p className="eyebrow">Company names found on the site</p>
          <p className="mt-2 text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
            {bundle.companyNamesFound.join(" · ")}
          </p>
        </div>
      ) : null}
    </div>
  );

  if (expanded) {
    return (
      <div className="border-t border-[var(--border)]">
        <div className="px-5 pt-4">
          <p className="text-[0.875rem] font-medium text-[var(--text-primary)]">
            What LenderLens established without the AI
          </p>
        </div>
        {body}
      </div>
    );
  }

  return (
    <div className="border-t border-[var(--border)] px-4 pt-4">
      <Collapsible summary="The evidence LenderLens gathered itself">{body}</Collapsible>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-5 py-3 text-[0.875rem] leading-relaxed sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-[var(--text-muted)] sm:w-60">{label}</dt>
      <dd className="min-w-0 break-words text-[var(--text-primary)]">{children}</dd>
    </div>
  );
}
