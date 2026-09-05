import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { loadEntityIndex } from "@/lib/index/store";
import type { IndexedEntity } from "@/lib/index/types";
import { EntityRecord } from "@/components/entity-record";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { Callout } from "@/components/ui";
import { confidenceLabelFor, type EntityMatch } from "@/lib/verify/types";

/**
 * A permanent, linkable page for one RBI record.
 *
 *   /record/registered_nbfc:1234
 *
 * Useful for citing a specific entry without re-running a check, and it keeps
 * the record view honest: this page carries no verdict, because a verdict is
 * about a *query* — what was claimed, by whom, with what evidence — and not
 * about a company.
 */

export const dynamic = "force-dynamic";

const ID_PATTERN = /^(registered_nbfc|registered_arc|cancelled_company|cancelled_record|bank):\d+$/;

function loadEntity(id: string): IndexedEntity | null {
  if (!ID_PATTERN.test(id)) return null;
  try {
    return loadEntityIndex().byId.get(id) ?? null;
  } catch {
    return null;
  }
}

export async function generateMetadata(
  props: PageProps<"/record/[id]">,
): Promise<Metadata> {
  const { id } = await props.params;
  const entity = loadEntity(decodeURIComponent(id));
  return { title: entity ? entity.name : "Record not found" };
}

export default async function RecordPage(props: PageProps<"/record/[id]">) {
  const { id } = await props.params;
  const entity = loadEntity(decodeURIComponent(id));

  if (!entity) notFound();

  const index = loadEntityIndex();
  const nbfcDataset = index.file.datasets.find((dataset) => dataset.key === "registered_nbfc");
  const bankDataset = index.file.datasets.find((dataset) => dataset.key === "bank");

  // A record page has no query behind it, so there is no match to report — the
  // shape is reused only so the record renders identically to a result.
  const match: EntityMatch = {
    entity,
    matchProbability: 1,
    acceptedByModel: true,
    routes: [],
    identifiedBy: "exact_name",
    confidenceLabel: confidenceLabelFor("exact_name", 1),
  };

  return (
    <>
      <SiteHeader />

      <main className="flex-1">
        <div className="mx-auto max-w-4xl space-y-4 px-6 py-10">
          <Link
            href="/"
            className="text-[0.8125rem] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
          >
            ← Back to the check
          </Link>

          <EntityRecord
            match={match}
            asOf={nbfcDataset?.asOf ?? null}
            banksFetchedAt={bankDataset?.asOf ?? null}
          />

          <Callout tone="info">
            This page reproduces one row of a published RBI source and carries no assessment. A
            LenderLens verdict applies to a check — what a lender claimed, what they asked for, and
            what could be corroborated — not to a company in isolation.
          </Callout>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
