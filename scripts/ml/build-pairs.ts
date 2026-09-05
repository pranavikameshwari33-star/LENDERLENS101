/**
 * Build the entity-matching dataset.
 *
 *   npm run ml:pairs
 *
 * Writes `ml/data/pairs.csv` — one row per (claimed name, candidate entity)
 * pair, with its label, its split, its group and its feature vector already
 * computed by `src/lib/ml/features.ts`. The Python trainer never recomputes a
 * feature, so the numbers it learns from are byte-identical to the numbers the
 * live request path produces.
 *
 * How the labels are obtained
 * ---------------------------
 * There is no public register of "which fake lender impersonated which NBFC",
 * and inventing one would make every metric downstream meaningless. So the
 * label here is not fraud. It is identity:
 *
 *     y = 1  the claimed name and the candidate entity are the same institution
 *     y = 0  they are different institutions
 *
 * Ground truth comes from the RBI data itself. Two records are the same
 * institution when they share a normalised name or a CIN — which is how the
 * same company appears in both the registered and the cancelled lists. Every
 * other pair is a different institution, and the RBI sheets contain no
 * duplicate names within a sheet, so that rule is safe.
 *
 * How the queries are obtained
 * ----------------------------
 * A user does not paste the RBI's exact string. They type what the lender told
 * them. Two sources of realistic variation are used:
 *
 *   REAL       the "(Formerly: ...)" and "(Name as per MCA - ...)" aliases the
 *              RBI itself prints — 593 genuine name pairs, no synthesis at all
 *   SYNTHETIC  documented, deterministic edits of the published name: legal
 *              form swapped or dropped, a middle word omitted, "&" spelled
 *              out, a single-character typo, the initials of a long name
 *
 * The synthetic edits are listed in `VARIANTS` below and each pair records
 * which one produced it, so the evaluation can report accuracy per variant
 * rather than hiding an easy case inside an average.
 *
 * How leakage is prevented
 * ------------------------
 *  - Entities are grouped by the first distinctive word of their name
 *    (`clusterKeyFor`). Every Bajaj entity is in one group.
 *  - Groups, not rows, are assigned to train / validation / test.
 *  - Hard negatives for a query are retrieved from a per-split index, so a
 *    training pair can never mention a test-set entity.
 *  - IDF for the features is computed over the FULL corpus, matching what the
 *    request path sees. That is a property of the corpus, not of the labels,
 *    so it carries no target information.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildEntityIndexFrom, loadEntityIndex } from "../../src/lib/index/store.ts";
import { retrieveCandidates } from "../../src/lib/index/search.ts";
import type { EntityIndexFile, IndexedEntity } from "../../src/lib/index/types.ts";
import {
  FEATURE_NAMES,
  buildIdfContext,
  buildQueryProfile,
  extractFeatures,
} from "../../src/lib/ml/features.ts";
import { normalizeName } from "../../src/lib/normalize.ts";

// ---------------------------------------------------------------------------
// Configuration — every number here is reported in the metrics artifact.
// ---------------------------------------------------------------------------

export const DATASET_CONFIG = {
  seed: 20260629,
  splitRatios: { train: 0.7, validation: 0.15, test: 0.15 },
  /** Entities sampled as query sources. The full corpus is the candidate pool. */
  entitySampleSize: 6_000,
  /** Hard negatives drawn from the top of the candidate ranking, per query. */
  hardNegativesPerQuery: 5,
  /** Random in-split negatives, so the model sees easy cases too. */
  randomNegativesPerQuery: 1,
  candidatePoolSize: 40,
} as const;

const OUTPUT_PATH = "ml/data/pairs.csv";

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** xmur3 + mulberry32: a small, seedable, reproducible PRNG. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable hash of a group key, so the split does not depend on iteration order. */
function hashString(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash / 4294967296;
}

type Split = "train" | "validation" | "test";

function splitForGroup(group: string): Split {
  const value = hashString(group, DATASET_CONFIG.seed);
  if (value < DATASET_CONFIG.splitRatios.train) return "train";
  if (value < DATASET_CONFIG.splitRatios.train + DATASET_CONFIG.splitRatios.validation) {
    return "validation";
  }
  return "test";
}

// ---------------------------------------------------------------------------
// Query variants
// ---------------------------------------------------------------------------

type VariantId =
  | "verbatim"
  | "legal_form_swapped"
  | "legal_form_dropped"
  | "middle_word_dropped"
  | "ampersand_spelled_out"
  | "single_character_typo"
  | "initialism"
  | "initialism_with_legal_form"
  | "rbi_former_name";

