/**
 * LAYER 1 — Regulatory identity.
 *
 * Is the institution the lender claims to be present in the RBI's published
 * reference data, and what does that data say about its standing?
 *
 * Everything in this layer is a lookup. No inference, no scoring: if the
 * cancelled-registration list contains a matching entry, the layer says so,
 * and nothing further downstream is permitted to overturn that. The model's
 * only contribution is deciding *which* record is being talked about.
 *
 * The most important rule here is the one that is easiest to get wrong:
 *
 *     ABSENCE FROM THE RBI DATA IS NOT EVIDENCE OF FRAUD.
 *
 * The NBFC and ARC lists cover NBFCs and ARCs. Banks are in a separate RBI
 * source. Insurers, stockbrokers, payment aggregators, co-operative societies
 * and unregulated lenders are in none of them. A lender absent from all of it
 * is unverified, which is a different and much weaker statement.
 */

import type { EntityStanding } from "../../index/types";
import { signal, type Signal } from "../signals";
import {
  REGULATORY_STATUS_LABELS,
  entitySourceLabel,
  type EntityMatch,
  type RegulatoryFindings,
  type RegulatoryStatus,
} from "../types";

/** A model probability at or above this is treated as an established match. */
const ACCEPTED = (match: EntityMatch): boolean => match.acceptedByModel;

const RBI_NBFC_SOURCE = "RBI list of registered NBFCs / ARCs";
const RBI_CANCELLED_SOURCE = "RBI cancelled-registration list";
const RBI_BANK_SOURCE = "RBI Banks in India";

export interface RegulatoryInput {
  readonly claimedName: string | null;
  readonly cin: string | null;
  readonly cinLooksMalformed: boolean;
  readonly matches: readonly EntityMatch[];
  readonly datasetAsOf: string | null;
}

