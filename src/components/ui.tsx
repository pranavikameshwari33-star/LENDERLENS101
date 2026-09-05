import type { ReactNode } from "react";

import type { SignalSeverity } from "@/lib/verify/signals";
import type { Verdict, VerificationMatrixRow } from "@/lib/verify/types";

/**
 * Shared presentational primitives.
 *
 * Colour carries meaning in this interface, so it is defined once, here, and
 * every element that uses it also carries a word. A reader who cannot rely on
 * hue loses nothing.
 */

export function Panel({
  children,
  className = "",
  as: Element = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
}) {
  return (
    <Element
      className={`rounded-lg border border-[var(--border)] bg-[var(--surface-1)] ${className}`}
    >
      {children}
    </Element>
  );
}

export function PanelHeader({
  eyebrow,
  title,
  hint,
  aside,
}: {
  eyebrow?: string;
  title: string;
  hint?: string;
  aside?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2 className="mt-1 text-[0.9375rem] font-semibold tracking-tight text-[var(--text-primary)]">
          {title}
        </h2>
        {hint ? (
          <p className="mt-1 max-w-2xl text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
            {hint}
          </p>
        ) : null}
      </div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </header>
  );
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export const VERDICT_STYLES: Record<
  Verdict,
  { border: string; background: string; text: string; dot: string }
> = {
  green: {
    border: "border-emerald-500/35",
    background: "bg-emerald-500/[0.07]",
    text: "text-emerald-300",
    dot: "bg-emerald-400",
  },
  amber: {
    border: "border-amber-500/35",
    background: "bg-amber-500/[0.07]",
    text: "text-amber-300",
    dot: "bg-amber-400",
  },
  red: {
    border: "border-rose-500/35",
    background: "bg-rose-500/[0.07]",
    text: "text-rose-300",
    dot: "bg-rose-400",
  },
  gray: {
    border: "border-[var(--border-strong)]",
    background: "bg-[var(--surface-2)]",
    text: "text-[var(--text-secondary)]",
    dot: "bg-[var(--signal-neutral)]",
  },
};

// ---------------------------------------------------------------------------
// Tones (used by the matrix)
// ---------------------------------------------------------------------------

type Tone = VerificationMatrixRow["tone"];

const TONE_STYLES: Record<Tone, { text: string; chip: string; mark: string; word: string }> = {
  positive: {
    text: "text-emerald-300",
    chip: "border-emerald-500/30 bg-emerald-500/[0.07]",
    mark: "✓",
    word: "Corroborated",
  },
  caution: {
    text: "text-amber-300",
    chip: "border-amber-500/30 bg-amber-500/[0.07]",
    mark: "!",
    word: "Unresolved",
  },
  negative: {
    text: "text-rose-300",
    chip: "border-rose-500/30 bg-rose-500/[0.07]",
    mark: "✕",
    word: "Contradicted",
  },
  neutral: {
    text: "text-[var(--text-secondary)]",
    chip: "border-[var(--border)] bg-[var(--surface-2)]",
    mark: "–",
    word: "No evidence",
  },
};

export function toneStyle(tone: Tone) {
  return TONE_STYLES[tone];
}

// ---------------------------------------------------------------------------
// Signal severities
// ---------------------------------------------------------------------------

const SEVERITY_STYLES: Record<
  SignalSeverity,
  { label: string; text: string; chip: string; bar: string }
> = {
  critical: {
    label: "Critical",
    text: "text-rose-300",
    chip: "border-rose-500/35 bg-rose-500/[0.07]",
    bar: "bg-rose-400",
  },
  high: {
    label: "High",
    text: "text-rose-200",
    chip: "border-rose-500/25 bg-rose-500/[0.05]",
    bar: "bg-rose-400/70",
  },
  medium: {
    label: "Medium",
    text: "text-amber-300",
    chip: "border-amber-500/25 bg-amber-500/[0.05]",
    bar: "bg-amber-400",
  },
  low: {
    label: "Low",
    text: "text-amber-200/80",
    chip: "border-amber-500/20 bg-amber-500/[0.03]",
    bar: "bg-amber-400/60",
  },
  positive: {
    label: "Supports",
    text: "text-emerald-300",
    chip: "border-emerald-500/25 bg-emerald-500/[0.05]",
    bar: "bg-emerald-400",
  },
  info: {
    label: "Context",
    text: "text-[var(--text-secondary)]",
    chip: "border-[var(--border)] bg-[var(--surface-2)]",
    bar: "bg-[var(--signal-neutral)]",
  },
};

export function severityStyle(severity: SignalSeverity) {
  return SEVERITY_STYLES[severity];
}

// ---------------------------------------------------------------------------
// Deeper detail
// ---------------------------------------------------------------------------

/**
 * A section a reader opens when they want it.
 *
 * Built on `<details>` so it works without JavaScript, is keyboard-operable and
 * is announced correctly by a screen reader without any ARIA of our own.
 */
export function Collapsible({
  summary,
  children,
  className = "",
}: {
  summary: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details
      className={`group rounded-lg border border-[var(--border)] bg-[var(--surface-1)] ${className}`}
    >
      <summary className="flex cursor-pointer items-center justify-between gap-4 px-5 py-3.5 text-[0.875rem] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
        {summary}
        <span
          aria-hidden="true"
          className="shrink-0 text-lg leading-none text-[var(--text-muted)] transition-transform group-open:rotate-45"
        >
          +
        </span>
      </summary>
      <div className="border-t border-[var(--border)]">{children}</div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** A labelled value in a detail grid. Renders an em dash when empty. */
export function Field({
  label,
  value,
  mono = false,
  className = "",
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  className?: string;
}) {
  const isEmpty = value === null || value === undefined || value === "";

  return (
    <div className={className}>
      <dt className="text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
        {label}
      </dt>
      <dd
        className={`mt-1 break-words text-[0.8125rem] leading-relaxed ${
          isEmpty ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"
        } ${mono ? "tabular" : ""}`}
      >
        {isEmpty ? "—" : value}
      </dd>
    </div>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning" | "error";
  title?: string;
  children: ReactNode;
}) {
  const styles = {
    info: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-secondary)]",
    warning: "border-amber-500/35 bg-amber-500/[0.06] text-amber-200",
    error: "border-rose-500/35 bg-rose-500/[0.06] text-rose-200",
  }[tone];

  return (
    <div className={`rounded-lg border px-4 py-3 text-[0.8125rem] leading-relaxed ${styles}`}>
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      {children}
    </div>
  );
}
