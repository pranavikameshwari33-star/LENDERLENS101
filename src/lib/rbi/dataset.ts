/**
 * Descriptions of the RBI reference workbooks this application is built on.
 *
 * Shared by the importer (which reads the files) and the UI (which has to tell
 * the user exactly which publication an answer came from). Nothing here is
 * invented: every string below is taken from the workbooks themselves.
 */

/** The four datasets, plus the reference sheet, addressed by a stable key. */
export const DATASET_KEYS = [
  "registered_nbfc",
  "registered_arc",
  "cancelled_company",
  "cancelled_record",
] as const;

export type DatasetKey = (typeof DATASET_KEYS)[number];

export interface DatasetDescriptor {
  readonly key: DatasetKey;
  /** The Supabase table the sheet is imported into. */
  readonly table: string;
  /** File name as it appears in `data/`. */
  readonly fileName: string;
  /** Worksheet name inside the workbook. */
  readonly sheetName: string;
  /** Human label used across the UI. */
  readonly label: string;
  /** One-line description of what the sheet actually contains. */
  readonly description: string;
}

export const REGISTERED_WORKBOOK = "List_registered_with_the_RBI.XLSX";
export const CANCELLED_WORKBOOK = "List_cancelled_by_the_RBI.XLSX";

export const DATASETS: readonly DatasetDescriptor[] = [
  {
    key: "registered_nbfc",
    table: "registered_nbfc",
    fileName: REGISTERED_WORKBOOK,
    sheetName: "List of NBFCs",
    label: "Registered NBFCs",
    description:
      "Non-Banking Financial Companies holding a valid Certificate of Registration with the RBI.",
  },
  {
    key: "registered_arc",
    table: "registered_arc",
    fileName: REGISTERED_WORKBOOK,
    sheetName: "ARCs",
    label: "Registered ARCs",
    description: "Asset Reconstruction Companies registered with the RBI.",
  },
  {
    key: "cancelled_company",
    table: "cancelled_company",
    fileName: CANCELLED_WORKBOOK,
    sheetName: "Cancelled List",
    label: "Cancelled CoR list",
    description:
      "NBFCs and ARCs whose Certificate of Registration has been cancelled by the RBI.",
  },
  {
    key: "cancelled_record",
    table: "cancelled_record",
    fileName: CANCELLED_WORKBOOK,
    sheetName: "Record",
    label: "Cancellation / restoration record",
    description:
      "Companies recently added to, or removed from, the cancelled list — including restorations.",
  },
];

/** The reference sheet of permitted classification / layer values. */
export const REFERENCE_SHEET = {
  table: "rbi_reference_value",
  fileName: REGISTERED_WORKBOOK,
  sheetName: "Sheet3",
} as const;

/**
 * The publication date printed on both workbooks ("as on June 30, 2026").
 *
 * This is only a fallback for display before any import has run — the real
 * value is read back from `dataset_as_of` on the imported rows, so that the
 * UI can never claim a freshness the data does not have.
 */
export const FALLBACK_DATASET_AS_OF = "2026-06-30";

/**
 * Pull the as-of date out of a sheet title such as
 * "List of NBFCs registered with the RBI (as on June 30, 2026)" or
 * "List of NBFCs and ARCs whose CoR has been cancelled by the RBI as on June 30, 2026".
 *
 * Returns the raw date text; callers run it through `parseFlexibleDate`.
 */
export function extractAsOfText(title: string): string | null {
  const match = /as\s+on\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i.exec(title);
  return match ? match[1] : null;
}

/** The two stacked tables inside the "Record" sheet. */
export type CancelledRecordSection = "removed_from_list" | "added_to_list";

export const CANCELLED_RECORD_SECTION_LABELS: Record<CancelledRecordSection, string> = {
  removed_from_list:
    "Removed from the cancelled list (registration restored or the entry withdrawn)",
  added_to_list: "Recently added to the cancelled list",
};

/**
 * Classify a section heading inside the "Record" sheet. The sheet holds two
 * separate tables whose SR No. counters both restart at 1, so the heading is
 * the only thing telling them apart.
 */
export function classifyRecordSection(title: string): CancelledRecordSection | null {
  const lower = title.toLowerCase();
  if (lower.includes("removed")) return "removed_from_list";
  if (lower.includes("added")) return "added_to_list";
  return null;
}

// ---------------------------------------------------------------------------
// RBI "Banks in India"
// ---------------------------------------------------------------------------

/**
 * The RBI's own directory of banks operating in India. Unlike the NBFC and ARC
 * workbooks this is a web page rather than a spreadsheet, so it is captured as
 * a dated JSON snapshot by `npm run fetch:banks`.
 *
 * It matters for two reasons:
 *   - banks are regulated under a different framework and never appear in the
 *     NBFC lists, so without it every bank would read as "not found";
 *   - the RBI links each bank's OFFICIAL website, which is the only
 *     authoritative name-to-domain mapping available in this project.
 */
export const BANKS_SOURCE_URL =
  "https://www.rbi.org.in/commonman/english/scripts/BanksInIndia.aspx";

export const BANKS_SNAPSHOT_FILE = "rbi_banks.json";

export const BANK_CATEGORIES = [
  "public_sector_bank",
  "private_sector_bank",
  "small_finance_bank",
  "payments_bank",
  "local_area_bank",
  "regional_rural_bank",
  "state_cooperative_bank",
  "foreign_bank",
  "foreign_bank_subsidiary",
  "financial_institution",
] as const;

export type BankCategory = (typeof BANK_CATEGORIES)[number];

export const BANK_CATEGORY_LABELS: Record<BankCategory, string> = {
  public_sector_bank: "Public Sector Bank",
  private_sector_bank: "Private Sector Bank",
  small_finance_bank: "Small Finance Bank",
  payments_bank: "Payments Bank",
  local_area_bank: "Local Area Bank",
  regional_rural_bank: "Regional Rural Bank",
  state_cooperative_bank: "State Co-operative Bank",
  foreign_bank: "Foreign Bank",
  foreign_bank_subsidiary: "Foreign Bank (wholly owned subsidiary)",
  financial_institution: "All-India Financial Institution",
};

/**
 * Map a section heading on the RBI page onto a category.
 *
 * The page uses several wordings for the same group ("Nationalised Banks",
 * "SBI & Nationalised Banks", "List of Public Sector Banks in India"), and the
 * order of these tests matters: the more specific phrases are checked first so
 * that "List of Small Finance Banks (SFB)" is not swallowed by a generic
 * "bank" rule.
 */
export function bankCategoryForHeading(heading: string): BankCategory | null {
  const text = heading.toLowerCase();

  if (text.includes("small finance")) return "small_finance_bank";
  if (text.includes("payments bank")) return "payments_bank";
  if (text.includes("local area bank")) return "local_area_bank";
  if (text.includes("regional rural") || text.includes("name of rrb") || text.includes("name of the rrb")) {
    return "regional_rural_bank";
  }
  if (text.includes("co-operative") || text.includes("cooperative")) return "state_cooperative_bank";
  if (text.includes("financial  institution") || text.includes("financial institution")) {
    return "financial_institution";
  }
  if (text.includes("wholly owned banking subsidiary")) return "foreign_bank_subsidiary";
  if (text.includes("foreign bank")) return "foreign_bank";
  if (text.includes("private sector")) return "private_sector_bank";
  if (text.includes("nationalised") || text.includes("state bank of india") || text.includes("public sector")) {
    return "public_sector_bank";
  }

  return null;
}