export function assessRegulatory(input: RegulatoryInput): RegulatoryFindings {
  const registered = input.matches.filter((match) => match.entity.standing === "registered");
  const cancelled = input.matches.filter((match) => match.entity.standing === "cancelled");
  const records = input.matches.filter((match) => match.entity.standing === "cancellation_record");
  const banks = input.matches.filter((match) => match.entity.standing === "bank");

  const acceptedRegistered = registered.filter(ACCEPTED);
  const acceptedCancelled = cancelled.filter(ACCEPTED);
  const acceptedBanks = banks.filter(ACCEPTED);

  const status = resolveStatus(input, acceptedRegistered, acceptedCancelled, acceptedBanks);
  const primary = choosePrimary(status, acceptedRegistered, acceptedCancelled, acceptedBanks);

  const signals: Signal[] = [];

  // --- what the registered lists say ---------------------------------------
  for (const match of acceptedRegistered.slice(0, 1)) {
    const entity = match.entity;
    signals.push(
      signal({
        id: "rbi_registered",
        category: "regulatory",
        severity: "positive",
        origin: "regulatory_fact",
        title: "Present in the RBI's registered list",
        explanation:
          "An entity of this name holds a Certificate of Registration in the RBI reference data " +
          "used by LenderLens. This confirms the institution exists and is registered. It says " +
          "nothing about whether the party contacting you is actually that institution — the " +
          "layers below are what test that.",
        evidence: `${entity.name}${entity.cin ? ` (CIN ${entity.cin})` : ""}`,
        source: `${entitySourceLabel(entity)}${input.datasetAsOf ? `, as on ${input.datasetAsOf}` : ""}`,
      }),
    );

    if (entity.attributes.acceptsPublicDeposits === false) {
      signals.push(
        signal({
          id: "not_deposit_taking",
          category: "regulatory",
          severity: "info",
          origin: "regulatory_fact",
          title: "Not authorised to accept public deposits",
          explanation:
            "The RBI record shows this entity does not hold a Certificate of Registration permitting " +
            "it to accept or hold public deposits. If you are being offered a deposit or investment " +
            "scheme in this company's name, that is worth questioning.",
          evidence: "Public deposits: No",
          source: RBI_NBFC_SOURCE,
        }),
      );
    }

    if (entity.attributes.layer === "Upper" || entity.attributes.layer === "Middle") {
      signals.push(
        signal({
          id: "scale_based_layer",
          category: "regulatory",
          severity: "info",
          origin: "regulatory_fact",
          title: `Placed in the RBI's ${entity.attributes.layer} Layer`,
          explanation:
            "Under the RBI's scale-based regulation this entity sits above the Base Layer, which " +
            "carries closer supervision.",
          evidence: `${entity.attributes.layer} Layer`,
          source: RBI_NBFC_SOURCE,
        }),
      );
    }
  }

  // --- what the bank directory says ----------------------------------------
  for (const match of acceptedBanks.slice(0, 1)) {
    const entity = match.entity;
    signals.push(
      signal({
        id: "rbi_bank_listed",
        category: "regulatory",
        severity: "positive",
        origin: "regulatory_fact",
        title: "Listed by the RBI as a bank operating in India",
        explanation:
          "This institution appears in the RBI's Banks-in-India directory. Banks are licensed under " +
          "the Banking Regulation Act and do not appear in the NBFC lists at all, which is why a " +
          "bank must be checked against this separate source.",
        evidence: entity.name,
        source: RBI_BANK_SOURCE,
      }),
    );
  }

  // --- what the cancelled list says ----------------------------------------
  for (const match of acceptedCancelled.slice(0, 1)) {
    const entity = match.entity;
    const exact = match.identifiedBy === "exact_name";
    signals.push(
      signal({
        id: exact ? "rbi_cancelled_exact" : "rbi_cancelled_probable",
        category: "regulatory",
        severity: exact ? "critical" : "high",
        origin: "regulatory_fact",
        title: exact
          ? "Appears on the RBI's cancelled-registration list"
          : "Closely matches an entry on the RBI's cancelled-registration list",
        explanation:
          "The RBI has cancelled the Certificate of Registration of a company recorded under this " +
          "name. An entity whose CoR has been cancelled is not authorised to carry on the business " +
          "of a non-banking financial company. " +
          (exact
            ? "The RBI does not publish CINs on this list, so identity rests on the name alone — but an exact match here is serious."
            : "The RBI does not publish CINs on this list, so this may be a different company with a very similar name. Confirm before drawing a conclusion."),
        evidence: entity.name,
        source: `${RBI_CANCELLED_SOURCE}${input.datasetAsOf ? `, as on ${input.datasetAsOf}` : ""}`,
      }),
    );
  }

  // --- the cancellation / restoration record -------------------------------
  for (const match of records.filter(ACCEPTED).slice(0, 2)) {
    const entity = match.entity;
    const restored = entity.attributes.recordSection === "removed_from_list";
    signals.push(
      signal({
        id: restored ? "cor_restored" : "recently_cancelled",
        category: "regulatory",
        severity: restored ? "positive" : "high",
        origin: "regulatory_fact",
        title: restored
          ? "Certificate of Registration was restored"
          : "Recently added to the cancelled-registration list",
        explanation: restored
          ? "The RBI's record sheet shows this company being removed from the cancelled list."
          : "The RBI's record sheet lists this company among recent additions to the cancelled-registration list.",
        evidence: [entity.attributes.cancellationReason, entity.attributes.corCancellationDate]
          .filter(Boolean)
          .join(" · ") || entity.name,
        source: "RBI cancellation / restoration record",
      }),
    );
  }

  // --- conflict ------------------------------------------------------------
  if (status === "conflicting") {
    signals.push(
      signal({
        id: "registered_and_cancelled",
        category: "regulatory",
        severity: "high",
        origin: "regulatory_fact",
        title: "Both a registered and a cancelled record matched",
        explanation:
          "This name matches an entity holding a current registration AND an entry on the cancelled " +
          "list. Usually that means two different companies share a similar name. It cannot be " +
          "settled from names alone — a CIN would resolve it.",
        evidence: [acceptedRegistered[0]?.entity.name, acceptedCancelled[0]?.entity.name]
          .filter(Boolean)
          .join(" vs "),
        source: "RBI registered and cancelled lists",
      }),
    );
  }

  // --- nothing found -------------------------------------------------------
  if (status === "not_verified") {
    signals.push(
      signal({
        id: "not_in_rbi_data",
        category: "regulatory",
        severity: "medium",
        origin: "regulatory_fact",
        title: "Not found in the RBI reference data",
        explanation:
          "Nothing in the RBI's registered NBFC and ARC lists, its cancelled-registration list or " +
          "its Banks-in-India directory corroborates this name. That is NOT the same as finding " +
          "evidence of fraud: many lawful lenders — banks' subsidiaries trading under other names, " +
          "insurers, brokers, payment companies, co-operative societies — are regulated elsewhere " +
          "or not at all. It does mean LenderLens cannot confirm this lender is an RBI-registered " +
          "NBFC, and an unregistered party offering loans in India is worth taking seriously.",
        evidence: input.claimedName,
        source: "RBI reference datasets used by LenderLens",
      }),
    );
  }

  // --- CIN observations -----------------------------------------------------
  if (input.cin && input.cinLooksMalformed) {
    signals.push(
      signal({
        id: "cin_malformed",
        category: "regulatory",
        severity: "medium",
        origin: "heuristic",
        title: "The CIN is not in the standard format",
        explanation:
          "A Corporate Identification Number is 21 characters: L or U, five industry digits, a " +
          "two-letter state code, a four-digit year, a three-letter ownership code and a six-digit " +
          "registration number. The value supplied does not follow that pattern.",
        evidence: input.cin,
        source: "Format check",
      }),
    );
  }

  if (input.cin && !input.matches.some((match) => match.identifiedBy === "cin")) {
    signals.push(
      signal({
        id: "cin_not_in_rbi_lists",
        category: "regulatory",
        severity: "medium",
        origin: "regulatory_fact",
        title: "The CIN does not appear in the RBI registered lists",
        explanation:
          "This CIN is not recorded against any NBFC or ARC in the RBI reference data. Many companies " +
          "are registered with the Ministry of Corporate Affairs without being RBI-registered NBFCs, " +
          "so this does not mean the company does not exist — only that NBFC registration cannot be " +
          "confirmed from this data.",
        evidence: input.cin,
        source: RBI_NBFC_SOURCE,
      }),
    );
  }

  return {
    status,
    statusLabel: REGULATORY_STATUS_LABELS[status],
    primary,
    registered,
    cancelled,
    cancellationRecords: records,
    banks,
    primaryStanding: (primary?.entity.standing as EntityStanding | undefined) ?? null,
    signals,
  };
}

