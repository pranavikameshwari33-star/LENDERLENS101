/**
 * Features for the entity-matching model.
 *
 * The question this model answers is narrow and stated precisely:
 *
 *     Given the lender name a user was given, and one candidate entity from
 *     the RBI reference data, do the two names refer to the same institution?
 *
 * That is all. It is not a fraud score, it does not look at the website, the
 * e-mail or the loan terms, and it never sees a label that would let it learn
 * anything about fraud. Those questions are answered deterministically by the
 * verification layers, which is where the evidence for them actually lives.
 *
 * Why the features live here rather than in the training script
 * ------------------------------------------------------------
 * This module is imported by BOTH `scripts/ml/build-pairs.ts` (which writes the
 * training CSV) and the request path (which scores a live candidate). There is
 * therefore exactly one implementation of every feature, and the classic
 * train/serve skew — a subtly different tokeniser on each side — cannot happen.
 * The Python trainer never computes a feature; it consumes the CSV this code
 * produced.
 */

import {
  acronymOf,
  charNgrams,
  commonPrefixLength,
  jaroWinkler,
  nameCore,
  nameTokens,
  normalizeName,
  normalizedEditSimilarity,
  tokenContainment,
  tokenJaccard,
  trigramSimilarity,
  weightedTokenOverlap,
} from "../normalize";

/**
 * Feature names, in the exact order the model expects them.
 *
 * The trained artifact records this list too, and `loadEntityMatchModel`
 * refuses a model whose order disagrees — a silently reordered vector would
 * produce confident nonsense.
 */
