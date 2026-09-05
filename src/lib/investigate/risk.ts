/**
 * The user-facing risk assessment.
 *
 * Everything else in the investigation layer is written to describe evidence
 * accurately. This file exists to answer the only question the person in front
 * of the screen is actually asking — is it safe to send these people money —
 * and it answers it under one rule:
 *
 *     LOW RISK has to be earned. HIGH RISK is what you get otherwise.
 *
 * That asymmetry is deliberate and it is not symmetrical with the evidence.
 * "We could not establish who runs this website" and "we established that this
 * website is run by criminals" are worlds apart as findings, and they are the
 * same thing as advice: do not send them money. A verification tool that
 * downgrades the first to something reassuring because it lacks proof of the
 * second is worse than no tool, because the user acts on the reassurance.
 *
 * Two facts have to hold, separately, before anything is LOW RISK:
 *
 *   FACT A — IDENTITY. The website can be tied to a named legal entity, with
 *            the identification grounded in something that was actually read.
 *   FACT B — REGULATORY STANDING. That legal entity — not the domain, not the
 *            brand — was found in the RBI reference data by an IDENTIFIER, and
 *            holds a current registration.
 *
 * Fact A is never allowed to stand in for Fact B. Discovering that
 * i2ifunding.com is operated by RNVP Technology Private Limited establishes
 * only that the website names an operator; whether that operator is registered
 * is a separate lookup with a separate answer. Neither is Fact B allowed to
 * stand in for Fact A: a real registered NBFC's name on a website nobody can
 * tie to it is exactly what impersonation looks like.
 *
 * An AI failure lands here as HIGH RISK too, and this is worth being clear
 * about, because it looks like the very conflation the rest of this layer
 * exists to prevent. It is not. The INTERNAL status stays AI_QUOTA_EXCEEDED —
 * the reason is preserved, reported and logged, and the evidence is kept — and
 * that is a statement about LenderLens. The risk level is a separate statement
 * about what the user may safely conclude, and what a user may conclude from an
 * investigation that did not finish is nothing. Nothing is not LOW RISK.
 *
 * Pure: no server-only import, no SDK, no environment. Every rule below is a
 * unit test.
 */

/**
 * Two levels, on purpose.
 *
 * The deterministic verification upstream has four (`Verdict` in
 * `verify/types.ts`) because it grades contradictions it can actually see. This
 * one grades whether legitimacy was established, and that has no middle: it
 * either was or it was not. A third level here would only give an unverified
 * lender somewhere softer to land.
 */
export type InvestigationRiskLevel = "LOW_RISK" | "HIGH_RISK";

/** The words shown to a user. Deliberately the same as `VERDICT_SHORT`. */
export const RISK_LABELS: Record<InvestigationRiskLevel, string> = {
  LOW_RISK: "LOW RISK",
  HIGH_RISK: "HIGH RISK",
};

export interface InvestigationRisk {
  readonly level: InvestigationRiskLevel;
  readonly label: string;
  /** One sentence saying what was or was not established. */
  readonly reason: string;
  /** Fact A: the website could be tied to a named legal entity. */
  readonly identityEstablished: boolean;
  /** Fact B: that entity holds a current RBI registration. */
  readonly regulatoryEstablished: boolean;
}

export interface RiskInput {
  /** Whether the AI reasoning step produced anything at all. */
  readonly aiCompleted: boolean;
  /** The legal entity the investigation settled on, if any. */
  readonly legalEntityName: string | null;
  /** How well that identification is supported by what was read. */
  readonly identityConfidence: IdentityConfidence;
  /**
   * Whether the RBI lookup on that legal entity found a record by an
   * IDENTIFIER — an exact name, a former name, a CIN, a published website —
   * rather than by name similarity.
   */
  readonly regulatoryIdentified: boolean;
  /** The standing of that record: "registered", "cancelled", "bank", … */
  readonly regulatoryStanding: string | null;
  /** Whether the evidence ties the domain to the entity. */
  readonly domainTied: boolean;
  /** Sources that contradict each other, from the sanitised analysis. */
  readonly conflicts: number;
}

export type IdentityConfidence = "high" | "medium" | "low" | "none";

