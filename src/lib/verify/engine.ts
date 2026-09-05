import "server-only";

/**
 * The verification pipeline.
 *
 *   parsed input
 *     -> entity resolution        identifiers first, then the ML model
 *     -> LAYER 1  regulatory identity      (RBI registered / cancelled / banks)
 *     -> LAYER 2  company identity         (legal name, CIN, address)
 *     -> LAYER 3  website identity         (RBI-published site, live check)
 *     -> LAYER 4  e-mail identity
 *     -> LAYER 5a loan terms
 *     -> LAYER 5b behavioural scam signals
 *     -> deterministic verdict engine
 *     -> structured evidence
 *
 * Each layer is independent and produces signals; the verdict engine reads only
 * signals and layer verdicts. Removing the website entirely leaves five layers
 * still working, which is the test that this is not a website checker with
 * extra steps.
 */

import { loadEntityIndex, EntityIndexUnavailableError } from "../index/store";
import { decide } from "./decision";
import { assessCompanyIdentity } from "./layers/company";
import { assessEmail } from "./layers/email";
import { assessLoanTerms } from "./layers/loan-terms";
import { assessRegulatory } from "./layers/regulatory";
import { assessScamSignals } from "./layers/scam-signals";
import { assessWebsite } from "./layers/website";
import { resolveEntities } from "./matcher";
import { bySeverity, type Signal } from "./signals";
import { INPUT_KIND_LABELS, type ParsedInput } from "./input";
import type { ModelFindings, VerificationResult } from "./types";

export interface EngineOptions {
  /** Skip the outbound HTTP request to the lender's site. */
  readonly skipWebsiteCheck?: boolean;
}

export class VerificationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationUnavailableError";
  }
}

export async function verify(
  input: ParsedInput,
  options: EngineOptions = {},
): Promise<VerificationResult> {
  const startedAt = Date.now();
  const notices: string[] = [];

  let index;
  try {
    index = loadEntityIndex();
  } catch (error) {
    throw new VerificationUnavailableError(
      error instanceof EntityIndexUnavailableError
        ? error.message
        : "The RBI reference data could not be loaded.",
    );
  }

  // --- entity resolution ---------------------------------------------------
  const resolution = resolveEntities(
    {
      claimedName: input.companyName,
      cin: input.cin,
      hostname: input.hostname,
      emailDomain: input.email,
    },
    index,
  );
  notices.push(...resolution.notices);

  // --- LAYER 1: regulatory identity ---------------------------------------
  const nbfcDataset = index.file.datasets.find((dataset) => dataset.key === "registered_nbfc");
  const bankDataset = index.file.datasets.find((dataset) => dataset.key === "bank");

  const regulatory = assessRegulatory({
    claimedName: input.companyName,
    cin: input.cin,
    cinLooksMalformed: input.cinLooksMalformed,
    matches: resolution.matches,
    datasetAsOf: nbfcDataset?.asOf ?? null,
  });

  const primaryEntity = regulatory.primary?.entity ?? null;

  // --- LAYER 2: company identity -------------------------------------------
  const company = assessCompanyIdentity({
    claimedName: input.companyName,
    cin: input.cin,
    primary: regulatory.primary,
    matches: resolution.matches,
    modelThreshold: resolution.model.threshold,
  });

  // --- LAYERS 3-5: run the independent ones together ------------------------
  const websitePromise = assessWebsite({
    hostname: input.hostname,
    derivedFromEmail: input.websiteUrl === null && input.hostname !== null,
    matchedEntity: primaryEntity,
    claimedName: input.companyName,
    skipNetwork: options.skipWebsiteCheck === true,
  });

  const email = assessEmail({
    address: input.email,
    websiteHostname: input.websiteUrl !== null ? input.hostname : null,
    matchedEntity: primaryEntity,
    claimsRegulatedStatus: regulatory.status === "verified" || input.companyName !== null,
  });

  const loanTerms = assessLoanTerms(input.loanTerms, input.loanTermsProvided);
  const scamSignals = assessScamSignals(input.disclosures, input.disclosuresAnswered);

  const website = await websitePromise;

  if (website.checked && website.domainAge && !website.domainAge.available && website.domainAge.unavailableReason) {
    notices.push(website.domainAge.unavailableReason);
  }
  if (!input.companyName && !input.cin) {
    notices.push(
      "No lender name or CIN was supplied, so the identity checks worked from the domain alone. " +
        "Entering the name the lender gave you makes the result considerably stronger.",
    );
  }
  if (!input.disclosuresAnswered) {
    notices.push(
      "You did not answer the questions about what this lender has asked you for, so that part of " +
        "the check did not run. It is the strongest evidence this tool has.",
    );
  }

  // --- assemble ------------------------------------------------------------
  const allSignals: Signal[] = [
    ...regulatory.signals,
    ...company.signals,
    ...website.signals,
    ...email.signals,
    ...loanTerms.signals,
    ...scamSignals.signals,
  ].sort(bySeverity);

  const decision = decide({
    regulatory,
    company,
    website,
    email,
    loanTerms,
    scamSignals,
    claimedName: input.companyName,
    allSignals,
  });

  const best = resolution.matches[0] ?? null;
  const model: ModelFindings = {
    available: resolution.model.available,
    version: resolution.model.version,
    algorithm: resolution.model.algorithm,
    threshold: resolution.model.threshold,
    bestScore: best ? best.matchProbability : null,
    bestEntityName: best?.entity.name ?? null,
    candidatesScored: resolution.model.candidatesScored,
    unavailableReason: resolution.model.unavailableReason,
  };

  const sources = [
    ...new Set(
      resolution.matches.map((match) => {
        const dataset = index.file.datasets.find((item) => item.key === match.entity.source);
        return dataset?.label ?? match.entity.source;
      }),
    ),
  ];

  return {
    query: {
      raw: input.raw,
      interpretedAs: input.kind,
      interpretedAsLabel: INPUT_KIND_LABELS[input.kind],
      companyName: input.companyName,
      cin: input.cin,
      email: input.email,
      hostname: input.hostname,
      loanTermsProvided: input.loanTermsProvided,
      disclosuresProvided: input.disclosuresAnswered,
    },

    verdict: decision.verdict,
    verdictLabel: decision.verdictLabel,
    verdictShort: decision.verdictShort,
    headline: decision.headline,
    summary: decision.summary,
    reasons: decision.reasons,
    recommendedActions: decision.recommendedActions,

    regulatory,
    company,
    website,
    email,
    loanTerms,
    scamSignals,
    model,

    signals: allSignals,
    matrix: decision.matrix,

    dataset: {
      nbfcAsOf: nbfcDataset?.asOf ?? null,
      banksFetchedAt: bankDataset?.asOf ?? null,
      counts: index.countsByStanding,
      sources,
    },

    notices,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

/** Format an ISO date for display, in Indian English. */
export function formatAsOf(isoDate: string | null): string {
  if (!isoDate) return "date unavailable";
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return parsed.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
