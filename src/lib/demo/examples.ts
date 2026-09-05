/**
 * Worked examples for the home page.
 *
 * Each one is assembled from a real record in the compiled index — the entity
 * is looked up, never typed in — so an example can never present a company that
 * does not exist in the RBI data. If the data changes and a chosen record goes
 * away, the example disappears rather than becoming a fiction.
 *
 * They are labelled by the thing the user is asked to enter — a website — so
 * that clicking one teaches the input rather than distracting from it. The
 * website in the impersonation example is a deliberately unregistered,
 * obviously synthetic string: it demonstrates the contradiction the product
 * exists to find without naming any real third party as fraudulent.
 */

import type { EntityIndex } from "../index/store";
import type { IndexedEntity } from "../index/types";

export interface HomepageExample {
  readonly label: string;
  readonly payload: Record<string, unknown>;
}

function find(index: EntityIndex, predicate: (entity: IndexedEntity) => boolean): IndexedEntity | null {
  return index.entities.find(predicate) ?? null;
}

/**
 * Long legal names make unreadable buttons; the distinctive part is enough.
 * The RBI publishes names in capitals, which read as shouting in a button.
 */
function shorten(name: string): string {
  const trimmed = name.replace(/\s+(PRIVATE\s+LIMITED|PVT\.?\s*LTD\.?|LIMITED|LTD\.?)$/i, "").trim();
  const words = trimmed.split(/\s+/).slice(0, 4);
  const cased = words.map((word) =>
    word === word.toUpperCase() && word.length > 3
      ? word[0] + word.slice(1).toLowerCase()
      : word,
  );
  return cased.join(" ") + (trimmed.split(/\s+/).length > 4 ? "…" : "");
}

export function buildHomepageExamples(index: EntityIndex): HomepageExample[] {
  const examples: HomepageExample[] = [];

  const bank = find(
    index,
    (entity) => entity.source === "bank" && entity.hostnames.length > 0,
  );

  const nbfc = find(
    index,
    (entity) =>
      entity.source === "registered_nbfc" &&
      entity.cin !== null &&
      entity.emailDomains.length > 0 &&
      entity.attributes.layer === "Upper",
  );

  const cancelled = find(
    index,
    (entity) => entity.source === "cancelled_company" && entity.name.length > 12,
  );

  // A website the RBI itself publishes for a bank: the one case where a domain
  // alone settles the question.
  if (bank) {
    examples.push({
      label: bank.hostnames[0],
      payload: { website: bank.hostnames[0] },
    });
  }

  // A real registered lender, approached through a website and e-mail that are
  // not its own, with an advance fee attached.
  if (nbfc) {
    examples.push({
      label: "instant-loan-approval-india.xyz",
      payload: {
        website: "https://instant-loan-approval-india.xyz",
        companyName: nbfc.name,
        email: "loan.officer.verification@gmail.com",
        loanTerms: {
          loanAmount: "500000",
          interestRatePercent: "8",
          processingFee: "12000",
          upfrontPayment: "24999",
          totalRepayment: "620000",
          tenureMonths: "12",
        },
        disclosures: {
          paymentBeforeDisbursement: true,
          pressuredToActImmediately: true,
          guaranteedApprovalNoChecks: true,
        },
      },
    });
  }

  // A lender whose registration the RBI cancelled. The cancelled list carries
  // no websites, so this example is necessarily by name.
  if (cancelled) {
    examples.push({
      label: shorten(cancelled.name),
      payload: { companyName: cancelled.name },
    });
  }

  return examples.slice(0, 3);
}