function resolveStatus(
  input: RegulatoryInput,
  registered: readonly EntityMatch[],
  cancelled: readonly EntityMatch[],
  banks: readonly EntityMatch[],
): RegulatoryStatus {
  if (!input.claimedName && !input.cin && input.matches.length === 0) return "unknown";

  const hasCurrent = registered.length > 0 || banks.length > 0;

  if (hasCurrent && cancelled.length > 0) {
    // A CIN or an RBI-published website is an identification. It outranks a
    // name collision on the cancelled list, which carries no identifiers at all.
    const identified = [...registered, ...banks].some(
      (match) => match.identifiedBy === "cin" || match.identifiedBy === "official_website",
    );
    return identified ? "verified" : "conflicting";
  }

  if (hasCurrent) return "verified";
  if (cancelled.length > 0) return "cancelled";
  return "not_verified";
}

/**
 * Only a match the model actually accepted may become the primary record.
 *
 * Falling back to "the best of a bad set" would attach the whole result — the
 * headline, the legal name, the address, the recommended actions — to a company
 * the matcher explicitly rejected. A near-miss belongs in the "also considered"
 * list, never at the top of the page.
 */
function choosePrimary(
  status: RegulatoryStatus,
  registered: readonly EntityMatch[],
  cancelled: readonly EntityMatch[],
  banks: readonly EntityMatch[],
): EntityMatch | null {
  if (status === "cancelled") return cancelled[0] ?? null;
  return registered[0] ?? banks[0] ?? cancelled[0] ?? null;
}