interface Variant {
  readonly id: VariantId;
  readonly describe: string;
  /** Returns null when the variant does not apply to this name. */
  readonly apply: (name: string, random: () => number) => string | null;
}

const LEGAL_FORM_SWAPS: readonly (readonly [RegExp, string])[] = [
  [/\bPrivate Limited\b/i, "Pvt Ltd"],
  [/\bPrivate Ltd\b/i, "Pvt. Ltd."],
  [/\bLimited\b/i, "Ltd"],
  [/\bLtd\.?\b/i, "Limited"],
];

const VARIANTS: readonly Variant[] = [
  {
    id: "verbatim",
    describe: "The name exactly as the RBI publishes it.",
    apply: (name) => name,
  },
  {
    id: "legal_form_swapped",
    describe: "\"Private Limited\" written as \"Pvt Ltd\", and the reverse.",
    apply: (name) => {
      for (const [pattern, replacement] of LEGAL_FORM_SWAPS) {
        if (pattern.test(name)) return name.replace(pattern, replacement);
      }
      return null;
    },
  },
  {
    id: "legal_form_dropped",
    describe: "The legal form left off entirely, as people usually say it.",
    apply: (name) => {
      const stripped = name.replace(
        /\s+(Private\s+Limited|Private\s+Ltd\.?|Pvt\.?\s*Ltd\.?|Limited|Ltd\.?)\s*$/i,
        "",
      );
      return stripped !== name && stripped.trim().length >= 4 ? stripped.trim() : null;
    },
  },
  {
    id: "middle_word_dropped",
    describe: "One interior word omitted, the commonest way a name is misquoted.",
    apply: (name, random) => {
      const words = name.split(/\s+/);
      if (words.length < 4) return null;
      const index = 1 + Math.floor(random() * (words.length - 2));
      const kept = words.filter((_, i) => i !== index);
      return kept.join(" ");
    },
  },
  {
    id: "ampersand_spelled_out",
    describe: "\"&\" written as \"and\", and the reverse.",
    apply: (name) => {
      if (name.includes("&")) return name.replace("&", "and");
      if (/\sand\s/i.test(name)) return name.replace(/\sand\s/i, " & ");
      return null;
    },
  },
  {
    id: "single_character_typo",
    describe: "One character transposed, dropped or doubled.",
    apply: (name, random) => {
      const letters = [...name];
      const positions = letters
        .map((character, index) => ({ character, index }))
        .filter((item) => /[A-Za-z]/.test(item.character) && item.index > 0);
      if (positions.length < 4) return null;

      const pick = positions[Math.floor(random() * positions.length)].index;
      const mode = Math.floor(random() * 3);
      if (mode === 0 && pick + 1 < letters.length) {
        [letters[pick], letters[pick + 1]] = [letters[pick + 1], letters[pick]];
      } else if (mode === 1) {
        letters.splice(pick, 1);
      } else {
        letters.splice(pick, 0, letters[pick]);
      }
      const result = letters.join("");
      return result === name ? null : result;
    },
  },
  {
    id: "initialism",
    describe: "The initials of a long name, as a caller might give them.",
    apply: (name) => {
      const words = name
        .replace(/\s+(Private\s+Limited|Pvt\.?\s*Ltd\.?|Limited|Ltd\.?)\s*$/i, "")
        .split(/\s+/)
        .filter((word) => /^[A-Za-z]/.test(word));
      if (words.length < 3) return null;
      return words.map((word) => word[0].toUpperCase()).join("");
    },
  },
  {
    id: "initialism_with_legal_form",
    describe: "The initials including the legal form, as Indian NBFCs are usually abbreviated.",
    apply: (name) => {
      const words = name.split(/\s+/).filter((word) => /^[A-Za-z]/.test(word));
      if (words.length < 3) return null;
      const initials = words.map((word) => word[0].toUpperCase()).join("");
      return initials.length >= 3 ? initials : null;
    },
  },
  {
    id: "rbi_former_name",
    describe: "A former or MCA name the RBI itself records for this entity.",
    // Supplied directly from the data rather than generated; see below.
    apply: () => null,
  },
];

const VARIANT_BY_ID = new Map(VARIANTS.map((variant) => [variant.id, variant]));

