import "server-only";

/**
 * Write a privacy-conscious record of each verification to Supabase.
 *
 * What is stored, and why
 * -----------------------
 * The layer verdicts, the signal ids that fired, the model version and score,
 * and how long the check took. That is enough to answer the questions that
 * matter operationally — which layers actually decide outcomes, how often the
 * model disagrees with an identifier lookup, whether a rule is firing on
 * everything — without keeping anything about the person who asked.
 *
 * What is NOT stored
 * ------------------
 * No IP address, hashed or otherwise. No e-mail address. No loan amounts. No
 * free text the user typed. The lender's name is stored only as a SHA-256
 * digest, so repeat checks of the same lender can be counted without the table
 * becoming a list of who is being investigated by whom.
 *
 * Failure is not an error
 * -----------------------
 * A verification must never fail, slow down or change because the audit table
 * is unreachable. Every path here swallows its error after logging it, and the
 * caller invokes this without awaiting it.
 */

import { createHash } from "node:crypto";

import { getSupabaseAdmin, isSupabaseConfigured } from "../supabase-admin";
import type { VerificationResult } from "../verify/types";

/** Same pepper as the rate limiter: a bare SHA-256 of a company name is guessable. */
function digest(value: string): string {
  const pepper = process.env.RATE_LIMIT_PEPPER?.trim() ?? "lenderlens-unpeppered";
  return createHash("sha256").update(pepper).update(" ").update(value.toLowerCase()).digest("hex");
}

export async function recordVerification(result: VerificationResult): Promise<void> {
  if (!isSupabaseConfigured()) return;

  try {
    const { error } = await getSupabaseAdmin().from("verification_event").insert({
      verdict: result.verdict,
      regulatory_status: result.regulatory.status,
      company_status: result.company.status,
      website_status: result.website.status,
      email_status: result.email.status,
      loan_terms_status: result.loanTerms.status,
      scam_signal_level: result.scamSignals.level,

      // Identity is reduced to a digest before it reaches the database.
      lender_name_digest: result.query.companyName ? digest(result.query.companyName) : null,
      matched_entity_id: result.regulatory.primary?.entity.id ?? null,
      matched_entity_source: result.regulatory.primary?.entity.source ?? null,

      model_version: result.model.version,
      model_score: result.model.bestScore,
      model_threshold: result.model.threshold,
      candidates_scored: result.model.candidatesScored,

      signal_ids: result.signals.map((signal) => signal.id),
      signal_count: result.signals.length,

      inputs_supplied: {
        name: result.query.companyName !== null,
        cin: result.query.cin !== null,
        website: result.query.hostname !== null,
        email: result.query.email !== null,
        loanTerms: result.query.loanTermsProvided,
        disclosures: result.query.disclosuresProvided,
      },

      duration_ms: result.durationMs,
    });

    if (error) console.warn("audit write skipped:", error.message);
  } catch (error) {
    console.warn(
      "audit write skipped:",
      error instanceof Error ? error.message : String(error),
    );
  }
}
