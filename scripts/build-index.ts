/**
 * Compile the RBI sources into the runtime entity index.
 *
 *   npm run build:index
 *
 * Reads the two workbooks and the Banks-in-India snapshot through exactly the
 * same parsers the Supabase importer uses, flattens every record into the one
 * `IndexedEntity` shape, and writes `data/index/entity-index.json`.
 *
 * Why an on-disk index at all, when there is a Supabase project?
 * -------------------------------------------------------------
 * Two reasons, both about correctness rather than convenience.
 *
 *  1. The ML training pairs and the live verification path must see byte-identical
 *     entity records. Training against a file and serving from a database is how
 *     a model quietly learns something the application never sees.
 *  2. Candidate retrieval for entity resolution wants an in-process inverted
 *     index over ~15,000 names. A per-query round trip to pg_trgm cannot supply
 *     the same candidate set to the feature extractor at training time.
 *
 * Supabase remains the durable store, the model registry and the audit log —
 * see supabase/migrations/. It is not on the critical path of a verification,
 * which is why a verification still works when it is unreachable.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  readCancelledRecordSheet,
  readSimpleSheet,
  workbookAsOf,
  type DbRow,
  type SheetReadResult,
} from "./lib/rbi-sheets.ts";
import { buildBankRows, readBankSnapshot } from "./lib/rbi-banks.ts";
import {
  BANKS_SOURCE_URL,
  CANCELLED_WORKBOOK,
  DATASETS,
  REGISTERED_WORKBOOK,
} from "../src/lib/rbi/dataset.ts";
import { clusterKeyFor } from "../src/lib/index/cluster.ts";
import { INDEX_FILE_PATH, INDEX_FORMAT_VERSION } from "../src/lib/index/store.ts";
import type {
  DatasetSummary,
  EntityAttributes,
  EntityStanding,
  EntityIndexFile,
  IndexedEntity,
} from "../src/lib/index/types.ts";
import type { EntitySource } from "../src/lib/rbi/types.ts";

// ---------------------------------------------------------------------------
// Row -> entity
// ---------------------------------------------------------------------------

function text(row: DbRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function list(row: DbRow, key: string): string[] {
  const value = row[key];
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
}

function flag(row: DbRow, key: string): boolean | undefined {
  const value = row[key];
  return typeof value === "boolean" ? value : undefined;
}

function integer(row: DbRow, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : 0;
}

/** Drop undefined keys so the written file stays readable. */
function attributes(values: EntityAttributes): EntityAttributes {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    kept[key] = value;
  }
  return kept as EntityAttributes;
}

function toEntity(
  row: DbRow,
  source: EntitySource,
  standing: EntityStanding,
  nameKey: string,
  normalizedKey: string,
  coreKey: string,
  extra: EntityAttributes,
): IndexedEntity | null {
  const name = text(row, nameKey);
  const nameNormalized = text(row, normalizedKey);
  if (!name || !nameNormalized) return null;

  const nameCore = text(row, coreKey) ?? nameNormalized;
  const rowNumber = integer(row, "source_row_number");

  return {
    id: `${source}:${rowNumber}`,
    source,
    standing,
    name,
    nameNormalized,
    nameCore,
    alternateNames: list(row, "alternate_names_normalized"),
    cin: text(row, "cin_normalized"),
    emailDomains: list(row, "email_domains"),
    hostnames: list(row, "hostnames"),
    clusterKey: clusterKeyFor(nameCore),
    attributes: attributes(extra),
    provenance: {
      sourceFile: text(row, "source_file") ?? "unknown",
      sourceSheet: text(row, "source_sheet") ?? "unknown",
      sourceRowNumber: rowNumber,
      datasetAsOf: text(row, "dataset_as_of"),
    },
  };
}

function convert(result: SheetReadResult, source: EntitySource, standing: EntityStanding): IndexedEntity[] {
  const entities: IndexedEntity[] = [];

  for (const row of result.rows) {
    let entity: IndexedEntity | null = null;

    switch (source) {
      case "registered_nbfc":
        entity = toEntity(row, source, standing, "display_name", "name_normalized", "name_core", {
          classification: text(row, "classification_code") ?? text(row, "classification") ?? undefined,
          layer: text(row, "layer") ?? undefined,
          regionalOffice: text(row, "regional_office") ?? undefined,
          address: text(row, "address") ?? undefined,
          acceptsPublicDeposits: flag(row, "accepts_public_deposits"),
        });
        break;
      case "registered_arc":
        entity = toEntity(row, source, standing, "display_name", "name_normalized", "name_core", {
          classification: "ARC",
          regionalOffice: text(row, "regional_office") ?? undefined,
          address: text(row, "address") ?? undefined,
        });
        break;
      case "cancelled_company":
        entity = toEntity(row, source, standing, "name", "name_normalized", "name_core", {
          regionalOffice: text(row, "regional_office") ?? undefined,
          address: text(row, "address") ?? undefined,
        });
        break;
      case "cancelled_record":
        entity = toEntity(row, source, standing, "company_name", "company_name_normalized", "company_name_core", {
          classification: text(row, "classification") ?? undefined,
          regionalOffice: text(row, "regional_office") ?? undefined,
          corNumber: text(row, "cor_number") ?? undefined,
          corCancellationDate: text(row, "cor_cancellation_date") ?? undefined,
          cancellationReason: text(row, "reason") ?? undefined,
          recordSection: text(row, "section") ?? undefined,
          nbfcCode: text(row, "nbfc_code") ?? undefined,
        });
        break;
      case "bank":
        entity = toEntity(row, source, standing, "name", "name_normalized", "name_core", {
          bankCategory: text(row, "category") ?? undefined,
          address: text(row, "address") ?? undefined,
          websites: list(row, "websites"),
        });
        break;
    }

    if (entity) entities.push(entity);
  }

  return entities;
}

