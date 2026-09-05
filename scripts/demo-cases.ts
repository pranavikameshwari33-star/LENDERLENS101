/**
 * Run the demonstration cases end to end and print the result of each.
 *
 *   npm run demo            (network checks skipped — deterministic)
 *   npm run demo -- --live  (also fetches the websites)
 *
 * Every case is built from a real record in the RBI data. Nothing is invented:
 * the script looks the entity up in the compiled index first and fails loudly
 * if it has gone away, so a demo can never show a company that does not exist.
 *
 * The impersonation case is the one that matters. It pairs a genuine, currently
 * registered institution with a website and an e-mail that have nothing to do
 * with it — which is precisely the situation a simple RBI lookup calls "fine"
 * and a simple website checker calls "fine", and which LenderLens is built to
 * catch.
 */
import { loadEntityIndex } from "../src/lib/index/store.ts";
import type { IndexedEntity } from "../src/lib/index/types.ts";
import { verify } from "../src/lib/verify/engine.ts";
import { parseVerificationRequest, type VerificationRequest } from "../src/lib/verify/input.ts";

interface DemoCase {
  readonly id: string;
  readonly title: string;
  readonly explains: string;
  readonly request: VerificationRequest;
}

function pick(predicate: (entity: IndexedEntity) => boolean, description: string): IndexedEntity {
  const index = loadEntityIndex();
  const found = index.entities.find(predicate);
  if (!found) {
    throw new Error(
      `No entity in the index satisfies "${description}". The demo cases are built from real ` +
        "records; refusing to invent one. Re-run `npm run build:data`.",
    );
  }
  return found;
}

export function buildDemoCases(): DemoCase[] {
  // A large, currently registered NBFC that publishes a contact e-mail.
  const registered = pick(
    (entity) =>
      entity.source === "registered_nbfc" &&
      entity.emailDomains.length > 0 &&
      entity.cin !== null &&
      entity.attributes.layer === "Upper",
    "a registered NBFC in the Upper Layer with a contact e-mail and a CIN",
  );

  const cancelled = pick(
    (entity) => entity.source === "cancelled_company" && entity.name.length > 15,
    "a company on the cancelled-registration list",
  );

  const bank = pick(
    (entity) =>
      entity.source === "bank" &&
      entity.hostnames.length > 0 &&
      entity.attributes.bankCategory === "private_sector_bank",
    "a private-sector bank with an RBI-published website",
  );

  return [
    {
      id: "registered",
      title: "Case 1 — a registered NBFC, checked against its own details",
      explains:
        "Regulatory identity verified, company identity established by CIN, digital identity " +
        "corroborated by the contact domain the RBI publishes.",
      request: {
        companyName: registered.name,
        cin: registered.cin ?? undefined,
        website: registered.emailDomains[0],
        email: `support@${registered.emailDomains[0]}`,
        disclosuresAnswered: true,
      },
    },
    {
      id: "cancelled",
      title: "Case 2 — an entity on the RBI's cancelled-registration list",
      explains:
        "A published regulatory fact. No amount of positive evidence elsewhere is allowed to " +
        "soften it, which is why this is a red verdict regardless of the other layers.",
      request: { companyName: cancelled.name, disclosuresAnswered: true },
    },
    {
      id: "unknown",
      title: "Case 3 — a lender absent from every RBI source",
      explains:
        "The verdict is GRAY, not RED. Absence from the reference data is not evidence of fraud, " +
        "and calling it fraud would be the product's worst possible failure mode.",
      request: { companyName: "Rapid Cash Instant Loans", disclosuresAnswered: true },
    },
    {
      id: "impersonation",
      title: "Case 4 — a real registered NBFC, contacted from somewhere else entirely",
      explains:
        "THE DIFFERENTIATOR. The company exists and is registered. The website, the e-mail and the " +
        "loan terms belong to nobody connected with it. An RBI lookup says yes; a website checker " +
        "says the site is fine; LenderLens says the identity does not hold together.",
      request: {
        companyName: registered.name,
        website: "https://quick-loan-approval.xyz",
        email: "loanofficer.verify@gmail.com",
        loanTerms: {
          loanAmount: 500000,
          interestRatePercent: 8,
          processingFee: 12000,
          upfrontPayment: 24999,
          totalRepayment: 620000,
          tenureMonths: 12,
        },
        disclosures: {
          paymentBeforeDisbursement: true,
          pressuredToActImmediately: true,
          guaranteedApprovalNoChecks: true,
        },
        disclosuresAnswered: true,
      },
    },
    {
      id: "bank",
      title: "Case 5 — a bank, which appears in no NBFC list at all",
      explains:
        "Banks are licensed under a different framework and are absent from the NBFC and ARC " +
        "workbooks. Without the RBI's Banks-in-India source this would read as 'not found'.",
      request: {
        companyName: bank.name,
        website: bank.hostnames[0],
        disclosuresAnswered: true,
      },
    },
    {
      id: "bank_impersonation",
      title: "Case 6 — a bank's name on a domain the RBI publishes for someone else",
      explains:
        "The bank directory gives LenderLens an authoritative name-to-domain mapping, so this " +
        "contradiction is a lookup rather than a guess.",
      request: {
        companyName: bank.name,
        website: pick(
          (entity) => entity.source === "bank" && entity.hostnames.length > 0 && entity.id !== bank.id,
          "a second bank with an RBI-published website",
        ).hostnames[0],
        disclosuresAnswered: true,
      },
    },
  ];
}

const TONE = {
  green: "GREEN ",
  amber: "AMBER ",
  red: "RED   ",
  gray: "GRAY  ",
} as const;

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  const cases = buildDemoCases();

  console.log("LenderLens :: demonstration cases");
  console.log(live ? "  live website checks: ON" : "  live website checks: skipped (--live to enable)");

  for (const demo of cases) {
    const parsed = parseVerificationRequest(demo.request);
    const result = await verify(parsed, { skipWebsiteCheck: !live });

    console.log(`\n${"=".repeat(96)}`);
    console.log(demo.title);
    console.log(`  ${demo.explains}`);
    console.log("-".repeat(96));
    console.log(`  input        ${JSON.stringify(demo.request).slice(0, 160)}`);
    console.log(`  VERDICT      ${TONE[result.verdict]} ${result.verdictShort}`);
    console.log(`  headline     ${result.headline}`);
    console.log("");
    for (const row of result.matrix) {
      console.log(`    ${row.layer.padEnd(26)} ${row.status.padEnd(18)} ${row.evidence.slice(0, 60)}`);
    }
    console.log("");
    console.log(
      `    ML entity match          ${
        result.model.bestScore !== null ? `${(result.model.bestScore * 100).toFixed(1)}%` : "n/a"
      }  (${result.model.algorithm ?? "unavailable"}, threshold ${result.model.threshold ?? "-"}, ${result.model.candidatesScored} candidates scored)`,
    );
    console.log("");
    for (const reason of result.reasons.slice(0, 4)) {
      console.log(`    · ${reason.slice(0, 150)}`);
    }
    console.log(`\n  signals (${result.signals.length}):`);
    for (const item of result.signals.slice(0, 8)) {
      console.log(`    [${item.severity.padEnd(8)}] ${item.title}`);
    }
    console.log(`\n  completed in ${result.durationMs} ms`);
  }

  console.log(`\n${"=".repeat(96)}\n`);
}

main().catch((error: unknown) => {
  console.error("\nDEMO FAILED");
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
