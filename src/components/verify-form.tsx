"use client";

import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from "react";

import {
  DISCLOSURE_KEYS,
  DISCLOSURE_QUESTIONS,
  extractHostname,
  type DisclosureKey,
} from "@/lib/verify/input";
import { investigationTrigger } from "@/lib/investigate/trigger";
import type { InvestigationResult } from "@/lib/investigate/types";
import type { VerificationResult } from "@/lib/verify/types";

import { InvestigationPanel } from "./investigation-panel";
import { VerificationReport } from "./verification-report";
import { VerificationSequence } from "./verification-sequence";
import { Callout } from "./ui";

/**
 * The check.
 *
 * Two questions are asked first, and asked loudly, because a person arrives
 * here holding one of two things: a link someone sent them, or the name a
 * lender gave them on a call. Either is enough to start, neither is required
 * alongside the other, and they are given equal weight on the page for that
 * reason. Everything else the engine can use is genuinely optional, so it
 * lives behind one collapsed panel rather than in front of the person trying
 * to get an answer.
 *
 * The two inputs are separate FIELDS rather than one box that guesses. The
 * interface already knows which one the user typed into, so the input type is
 * sent to the server as a fact instead of being re-derived there by a regular
 * expression that will eventually read "A.C. Fincom Pvt Ltd" as a domain. They
 * converge immediately: both run the same verification and the same
 * investigation, and there is one result panel, not two.
 *
 * Marketing copy is never rendered beside a result: `children` is the
 * homepage's supporting text, and it is shown only while the page is idle.
 */

interface LoanTermsState {
  loanAmount: string;
  interestRatePercent: string;
  aprPercent: string;
  processingFee: string;
  upfrontPayment: string;
  totalRepayment: string;
  tenureMonths: string;
  lateFee: string;
  prepaymentCharge: string;
  collateralDemanded: string;
}

const EMPTY_TERMS: LoanTermsState = {
  loanAmount: "",
  interestRatePercent: "",
  aprPercent: "",
  processingFee: "",
  upfrontPayment: "",
  totalRepayment: "",
  tenureMonths: "",
  lateFee: "",
  prepaymentCharge: "",
  collateralDemanded: "",
};

const TERM_FIELDS: { key: keyof LoanTermsState; label: string; placeholder: string; hint?: string }[] = [
  { key: "loanAmount", label: "Loan amount", placeholder: "₹2,00,000" },
  { key: "tenureMonths", label: "Tenure (months)", placeholder: "12" },
  { key: "interestRatePercent", label: "Interest rate (% a year)", placeholder: "14" },
  { key: "aprPercent", label: "APR quoted (% a year)", placeholder: "18" },
  { key: "processingFee", label: "Processing fee", placeholder: "₹4,000" },
  {
    key: "upfrontPayment",
    label: "Payable before the loan arrives",
    placeholder: "₹0",
    hint: "Anything you are asked to send first.",
  },
  { key: "totalRepayment", label: "Total repayable", placeholder: "₹2,40,000" },
  { key: "lateFee", label: "Late fee", placeholder: "₹1,000" },
  { key: "prepaymentCharge", label: "Prepayment charge", placeholder: "₹0" },
];

export interface VerifyFormProps {
  /** Compact examples offered under the search box. */
  readonly examples?: readonly { label: string; payload: Record<string, unknown> }[];
  /** Supporting copy for the page, hidden as soon as a check is running. */
  readonly children?: ReactNode;
}

