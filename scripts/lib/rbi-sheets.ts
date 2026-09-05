/**
 * Read the RBI workbooks into plain, typed rows.
 *
 * This module holds every rule about the shape of the spreadsheets — where the
 * title and header rows are, which columns must appear and in what order, how
 * a name cell is split from its parenthetical aliases, how the "Record" sheet
 * stacks two tables in one worksheet.
 *
 * It is deliberately free of both Supabase and the filesystem cache, because
 * the same rows feed two consumers:
 *
 *   scripts/import-rbi.ts   -> Supabase (the durable store)
 *   scripts/build-index.ts  -> data/index/entity-index.json (the runtime index)
 *
 * If the parsing lived in either one, the two would drift and the application
 * would start answering differently depending on which path a query took.
 */
import path from "node:path";

import {
  isBlankRow,
  isSingleCellRow,
  loadSheet,
  type CellValue,
  type LoadedSheet,
  type SheetRow,
} from "./workbook.ts";
import {
  REFERENCE_SHEET,
  classifyRecordSection,
  extractAsOfText,
  type CancelledRecordSection,
  type DatasetKey,
} from "../../src/lib/rbi/dataset.ts";
import {
  cleanText,
  cleanTextOrNull,
  emailDomains,
  isValidCin,
  nameCore,
  normalizeCin,
  normalizeName,
  parseCompanyName,
  parseEmails,
  parseFlexibleDate,
  parseInteger,
  parseYesNo,
} from "../../src/lib/normalize.ts";

export const DATA_DIR = path.join(process.cwd(), "data");

/** A parsed row on its way to PostgREST or to the local index. */
export type DbRow = Record<string, string | number | boolean | null | string[]>;

