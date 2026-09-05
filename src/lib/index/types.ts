/**
 * The compiled entity index.
 *
 * Every RBI record this application knows about — registered NBFCs, registered
 * ARCs, cancelled registrations, the cancellation/restoration record sheet and
 * the Banks-in-India directory — reduced to one flat, uniform shape.
 *
 * Why a single shape
 * ------------------
 * Entity resolution is the core of LenderLens, and it has to work the same way
 * whether the answer turns out to be an NBFC, an ARC or a bank. Five different
 * row types would mean five near-identical matching paths, and the one that
 * mattered would be the one nobody tested. Flattening them here means the
 * matcher, the ML feature extractor and the training-pair builder all operate
 * on exactly the same objects.
 *
 * Source-specific fields survive in `attributes`, so nothing published by the
 * RBI is lost on the way in.
 */

import type { EntitySource } from "../rbi/types";

/**
 * What the RBI's records say about this entity's standing. This is a fact
 * about a published list, never a judgement about a business.
 */
export type EntityStanding =
  /** Holds a current Certificate of Registration (NBFC or ARC list). */
  | "registered"
  /** Appears on the list of cancelled Certificates of Registration. */
  | "cancelled"
  /** Appears in the record of recent additions to / removals from that list. */
  | "cancellation_record"
  /** Appears in the RBI's Banks-in-India directory. */
  | "bank";

export interface IndexedEntity {
  /** Stable across rebuilds: `<source>:<source row number>`. */
  readonly id: string;
  readonly source: EntitySource;
  readonly standing: EntityStanding;

  /** Name as published, minus any parenthetical alias. */
  readonly name: string;
  readonly nameNormalized: string;
  readonly nameCore: string;
  /** Former / MCA names, normalised, from the RBI's own parentheticals. */
  readonly alternateNames: readonly string[];

  readonly cin: string | null;
  /** Contact e-mail domains published by the RBI for this entity. */
  readonly emailDomains: readonly string[];
  /**
   * Official website hostnames published by the RBI. Only banks have these —
   * the NBFC and ARC workbooks publish no websites at all, which is precisely
   * why a domain claim about an NBFC has to be corroborated some other way.
   */
  readonly hostnames: readonly string[];

  /**
   * Grouping key used to keep near-duplicate entities together when the ML
   * dataset is split, so that "Bajaj Finance Ltd" cannot sit in the training
   * set while "Bajaj Housing Finance Ltd" sits in the test set.
   */
  readonly clusterKey: string;

  readonly attributes: EntityAttributes;
  readonly provenance: EntityProvenance;
}

export interface EntityAttributes {
  readonly classification?: string;
  readonly layer?: string;
  readonly regionalOffice?: string;
  readonly address?: string;
  readonly acceptsPublicDeposits?: boolean;
  readonly bankCategory?: string;
  readonly websites?: readonly string[];
  /** Cancellation record only. */
  readonly corNumber?: string;
  readonly corCancellationDate?: string;
  readonly cancellationReason?: string;
  readonly recordSection?: string;
  readonly nbfcCode?: string;
}

export interface EntityProvenance {
  readonly sourceFile: string;
  readonly sourceSheet: string;
  readonly sourceRowNumber: number;
  /** The publication date of the list, or the fetch date for the bank page. */
  readonly datasetAsOf: string | null;
}

export interface DatasetSummary {
  readonly key: string;
  readonly label: string;
  readonly sourceFile: string;
  readonly sourceSheet: string;
  readonly sourceUrl: string | null;
  readonly asOf: string | null;
  /** True when `asOf` is the day the page was fetched, not a published date. */
  readonly asOfIsFetchDate: boolean;
  readonly count: number;
  readonly rowsRead: number;
  readonly rowsSkipped: number;
  readonly notes: readonly string[];
}

export interface EntityIndexFile {
  /** Bumped when the shape of this file changes. */
  readonly formatVersion: number;
  readonly builtAt: string;
  readonly datasets: readonly DatasetSummary[];
  readonly counts: Readonly<Record<EntityStanding, number>>;
  readonly entities: readonly IndexedEntity[];
}
