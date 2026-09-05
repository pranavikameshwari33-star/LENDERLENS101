/**
 * Typed models for the RBI reference records.
 *
 * These describe the sources as published. Once compiled, every record is
 * flattened into the single `IndexedEntity` shape in `src/lib/index/types.ts`,
 * which is what the matcher, the feature extractor and the verification layers
 * all operate on — see the note there for why one uniform shape matters.
 */

import { BANK_CATEGORIES, type BankCategory } from "./dataset";

/** Which published RBI source a record came from. */
export type EntitySource =
  | "registered_nbfc"
  | "registered_arc"
  | "cancelled_company"
  | "cancelled_record"
  | "bank";

// ---------------------------------------------------------------------------
// Banks (RBI "Banks in India" snapshot)
// ---------------------------------------------------------------------------

/**
 * One bank as published on the RBI's Banks-in-India page.
 *
 * `hostnames` is the important field: the RBI links each bank's own website,
 * which gives this application an authoritative institution-to-domain mapping
 * it has for no other entity type. It is why a domain claim about a bank can be
 * settled by lookup while a domain claim about an NBFC cannot.
 */
export interface BankRecord {
  readonly id: string;
  readonly name: string;
  readonly nameNormalized: string;
  readonly nameCore: string | null;
  readonly category: BankCategory;
  /** Every category the bank was listed under, when the page repeats it. */
  readonly categories: readonly BankCategory[];
  readonly websites: readonly string[];
  /** Normalised hostnames taken from `websites`. */
  readonly hostnames: readonly string[];
  readonly address: string | null;
  /** The RBI section headings this record was assembled from. */
  readonly sourceHeadings: readonly string[];
}

export interface BankSnapshot {
  readonly sourceUrl: string;
  readonly sourceName: string;
  /**
   * ISO timestamp of the fetch that produced this snapshot. The RBI page
   * publishes no as-of date of its own, so this is the only honest freshness
   * claim available and the interface labels it "fetched", never "as on".
   */
  readonly fetchedAt: string;
  readonly sectionHeadings: readonly string[];
  readonly counts: {
    readonly total: number;
    readonly withWebsite: number;
    readonly byCategory: Readonly<Record<string, number>>;
  };
  readonly banks: readonly BankRecord[];
}

export function isBankCategory(value: string): value is BankCategory {
  return (BANK_CATEGORIES as readonly string[]).includes(value);
}