function summarise(
  result: SheetReadResult,
  label: string,
  count: number,
  sourceUrl: string | null,
  asOfIsFetchDate: boolean,
): DatasetSummary {
  return {
    key: result.key,
    label,
    sourceFile: result.fileName,
    sourceSheet: result.sheetName,
    sourceUrl,
    asOf: result.datasetAsOf,
    asOfIsFetchDate,
    count,
    rowsRead: result.stats.rowsRead,
    rowsSkipped: result.stats.rowsSkipped,
    notes: result.stats.notes.slice(0, 25),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("LenderLens :: building the entity index");

  const builtAt = new Date().toISOString();
  const registeredAsOf = await workbookAsOf(REGISTERED_WORKBOOK, "List of NBFCs");
  const cancelledAsOf = await workbookAsOf(CANCELLED_WORKBOOK, "Cancelled List");
  console.log(`  registered workbook as of: ${registeredAsOf ?? "unknown"}`);
  console.log(`  cancelled workbook as of:  ${cancelledAsOf ?? "unknown"}`);

  const entities: IndexedEntity[] = [];
  const datasets: DatasetSummary[] = [];

  const plan: {
    key: string;
    source: EntitySource;
    standing: EntityStanding;
    read: () => Promise<SheetReadResult>;
  }[] = [
    {
      key: "registered_nbfc",
      source: "registered_nbfc",
      standing: "registered",
      read: () =>
        readSimpleSheet("registered_nbfc", "registered_nbfc", REGISTERED_WORKBOOK, "List of NBFCs", builtAt, registeredAsOf),
    },
    {
      key: "registered_arc",
      source: "registered_arc",
      standing: "registered",
      read: () =>
        readSimpleSheet("registered_arc", "registered_arc", REGISTERED_WORKBOOK, "ARCs", builtAt, registeredAsOf),
    },
    {
      key: "cancelled_company",
      source: "cancelled_company",
      standing: "cancelled",
      read: () =>
        readSimpleSheet("cancelled_company", "cancelled_company", CANCELLED_WORKBOOK, "Cancelled List", builtAt, cancelledAsOf),
    },
    {
      key: "cancelled_record",
      source: "cancelled_record",
      standing: "cancellation_record",
      read: () => readCancelledRecordSheet(CANCELLED_WORKBOOK, "Record", builtAt, cancelledAsOf),
    },
  ];

  for (const step of plan) {
    const result = await step.read();
    const converted = convert(result, step.source, step.standing);
    entities.push(...converted);

    const descriptor = DATASETS.find((dataset) => dataset.key === step.key);
    datasets.push(summarise(result, descriptor?.label ?? step.key, converted.length, null, false));
    console.log(`  ${step.key.padEnd(20)} ${converted.length} entities`);
  }

  const snapshot = readBankSnapshot();
  const bankResult = buildBankRows(snapshot, builtAt);
  const banks = convert(bankResult, "bank", "bank");
  entities.push(...banks);
  datasets.push(summarise(bankResult, "RBI Banks in India", banks.length, BANKS_SOURCE_URL, true));
  console.log(`  ${"bank".padEnd(20)} ${banks.length} entities (fetched ${snapshot.fetchedAt.slice(0, 10)})`);

  // Sanity: two entities must never collide on id, or lookups silently merge them.
  const ids = new Set<string>();
  for (const entity of entities) {
    if (ids.has(entity.id)) throw new Error(`Duplicate entity id ${entity.id} — the index would be ambiguous.`);
    ids.add(entity.id);
  }

  const counts: Record<EntityStanding, number> = {
    registered: 0,
    cancelled: 0,
    cancellation_record: 0,
    bank: 0,
  };
  for (const entity of entities) counts[entity.standing] += 1;

  const file: EntityIndexFile = {
    formatVersion: INDEX_FORMAT_VERSION,
    builtAt,
    datasets,
    counts,
    entities,
  };

  const target = path.join(process.cwd(), INDEX_FILE_PATH);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(file), "utf8");

  const clusters = new Set(entities.map((entity) => entity.clusterKey));
  console.log("");
  console.log(`  total entities: ${entities.length.toLocaleString("en-IN")}`);
  console.log(`  name clusters:  ${clusters.size.toLocaleString("en-IN")}`);
  console.log(`  standings:      ${JSON.stringify(counts)}`);
  console.log(`  wrote ${target} (${(JSON.stringify(file).length / 1_048_576).toFixed(1)} MB)`);
}

main().catch((error: unknown) => {
  console.error("\nINDEX BUILD FAILED");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
