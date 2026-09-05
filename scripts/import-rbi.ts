/**
 * Import the RBI reference workbooks into Supabase.
 *
 *   npm run import:rbi              -- import everything
 *   npm run import:rbi -- --dry-run -- parse and report, write nothing
 *   npm run import:rbi -- --only registered_nbfc,bank
 *   npm run import:rbi -- --no-prune
 *   npm run import:rbi -- --prune-legacy   -- also drop pre-provenance rows
 *
 * Design notes
 * ------------
 * Idempotent. Every row is UPSERTed on (source_file, source_sheet,
 * source_row_number), so running the importer twice updates rows in place
 * instead of duplicating the dataset. After a successful pass, rows belonging
 * to the same sheet that were not touched by this run are pruned, which keeps
 * the table in sync when the RBI publishes a shorter list.
 *
 * Nothing is dropped silently. Every row that is not imported is counted and
 * explained in the run summary and in the `import_runs` table.
 */
import path from "node:path";
import { existsSync } from "node:fs";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { requireSupabaseCredentials } from "./lib/script-env.ts";
import {
  DATA_DIR,
  readCancelledRecordSheet,
  readReferenceSheet,
  readSimpleSheet,
  workbookAsOf,
  type DbRow,
  type ImportStats,
  type SheetReadResult,
} from "./lib/rbi-sheets.ts";
import { buildBankRows, readBankSnapshot } from "./lib/rbi-banks.ts";
import {
  BANKS_SNAPSHOT_FILE,
  CANCELLED_WORKBOOK,
  DATASETS,
  REFERENCE_SHEET,
  REGISTERED_WORKBOOK,
} from "../src/lib/rbi/dataset.ts";

const UPSERT_CHUNK_SIZE = 500;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
  readonly dryRun: boolean;
  readonly prune: boolean;
  /** Also delete rows written before migration 0002 added the provenance columns. */
  readonly pruneLegacy: boolean;
  readonly only: ReadonlySet<string> | null;
}

function parseOptions(argv: readonly string[]): Options {
  const only = new Set<string>();
  let dryRun = false;
  let prune = true;
  let pruneLegacy = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-prune") prune = false;
    else if (arg === "--prune-legacy") pruneLegacy = true;
    else if (arg === "--only") {
      const value = argv[i + 1];
      if (!value) throw new Error("--only requires a dataset key");
      for (const key of value.split(",")) only.add(key.trim());
      i += 1;
    } else if (arg.startsWith("--only=")) {
      for (const key of arg.slice("--only=".length).split(",")) only.add(key.trim());
    } else {
      throw new Error(`Unrecognised argument: ${arg}`);
    }
  }

  return { dryRun, prune, pruneLegacy, only: only.size > 0 ? only : null };
}

// ---------------------------------------------------------------------------
// Supabase writes
//
// The sheets themselves are parsed by scripts/lib/rbi-sheets.ts, which is
// shared with the entity-index builder so the two can never disagree about
// what a row means.
// ---------------------------------------------------------------------------

async function upsertRows(
  client: SupabaseClient,
  table: string,
  rows: readonly DbRow[],
  stats: ImportStats,
  onConflict = "source_file,source_sheet,source_row_number",
): Promise<void> {
  for (let start = 0; start < rows.length; start += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + UPSERT_CHUNK_SIZE);
    const { error } = await client
      .from(table)
      .upsert(chunk, { onConflict });

    if (error) {
      stats.errorCount += 1;
      throw new Error(
        `Upsert into ${table} failed at rows ${start + 1}-${start + chunk.length}: ${error.message}` +
          (error.hint ? ` (hint: ${error.hint})` : ""),
      );
    }

    stats.rowsImported += chunk.length;
    process.stdout.write(
      `\r    upserted ${stats.rowsImported}/${rows.length} into ${table}`,
    );
  }
  if (rows.length > 0) process.stdout.write("\n");
}

/**
 * Delete rows from a previous import of the same sheet that this run did not
 * touch, so the table mirrors the workbook rather than accumulating history.
 *
 * A row is stale when its `last_imported_at` predates this run, or is null —
 * null meaning it was written before provenance tracking existed.
 */
async function pruneStaleRows(
  client: SupabaseClient,
  table: string,
  fileName: string,
  sheetName: string,
  importedAt: string,
  stats: ImportStats,
): Promise<void> {
  const { data, error } = await client
    .from(table)
    .delete()
    .eq("source_file", fileName)
    .eq("source_sheet", sheetName)
    .or(`last_imported_at.lt.${importedAt},last_imported_at.is.null`)
    .select("id");

  if (error) {
    stats.errorCount += 1;
    throw new Error(`Pruning stale rows from ${table} failed: ${error.message}`);
  }

  stats.rowsPruned = data?.length ?? 0;
}

