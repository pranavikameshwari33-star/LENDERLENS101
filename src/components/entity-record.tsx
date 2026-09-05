import { BANK_CATEGORY_LABELS, type BankCategory } from "@/lib/rbi/dataset";
import type { IndexedEntity } from "@/lib/index/types";
import { entitySourceLabel, standingLabel, type EntityMatch } from "@/lib/verify/types";

import { Field, Panel, PanelHeader } from "./ui";

/**
 * The RBI record a result is about, laid out so the fields that change a
 * decision come first: standing, deposit authorisation, CIN, official website.
 *
 * Every value shown here is reproduced from a published RBI source, and the
 * footer names the file, sheet and row it came from. Nothing is derived,
 * inferred or filled in.
 */

function bankCategoryLabel(value: string | undefined): string | null {
  if (!value) return null;
  return BANK_CATEGORY_LABELS[value as BankCategory] ?? value.replace(/_/g, " ");
}

export function EntityRecord({
  match,
  asOf,
  banksFetchedAt,
}: {
  match: EntityMatch;
  asOf: string | null;
  banksFetchedAt: string | null;
}) {
  const entity = match.entity;
  const isBank = entity.source === "bank";
  const isCancelled = entity.standing === "cancelled" || entity.standing === "cancellation_record";

  return (
    <Panel>
      <PanelHeader
        eyebrow={entitySourceLabel(entity)}
        title={entity.name}
        hint={`Matched by ${match.confidenceLabel}.`}
        aside={
          <span className="rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-secondary)]">
            {standingLabel(entity.standing)}
          </span>
        }
      />

      <dl className="grid grid-cols-1 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
        {isBank ? (
          <>
            <Field label="Category" value={bankCategoryLabel(entity.attributes.bankCategory)} />
            <Field
              label="Website published by the RBI"
              value={
                entity.hostnames.length > 0 ? (
                  <span className="tabular">{entity.hostnames.join(", ")}</span>
                ) : (
                  "The RBI page lists none for this bank"
                )
              }
              className="sm:col-span-2"
            />
          </>
        ) : (
          <>
            <Field label="Classification" value={entity.attributes.classification} />
            <Field label="Layer" value={entity.attributes.layer} />
            <Field label="CIN" value={entity.cin} mono />
            <Field
              label="Public deposits"
              value={
                entity.attributes.acceptsPublicDeposits === undefined
                  ? null
                  : entity.attributes.acceptsPublicDeposits
                    ? "Authorised to hold / accept public deposits"
                    : "Not authorised to hold or accept public deposits"
              }
            />
            <Field label="Regional office" value={entity.attributes.regionalOffice} />
            <Field
              label="Contact e-mail domain on record"
              value={
                entity.emailDomains.length > 0 ? (
                  <span className="tabular">{entity.emailDomains.join(", ")}</span>
                ) : null
              }
            />
          </>
        )}

        {entity.attributes.corCancellationDate ? (
          <Field label="CoR cancelled" value={entity.attributes.corCancellationDate} mono />
        ) : null}
        {entity.attributes.cancellationReason ? (
          <Field label="Reason on record" value={entity.attributes.cancellationReason} />
        ) : null}

        <Field
          label="Address on record"
          value={entity.attributes.address}
          className="sm:col-span-2 lg:col-span-3"
        />

        {entity.alternateNames.length > 0 ? (
          <Field
            label="Also recorded as"
            value={entity.alternateNames.join(" · ")}
            className="sm:col-span-2 lg:col-span-3"
          />
        ) : null}
      </dl>

      {isCancelled ? (
        <p className="mx-5 mb-4 rounded-lg border border-rose-500/30 bg-rose-500/[0.06] px-4 py-3 text-[0.8125rem] leading-relaxed text-rose-200">
          The RBI does not publish CINs on the cancelled list, so an entry there can only be matched
          by name. A company with a similar name may be an entirely different business. Confirm the
          identity with the RBI before drawing a conclusion from this.
        </p>
      ) : null}

      <p className="border-t border-[var(--border)] px-5 py-3 text-xs text-[var(--text-muted)]">
        Source: {entity.provenance.sourceFile} · {entity.provenance.sourceSheet} · row{" "}
        {entity.provenance.sourceRowNumber} ·{" "}
        {isBank
          ? `page fetched ${banksFetchedAt ?? entity.provenance.datasetAsOf ?? "unknown"}`
          : `data as on ${asOf ?? entity.provenance.datasetAsOf ?? "unknown"}`}
      </p>
    </Panel>
  );
}

export type { IndexedEntity };