/** Standings that mean "this record is a current authorisation". */
const CURRENT_STANDINGS: readonly string[] = ["registered", "bank"];

export function assessRisk(input: RiskInput): InvestigationRisk {
  const identityEstablished =
    input.legalEntityName !== null &&
    (input.identityConfidence === "high" || input.identityConfidence === "medium");

  const regulatoryEstablished =
    input.regulatoryIdentified &&
    input.regulatoryStanding !== null &&
    CURRENT_STANDINGS.includes(input.regulatoryStanding);

  const high = (reason: string): InvestigationRisk => ({
    level: "HIGH_RISK",
    label: RISK_LABELS.HIGH_RISK,
    reason,
    identityEstablished,
    regulatoryEstablished,
  });

  // The investigation did not finish. Whatever the internal reason — quota,
  // an overloaded model, an aborted request — the user learned nothing, and
  // nothing does not become reassurance.
  //
  // Unless, that is, the two facts were already established WITHOUT the model.
  // The AI step is one way to establish Fact A, not the only one: the RBI's own
  // record publishing this domain for a company, or the company's name printed
  // on the site and then found in the RBI data by identifier, establishes it
  // deterministically and is untouched by the model failing afterwards. Where
  // both facts stand on that evidence alone, "the AI was unavailable" is a
  // statement about LenderLens, not about the lender, and it must not overrule
  // a registration the RBI data positively confirms. The remaining rules below
  // still apply — a cancelled registration, or a domain that cannot be tied to
  // the entity, is still HIGH RISK on this path exactly as it is on the other.
  if (!input.aiCompleted && !(identityEstablished && regulatoryEstablished)) {
    return high(
      "The investigation could not be completed, so this website has not been verified. An " +
        "unfinished check is not a clean one: treat this lender as unverified until it can be run " +
        "again.",
    );
  }

  // A cancelled Certificate of Registration is the one case where the evidence
  // is positively bad rather than merely absent.
  if (input.regulatoryStanding === "cancelled" || input.regulatoryStanding === "cancellation_record") {
    return high(
      `The RBI's cancelled-registration list contains a matching record for ${
        input.legalEntityName ?? "the entity behind this website"
      }. An entity whose Certificate of Registration has been cancelled is not authorised to carry ` +
        "on the business of a non-banking financial company.",
    );
  }

  if (input.conflicts > 0) {
    return high(
      "The sources found during this investigation contradict each other, so the lender behind " +
        "this website could not be established. Unresolved contradictions are not something to act " +
        "through.",
    );
  }

  if (!identityEstablished) {
    return high(
      "No legal entity could be reliably tied to this website. A lending website that does not " +
        "disclose the company behind it cannot be checked against the RBI's records at all, which " +
        "is itself the reason to treat it as high risk.",
    );
  }

  if (!regulatoryEstablished) {
    return high(
      `This website appears to be operated by ${input.legalEntityName}, but that company could not ` +
        "be matched to a current registration in the RBI reference data LenderLens holds. Finding " +
        "the company is not the same as finding it authorised, and an unconfirmed regulatory " +
        "standing is treated as high risk.",
    );
  }

  if (!input.domainTied) {
    return high(
      `${input.legalEntityName} holds a current RBI registration, but nothing found during this ` +
        "investigation ties this particular website to that company. A registered lender's name on " +
        "a website that cannot be connected to it is what impersonation looks like.",
    );
  }

  return {
    level: "LOW_RISK",
    label: RISK_LABELS.LOW_RISK,
    reason:
      `This website discloses ${input.legalEntityName} as its operator, that company was found in ` +
      "the RBI reference data holding a current registration, and the evidence ties the two " +
      "together. Check the sources below yourself before you act on this.",
    identityEstablished,
    regulatoryEstablished,
  };
}

/**
 * The risk for an investigation that never reached the reasoning step.
 *
 * Used for both an AI failure and a genuine absence of evidence, which differ
 * in their internal status and their explanation but not in what a user may
 * safely conclude from them.
 */
export function unresolvedRisk(reason: string): InvestigationRisk {
  return {
    level: "HIGH_RISK",
    label: RISK_LABELS.HIGH_RISK,
    reason,
    identityEstablished: false,
    regulatoryEstablished: false,
  };
}
