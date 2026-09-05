import { loadEntityIndex, type EntityIndex } from "@/lib/index/store";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { VerifyForm } from "@/components/verify-form";
import { Callout, Collapsible } from "@/components/ui";
import { buildHomepageExamples } from "@/lib/demo/examples";

/**
 * The home page.
 *
 * A person arrives here holding a link and a decision they have to make in the
 * next few minutes. So the page is one sentence, one input and one button, and
 * the honest small print about what this tool cannot do is folded underneath —
 * present, one tap away, and not standing between them and the answer.
 *
 * A Server Component, so the worked examples are built from real records: a
 * demo can never show a company that does not exist in the data.
 */

export const dynamic = "force-dynamic";

function loadIndexSafely(): EntityIndex | null {
  try {
    return loadEntityIndex();
  } catch {
    return null;
  }
}

const LIMITS = [
  {
    title: "It cannot certify that a lender is safe.",
    body: "A clear result says the published evidence is consistent. It is not an endorsement of any offer.",
  },
  {
    title: "Not found does not mean fraudulent.",
    body: "Banks' subsidiaries trading under other names, insurers, stockbrokers, payment companies and co-operative societies are regulated under other frameworks and appear in none of these lists.",
  },
  {
    title: "It reads dated snapshots, not live RBI systems.",
    body: "Every answer is only as current as the date shown with it.",
  },
  {
    title: "It will miss careful fraudsters.",
    body: "Someone who registers a lookalike domain, writes from a matching address and asks for nothing up front will pass every check here.",
  },
];

export default function Home() {
  const index = loadIndexSafely();
  const examples = index ? buildHomepageExamples(index) : [];

  return (
    <>
      <SiteHeader />

      <main className="flex-1">
        <div className="hero-wash">
          <section className="mx-auto max-w-3xl px-5 pb-20 pt-12 sm:px-6 sm:pt-20">
            <h1 className="text-[1.75rem] font-semibold leading-[1.2] tracking-tight text-[var(--text-primary)] sm:text-[2.25rem]">
              Check a lending website before you trust it.
            </h1>
            <p className="mt-3 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]">
              Enter the address and LenderLens looks it up against the Reserve Bank of India&rsquo;s
              published lists of lenders — registered, banks, and those whose registration was
              cancelled.
            </p>

            <div className="mt-8">
              {index ? (
                <VerifyForm examples={examples}>
                  <Collapsible summary="What this can and cannot tell you">
                    <ul className="divide-y divide-[var(--border)]">
                      {LIMITS.map((limit) => (
                        <li key={limit.title} className="px-5 py-3.5">
                          <p className="text-[0.875rem] font-medium text-[var(--text-primary)]">
                            {limit.title}
                          </p>
                          <p className="mt-1 text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
                            {limit.body}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </Collapsible>
                </VerifyForm>
              ) : (
                <Callout tone="warning" title="The reference data has not been built yet.">
                  Run <code className="tabular">npm run build:data</code> to compile the RBI
                  workbooks and the Banks-in-India snapshot into the entity index, then{" "}
                  <code className="tabular">npm run ml:all</code> to train the entity-matching
                  model. <a href="/api/health" className="underline underline-offset-2">/api/health</a>{" "}
                  reports exactly what is outstanding.
                </Callout>
              )}
            </div>
          </section>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
