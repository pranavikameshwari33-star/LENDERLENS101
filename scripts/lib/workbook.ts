/**
 * Thin, defensive wrapper around ExcelJS for the RBI workbooks.
 *
 * ExcelJS hands back cell values in half a dozen shapes — plain strings,
 * numbers, Dates, rich-text objects, hyperlink objects (which is how the
 * e-mail columns arrive), formula results and error markers. Everything here
 * exists to flatten that into `string | number | Date | null` before the
 * import logic ever sees it.
 */
import ExcelJS from "exceljs";

export type CellValue = string | number | Date | null;

/** A sheet flattened into plain rows, keyed by the real 1-based sheet row number. */
export interface SheetRow {
  readonly rowNumber: number;
  readonly cells: readonly CellValue[];
}

export interface LoadedSheet {
  readonly fileName: string;
  readonly sheetName: string;
  readonly rows: readonly SheetRow[];
}

export async function loadSheet(
  filePath: string,
  fileName: string,
  sheetName: string,
): Promise<LoadedSheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) {
    const available = workbook.worksheets.map((sheet) => sheet.name).join(", ");
    throw new Error(
      `Sheet "${sheetName}" not found in ${fileName}. Available sheets: ${available}`,
    );
  }

  const rows: SheetRow[] = [];
  const columnCount = Math.max(worksheet.columnCount, 1);

  worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells: CellValue[] = [];
    for (let column = 1; column <= columnCount; column += 1) {
      cells.push(flattenCell(row.getCell(column).value));
    }
    rows.push({ rowNumber, cells });
  });

  return { fileName, sheetName, rows };
}

/** List a workbook's sheet names without committing to any of them. */
export async function listSheetNames(filePath: string): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook.worksheets.map((sheet) => sheet.name);
}

function flattenCell(value: ExcelJS.CellValue): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value instanceof Date) return value;

  if (typeof value === "object") {
    // Rich text: { richText: [{ text }, ...] }
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((run) => run.text).join("");
    }
    // Hyperlink: { text, hyperlink } — this is how the e-mail columns arrive.
    // `text` is typed as a string but can hold a rich-text object at runtime,
    // so it is re-checked here rather than trusted.
    if ("text" in value && value.text !== undefined && value.text !== null) {
      const text: unknown = value.text;
      if (typeof text === "string") return text;
      if (typeof text === "object" && text !== null && "richText" in text) {
        const runs = (text as { richText: unknown }).richText;
        if (Array.isArray(runs)) {
          return runs
            .map((run: unknown) =>
              typeof run === "object" && run !== null && "text" in run
                ? String((run as { text: unknown }).text)
                : "",
            )
            .join("");
        }
      }
    }
    if ("hyperlink" in value && typeof value.hyperlink === "string") {
      return value.hyperlink.replace(/^mailto:/i, "");
    }
    // Formula: { formula, result }
    if ("result" in value) return flattenCell(value.result as ExcelJS.CellValue);
    // Error: { error: '#N/A' } — treated as no value.
    if ("error" in value) return null;
  }

  return String(value);
}

/** True when every cell in the row is empty. */
export function isBlankRow(row: SheetRow): boolean {
  return row.cells.every(
    (cell) => cell === null || (typeof cell === "string" && cell.trim().length === 0),
  );
}

/**
 * True for rows that carry a single banner of text rather than a record — the
 * workbooks use these for titles, section headings, and the trailing
 * "N.B.: NBFC-ICC category marked with asterisk (*) ..." footnote on the
 * registered-NBFC sheet. Treating one as a company would invent an entity that
 * does not exist.
 *
 * These banners are merged cell ranges, and ExcelJS reports the merged value
 * once per underlying column. A naive "only column 1 is populated" test
 * therefore misses every one of them, which is exactly how the footnote and
 * both "Record" section headings first slipped into the import.
 */
export function isSingleCellRow(row: SheetRow): boolean {
  const first = String(row.cells[0] ?? "").trim();
  if (first.length === 0) return false;

  const distinct = new Set<string>();
  for (const cell of row.cells) {
    const text = cell === null ? "" : String(cell).trim();
    if (text.length > 0) distinct.add(text);
  }

  return distinct.size === 1;
}