export const FEATURE_NAMES = [
  "exact_normalized_match",
  "exact_core_match",
  "alternate_name_match",
  "token_jaccard",
  "token_containment",
  "idf_weighted_overlap",
  "trigram_core",
  "trigram_full",
  "jaro_winkler",
  "edit_similarity",
  "prefix_ratio",
  "length_ratio",
  "token_count_gap",
  "first_token_match",
  "acronym_match",
  "shared_rare_token",
  "unmatched_rare_query_token",
  "unmatched_rare_entity_token",
  "digit_token_agreement",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export const FEATURE_COUNT = FEATURE_NAMES.length;

/** The query side of a pair, normalised once and reused across candidates. */
export interface QueryProfile {
  readonly raw: string;
  readonly normalized: string;
  readonly core: string;
  readonly tokens: readonly string[];
  readonly tokenSet: ReadonlySet<string>;
  readonly compact: string;
}

/** The candidate side. Deliberately structural, so tests can build one. */
export interface CandidateProfile {
  readonly nameNormalized: string;
  readonly nameCore: string;
  readonly alternateNames: readonly string[];
}

export function buildQueryProfile(name: string): QueryProfile {
  const normalized = normalizeName(name);
  const core = nameCore(name) || normalized;
  const tokens = nameTokens(core);
  return {
    raw: name,
    normalized,
    core,
    tokens,
    tokenSet: new Set(tokens),
    compact: core.replace(/\s+/g, ""),
  };
}

/**
 * IDF lookup plus the constant used to rescale it into [0, 1].
 *
 * Rarity is measured against the whole RBI corpus, so "FINANCE" is worth
 * almost nothing and "YERROW" is worth almost everything. Without this the
 * model would treat agreement on the word "PRIVATE" as evidence.
 */
export interface IdfContext {
  readonly idf: ReadonlyMap<string, number>;
  /** IDF value that corresponds to a token appearing exactly once. */
  readonly maxIdf: number;
}

export function buildIdfContext(idf: ReadonlyMap<string, number>, totalDocuments: number): IdfContext {
  return { idf, maxIdf: Math.log((totalDocuments + 1) / 2) + 1 };
}

function weightOf(context: IdfContext, token: string): number {
  return Math.min(1, (context.idf.get(token) ?? context.maxIdf) / context.maxIdf);
}

function digitTokens(tokens: readonly string[]): string[] {
  return tokens.filter((token) => /\d/.test(token));
}

/**
 * Compute the feature vector for one (query, candidate) pair.
 *
 * Returns a plain number array in `FEATURE_NAMES` order.
 */
export function extractFeatures(
  query: QueryProfile,
  candidate: CandidateProfile,
  context: IdfContext,
): number[] {
  const candidateCore = candidate.nameCore || candidate.nameNormalized;
  const candidateTokens = nameTokens(candidateCore);
  const candidateSet = new Set(candidateTokens);
  const candidateCompact = candidateCore.replace(/\s+/g, "");

  const sharedRare = maxWeight(
    [...query.tokenSet].filter((token) => candidateSet.has(token)),
    context,
  );
  const unmatchedQueryRare = maxWeight(
    [...query.tokenSet].filter((token) => !candidateSet.has(token)),
    context,
  );
  const unmatchedCandidateRare = maxWeight(
    [...candidateSet].filter((token) => !query.tokenSet.has(token)),
    context,
  );

  const queryDigits = digitTokens(query.tokens);
  const candidateDigits = digitTokens(candidateTokens);
  const digitAgreement =
    queryDigits.length === 0 && candidateDigits.length === 0
      ? 1
      : queryDigits.length === 0 || candidateDigits.length === 0
        ? 0
        : queryDigits.filter((token) => candidateDigits.includes(token)).length /
          Math.max(queryDigits.length, candidateDigits.length);

  const longest = Math.max(query.compact.length, candidateCompact.length);
  const shortest = Math.min(query.compact.length, candidateCompact.length);

  // Both spellings of an initialism are recognised: "BF" for the core name and
  // "BFL" for the name including its legal form. Indian NBFC abbreviations
  // commonly keep the L, and a matcher that only knew one of the two would miss
  // whichever the caller happened to use.
  const acronymMatch = matchesAcronym(query, candidateCore, candidate.nameNormalized, candidateCompact)
    ? 1
    : 0;

  return [
    query.normalized === candidate.nameNormalized ? 1 : 0,
    query.core === candidateCore ? 1 : 0,
    candidate.alternateNames.includes(query.normalized) ? 1 : 0,
    tokenJaccard(query.core, candidateCore),
    tokenContainment(query.core, candidateCore),
    weightedTokenOverlap(query.core, candidateCore, context.idf, context.maxIdf),
    trigramSimilarity(query.core, candidateCore),
    trigramSimilarity(query.normalized, candidate.nameNormalized),
    jaroWinkler(query.compact, candidateCompact),
    normalizedEditSimilarity(query.compact, candidateCompact),
    shortest === 0 ? 0 : commonPrefixLength(query.compact, candidateCompact) / shortest,
    longest === 0 ? 0 : shortest / longest,
    Math.min(1, Math.abs(query.tokens.length - candidateTokens.length) / 5),
    query.tokens[0] !== undefined && query.tokens[0] === candidateTokens[0] ? 1 : 0,
    acronymMatch,
    sharedRare,
    unmatchedQueryRare,
    unmatchedCandidateRare,
    digitAgreement,
  ];
}

function matchesAcronym(
  query: QueryProfile,
  candidateCore: string,
  candidateNormalized: string,
  candidateCompact: string,
): boolean {
  const queryForms = [acronymOf(query.core), acronymOf(query.normalized)];
  const candidateForms = [acronymOf(candidateCore), acronymOf(candidateNormalized)];

  for (const form of queryForms) {
    if (form.length >= 2 && form === candidateCompact) return true;
  }
  for (const form of candidateForms) {
    if (form.length >= 2 && form === query.compact) return true;
  }
  return false;
}

function maxWeight(tokens: readonly string[], context: IdfContext): number {
  let best = 0;
  for (const token of tokens) {
    const weight = weightOf(context, token);
    if (weight > best) best = weight;
  }
  return best;
}

/** Character n-grams of a name, exposed for the retrieval index. */
export function retrievalNgrams(value: string): string[] {
  return charNgrams(value.replace(/\s+/g, " "), 3);
}
