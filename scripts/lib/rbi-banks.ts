/**
 * Read the RBI Banks-in-India snapshot from disk and turn it into rows.
 *
 * The snapshot is produced by `npm run fetch:banks` and committed, so that a
 * build never depends on the RBI web site being reachable. This module is the
 * only place that reads it, and — like `rbi-sheets.ts` — it is shared by the
 * Supabase importer and the local index builder so the two cannot disagree.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { BANKS_SNAPSHOT_FILE, BANKS_SOURCE_URL } from "../../src/lib/rbi/dataset.ts";
import type { BankSnapshot } from "../../src/lib/rbi/types.ts";
import { DATA_DIR, emptyStats, type DbRow, type SheetReadResult } from "./rbi-sheets.ts";

export function bankSnapshotPath(): string {
  return path.join(DATA_DIR, BANKS_SNAPSHOT_FILE);
}

export function readBankSnapshot(): BankSnapshot {
  const file = bankSnapshotPath();
  if (!existsSync(file)) {
    throw new Error(
      `Missing ${file}. Run \`npm run fetch:banks\` to capture the RBI Banks-in-India page first.`,
    );
  }

  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    typeof parsed !== "object" || parsed === null ||
    !Array.isArray((parsed as { banks?: unknown }).banks)
  ) {
    throw new Error(`${file} is not a bank snapshot — re-run \`npm run fetch:banks\`.`);
  }

  return parsed as BankSnapshot;
}

/**
 * Flatten the snapshot into database rows.
 *
 * `source_row_number` is the bank's position in the snapshot, which gives the
 * importer the same (source_file, source_sheet, source_row_number) idempotency
 * key every other dataset uses. `dataset_as_of` is the date the page was
 * fetched: this source publishes no as-of date of its own, and claiming one
 * would be inventing freshness.
 */
export function buildBankRows(snapshot: BankSnapshot, importedAt: string): SheetReadResult {
  const stats = emptyStats();
  const fetchedOn = snapshot.fetchedAt.slice(0, 10);
  const rows: DbRow[] = [];

  snapshot.banks.forEach((bank, index) => {
    stats.rowsRead += 1;
    if (bank.hostnames.length === 0) {
      stats.notes.push(`${bank.name}: the RBI page lists no website for this bank`);
    }
    rows.push({
      slug: bank.id,
      name: bank.name,
      name_normalized: bank.nameNormalized,
      name_core: bank.nameCore,
      category: bank.category,
      categories: [...bank.categories],
      websites: [...bank.websites],
      hostnames: [...bank.hostnames],
      address: bank.address,
      source_headings: [...bank.sourceHeadings],
      source_file: BANKS_SNAPSHOT_FILE,
      source_sheet: BANKS_SOURCE_URL,
      source_row_number: index + 1,
      dataset_as_of: fetchedOn,
      last_imported_at: importedAt,
    });
  });

  return {
    key: "bank",
    table: "rbi_bank",
    fileName: BANKS_SNAPSHOT_FILE,
    sheetName: BANKS_SOURCE_URL,
    datasetTitle: snapshot.sourceName,
    datasetAsOf: fetchedOn,
    stats,
    rows,
  };
}