/** The synthetic variants applied to each sampled entity, in order. */
const SYNTHETIC_ORDER: readonly VariantId[] = [
  "verbatim",
  "legal_form_dropped",
  "legal_form_swapped",
  "middle_word_dropped",
  "single_character_typo",
  "ampersand_spelled_out",
  "initialism",
  "initialism_with_legal_form",
];

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Whether two index records describe the same institution.
 *
 * Same normalised name, or same CIN. This is the labelling rule, and it is the
 * project's main labelling limitation: it treats institutional identity as
 * name identity, which is right for these sheets (no sheet contains a
 * duplicate name) but would not hold for a corpus that did.
 */
function sameInstitution(a: IndexedEntity, b: IndexedEntity): boolean {
  if (a.id === b.id) return true;
  if (a.cin && b.cin && a.cin === b.cin) return true;
  return a.nameNormalized === b.nameNormalized;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

interface PairRow {
  readonly split: Split;
  readonly group: string;
  readonly variant: VariantId;
  readonly query: string;
  readonly entityId: string;
  readonly entitySource: string;
  readonly label: 0 | 1;
  readonly features: readonly number[];
}

function stratifiedSample(entities: readonly IndexedEntity[], size: number, random: () => number): IndexedEntity[] {
  // Sample within each source so the 27 ARCs and 168 banks are represented at
  // all; a flat sample would be 55% cancelled companies and nothing else.
  const bySource = new Map<string, IndexedEntity[]>();
  for (const entity of entities) {
    const bucket = bySource.get(entity.source);
    if (bucket) bucket.push(entity);
    else bySource.set(entity.source, [entity]);
  }

  const shuffle = (items: IndexedEntity[]): IndexedEntity[] => {
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  };

  const shuffled = new Map<string, IndexedEntity[]>();
  for (const [source, bucket] of bySource) shuffled.set(source, shuffle(bucket));

  const perSource = Math.ceil(size / bySource.size);
  const sampled: IndexedEntity[] = [];
  const taken = new Map<string, number>();

  for (const [source, bucket] of shuffled) {
    const count = Math.min(perSource, bucket.length);
    sampled.push(...bucket.slice(0, count));
    taken.set(source, count);
  }

  // The small sources (27 ARCs, 24 record rows) cannot fill their share, so
  // the shortfall is redistributed to the large ones rather than shrinking the
  // dataset.
  for (const [source, bucket] of shuffled) {
    if (sampled.length >= size) break;
    const already = taken.get(source) ?? 0;
    const extra = Math.min(bucket.length - already, size - sampled.length);
    if (extra > 0) sampled.push(...bucket.slice(already, already + extra));
  }

  return sampled;
}

async function main(): Promise<void> {
  console.log("LenderLens :: building the entity-matching dataset");

  const index = loadEntityIndex();
  const idfContext = buildIdfContext(index.idf, index.totalDocuments);
  console.log(`  corpus: ${index.entities.length.toLocaleString("en-IN")} entities`);

  // --- split the corpus by group -----------------------------------------
  const splitOf = new Map<string, Split>();
  const entitiesBySplit: Record<Split, IndexedEntity[]> = { train: [], validation: [], test: [] };
  for (const entity of index.entities) {
    let split = splitOf.get(entity.clusterKey);
    if (!split) {
      split = splitForGroup(entity.clusterKey);
      splitOf.set(entity.clusterKey, split);
    }
    entitiesBySplit[split].push(entity);
  }

  console.log(
    `  groups: ${splitOf.size.toLocaleString("en-IN")} -> ` +
      `train ${entitiesBySplit.train.length}, validation ${entitiesBySplit.validation.length}, test ${entitiesBySplit.test.length}`,
  );

  // A separate retrieval index per split: a training query can then never pull
  // a test-set entity in as a negative.
  const splitIndexes: Record<Split, ReturnType<typeof buildEntityIndexFrom>> = {
    train: buildEntityIndexFrom({ ...index.file, entities: entitiesBySplit.train } as EntityIndexFile),
    validation: buildEntityIndexFrom({ ...index.file, entities: entitiesBySplit.validation } as EntityIndexFile),
    test: buildEntityIndexFrom({ ...index.file, entities: entitiesBySplit.test } as EntityIndexFile),
  };

  const random = makeRandom(DATASET_CONFIG.seed);
  const sample = stratifiedSample(index.entities, DATASET_CONFIG.entitySampleSize, random);
  console.log(`  query sources: ${sample.length.toLocaleString("en-IN")} entities`);

  const rows: PairRow[] = [];
  const variantCounts = new Map<VariantId, number>();
  const seenPairs = new Set<string>();
  let processed = 0;

  for (const entity of sample) {
    processed += 1;
    if (processed % 500 === 0) {
      process.stdout.write(`\r    ${processed}/${sample.length} entities, ${rows.length} pairs`);
    }

    const split = splitOf.get(entity.clusterKey) ?? "train";
    const splitIndex = splitIndexes[split];

    // --- assemble the queries for this entity -----------------------------
    const queries: { text: string; variant: VariantId }[] = [];
    for (const variantId of SYNTHETIC_ORDER) {
      const variant = VARIANT_BY_ID.get(variantId);
      if (!variant) continue;
      const produced = variant.apply(entity.name, random);
      if (!produced) continue;
      const normalized = normalizeName(produced);
      if (normalized.length < 3) continue;
      if (queries.some((existing) => normalizeName(existing.text) === normalized)) continue;
      queries.push({ text: produced, variant: variantId });
    }
    for (const alternate of entity.alternateNames) {
      if (alternate.length >= 3) queries.push({ text: alternate, variant: "rbi_former_name" });
    }

    for (const query of queries) {
      variantCounts.set(query.variant, (variantCounts.get(query.variant) ?? 0) + 1);

      const profile = buildQueryProfile(query.text);
      const candidates = retrieveCandidates(
        query.text,
        { maxCandidates: DATASET_CONFIG.candidatePoolSize },
        splitIndex,
      );

      const positives: IndexedEntity[] = [];
      const negatives: IndexedEntity[] = [];
      for (const candidate of candidates) {
        (sameInstitution(candidate.entity, entity) ? positives : negatives).push(candidate.entity);
      }

      // The true entity is always a positive, even when blocking missed it —
      // otherwise the recall the model is measured on would silently exclude
      // every case the retrieval stage got wrong.
      if (!positives.some((item) => item.id === entity.id)) positives.unshift(entity);

      const chosen: { entity: IndexedEntity; label: 0 | 1 }[] = [];
      for (const positive of positives) chosen.push({ entity: positive, label: 1 });
      for (const negative of negatives.slice(0, DATASET_CONFIG.hardNegativesPerQuery)) {
        chosen.push({ entity: negative, label: 0 });
      }
      for (let i = 0; i < DATASET_CONFIG.randomNegativesPerQuery; i += 1) {
        const pool = entitiesBySplit[split];
        const pick = pool[Math.floor(random() * pool.length)];
        if (pick && !sameInstitution(pick, entity)) chosen.push({ entity: pick, label: 0 });
      }

      for (const item of chosen) {
        const key = `${split}|${profile.normalized}|${item.entity.id}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);

        rows.push({
          split,
          group: entity.clusterKey,
          variant: query.variant,
          query: query.text,
          entityId: item.entity.id,
          entitySource: item.entity.source,
          label: item.label,
          features: extractFeatures(profile, item.entity, idfContext),
        });
      }
    }
  }

  process.stdout.write("\r");

  // --- write --------------------------------------------------------------
  const header = [
    "split", "group", "variant", "query", "entity_id", "entity_source", "label",
    ...FEATURE_NAMES,
  ];

  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.split,
        csv(row.group),
        row.variant,
        csv(row.query),
        row.entityId,
        row.entitySource,
        String(row.label),
        ...row.features.map((value) => value.toFixed(6)),
      ].join(","),
    );
  }

  const target = path.join(process.cwd(), OUTPUT_PATH);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${lines.join("\n")}\n`, "utf8");

  // --- report -------------------------------------------------------------
  const perSplit: Record<Split, { total: number; positive: number }> = {
    train: { total: 0, positive: 0 },
    validation: { total: 0, positive: 0 },
    test: { total: 0, positive: 0 },
  };
  for (const row of rows) {
    perSplit[row.split].total += 1;
    if (row.label === 1) perSplit[row.split].positive += 1;
  }

  console.log(`  pairs written: ${rows.length.toLocaleString("en-IN")}`);
  for (const split of ["train", "validation", "test"] as const) {
    const stats = perSplit[split];
    const share = stats.total > 0 ? ((stats.positive / stats.total) * 100).toFixed(1) : "0.0";
    console.log(`    ${split.padEnd(11)} ${String(stats.total).padStart(7)} pairs, ${share}% positive`);
  }
  console.log("  query variants:");
  for (const [variant, count] of [...variantCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${variant.padEnd(24)} ${count}`);
  }
  console.log(`\n  wrote ${target}`);
}

function csv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

main().catch((error: unknown) => {
  console.error("\nDATASET BUILD FAILED");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