/**
 * Rows left behind by an import that ran before migration 0002 added the
 * provenance columns. They carry no `source_file`, so the ordinary prune above
 * cannot see them, and their unique key is all-null — which means an upsert
 * inserts alongside them rather than replacing them. Left alone they would
 * quietly double every count.
 *
 * They are reported by default and only removed when explicitly asked for,
 * because deleting rows this script did not write should be a decision rather
 * than a side effect.
 */
async function handleLegacyRows(
  client: SupabaseClient,
  table: string,
  pruneLegacy: boolean,
  stats: ImportStats,
): Promise<void> {
  const { count, error } = await client
    .from(table)
    .select("id", { count: "exact", head: true })
    .is("source_file", null);

  if (error) {
    stats.notes.push(`could not check ${table} for rows without provenance: ${error.message}`);
    return;
  }

  const legacyCount = count ?? 0;
  if (legacyCount === 0) return;

  if (!pruneLegacy) {
    stats.notes.push(
      `${legacyCount} row(s) in ${table} have no source_file — they predate migration 0002 ` +
        "and are duplicates of rows this run imported. Re-run with --prune-legacy to remove them.",
    );
    console.warn(
      `    ! ${legacyCount} row(s) in ${table} predate provenance tracking and were left in place.\n` +
        "      Re-run with --prune-legacy to remove them.",
    );
    return;
  }

  const { data, error: deleteError } = await client
    .from(table)
    .delete()
    .is("source_file", null)
    .select("id");

  if (deleteError) {
    stats.errorCount += 1;
    throw new Error(`Removing rows without provenance from ${table} failed: ${deleteError.message}`);
  }

  const removed = data?.length ?? 0;
  stats.rowsPruned += removed;
  stats.notes.push(`removed ${removed} row(s) from ${table} that predated provenance tracking`);
}

