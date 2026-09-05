/**
 * Load the compiled entity index and build the in-memory lookups over it.
 *
 * The file is read once per process and cached. Everything derived from it —
 * the identifier maps, the token postings, the document frequencies used for
 * IDF — is built at load time rather than stored, because rebuilding it takes
 * a few tens of milliseconds and storing it would double the file size.
 *
 * This module has no Next.js, Supabase or network dependency, so the training
 * pipeline in `scripts/ml/` loads exactly the same index the request path does.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { charNgrams, nameTokens } from "../normalize";
import type { EntityIndexFile, EntityStanding, IndexedEntity } from "./types";

/** Relative to the project root. Kept here so the builder and reader agree. */
export const INDEX_FILE_PATH = "data/index/entity-index.json";
export const INDEX_FORMAT_VERSION = 1;

/** Size of the character n-grams used for typo-tolerant candidate retrieval. */
const NGRAM_SIZE = 3;

/**
 * Tokens appearing in more than this share of names ("FINANCE", "PRIVATE") are
 * useless for retrieval and expensive to post: a query containing one would
 * pull in thousands of candidates. They still contribute to the similarity
 * features, just not to the candidate set.
 */
const TOKEN_POSTING_CEILING = 0.02;

export class EntityIndexUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityIndexUnavailableError";
  }
}

export interface EntityIndex {
  readonly builtAt: string;
  readonly file: EntityIndexFile;
  readonly entities: readonly IndexedEntity[];

  readonly byId: ReadonlyMap<string, IndexedEntity>;
  readonly byNameNormalized: ReadonlyMap<string, readonly number[]>;
  readonly byNameCore: ReadonlyMap<string, readonly number[]>;
  readonly byAlternateName: ReadonlyMap<string, readonly number[]>;
  readonly byCin: ReadonlyMap<string, readonly number[]>;
  readonly byEmailDomain: ReadonlyMap<string, readonly number[]>;
  readonly byHostname: ReadonlyMap<string, readonly number[]>;

  /** token -> entity positions, excluding tokens that appear almost everywhere. */
  readonly tokenPostings: ReadonlyMap<string, readonly number[]>;
  /** 3-gram -> entity positions, for names with typos. */
  readonly ngramPostings: ReadonlyMap<string, readonly number[]>;
  /** Inverse document frequency per token, over the whole corpus. */
  readonly idf: ReadonlyMap<string, number>;
  readonly totalDocuments: number;
  readonly countsByStanding: Readonly<Record<EntityStanding, number>>;
}

let cached: EntityIndex | null = null;

export function indexFilePath(root: string = process.cwd()): string {
  return path.join(root, INDEX_FILE_PATH);
}

export function isEntityIndexBuilt(root?: string): boolean {
  return existsSync(indexFilePath(root));
}

/** Load (and memoise) the index. Throws a message a human can act on. */
export function loadEntityIndex(root?: string): EntityIndex {
  if (cached) return cached;

  const file = indexFilePath(root);
  if (!existsSync(file)) {
    throw new EntityIndexUnavailableError(
      `The entity index has not been built. Run \`npm run build:data\` to create ${INDEX_FILE_PATH}.`,
    );
  }

  let parsed: EntityIndexFile;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as EntityIndexFile;
  } catch (error) {
    throw new EntityIndexUnavailableError(
      `${INDEX_FILE_PATH} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed.formatVersion !== INDEX_FORMAT_VERSION || !Array.isArray(parsed.entities)) {
    throw new EntityIndexUnavailableError(
      `${INDEX_FILE_PATH} was built by a different version of this application. Re-run \`npm run build:data\`.`,
    );
  }

  cached = build(parsed);
  return cached;
}

/** Test seam: forget the memoised index. */
export function resetEntityIndexCache(): void {
  cached = null;
}

function add(map: Map<string, number[]>, key: string, position: number): void {
  if (key.length === 0) return;
  const bucket = map.get(key);
  if (bucket) bucket.push(position);
  else map.set(key, [position]);
}

/**
 * Build an index over an arbitrary set of entities.
 *
 * The ML pair builder uses this to construct one index per data split, so that
 * a hard negative for a training query can never be drawn from the test set.
 * Feature IDF still comes from the full corpus — see scripts/ml/build-pairs.ts.
 */
export function buildEntityIndexFrom(file: EntityIndexFile): EntityIndex {
  return build(file);
}

function build(file: EntityIndexFile): EntityIndex {
  const entities = file.entities;
  const byId = new Map<string, IndexedEntity>();
  const byNameNormalized = new Map<string, number[]>();
  const byNameCore = new Map<string, number[]>();
  const byAlternateName = new Map<string, number[]>();
  const byCin = new Map<string, number[]>();
  const byEmailDomain = new Map<string, number[]>();
  const byHostname = new Map<string, number[]>();
  const ngramPostings = new Map<string, number[]>();
  const allTokenPostings = new Map<string, number[]>();

  entities.forEach((entity, position) => {
    byId.set(entity.id, entity);
    add(byNameNormalized, entity.nameNormalized, position);
    add(byNameCore, entity.nameCore, position);
    for (const alternate of entity.alternateNames) add(byAlternateName, alternate, position);
    if (entity.cin) add(byCin, entity.cin, position);
    for (const domain of entity.emailDomains) add(byEmailDomain, domain, position);
    for (const hostname of entity.hostnames) add(byHostname, hostname, position);

    // Postings are built from the core name plus any former name, which is
    // what a user is realistically typing.
    const surfaces = [entity.nameCore, ...entity.alternateNames];
    const tokens = new Set<string>();
    const grams = new Set<string>();
    for (const surface of surfaces) {
      for (const token of nameTokens(surface)) tokens.add(token);
      for (const gram of charNgrams(surface.replace(/\s+/g, " "), NGRAM_SIZE)) grams.add(gram);
    }
    for (const token of tokens) add(allTokenPostings, token, position);
    for (const gram of grams) add(ngramPostings, gram, position);
  });

  const totalDocuments = entities.length;
  const idf = new Map<string, number>();
  const tokenPostings = new Map<string, number[]>();
  const ceiling = Math.max(20, Math.floor(totalDocuments * TOKEN_POSTING_CEILING));

  for (const [token, positions] of allTokenPostings) {
    idf.set(token, Math.log((totalDocuments + 1) / (positions.length + 1)) + 1);
    if (positions.length <= ceiling) tokenPostings.set(token, positions);
  }

  return {
    builtAt: file.builtAt,
    file,
    entities,
    byId,
    byNameNormalized,
    byNameCore,
    byAlternateName,
    byCin,
    byEmailDomain,
    byHostname,
    tokenPostings,
    ngramPostings,
    idf,
    totalDocuments,
    countsByStanding: file.counts,
  };
}
