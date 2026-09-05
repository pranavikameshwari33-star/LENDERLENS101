import Link from "next/link";

import type { InvestigationResult, ResolvedIdentity } from "@/lib/investigate/types";
import { resolveHeadline } from "@/lib/verify/headline";
import {
  SIGNAL_CATEGORY_LABELS,
  type Signal,
  type SignalCategory,
} from "@/lib/verify/signals";
import type { EntityMatch, VerificationResult } from "@/lib/verify/types";

import {
  Callout,
  Collapsible,
  Panel,
  severityStyle,
  toneStyle,
  VERDICT_STYLES,
} from "./ui";

/**
 * The answer.
 *
 * Reading order is the order a frightened person asks the questions in:
 *
 *   1. which website did I just check?
 *   2. what did you find?
 *   3. why?
 *   4. does this website actually belong to the lender it claims?
 *   5. who is behind it, then?
 *   6. what do I do now?
 *
 * Everything else — the layer-by-layer breakdown, every individual signal with
 * its source — is real and is kept, but it is folded away behind a summary a
 * reader opens when they want it. Nothing is deleted; the order of attention
 * is what changed.
 *
 * There is deliberately no number anywhere on this page. The engine's internal
 * match probability is not a measure of how safe a lender is, and putting a
 * percentage in front of someone who is about to send money would be read as
 * exactly that.
 *
 * The banner is NOT `result.verdictShort`. The verification runs first and
 * hands the cases it cannot settle to the investigation, so whenever an
 * investigation ran it is the later and better informed of the two engines and
 * its deterministic risk is the headline. `resolveHeadline` holds that rule and
 * nothing else on the page changes: every verification reason, layer and signal
 * below is still the verification's own. See `verify/headline.ts`.
 */

