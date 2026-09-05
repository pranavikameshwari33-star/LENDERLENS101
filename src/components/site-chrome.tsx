import Link from "next/link";

/**
 * Header and footer.
 *
 * The header is a wordmark and nothing else: there is one thing to do on this
 * site, the page below is doing it, and a row of navigation would only offer a
 * person in a hurry somewhere else to go. The engineering pages are still
 * reachable — from the footer, where a reader who wants them will look.
 *
 * The disclaimer sits in the footer of every page rather than only on the one a
 * reader happens to land on: the regulatory wording matters as much as the
 * product does.
 */

export function SiteHeader() {
  return (
    <header className="border-b border-[var(--border)]">
      <div className="mx-auto flex max-w-3xl items-center px-5 py-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <LensMark />
          <span className="text-[0.9375rem] font-semibold tracking-tight text-[var(--text-primary)]">
            LenderLens
          </span>
        </Link>
      </div>
    </header>
  );
}

/** A lens over a document line — the product in one mark, at 28 pixels. */
function LensMark() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent-soft)] ring-1 ring-inset ring-[var(--accent)]/40"
    >
      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="8.5" cy="8.5" r="5" className="stroke-[var(--accent)]" />
        <path d="M12.4 12.4 17 17" className="stroke-[var(--accent)]" strokeLinecap="round" />
        <path d="M6.5 8.6l1.4 1.4 2.6-2.9" className="stroke-emerald-400" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-[var(--border)]">
      <div className="mx-auto max-w-3xl px-5 py-8 sm:px-6">
        <p className="text-center text-xs leading-relaxed text-[var(--text-muted)]">
          LenderLens is a risk-assessment tool built on the Reserve Bank of India&rsquo;s published
          reference data. It is not affiliated with, endorsed by, or connected to the Reserve Bank of
          India. It reads dated snapshots rather than live RBI systems, gives no financial advice,
          and cannot certify that any lender is safe. Always confirm a lender&rsquo;s status
          directly with the RBI before parting with money or documents.
        </p>
        <p className="mt-4 flex items-center justify-center gap-5 text-xs text-[var(--text-muted)]">
          <Link href="/technical" className="transition-colors hover:text-[var(--text-secondary)]">
            How the matching works
          </Link>
          <a href="/api/health" className="transition-colors hover:text-[var(--text-secondary)]">
            Status
          </a>
        </p>
      </div>
    </footer>
  );
}