async function recordImportRun(
  client: SupabaseClient,
  result: SheetReadResult,
  startedAt: string,
  status: "succeeded" | "failed",
  failureMessage: string | null,
): Promise<void> {
  const { stats } = result;
  const { error } = await client.from("import_runs").insert({
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status,
    source_file: result.fileName,
    source_sheet: result.sheetName,
    target_table: result.table,
    dataset_as_of: result.datasetAsOf,
    dataset_title: result.datasetTitle,
    rows_read: stats.rowsRead,
    rows_imported: stats.rowsImported,
    rows_skipped: stats.rowsSkipped,
    rows_missing_cin: stats.rowsMissingCin,
    rows_invalid_cin: stats.rowsInvalidCin,
    rows_missing_email: stats.rowsMissingEmail,
    duplicate_keys: stats.duplicateKeys,
    rows_pruned: stats.rowsPruned,
    error_count: stats.errorCount,
    notes: {
      // Bounded so a pathological file cannot bloat the row.
      messages: stats.notes.slice(0, 200),
      truncated: stats.notes.length > 200,
      failure: failureMessage,
    },
  });

  if (error) {
    console.warn(`  ! could not write import_runs entry: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Per-dataset importers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function printSummary(results: readonly SheetReadResult[], options: Options): void {
  console.log("\n" + "=".repeat(78));
  console.log(options.dryRun ? "DRY RUN SUMMARY (nothing was written)" : "IMPORT SUMMARY");
  console.log("=".repeat(78));

  for (const result of results) {
    const s = result.stats;
    console.log(`\n  ${result.sheetName}  ->  ${result.table}`);
    console.log(`    source        ${result.fileName}`);
    if (result.datasetAsOf) console.log(`    dataset as of ${result.datasetAsOf}`);
    console.log(`    rows read     ${s.rowsRead}`);
    console.log(`    rows imported ${s.rowsImported}`);
    console.log(`    rows skipped  ${s.rowsSkipped}`);
    console.log(`    missing CIN   ${s.rowsMissingCin}`);
    console.log(`    invalid CIN   ${s.rowsInvalidCin}`);
    console.log(`    missing email ${s.rowsMissingEmail}`);
    console.log(`    duplicates    ${s.duplicateKeys}`);
    console.log(`    rows pruned   ${s.rowsPruned}`);
    console.log(`    errors        ${s.errorCount}`);

    if (s.notes.length > 0) {
      console.log(`    notes (${s.notes.length}):`);
      for (const note of s.notes.slice(0, 12)) console.log(`      - ${note}`);
      if (s.notes.length > 12) console.log(`      ... and ${s.notes.length - 12} more`);
    }
  }

  const totals = results.reduce(
    (acc, result) => ({
      read: acc.read + result.stats.rowsRead,
      imported: acc.imported + result.stats.rowsImported,
      skipped: acc.skipped + result.stats.rowsSkipped,
    }),
    { read: 0, imported: 0, skipped: 0 },
  );

  console.log("\n" + "-".repeat(78));
  console.log(
    `  TOTAL  read ${totals.read}  imported ${totals.imported}  skipped ${totals.skipped}`,
  );
  console.log("-".repeat(78) + "\n");
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  for (const fileName of [REGISTERED_WORKBOOK, CANCELLED_WORKBOOK]) {
    const fullPath = path.join(DATA_DIR, fileName);
    if (!existsSync(fullPath)) {
      throw new Error(
        `Missing dataset: ${fullPath}\n` +
          "Place the RBI workbooks in data/ before running the importer.",
      );
    }
  }

  const importedAt = new Date().toISOString();
  const registeredAsOf = await workbookAsOf(REGISTERED_WORKBOOK, "List of NBFCs");
  const cancelledAsOf = await workbookAsOf(CANCELLED_WORKBOOK, "Cancelled List");

  console.log(`RBI dataset import — ${importedAt}`);
  console.log(`  registered workbook as of: ${registeredAsOf ?? "unknown"}`);
  console.log(`  cancelled workbook as of:  ${cancelledAsOf ?? "unknown"}`);
  if (options.dryRun) console.log("  MODE: dry run — the database will not be touched");

  const client = options.dryRun
    ? null
    : (() => {
        const { url, serviceRoleKey } = requireSupabaseCredentials();
        return createClient(url, serviceRoleKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
      })();

  const selected = DATASETS.filter(
    (dataset) => options.only === null || options.only.has(dataset.key),
  );
  const includeReference = options.only === null || options.only.has("reference");
  const includeBanks = options.only === null || options.only.has("bank");

  const results: SheetReadResult[] = [];

  for (const dataset of selected) {
    console.log(`\n> ${dataset.sheetName} (${dataset.fileName})`);
    const startedAt = new Date().toISOString();
    const fallbackAsOf =
      dataset.fileName === REGISTERED_WORKBOOK ? registeredAsOf : cancelledAsOf;

    const result =
      dataset.key === "cancelled_record"
        ? await readCancelledRecordSheet(
            dataset.fileName, dataset.sheetName, importedAt, fallbackAsOf,
          )
        : await readSimpleSheet(
            dataset.key, dataset.table, dataset.fileName, dataset.sheetName,
            importedAt, fallbackAsOf,
          );
    const rows = result.rows;

    console.log(`    parsed ${rows.length} rows`);

    if (client) {
      try {
        await upsertRows(client, dataset.table, rows, result.stats);
        if (options.prune) {
          await pruneStaleRows(
            client, dataset.table, dataset.fileName, dataset.sheetName,
            importedAt, result.stats,
          );
          await handleLegacyRows(client, dataset.table, options.pruneLegacy, result.stats);
        }
        await recordImportRun(client, result, startedAt, "succeeded", null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await recordImportRun(client, result, startedAt, "failed", message);
        throw error;
      }
    } else {
      result.stats.rowsImported = rows.length;
    }

    results.push(result);
  }

  if (includeReference) {
    console.log(`\n> ${REFERENCE_SHEET.sheetName} (reference values)`);
    const startedAt = new Date().toISOString();
    const result = await readReferenceSheet(importedAt, registeredAsOf);
    const rows = result.rows;
    console.log(`    parsed ${rows.length} reference values`);

    if (client) {
      for (let start = 0; start < rows.length; start += UPSERT_CHUNK_SIZE) {
        const chunk = rows.slice(start, start + UPSERT_CHUNK_SIZE);
        const { error } = await client
          .from(REFERENCE_SHEET.table)
          .upsert(chunk, {
            onConflict: "source_file,source_sheet,source_row_number,source_column",
          });
        if (error) {
          result.stats.errorCount += 1;
          await recordImportRun(client, result, startedAt, "failed", error.message);
          throw new Error(`Upsert into ${REFERENCE_SHEET.table} failed: ${error.message}`);
        }
        result.stats.rowsImported += chunk.length;
      }
      await recordImportRun(client, result, startedAt, "succeeded", null);
    } else {
      result.stats.rowsImported = rows.length;
    }

    results.push(result);
  }

  if (includeBanks) {
    console.log(`
> ${BANKS_SNAPSHOT_FILE} (RBI Banks in India)`);
    const startedAt = new Date().toISOString();
    const snapshot = readBankSnapshot();
    const result = buildBankRows(snapshot, importedAt);
    console.log(`    parsed ${result.rows.length} banks`);

    if (client) {
      try {
        await upsertRows(client, "rbi_bank", result.rows, result.stats, "source_file,source_sheet,source_row_number");
        if (options.prune) {
          await pruneStaleRows(
            client, "rbi_bank", result.fileName, result.sheetName, importedAt, result.stats,
          );
        }
        await recordImportRun(client, result, startedAt, "succeeded", null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await recordImportRun(client, result, startedAt, "failed", message);
        throw error;
      }
    } else {
      result.stats.rowsImported = result.rows.length;
    }

    results.push(result);
  }

  printSummary(results, options);
}

main().catch((error: unknown) => {
  console.error("\nIMPORT FAILED");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