export function VerificationReport({
  result,
  investigation = null,
  investigating = false,
}: {
  result: VerificationResult;
  /** The investigation, once it has answered. Null until then. */
  investigation?: InvestigationResult | null;
  /** True while the investigation request is still in flight. */
  investigating?: boolean;
}) {
  const headline = resolveHeadline(result, investigation?.risk ?? null, { investigating });
  const style = VERDICT_STYLES[headline.tone];
  const subject = result.query.hostname ?? result.query.companyName ?? result.query.raw;
  const primary = result.regulatory.primary;
  const link = websiteLink(result);
  const facts = investigation ? twoFactLines(investigation) : null;

  return (
    <div className="space-y-4">
      {/* 1-3. What was checked, what we found, and why ------------------- */}
      <Panel className={`overflow-hidden ${style.border}`}>
        <div className={`px-5 py-6 sm:px-6 ${style.background}`}>
          <p className="eyebrow">We checked</p>
          <p className="tabular mt-1.5 break-all text-lg font-semibold text-[var(--text-primary)] sm:text-xl">
            {subject}
          </p>

          <p
            className={`mt-5 text-2xl font-bold uppercase tracking-wide sm:text-3xl ${style.text}`}
          >
            <span aria-hidden="true" className={`mr-2.5 inline-block h-2.5 w-2.5 rounded-full align-middle ${style.dot}`} />
            {headline.short}
          </p>

          <p className="mt-3 text-[0.9375rem] font-medium leading-relaxed text-[var(--text-primary)]">
            {headline.line}
          </p>
          <p className="mt-2 text-[0.875rem] leading-relaxed text-[var(--text-secondary)]">
            {headline.detail}
          </p>
        </div>

        {/* Why — the two facts when an investigation established them, the
            verification's own reasons when it did not. */}
        {facts ? (
          <div className="border-t border-[var(--border)] px-5 py-4 sm:px-6">
            <p className="eyebrow">Why</p>
            <dl className="mt-2.5 space-y-3">
              {facts.map((fact) => (
                <div key={fact.question}>
                  <dt className="text-[0.8125rem] font-medium text-[var(--text-primary)]">
                    {fact.question}
                  </dt>
                  <dd className="mt-0.5 text-[0.875rem] leading-relaxed text-[var(--text-secondary)]">
                    {fact.answer}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">
              The RBI lists alone could not settle this one, so LenderLens investigated. The full
              evidence, and every source it was read from, is below.
            </p>
          </div>
        ) : result.reasons.length > 0 ? (
          <div className="border-t border-[var(--border)] px-5 py-4 sm:px-6">
            <p className="eyebrow">Why</p>
            <ul className="mt-2.5 space-y-2">
              {result.reasons.map((reason) => (
                <li
                  key={reason}
                  className="flex gap-2.5 text-[0.875rem] leading-relaxed text-[var(--text-secondary)]"
                >
                  <span aria-hidden="true" className={`mt-2 h-1 w-1 shrink-0 rounded-full ${style.dot}`} />
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel>

      {/* 4. Does this website belong to the lender it claims? ------------- */}
      {link ? (
        <Panel className="px-5 py-4">
          <p className="eyebrow">
            {facts ? "This website, in the RBI’s own lists" : "This website"}
          </p>
          <p className="mt-1.5 text-[0.875rem] leading-relaxed text-[var(--text-primary)]">
            {link}
          </p>
        </Panel>
      ) : null}

      {/* 5. Who is behind it ---------------------------------------------- */}
      {primary ? <BehindTheSite match={primary} result={result} /> : null}

      {/* 6. What to do ---------------------------------------------------- */}
      <Panel className="px-5 py-4">
        <p className="eyebrow">What to do</p>
        <ol className="mt-2.5 space-y-2.5">
          {result.recommendedActions.map((action) => (
            <li
              key={action}
              className="flex gap-2.5 text-[0.875rem] leading-relaxed text-[var(--text-secondary)]"
            >
              <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[var(--text-muted)]" />
              <span>{action}</span>
            </li>
          ))}
        </ol>
      </Panel>

      {/* Everything deeper, folded away ----------------------------------- */}
      <Collapsible summary="See everything that was checked">
        <ul className="divide-y divide-[var(--border)]">
          {result.matrix.map((row) => {
            const tone = toneStyle(row.tone);
            return (
              <li key={row.key} className="px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="text-[0.875rem] text-[var(--text-primary)]">
                    {LAYER_QUESTIONS[row.key] ?? row.layer}
                  </p>
                  <span
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-medium ${tone.chip} ${tone.text}`}
                  >
                    <span aria-hidden="true">{tone.mark}</span>
                    {row.status}
                  </span>
                </div>
                <p className="mt-1 text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
                  {row.evidence}
                </p>
              </li>
            );
          })}
        </ul>
      </Collapsible>

      {result.signals.length > 0 ? (
        <Collapsible
          summary={`See the evidence in full (${result.signals.length} finding${
            result.signals.length === 1 ? "" : "s"
          })`}
        >
          <SignalGroups signals={result.signals} />
        </Collapsible>
      ) : null}

      {result.notices.length > 0 ? (
        <Callout tone="info" title="What this check could not do">
          <ul className="space-y-1.5">
            {result.notices.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <p className="px-1 pb-4 text-center text-xs leading-relaxed text-[var(--text-muted)]">
        Checked against the RBI&rsquo;s published lists — NBFC, ARC and cancellation data as on{" "}
        {result.dataset.nbfcAsOf ?? "an unknown date"}, the Banks in India page as on{" "}
        {result.dataset.banksFetchedAt ?? "an unknown date"}. These are dated snapshots, not live
        RBI systems, so nothing after those dates is visible here.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The two facts, in the banner
// ---------------------------------------------------------------------------

/**
 * The evidence the risk was actually computed from, in two lines.
 *
 * Deliberately the two questions `investigate/risk.ts` asks separately, in the
 * order it asks them, because they are separately true or false: who operates
 * this website, and what the RBI holds on that company. The full version of
 * both — every match, every source, every page read — is in the investigation
 * panel below; this is the short form, next to the verdict it produced.
 */
const CONFIDENCE_WORDS: Record<ResolvedIdentity["confidence"], string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "Not established",
};

/** The RBI standing in the same word the risk engine reasons over. */
const STANDING_WORDS: Record<string, string> = {
  registered: "Registered",
  bank: "Registered (bank)",
  cancelled: "Cancelled",
  cancellation_record: "Cancelled",
};

function twoFactLines(
  investigation: InvestigationResult,
): readonly { question: string; answer: string }[] {
  const { identity, regulatory } = investigation.evidenceBundle;

  const identityParts: string[] = [];
  if (identity.brandName) identityParts.push(`Brand: ${identity.brandName}`);
  identityParts.push(
    identity.legalEntityName
      ? `Legal entity: ${identity.legalEntityName}`
      : "Legal entity: none could be tied to this website",
  );
  identityParts.push(`Identity confidence: ${CONFIDENCE_WORDS[identity.confidence]}`);
  if (identity.basis) identityParts.push(`Basis: ${identity.basis}`);

  const identified = regulatory.matches.find((match) => match.identified) ?? null;
  const regulatoryParts: string[] = [];
  if (regulatory.lookupName === null) {
    regulatoryParts.push("RBI match: not searched — no company name to look up");
  } else {
    regulatoryParts.push(
      identified
        ? `RBI match: Identified (${identified.name})`
        : regulatory.matches.length > 0
          ? "RBI match: similarly named records only — a similar name is not the same company"
          : "RBI match: none",
    );
    if (regulatory.entityType) regulatoryParts.push(`Entity type: ${regulatory.entityType}`);
    if (identified) {
      regulatoryParts.push(`Status: ${STANDING_WORDS[regulatory.standing ?? ""] ?? identified.standingLabel}`);
    }
  }

  return [
    { question: "Who operates this website?", answer: identityParts.join(" · ") },
    { question: "Is that entity regulated?", answer: regulatoryParts.join(" · ") },
  ];
}

// ---------------------------------------------------------------------------
// Does this website belong to the lender?
// ---------------------------------------------------------------------------

/**
 * The distinction the whole product turns on: a registered lender existing is
 * not the same claim as this website belonging to it. The sentence below is
 * assembled only from evidence the engine actually produced — an RBI-published
 * website, an RBI-held contact domain, or the absence of either.
 */
function websiteLink(result: VerificationResult): string | null {
  const hostname = result.website.hostname;
  if (!hostname) return null;

  const has = (id: string) => result.signals.some((item) => item.id === id);
  const name = result.regulatory.primary?.entity.name ?? null;

  if (has("domain_is_official") && name) {
    return `The RBI publishes this exact address as ${name}'s own website. That is the strongest confirmation available here that the site belongs to the lender it names.`;
  }

  if (has("domain_belongs_to_other_institution") && result.website.domainBelongsTo) {
    return `The RBI publishes this address as ${result.website.domainBelongsTo}'s website — not the lender you were told about.`;
  }

  if (result.website.matchesRegisteredEmailDomain && name) {
    return `This address matches the contact e-mail address the RBI holds for ${name}, which ties the site to that registered lender.`;
  }

  if (result.website.officialHostnames.length > 0 && name) {
    return `The RBI lists ${result.website.officialHostnames.join(", ")} as ${name}'s website, not this address. Reach the lender through the address the RBI publishes instead of this one.`;
  }

  if (name) {
    return `A lender named ${name} is in the RBI's data, but nothing the RBI publishes ties this website to it. The company being real does not mean this website is theirs.`;
  }

  return "No lender in the RBI's registered, bank or cancelled lists could be tied to this website. That is not proof of wrongdoing — many lawful lenders are regulated elsewhere — but it does mean nothing here vouches for this site.";
}

// ---------------------------------------------------------------------------
// Who is behind the site
// ---------------------------------------------------------------------------

const STANDING_PLAIN: Record<string, string> = {
  registered_nbfc: "On the RBI's list of registered non-banking financial companies",
  registered_arc: "On the RBI's list of registered asset reconstruction companies",
  bank: "Listed by the RBI as a bank operating in India",
  cancelled_company: "On the RBI's cancelled-registration list — no longer permitted to operate as an NBFC",
  cancelled_record: "Appears in the RBI's record of cancelled and restored registrations",
};

function BehindTheSite({ match, result }: { match: EntityMatch; result: VerificationResult }) {
  const entity = match.entity;
  const cancelled = entity.standing === "cancelled" || entity.standing === "cancellation_record";

  return (
    <Panel className="px-5 py-4">
      <p className="eyebrow">The lender this points to</p>
      <p className="mt-1.5 text-[0.9375rem] font-semibold text-[var(--text-primary)]">
        {entity.name}
      </p>

      <dl className="mt-3 space-y-2.5 text-[0.875rem] leading-relaxed">
        <Row label="RBI registry status">
          <span className={cancelled ? "text-rose-300" : "text-[var(--text-secondary)]"}>
            {STANDING_PLAIN[entity.source] ?? entity.source}
            {entity.attributes.corCancellationDate
              ? `, cancelled on ${entity.attributes.corCancellationDate}`
              : ""}
          </span>
        </Row>

        {entity.cin ? (
          <Row label="Company number (CIN)">
            <span className="tabular text-[var(--text-secondary)]">{entity.cin}</span>
          </Row>
        ) : null}

        {entity.hostnames.length > 0 ? (
          <Row label="Website the RBI publishes">
            <span className="tabular text-[var(--text-secondary)]">{entity.hostnames.join(", ")}</span>
          </Row>
        ) : null}

        {entity.emailDomains.length > 0 ? (
          <Row label="Contact address the RBI holds">
            <span className="tabular text-[var(--text-secondary)]">@{entity.emailDomains.join(", @")}</span>
          </Row>
        ) : null}

        <Row label="How this lender was found">
          <span className="text-[var(--text-secondary)]">{match.confidenceLabel}</span>
        </Row>
      </dl>

      {cancelled ? (
        <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/[0.06] px-4 py-3 text-[0.8125rem] leading-relaxed text-rose-200">
          The RBI does not publish company numbers on the cancelled list, so entries there can only
          be matched by name — a company with a similar name may be an entirely different business.
          Confirm this with the RBI before drawing a conclusion from it.
        </p>
      ) : null}

      <p className="mt-3 text-[0.8125rem]">
        <Link
          href={`/record/${encodeURIComponent(entity.id)}`}
          className="text-[var(--accent)] underline decoration-[var(--accent)]/40 underline-offset-4 hover:decoration-[var(--accent)]"
        >
          See the full RBI record
        </Link>
        <span className="text-[var(--text-muted)]">
          {" "}
          · data as on {result.dataset.nbfcAsOf ?? "an unknown date"}
        </span>
      </p>
    </Panel>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-[var(--text-muted)] sm:w-56">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The evidence in full
// ---------------------------------------------------------------------------

const LAYER_QUESTIONS: Record<string, string> = {
  regulatory: "Is this lender on the RBI's lists?",
  company: "Does the name match a real registered company?",
  website: "Does this website belong to that lender?",
  email: "Does the e-mail address belong to that lender?",
  loan_terms: "Do the loan terms add up?",
  scam_signals: "What have they asked you for?",
};

const CATEGORY_ORDER: readonly SignalCategory[] = [
  "regulatory",
  "company_identity",
  "website_identity",
  "email_identity",
  "loan_terms",
  "scam_behaviour",
];

function SignalGroups({ signals }: { signals: readonly Signal[] }) {
  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    items: signals.filter((signal) => signal.category === category),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="divide-y divide-[var(--border)]">
      {groups.map((group) => (
        <section key={group.category} className="px-4 py-4 sm:px-5">
          <h3 className="eyebrow">{SIGNAL_CATEGORY_LABELS[group.category]}</h3>
          <ul className="mt-3 space-y-2.5">
            {group.items.map((signal) => {
              const style = severityStyle(signal.severity);
              return (
                <li key={signal.id} className={`rounded-lg border px-4 py-3 ${style.chip}`}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span aria-hidden="true" className={`h-3.5 w-1 rounded-full ${style.bar}`} />
                    <span className="text-[0.875rem] font-medium text-[var(--text-primary)]">
                      {signal.title}
                    </span>
                    <span
                      className={`text-[0.6875rem] font-semibold uppercase tracking-wider ${style.text}`}
                    >
                      {style.label}
                    </span>
                  </div>

                  <p className="mt-2 text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
                    {signal.explanation}
                  </p>

                  <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]">
                    {signal.evidence ? (
                      <span>
                        What we saw:{" "}
                        <span className="text-[var(--text-secondary)]">{signal.evidence}</span>
                      </span>
                    ) : null}
                    <span>
                      Source: <span className="text-[var(--text-secondary)]">{signal.source}</span>
                    </span>
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export type { EntityMatch };