export function VerifyForm({ examples = [], children }: VerifyFormProps) {
  const [website, setWebsite] = useState("");
  const [lenderName, setLenderName] = useState("");
  const [email, setEmail] = useState("");
  const [cin, setCin] = useState("");
  const [terms, setTerms] = useState<LoanTermsState>(EMPTY_TERMS);
  const [disclosures, setDisclosures] = useState<Record<DisclosureKey, boolean>>(
    () => Object.fromEntries(DISCLOSURE_KEYS.map((key) => [key, false])) as Record<DisclosureKey, boolean>,
  );

  const [showDetails, setShowDetails] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [showBehaviour, setShowBehaviour] = useState(false);
  const [behaviourAnswered, setBehaviourAnswered] = useState(false);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerificationResult | null>(null);

  // The fallback investigation. It runs only when the RBI lookup could not
  // resolve the domain, and it never blocks or alters the result above it.
  const [investigating, setInvestigating] = useState(false);
  const [investigation, setInvestigation] = useState<InvestigationResult | null>(null);
  const [investigationNote, setInvestigationNote] = useState<string | null>(null);

  const resultsRef = useRef<HTMLDivElement>(null);
  const websiteRef = useRef<HTMLInputElement>(null);
  const companyRef = useRef<HTMLInputElement>(null);
  const websiteId = useId();
  const companyId = useId();
  const websiteHintId = useId();

  const stages = useMemo(
    () => [
      { id: "input", label: "Reading what you entered", runs: true },
      { id: "site", label: "Opening the website", runs: website.trim().length > 0 },
      { id: "registered", label: "Checking the RBI's registered lender lists", runs: true },
      { id: "cancelled", label: "Checking the RBI's cancelled-registration list", runs: true },
      {
        id: "match",
        label:
          website.trim().length > 0
            ? "Looking for the lender behind the site"
            : "Looking for that lender in the RBI records",
        runs: true,
      },
      { id: "email", label: "Checking the e-mail address", runs: email.trim().length > 0 },
      {
        id: "terms",
        label: "Checking the loan you were offered",
        runs: Object.values(terms).some((value) => value.trim().length > 0),
      },
      { id: "behaviour", label: "Checking what you were asked for", runs: behaviourAnswered },
      { id: "decision", label: "Working out what it means", runs: true },
    ],
    [website, email, terms, behaviourAnswered],
  );

  /**
   * The second request, made only for a domain the RBI data could not settle.
   *
   * Everything here fails quietly. The verification is already on the screen
   * and is the authoritative part of the answer; an investigation that cannot
   * run must leave it exactly as it is.
   */
  const investigate = useCallback(
    async (verification: VerificationResult, domain: string, inputType: "COMPANY" | "WEBSITE") => {
      setInvestigating(true);
      setInvestigation(null);
      setInvestigationNote(null);

      try {
        const response = await fetch("/api/investigate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            domain,
            companyName: verification.query.companyName ?? undefined,
            inputType,
            originalInput: verification.query.companyName ?? domain,
          }),
        });

        const body: unknown = await response.json();
        const payload =
          typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

        if (response.ok && payload.available === true && payload.investigation) {
          setInvestigation(payload.investigation as InvestigationResult);
        } else if (typeof payload.reason === "string") {
          setInvestigationNote(payload.reason);
        }
      } catch {
        // Nothing to say: the checks above stand on their own.
      } finally {
        setInvestigating(false);
      }
    },
    [],
  );

  const run = useCallback(
    async (payload: Record<string, unknown>, inputType: "COMPANY" | "WEBSITE") => {
    setPending(true);
    setError(null);
    setResult(null);
    setInvestigation(null);
    setInvestigationNote(null);
    setInvestigating(false);

    try {
      const response = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const body: unknown = await response.json();

      if (!response.ok) {
        const message =
          typeof body === "object" && body !== null && "error" in body &&
          typeof (body as { error: unknown }).error === "string"
            ? (body as { error: string }).error
            : "We could not finish the check. Please try again.";
        setError(message);
        return;
      }

      const verification = body as VerificationResult;
      setResult(verification);
      requestAnimationFrame(() => resultsRef.current?.focus());

      // The deterministic answer comes first, always. Gemini is asked only
      // about what it could not resolve — and about the domain the trigger
      // chose, which for a company-name search may be a website the RBI itself
      // publishes for the matched record rather than one the user typed.
      const trigger = investigationTrigger(verification);
      if (trigger.investigate && trigger.hostname) {
        void investigate(verification, trigger.hostname, inputType);
      }
    } catch {
      setError("We could not reach LenderLens. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  },
    [investigate],
  );

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const site = website.trim();
    // Whitespace is normalised; nothing else about a company name is. Real
    // names carry full stops, ampersands and brackets, and a validator strict
    // enough to be worth having would reject them.
    const name = lenderName.replace(/\s+/g, " ").trim();

    if (site.length === 0 && name.length === 0 && email.trim().length === 0 && cin.trim().length === 0) {
      setError("Enter a company name, or the website you want to check.");
      companyRef.current?.focus();
      return;
    }

    // www., https:// and a trailing path are all fine. Anything that is not an
    // address at all is caught here, in plain words, rather than by the server.
    if (site.length > 0 && extractHostname(site) === null) {
      setError(
        `“${site}” does not look like a website address. Try it in the form example.com.`,
      );
      websiteRef.current?.focus();
      return;
    }

    void run(
      {
        website: site,
        companyName: name,
        email: email.trim(),
        cin: cin.trim(),
        loanTerms: Object.fromEntries(
          Object.entries(terms).filter(([, value]) => value.trim().length > 0),
        ),
        disclosures,
        disclosuresAnswered: behaviourAnswered,
      },
      // The interface knows which bar was used, so it says so rather than
      // leaving the server to guess from the shape of the text.
      site.length === 0 && name.length > 0 ? "COMPANY" : "WEBSITE",
    );
  }

  function applyExample(payload: Record<string, unknown>) {
    const readString = (key: string): string =>
      typeof payload[key] === "string" ? (payload[key] as string) : "";

    setWebsite(readString("website"));
    setLenderName(readString("companyName"));
    setEmail(readString("email"));
    setCin(readString("cin"));

    const exampleTerms = (payload.loanTerms ?? {}) as Record<string, unknown>;
    setTerms({
      ...EMPTY_TERMS,
      ...Object.fromEntries(
        Object.entries(exampleTerms).map(([key, value]) => [key, String(value)]),
      ),
    });

    const exampleDisclosures = (payload.disclosures ?? {}) as Record<string, unknown>;
    const nextDisclosures = Object.fromEntries(
      DISCLOSURE_KEYS.map((key) => [key, exampleDisclosures[key] === true]),
    ) as Record<DisclosureKey, boolean>;
    setDisclosures(nextDisclosures);
    setBehaviourAnswered(true);
    setShowDetails(true);
    setShowTerms(Object.keys(exampleTerms).length > 0);
    setShowBehaviour(Object.values(nextDisclosures).some(Boolean));

    void run(
      { ...payload, disclosuresAnswered: true },
      readString("website").length === 0 && readString("companyName").length > 0
        ? "COMPANY"
        : "WEBSITE",
    );
  }

  function reset() {
    setResult(null);
    setError(null);
    setInvestigation(null);
    setInvestigationNote(null);
    setInvestigating(false);
    requestAnimationFrame(() => companyRef.current?.focus());
  }

  const behaviourCount = DISCLOSURE_KEYS.filter((key) => disclosures[key]).length;
  const termsCount = Object.values(terms).filter((value) => value.trim().length > 0).length;
  const detailCount = (email.trim() ? 1 : 0) + (cin.trim() ? 1 : 0) + termsCount + behaviourCount;
  const idle = !pending && result === null;

  return (
    <div className="w-full">
      <form onSubmit={handleSubmit} className="mx-auto w-full max-w-2xl">
        <p className="text-lg font-medium text-[var(--text-primary)]">
          Check a lender by name, or by website
        </p>
        <p className="mt-1.5 text-[0.875rem] leading-relaxed text-[var(--text-secondary)]">
          Either one is enough. Use whichever you actually have.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label
              htmlFor={companyId}
              className="block text-[0.8125rem] font-medium text-[var(--text-secondary)]"
            >
              Company Name
            </label>
            <input
              ref={companyRef}
              id={companyId}
              value={lenderName}
              onChange={(event) => setLenderName(event.target.value)}
              placeholder="Enter company name"
              type="text"
              enterKeyHint="go"
              autoComplete="organization"
              maxLength={300}
              className="mt-1.5 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-4 py-3.5 text-base text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] sm:text-lg"
            />
          </div>

          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-[var(--border)]" />
            <span className="text-xs uppercase tracking-wider text-[var(--text-muted)]">or</span>
            <span className="h-px flex-1 bg-[var(--border)]" />
          </div>

          <div>
            <label
              htmlFor={websiteId}
              className="block text-[0.8125rem] font-medium text-[var(--text-secondary)]"
            >
              Website URL
            </label>
            <input
              ref={websiteRef}
              id={websiteId}
              aria-describedby={websiteHintId}
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
              placeholder="Enter website URL"
              type="text"
              inputMode="url"
              enterKeyHint="go"
              autoComplete="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={300}
              className="tabular mt-1.5 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-4 py-3.5 text-base text-[var(--text-primary)] outline-none transition-colors placeholder:font-sans placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] sm:text-lg"
            />
            <p
              id={websiteHintId}
              className="mt-1.5 text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]"
            >
              <code className="tabular">www.</code>, <code className="tabular">https://</code> and
              anything after the address are all fine.
            </p>
          </div>

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-lg bg-[var(--accent)] px-6 py-3.5 text-base font-semibold text-white transition-colors hover:bg-[#4b7ce8] disabled:cursor-not-allowed disabled:bg-[var(--surface-2)] disabled:text-[var(--text-muted)]"
          >
            {pending ? "Checking…" : "Check this lender"}
          </button>
        </div>

        {examples.length > 0 && idle ? (
          <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[0.8125rem] text-[var(--text-muted)]">
            <span>Try:</span>
            {examples.map((example) => (
              <button
                key={example.label}
                type="button"
                onClick={() => applyExample(example.payload)}
                className="rounded-md border border-[var(--border)] px-2 py-1 text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
              >
                {example.label}
              </button>
            ))}
          </p>
        ) : null}

        <div className="mt-5">
          <Disclosure
            open={showDetails}
            onToggle={() => setShowDetails((open) => !open)}
            title="Add what else you were told"
            summary={
              detailCount > 0
                ? `${detailCount} detail${detailCount === 1 ? "" : "s"} added`
                : "Optional. The e-mail they used, the loan they offered, what they asked for."
            }
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Text
                label="E-mail they wrote from"
                value={email}
                onChange={setEmail}
                placeholder="name@example.com"
                autoComplete="email"
              />
              <Text
                label="Company number (CIN)"
                value={cin}
                onChange={setCin}
                placeholder="U65990MH1994PLC080646"
                mono
              />
            </div>

            <div className="mt-3 space-y-2">
              <Disclosure
                open={showBehaviour}
                onToggle={() => {
                  setShowBehaviour((open) => !open);
                  setBehaviourAnswered(true);
                }}
                title="What have they asked you for?"
                summary={
                  behaviourAnswered
                    ? behaviourCount > 0
                      ? `${behaviourCount} of 10 reported`
                      : "Answered — none of these happened"
                    : "Ten quick yes/no questions"
                }
              >
                <ul className="space-y-1">
                  {DISCLOSURE_KEYS.map((key) => (
                    <li key={key}>
                      <label className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 transition-colors hover:bg-[var(--surface-2)]">
                        <input
                          type="checkbox"
                          checked={disclosures[key]}
                          onChange={(event) => {
                            setBehaviourAnswered(true);
                            setDisclosures((current) => ({ ...current, [key]: event.target.checked }));
                          }}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
                        />
                        <span className="text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
                          {DISCLOSURE_QUESTIONS[key]}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">
                  Tick only what actually happened. We never ask for the message, the app or your
                  account.
                </p>
              </Disclosure>

              <Disclosure
                open={showTerms}
                onToggle={() => setShowTerms((open) => !open)}
                title="The loan you were offered"
                summary={
                  termsCount > 0
                    ? `${termsCount} field${termsCount === 1 ? "" : "s"} filled in`
                    : "Amounts, rate and fees, if you have them"
                }
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {TERM_FIELDS.map((field) => (
                    <Text
                      key={field.key}
                      label={field.label}
                      hint={field.hint}
                      value={terms[field.key]}
                      onChange={(value) => setTerms((current) => ({ ...current, [field.key]: value }))}
                      placeholder={field.placeholder}
                    />
                  ))}
                  <Text
                    label="Security or papers demanded"
                    value={terms.collateralDemanded}
                    onChange={(value) =>
                      setTerms((current) => ({ ...current, collateralDemanded: value }))
                    }
                    placeholder="e.g. original property papers"
                    className="sm:col-span-3"
                  />
                </div>
                <p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">
                  Leave anything you were not told blank. Nothing is guessed on your behalf.
                </p>
              </Disclosure>
            </div>
          </Disclosure>
        </div>
      </form>

      <div
        ref={resultsRef}
        tabIndex={-1}
        aria-live="polite"
        aria-busy={pending}
        className="mx-auto mt-8 w-full max-w-3xl outline-none"
      >
        {error ? <Callout tone="error">{error}</Callout> : null}
        {pending ? <VerificationSequence stages={stages} /> : null}
        {result && !pending ? (
          <>
            <VerificationReport
              result={result}
              investigation={investigation}
              investigating={investigating}
            />

            {investigating ? (
              <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4">
                <p className="text-[0.875rem] font-medium text-[var(--text-primary)]">
                  Investigating this website…
                </p>
                <p className="mt-1 text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
                  It is not in the RBI data LenderLens holds, so LenderLens is reading the site,
                  looking for the company behind it and checking what official sources say. This
                  takes a few seconds.
                </p>
              </div>
            ) : null}

            {investigation ? <InvestigationPanel investigation={investigation} /> : null}

            {!investigating && !investigation && investigationNote ? (
              <p className="mt-4 px-1 text-[0.8125rem] leading-relaxed text-[var(--text-muted)]">
                {investigationNote}
              </p>
            ) : null}

            <div className="mt-6 text-center">
              <button
                type="button"
                onClick={reset}
                className="rounded-lg border border-[var(--border-strong)] px-5 py-2.5 text-[0.875rem] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
              >
                Check another website
              </button>
            </div>
          </>
        ) : null}
      </div>

      {idle && children ? <div className="mx-auto mt-14 w-full max-w-2xl">{children}</div> : null}
    </div>
  );
}

function Text({
  label,
  hint,
  value,
  onChange,
  placeholder,
  mono = false,
  className = "",
  autoComplete = "off",
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  mono?: boolean;
  className?: string;
  autoComplete?: string;
}) {
  const id = useId();

  return (
    <div className={className}>
      <label htmlFor={id} className="block text-[0.8125rem] font-medium text-[var(--text-secondary)]">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoCapitalize="none"
        spellCheck={false}
        maxLength={300}
        className={`mt-1.5 w-full rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2.5 text-[0.875rem] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] ${
          mono ? "tabular" : ""
        }`}
      />
      {hint ? <p className="mt-1 text-[0.6875rem] text-[var(--text-muted)]">{hint}</p> : null}
    </div>
  );
}

function Disclosure({
  open,
  onToggle,
  title,
  summary,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  title: string;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left"
      >
        <span className="min-w-0">
          <span className="block text-[0.875rem] font-medium text-[var(--text-primary)]">
            {title}
          </span>
          <span className="mt-0.5 block text-[0.8125rem] leading-relaxed text-[var(--text-muted)]">
            {summary}
          </span>
        </span>
        <span
          aria-hidden="true"
          className={`shrink-0 text-lg leading-none text-[var(--text-muted)] transition-transform ${open ? "rotate-45" : ""}`}
        >
          +
        </span>
      </button>
      {open ? <div className="border-t border-[var(--border)] px-4 py-4">{children}</div> : null}
    </div>
  );
}