export interface SheetReadResult {
  readonly key: string;
  readonly table: string;
  readonly fileName: string;
  readonly sheetName: string;
  readonly datasetTitle: string | null;
  readonly datasetAsOf: string | null;
  readonly stats: ImportStats;
  readonly rows: DbRow[];
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface ImportStats {
  rowsRead: number;
  rowsImported: number;
  rowsSkipped: number;
  rowsMissingCin: number;
  rowsInvalidCin: number;
  rowsMissingEmail: number;
  duplicateKeys: number;
  rowsPruned: number;
  errorCount: number;
  /** Human-readable reasons, one per skipped or suspicious row. */
  readonly notes: string[];
}

export function emptyStats(): ImportStats {
  return {
    rowsRead: 0,
    rowsImported: 0,
    rowsSkipped: 0,
    rowsMissingCin: 0,
    rowsInvalidCin: 0,
    rowsMissingEmail: 0,
    duplicateKeys: 0,
    rowsPruned: 0,
    errorCount: 0,
    notes: [],
  };
}

/**
 * Every sheet in these workbooks is laid out the same way: row 1 is a title
 * (which carries the "as on ..." date), row 2 is the header, and data starts
 * at row 3.
 */
const TITLE_ROW = 1;
const HEADER_ROW = 2;
const FIRST_DATA_ROW = 3;

export interface SheetHeader {
  readonly title: string;
  readonly asOf: string | null;
  readonly headers: readonly string[];
}

export function readSheetHeader(sheet: LoadedSheet): SheetHeader {
  const titleRow = sheet.rows.find((row) => row.rowNumber === TITLE_ROW);
  const headerRow = sheet.rows.find((row) => row.rowNumber === HEADER_ROW);

  const title = cleanText(titleRow?.cells[0] ?? "");
  const asOfText = extractAsOfText(title);

  return {
    title,
    asOf: asOfText ? parseFlexibleDate(asOfText) : null,
    headers: (headerRow?.cells ?? []).map((cell) => cleanText(cell)),
  };
}

/**
 * Fail loudly when a sheet's columns are not where they are expected to be.
 * Importing shifted columns would quietly fill the database with, say,
 * addresses in the CIN field — far worse than refusing to run.
 */
export function assertHeaders(
  sheet: LoadedSheet,
  actual: readonly string[],
  expected: readonly string[],
): void {
  for (let i = 0; i < expected.length; i += 1) {
    const found = cleanText(actual[i] ?? "").toLowerCase();
    const want = expected[i].toLowerCase();
    if (!found.startsWith(want)) {
      throw new Error(
        `Unexpected layout in "${sheet.sheetName}" of ${sheet.fileName}: ` +
          `column ${i + 1} is "${actual[i] ?? "(empty)"}", expected it to start with "${expected[i]}". ` +
          "The workbook format has changed; update scripts/import-rbi.ts before importing.",
      );
    }
  }
}

/** Data rows, with blanks and single-cell note rows filtered out and counted. */
export function dataRows(sheet: LoadedSheet, stats: ImportStats): SheetRow[] {
  const kept: SheetRow[] = [];

  for (const row of sheet.rows) {
    if (row.rowNumber < FIRST_DATA_ROW) continue;

    if (isBlankRow(row)) continue; // Trailing padding; not counted as read.

    stats.rowsRead += 1;

    if (isSingleCellRow(row)) {
      // e.g. the "N.B.: NBFC-ICC category marked with asterisk (*) ..." footnote
      // at the bottom of the registered-NBFC sheet.
      stats.rowsSkipped += 1;
      stats.notes.push(
        `row ${row.rowNumber}: skipped note/heading row — "${truncate(cleanText(row.cells[0]), 90)}"`,
      );
      continue;
    }

    kept.push(row);
  }

  return kept;
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

export function buildRegisteredNbfcRow(
  row: SheetRow,
  context: RowContext,
  stats: ImportStats,
): DbRow | null {
  const [slNo, rawName, regionalOffice, deposits, classification, rawCin, layer, address, rawEmail] =
    row.cells;

  const parsedName = parseCompanyName(rawName);
  if (parsedName.raw.length === 0) {
    stats.rowsSkipped += 1;
    stats.notes.push(`row ${row.rowNumber}: skipped — no company name`);
    return null;
  }

  const cin = normalizeCin(rawCin);
  const cinValid = isValidCin(cin);
  if (cin === null) {
    stats.rowsMissingCin += 1;
    stats.notes.push(`row ${row.rowNumber}: missing CIN — "${truncate(parsedName.displayName, 60)}"`);
  } else if (!cinValid) {
    stats.rowsInvalidCin += 1;
    stats.notes.push(
      `row ${row.rowNumber}: CIN "${cin}" does not match the 21-character MCA format — imported and flagged`,
    );
  }

  const emails = parseEmails(rawEmail);
  if (emails.length === 0) stats.rowsMissingEmail += 1;

  const classificationText = cleanTextOrNull(classification);
  // "ICC*" marks an NBFC-ICC that additionally holds a factoring CoR.
  const hasFactoringCor = classificationText?.includes("*") ?? false;

  return {
    source_row_number: row.rowNumber,
    sl_no: parseInteger(slNo),
    name: parsedName.raw,
    display_name: parsedName.displayName,
    alternate_names: [...parsedName.alternateNames],
    alternate_names_normalized: parsedName.alternateNames.map(normalizeName),
    name_normalized: normalizeName(parsedName.displayName),
    name_core: nameCore(parsedName.displayName),
    regional_office: cleanTextOrNull(regionalOffice),
    public_deposits: cleanTextOrNull(deposits),
    accepts_public_deposits: parseYesNo(deposits),
    classification: classificationText,
    classification_code: classificationText?.replace(/\*/g, "").trim() || null,
    has_factoring_cor: hasFactoringCor,
    cin: cleanTextOrNull(rawCin),
    cin_normalized: cin,
    cin_is_valid: cinValid,
    layer: cleanTextOrNull(layer),
    address: cleanTextOrNull(address),
    email: cleanTextOrNull(rawEmail),
    emails,
    email_domains: emailDomains(emails),
    ...context,
  };
}

export function buildRegisteredArcRow(
  row: SheetRow,
  context: RowContext,
  stats: ImportStats,
): DbRow | null {
  const [srNo, rawName, regionalOffice, rawCin, address, rawEmail] = row.cells;

  const parsedName = parseCompanyName(rawName);
  if (parsedName.raw.length === 0) {
    stats.rowsSkipped += 1;
    stats.notes.push(`row ${row.rowNumber}: skipped — no company name`);
    return null;
  }

  const cin = normalizeCin(rawCin);
  const cinValid = isValidCin(cin);
  if (cin === null) {
    stats.rowsMissingCin += 1;
    stats.notes.push(`row ${row.rowNumber}: missing CIN — "${truncate(parsedName.displayName, 60)}"`);
  } else if (!cinValid) {
    stats.rowsInvalidCin += 1;
    stats.notes.push(`row ${row.rowNumber}: CIN "${cin}" is not in the 21-character MCA format`);
  }

  const emails = parseEmails(rawEmail);
  if (emails.length === 0) stats.rowsMissingEmail += 1;

  return {
    source_row_number: row.rowNumber,
    sr_no: parseInteger(srNo),
    name: parsedName.raw,
    display_name: parsedName.displayName,
    alternate_names: [...parsedName.alternateNames],
    alternate_names_normalized: parsedName.alternateNames.map(normalizeName),
    name_normalized: normalizeName(parsedName.displayName),
    name_core: nameCore(parsedName.displayName),
    regional_office: cleanTextOrNull(regionalOffice),
    cin: cleanTextOrNull(rawCin),
    cin_normalized: cin,
    cin_is_valid: cinValid,
    address: cleanTextOrNull(address),
    email: cleanTextOrNull(rawEmail),
    emails,
    email_domains: emailDomains(emails),
    ...context,
  };
}

export function buildCancelledCompanyRow(
  row: SheetRow,
  context: RowContext,
  stats: ImportStats,
): DbRow | null {
  const [slNo, rawName, regionalOffice, address] = row.cells;

  // Every name in this sheet begins with a literal newline and many contain
  // non-breaking spaces; cleanText handles both.
  const name = cleanText(rawName);
  if (name.length === 0) {
    stats.rowsSkipped += 1;
    stats.notes.push(`row ${row.rowNumber}: skipped — no company name`);
    return null;
  }

  return {
    source_row_number: row.rowNumber,
    sl_no: parseInteger(slNo),
    name,
    name_normalized: normalizeName(name),
    name_core: nameCore(name),
    regional_office: cleanTextOrNull(regionalOffice),
    address: cleanTextOrNull(address),
    ...context,
  };
}

export function buildCancelledRecordRow(
  row: SheetRow,
  context: RowContext,
  section: CancelledRecordSection,
  sectionTitle: string,
  stats: ImportStats,
): DbRow | null {
  const [
    srNo, nbfcCode, rawName, regionalOffice, category,
    classification, corNumber, issuance, cancellation, reason,
  ] = row.cells;

  const name = cleanText(rawName);
  if (name.length === 0) {
    stats.rowsSkipped += 1;
    stats.notes.push(`row ${row.rowNumber}: skipped — no company name`);
    return null;
  }

  const issuanceDate = parseFlexibleDate(issuance);
  const cancellationDate = parseFlexibleDate(cancellation);

  // The dates in this sheet arrive in three different shapes. When one cannot
  // be parsed the raw text is kept so nothing is lost.
  if (issuance !== null && cleanText(issuance).length > 0 && issuanceDate === null) {
    stats.notes.push(`row ${row.rowNumber}: unparseable CoR issuance date "${cleanText(issuance)}" — raw value kept`);
  }
  if (cancellation !== null && cleanText(cancellation).length > 0 && cancellationDate === null) {
    stats.notes.push(`row ${row.rowNumber}: unparseable CoR cancellation date "${cleanText(cancellation)}" — raw value kept`);
  }

  return {
    source_row_number: row.rowNumber,
    sr_no: parseInteger(srNo),
    section,
    section_title: sectionTitle,
    nbfc_code: cleanTextOrNull(nbfcCode),
    company_name: name,
    company_name_normalized: normalizeName(name),
    company_name_core: nameCore(name),
    regional_office: cleanTextOrNull(regionalOffice),
    category: cleanTextOrNull(category),
    classification: cleanTextOrNull(classification),
    cor_number: cleanTextOrNull(corNumber),
    cor_issuance_date: issuanceDate,
    cor_issuance_date_raw: cleanTextOrNull(issuance),
    cor_cancellation_date: cancellationDate,
    cor_cancellation_date_raw: cleanTextOrNull(cancellation),
    reason: cleanTextOrNull(reason),
    ...context,
  };
}

export interface RowContext extends DbRow {
  readonly source_file: string;
  readonly source_sheet: string;
  readonly dataset_as_of: string | null;
  readonly last_imported_at: string;
}

export const EXPECTED_HEADERS: Record<DatasetKey, readonly string[]> = {
  registered_nbfc: [
    "sl. no.", "nbfc name", "regional office", "whether have cor",
    "classification", "corporate identification number", "layer", "address", "email",
  ],
  registered_arc: [
    "sr no.", "nbfc name", "regional office",
    "corporate identification number", "address", "email",
  ],
  cancelled_company: ["sl. no.", "name of the company", "regional office", "address"],
  cancelled_record: [
    "sr no.", "nbfc code", "nbfc name", "regional office", "category",
    "classification", "cor number", "cor issuance date", "cor cancellation date", "reason",
  ],
};

export async function readSimpleSheet(
  key: Exclude<DatasetKey, "cancelled_record">,
  table: string,
  fileName: string,
  sheetName: string,
  importedAt: string,
  fallbackAsOf: string | null,
): Promise<SheetReadResult> {
  const sheet = await loadSheet(path.join(DATA_DIR, fileName), fileName, sheetName);
  const header = readSheetHeader(sheet);
  assertHeaders(sheet, header.headers, EXPECTED_HEADERS[key]);

  const stats = emptyStats();
  const datasetAsOf = header.asOf ?? fallbackAsOf;
  const context: RowContext = {
    source_file: fileName,
    source_sheet: sheetName,
    dataset_as_of: datasetAsOf,
    last_imported_at: importedAt,
  };

  const builders = {
    registered_nbfc: buildRegisteredNbfcRow,
    registered_arc: buildRegisteredArcRow,
    cancelled_company: buildCancelledCompanyRow,
  } as const;

  const rows: DbRow[] = [];
  const seenKeys = new Set<number>();

  for (const row of dataRows(sheet, stats)) {
    const built = builders[key](row, context, stats);
    if (!built) continue;

    if (seenKeys.has(row.rowNumber)) {
      stats.duplicateKeys += 1;
      stats.notes.push(`row ${row.rowNumber}: duplicate source row number — later value wins`);
    }
    seenKeys.add(row.rowNumber);
    rows.push(built);
  }

  return {
    key,
    table,
    fileName,
    sheetName,
    datasetTitle: header.title || null,
    datasetAsOf,
    stats,
    rows,
  };
}

/**
 * The "Record" sheet is the awkward one: it stacks two independent tables in a
 * single sheet, each with its own heading and its own header row, and both
 * numbering their rows from 1. The reader walks the sheet top to bottom,
 * switching sections whenever it meets a heading.
 */
export async function readCancelledRecordSheet(
  fileName: string,
  sheetName: string,
  importedAt: string,
  fallbackAsOf: string | null,
): Promise<SheetReadResult> {
  const sheet = await loadSheet(path.join(DATA_DIR, fileName), fileName, sheetName);
  const header = readSheetHeader(sheet);
  assertHeaders(sheet, header.headers, EXPECTED_HEADERS.cancelled_record);

  const stats = emptyStats();
  const datasetAsOf = header.asOf ?? fallbackAsOf;
  const context: RowContext = {
    source_file: fileName,
    source_sheet: sheetName,
    dataset_as_of: datasetAsOf,
    last_imported_at: importedAt,
  };

  let section: CancelledRecordSection | null = classifyRecordSection(header.title);
  let sectionTitle = header.title;
  const rows: DbRow[] = [];

  for (const row of sheet.rows) {
    if (row.rowNumber < TITLE_ROW) continue;
    if (isBlankRow(row)) continue;

    const firstCell = cleanText(row.cells[0]);

    // A section heading: text in column 1 only.
    if (isSingleCellRow(row)) {
      const detected = classifyRecordSection(firstCell);
      if (detected) {
        section = detected;
        sectionTitle = firstCell;
      } else {
        stats.notes.push(`row ${row.rowNumber}: unrecognised heading "${truncate(firstCell, 80)}" — section unchanged`);
      }
      continue;
    }

    // A repeated header row for the next stacked table.
    if (firstCell.toLowerCase().startsWith("sr no")) continue;

    stats.rowsRead += 1;

    if (section === null) {
      stats.rowsSkipped += 1;
      stats.notes.push(`row ${row.rowNumber}: skipped — appears before any recognised section heading`);
      continue;
    }

    const built = buildCancelledRecordRow(row, context, section, sectionTitle, stats);
    if (built) rows.push(built);
  }

  return {
    key: "cancelled_record",
    table: "cancelled_record",
    fileName,
    sheetName,
    datasetTitle: header.title || null,
    datasetAsOf,
    stats,
    rows,
  };
}

/**
 * "Sheet3" is a column-per-field list of the values the RBI uses for
 * classification, layer, ownership and so on. It is stored for reference and
 * for the UI's glossary — never used to validate imported rows, because the
 * live data contains classifications (HFC, AA, Factor, NOFHC, MGC, IDF) that
 * Sheet3 does not list.
 */
export async function readReferenceSheet(
  importedAt: string,
  fallbackAsOf: string | null,
): Promise<SheetReadResult> {
  const { fileName, sheetName, table } = REFERENCE_SHEET;
  const sheet = await loadSheet(path.join(DATA_DIR, fileName), fileName, sheetName);
  const stats = emptyStats();

  const fieldGroups = [
    "classification",
    "category",
    "layer",
    "ownership",
    "deposit_type",
    "accepts_public_deposits",
  ];

  const rows: DbRow[] = [];
  for (const row of sheet.rows) {
    row.cells.forEach((cell: CellValue, index: number) => {
      const value = cleanText(cell);
      if (value.length === 0) return;
      stats.rowsRead += 1;
      rows.push({
        field_group: fieldGroups[index] ?? `column_${index + 1}`,
        value,
        source_file: fileName,
        source_sheet: sheetName,
        source_row_number: row.rowNumber,
        source_column: index + 1,
        dataset_as_of: fallbackAsOf,
        last_imported_at: importedAt,
      });
    });
  }

  return {
    key: "rbi_reference_value",
    table,
    fileName,
    sheetName,
    datasetTitle: "Reference classification values (Sheet3)",
    datasetAsOf: fallbackAsOf,
    stats,
    rows,
  };
}

/**
 * Read the "as on ..." date once per workbook. The "Record" sheet has no date
 * of its own, so it inherits the one printed on its sibling sheet.
 */
export async function workbookAsOf(fileName: string, sheetName: string): Promise<string | null> {
  const sheet = await loadSheet(path.join(DATA_DIR, fileName), fileName, sheetName);
  return readSheetHeader(sheet).asOf;
}
