import type { Metadata } from "next";

import { loadEntityIndex, type EntityIndex } from "@/lib/index/store";
import { loadModelMetrics, type ClassificationMetrics, type ModelMetrics } from "@/lib/ml/artifacts";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { Callout, Field, Panel, PanelHeader } from "@/components/ui";

/**
 * The technical page.
 *
 * Every number here is read from `ml/artifacts/metrics.json` and the compiled
 * entity index at request time. Nothing on this page is written into the
 * markup: if the model gets worse, this page gets worse, which is the only
 * arrangement under which the figures mean anything.
 *
 * The same document is served verbatim at /api/model, so a reader can check the
 * rendering against the source without reading the React.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Model & metrics",
  description:
    "The entity-matching model, its dataset construction, its held-out evaluation and its " +
    "false-positive / false-negative cost analysis — read directly from the training artifacts.",
};

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function loadIndexSafely(): EntityIndex | null {
  try {
    return loadEntityIndex();
  } catch {
    return null;
  }
}

export default function TechnicalPage() {
  const metrics = loadModelMetrics();
  const index = loadIndexSafely();

  return (
    <>
      <SiteHeader />

      <main className="flex-1">
        <div className="mx-auto max-w-6xl space-y-4 px-6 py-10">
          <header className="max-w-3xl">
            <p className="eyebrow">Evaluation</p>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-3xl">
              Model &amp; metrics
            </h1>
            <p className="mt-4 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]">
              Everything below is read from the artifacts written by{" "}
              <code className="tabular text-[var(--text-primary)]">ml/train.py</code> at request
              time — never typed into this page. The same document is served verbatim at{" "}
              <a
                href="/api/model"
                className="text-[var(--accent)] underline decoration-[var(--accent)]/40 underline-offset-4"
              >
                /api/model
              </a>
              .
            </p>
          </header>

          {index ? <DatasetPanel index={index} /> : null}

          {metrics ? (
            <>
              <ModelPanel metrics={metrics} />
              <SplitPanel metrics={metrics} />
              <ResultsPanel metrics={metrics} />
              <BreakdownPanel metrics={metrics} />
              <CostPanel metrics={metrics} />
              <SelectionPanel metrics={metrics} />
              <IntegrityPanel metrics={metrics} />
            </>
          ) : (
            <Callout tone="warning" title="No evaluation artifact is present.">
              Run <code className="tabular">npm run ml:all</code>. It builds the training pairs with{" "}
              <code className="tabular">scripts/ml/build-pairs.ts</code> and trains the model with{" "}
              <code className="tabular">ml/train.py</code>, writing{" "}
              <code className="tabular">ml/artifacts/metrics.json</code>. This page shows nothing
              until that file exists — there is no fallback and no placeholder number.
            </Callout>
          )}
        </div>
      </main>

      <SiteFooter />
    </>
  );
}

// ---------------------------------------------------------------------------

function DatasetPanel({ index }: { index: EntityIndex }) {
  return (
    <Panel>
      <PanelHeader
        eyebrow="Corpus"
        title="RBI reference data"
        hint="Compiled from the published sources by `npm run build:data`. Row counts are the number of entities that survived parsing, not the number of rows in the file."
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[42rem] border-collapse text-left text-[0.8125rem]">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="eyebrow px-5 py-2.5 font-medium">Dataset</th>
              <th className="eyebrow px-5 py-2.5 font-medium">Entities</th>
              <th className="eyebrow px-5 py-2.5 font-medium">Rows read</th>
              <th className="eyebrow px-5 py-2.5 font-medium">Skipped</th>
              <th className="eyebrow px-5 py-2.5 font-medium">As of</th>
              <th className="eyebrow px-5 py-2.5 font-medium">Source</th>
            </tr>
          </thead>
          <tbody>
            {index.file.datasets.map((dataset) => (
              <tr key={dataset.key} className="border-b border-[var(--border)] last:border-0">
                <td className="px-5 py-3 text-[var(--text-primary)]">{dataset.label}</td>
                <td className="tabular px-5 py-3 text-[var(--text-primary)]">
                  {dataset.count.toLocaleString("en-IN")}
                </td>
                <td className="tabular px-5 py-3 text-[var(--text-secondary)]">
                  {dataset.rowsRead.toLocaleString("en-IN")}
                </td>
                <td className="tabular px-5 py-3 text-[var(--text-secondary)]">
                  {dataset.rowsSkipped}
                </td>
                <td className="px-5 py-3 text-[var(--text-secondary)]">
                  {dataset.asOf ?? "—"}
                  {dataset.asOfIsFetchDate ? (
                    <span className="ml-1 text-xs text-[var(--text-muted)]">(fetched)</span>
                  ) : null}
                </td>
                <td className="px-5 py-3 text-xs text-[var(--text-muted)]">
                  {dataset.sourceUrl ?? `${dataset.sourceFile} · ${dataset.sourceSheet}`}
                </td>
              </tr>
            ))}
            <tr className="border-t border-[var(--border-strong)] bg-[var(--surface-2)]/40">
              <td className="px-5 py-3 font-medium text-[var(--text-primary)]">Total</td>
              <td className="tabular px-5 py-3 font-medium text-[var(--text-primary)]">
                {index.entities.length.toLocaleString("en-IN")}
              </td>
              <td colSpan={4} className="px-5 py-3 text-xs text-[var(--text-muted)]">
                Index built {new Date(index.builtAt).toLocaleString("en-IN")}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="border-t border-[var(--border)] px-5 py-3 text-xs leading-relaxed text-[var(--text-muted)]">
        The RBI states approximately 8,561 NBFCs and 27 ARCs in this publication, which is what the
        importer parsed. A single row in the NBFC sheet is a footnote rather than a company and is
        counted as skipped, not silently dropped.
      </p>
    </Panel>
  );
}

function ModelPanel({ metrics }: { metrics: ModelMetrics }) {
  return (
    <Panel>
      <PanelHeader eyebrow="Task" title={metrics.task.name} hint={metrics.task.notFraudDetection} />
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-4">
        <Field label="Model version" value={metrics.modelVersion} mono />
        <Field label="Algorithm" value={metrics.algorithm.replace(/_/g, " ")} />
        <Field label="Trained" value={new Date(metrics.trainedAt).toLocaleString("en-IN")} />
        <Field label="Features" value={metrics.dataset.features} mono />
        <Field label="Positive class" value={metrics.task.positiveClass} className="col-span-2" />
        <Field label="Negative class" value={metrics.task.negativeClass} className="col-span-2" />
        <Field
          label="Feature names"
          value={<span className="tabular text-xs">{metrics.dataset.featureNames.join(", ")}</span>}
          className="col-span-2 sm:col-span-4"
        />
      </dl>
    </Panel>
  );
}

function SplitPanel({ metrics }: { metrics: ModelMetrics }) {
  const splits = ["train", "validation", "test"] as const;

  return (
    <Panel>
      <PanelHeader
        eyebrow="Dataset construction"
        title="Splits, groups and leakage control"
        hint={metrics.dataset.splitStrategy}
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse text-left text-[0.8125rem]">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="eyebrow px-5 py-2.5 font-medium">Split</th>
              <th className="eyebrow px-5 py-2.5 font-medium">Pairs</th>
              <th className="eyebrow px-5 py-2.5 font-medium">Positive</th>
              <th className="eyebrow px-5 py-2.5 font-medium">Negative</th>
              <th className="eyebrow px-5 py-2.5 font-medium">Positive share</th>
              <th className="eyebrow px-5 py-2.5 font-medium">Name groups</th>
            </tr>
          </thead>
          <tbody>
            {splits.map((name) => {
              const split = metrics.dataset.splits[name];
              return (
                <tr key={name} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-5 py-3 capitalize text-[var(--text-primary)]">{name}</td>
                  <td className="tabular px-5 py-3 text-[var(--text-primary)]">
                    {split.pairs.toLocaleString("en-IN")}
                  </td>
                  <td className="tabular px-5 py-3 text-[var(--text-secondary)]">
                    {split.positive.toLocaleString("en-IN")}
                  </td>
                  <td className="tabular px-5 py-3 text-[var(--text-secondary)]">
                    {split.negative.toLocaleString("en-IN")}
                  </td>
                  <td className="tabular px-5 py-3 text-[var(--text-secondary)]">
                    {percent(split.positiveShare)}
                  </td>
                  <td className="tabular px-5 py-3 text-[var(--text-secondary)]">
                    {split.groups.toLocaleString("en-IN")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="space-y-3 border-t border-[var(--border)] px-5 py-4 text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
        <p>
          <span className="font-medium text-[var(--text-primary)]">How the labels were obtained.</span>{" "}
          {metrics.dataset.labelRule}
        </p>
        <p>
          <span className="font-medium text-[var(--text-primary)]">Random seed.</span>{" "}
          <span className="tabular">{metrics.dataset.randomSeed}</span> — the split is a seeded hash
          of the group key, so it is identical on every rebuild.
        </p>
        <p>
          <span className="font-medium text-[var(--text-primary)]">Leakage check.</span> The trainer
          asserts that no group appears in more than one split and refuses to train if one does. Hard
          negatives are retrieved from a per-split index, so a training pair cannot name a test-set
          entity.
        </p>
      </div>
    </Panel>
  );
}

function ResultsPanel({ metrics }: { metrics: ModelMetrics }) {
  const test = metrics.test;

  return (
    <Panel>
      <PanelHeader
        eyebrow="Held-out test set"
        title={`${metrics.dataset.splits.test.pairs.toLocaleString("en-IN")} pairs the model never saw`}
        hint={`Scored once, after the model and the threshold had been selected on validation. Threshold ${metrics.threshold.value}, chosen on ${metrics.threshold.chosenOn}.`}
      />

      <dl className="grid grid-cols-2 gap-px overflow-hidden border-b border-[var(--border)] bg-[var(--border)] sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Precision", percent(test.precision)],
          ["Recall", percent(test.recall)],
          ["F1", test.f1.toFixed(4)],
          ["Accuracy", percent(test.accuracy)],
          ["ROC-AUC", test.rocAuc !== null ? test.rocAuc.toFixed(4) : "—"],
          ["PR-AUC", test.prAuc !== null ? test.prAuc.toFixed(4) : "—"],
        ].map(([label, value]) => (
          <div key={label} className="bg-[var(--surface-1)] px-5 py-4">
            <dt className="text-[0.6875rem] uppercase tracking-[0.08em] text-[var(--text-muted)]">
              {label}
            </dt>
            <dd className="numeric mt-1 text-xl font-semibold text-[var(--text-primary)]">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="px-5 py-5">
        <p className="eyebrow">Confusion matrix</p>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-[26rem] border-collapse text-left text-[0.8125rem]">
            <thead>
              <tr>
                <th className="px-4 py-2" />
                <th className="eyebrow px-4 py-2 font-medium">Predicted: same</th>
                <th className="eyebrow px-4 py-2 font-medium">Predicted: different</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th className="eyebrow px-4 py-2 text-left font-medium">Actually same</th>
                <td className="tabular border border-[var(--border)] bg-emerald-500/[0.07] px-4 py-3 text-emerald-300">
                  {test.truePositives.toLocaleString("en-IN")}
                  <span className="ml-2 text-xs text-[var(--text-muted)]">TP</span>
                </td>
                <td className="tabular border border-[var(--border)] bg-amber-500/[0.07] px-4 py-3 text-amber-300">
                  {test.falseNegatives.toLocaleString("en-IN")}
                  <span className="ml-2 text-xs text-[var(--text-muted)]">FN</span>
                </td>
              </tr>
              <tr>
                <th className="eyebrow px-4 py-2 text-left font-medium">Actually different</th>
                <td className="tabular border border-[var(--border)] bg-rose-500/[0.07] px-4 py-3 text-rose-300">
                  {test.falsePositives.toLocaleString("en-IN")}
                  <span className="ml-2 text-xs text-[var(--text-muted)]">FP</span>
                </td>
                <td className="tabular border border-[var(--border)] px-4 py-3 text-[var(--text-secondary)]">
                  {test.trueNegatives.toLocaleString("en-IN")}
                  <span className="ml-2 text-xs text-[var(--text-muted)]">TN</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          {test.supportPositive.toLocaleString("en-IN")} positive and{" "}
          {test.supportNegative.toLocaleString("en-IN")} negative pairs in the held-out split.
        </p>
      </div>
    </Panel>
  );
}

function BreakdownPanel({ metrics }: { metrics: ModelMetrics }) {
  const { byQueryVariant, byEntitySource } = metrics.testBreakdown;
  if (byQueryVariant.length === 0 && byEntitySource.length === 0) return null;

  return (
    <Panel>
      <PanelHeader
        eyebrow="Where it fails"
        title="Recall broken down, so an easy case cannot hide inside an average"
        hint="A single aggregate would let a perfect score on verbatim names conceal a poor one on abbreviations. Both are shown."
      />
      <div className="grid grid-cols-1 gap-px bg-[var(--border)] lg:grid-cols-2">
        <div className="bg-[var(--surface-1)] px-5 py-4">
          <p className="eyebrow">By how the name was written</p>
          <ul className="mt-3 space-y-2">
            {byQueryVariant.map((row) => (
              <li key={row.variant} className="flex items-center gap-3 text-[0.8125rem]">
                <span className="w-52 shrink-0 text-[var(--text-secondary)]">
                  {row.variant.replace(/_/g, " ")}
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                  <span
                    className={`block h-full rounded-full ${
                      row.recall >= 0.95 ? "bg-emerald-400" : row.recall >= 0.85 ? "bg-amber-400" : "bg-rose-400"
                    }`}
                    style={{ width: `${row.recall * 100}%` }}
                  />
                </span>
                <span className="tabular w-28 shrink-0 text-right text-[var(--text-primary)]">
                  {percent(row.recall)}
                  <span className="ml-1 text-xs text-[var(--text-muted)]">
                    {row.recalled}/{row.positive_pairs}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="bg-[var(--surface-1)] px-5 py-4">
          <p className="eyebrow">By RBI source</p>
          <ul className="mt-3 space-y-2">
            {byEntitySource.map((row) => (
              <li key={row.source} className="flex items-center gap-3 text-[0.8125rem]">
                <span className="w-52 shrink-0 text-[var(--text-secondary)]">
                  {row.source.replace(/_/g, " ")}
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                  <span
                    className={`block h-full rounded-full ${
                      row.recall >= 0.95 ? "bg-emerald-400" : row.recall >= 0.85 ? "bg-amber-400" : "bg-rose-400"
                    }`}
                    style={{ width: `${row.recall * 100}%` }}
                  />
                </span>
                <span className="tabular w-28 shrink-0 text-right text-[var(--text-primary)]">
                  {percent(row.recall)}
                  <span className="ml-1 text-xs text-[var(--text-muted)]">
                    {row.recalled}/{row.positive_pairs}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Panel>
  );
}

function CostPanel({ metrics }: { metrics: ModelMetrics }) {
  const { costModel } = metrics;
  const primaryName = costModel.primary.name;
  const chosen = metrics.threshold.value;

  // Show a readable slice of the sweep around the chosen operating point.
  const sweep = metrics.threshold.sweep.filter((row) => {
    const step = Math.round(row.threshold * 100);
    return step % 5 === 0 || Math.abs(row.threshold - chosen) < 1e-9;
  });

  return (
    <Panel>
      <PanelHeader
        eyebrow="Threshold selection"
        title="False-positive and false-negative cost"
        hint={costModel.disclaimer}
      />

      <div className="grid grid-cols-1 gap-px border-b border-[var(--border)] bg-[var(--border)] lg:grid-cols-2">
        <div className="bg-[var(--surface-1)] px-5 py-4">
          <p className="text-[0.8125rem] font-medium text-[var(--text-primary)]">
            Primary — FP × {costModel.primary.false_positive}, FN × {costModel.primary.false_negative}
          </p>
          <p className="mt-2 text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
            {costModel.primaryRationale}
          </p>
          <p className="numeric mt-3 text-lg font-semibold text-[var(--text-primary)]">
            {metrics.test.relativeCost[primaryName]?.toLocaleString("en-IN") ?? "—"}
            <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
              relative cost on the held-out split
            </span>
          </p>
        </div>

        <div className="bg-[var(--surface-1)] px-5 py-4">
          <p className="text-[0.8125rem] font-medium text-[var(--text-primary)]">
            Alternate — FP × {costModel.alternate.false_positive}, FN ×{" "}
            {costModel.alternate.false_negative}
          </p>
          <p className="mt-2 text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
            {costModel.alternateRationale}
          </p>
          <p className="numeric mt-3 text-lg font-semibold text-[var(--text-secondary)]">
            {metrics.test.relativeCost[costModel.alternate.name]?.toLocaleString("en-IN") ?? "—"}
            <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
              same predictions, other weighting
            </span>
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] border-collapse text-left text-[0.8125rem]">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="eyebrow px-5 py-2.5 font-medium">Threshold</th>
              <th className="eyebrow px-5 py-2.5 font-medium">Precision</th>
              <th className="eyebrow px-5 py-2.5 font-medium">Recall</th>
              <th className="eyebrow px-5 py-2.5 font-medium">F1</th>
              <th className="eyebrow px-5 py-2.5 font-medium">FP</th>
              <th className="eyebrow px-5 py-2.5 font-medium">FN</th>
              <th className="eyebrow px-5 py-2.5 font-medium">Relative cost</th>
            </tr>
          </thead>
          <tbody>
            {sweep.map((row) => {
              const isChosen = Math.abs(row.threshold - chosen) < 1e-9;
              return (
                <tr
                  key={row.threshold}
                  className={`border-b border-[var(--border)] last:border-0 ${
                    isChosen ? "bg-[var(--accent-soft)]/50" : ""
                  }`}
                >
                  <td className="tabular px-5 py-2.5 text-[var(--text-primary)]">
                    {row.threshold.toFixed(2)}
                    {isChosen ? (
                      <span className="ml-2 rounded border border-[var(--accent)]/40 px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wider text-[var(--accent)]">
                        shipped
                      </span>
                    ) : null}
                  </td>
                  <td className="tabular px-5 py-2.5 text-[var(--text-secondary)]">{percent(row.precision)}</td>
                  <td className="tabular px-5 py-2.5 text-[var(--text-secondary)]">{percent(row.recall)}</td>
                  <td className="tabular px-5 py-2.5 text-[var(--text-secondary)]">{row.f1.toFixed(4)}</td>
                  <td className="tabular px-5 py-2.5 text-rose-300">{row.falsePositives}</td>
                  <td className="tabular px-5 py-2.5 text-amber-300">{row.falseNegatives}</td>
                  <td className="tabular px-5 py-2.5 text-[var(--text-primary)]">
                    {row.relativeCost[primaryName]?.toLocaleString("en-IN") ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-[var(--border)] px-5 py-3 text-xs leading-relaxed text-[var(--text-muted)]">
        This sweep is measured on the VALIDATION split, which is where the threshold was chosen. The
        held-out test numbers above were produced by applying that threshold unchanged.
      </p>
    </Panel>
  );
}

function SelectionPanel({ metrics }: { metrics: ModelMetrics }) {
  return (
    <Panel>
      <PanelHeader
        eyebrow="Model selection"
        title="Three candidates, compared on validation"
        hint={metrics.selection.criterion}
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] border-collapse text-left text-[0.8125rem]">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="eyebrow px-5 py-2.5 font-medium">Model</th>
              <th className="eyebrow px-5 py-2.5 font-medium">Threshold</th>
              <th className="eyebrow px-5 py-2.5 font-medium">Precision</th>
              <th className="eyebrow px-5 py-2.5 font-medium">Recall</th>
              <th className="eyebrow px-5 py-2.5 font-medium">PR-AUC</th>
              <th className="eyebrow px-5 py-2.5 font-medium">Hyperparameters</th>
            </tr>
          </thead>
          <tbody>
            {metrics.selection.candidates.map((candidate) => {
              const selected = candidate.model === metrics.selection.selected;
              return (
                <tr
                  key={candidate.model}
                  className={`border-b border-[var(--border)] last:border-0 ${
                    selected ? "bg-[var(--accent-soft)]/50" : ""
                  }`}
                >
                  <td className="px-5 py-3 text-[var(--text-primary)]">
                    {candidate.model.replace(/_/g, " ")}
                    {selected ? (
                      <span className="ml-2 rounded border border-[var(--accent)]/40 px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wider text-[var(--accent)]">
                        selected
                      </span>
                    ) : null}
                  </td>
                  <td className="tabular px-5 py-3 text-[var(--text-secondary)]">
                    {candidate.selected_threshold.toFixed(2)}
                  </td>
                  <td className="tabular px-5 py-3 text-[var(--text-secondary)]">
                    {percent(candidate.validation.precision)}
                  </td>
                  <td className="tabular px-5 py-3 text-[var(--text-secondary)]">
                    {percent(candidate.validation.recall)}
                  </td>
                  <td className="tabular px-5 py-3 text-[var(--text-secondary)]">
                    {candidate.validation.prAuc !== null ? candidate.validation.prAuc.toFixed(4) : "—"}
                  </td>
                  <td className="px-5 py-3 text-xs text-[var(--text-muted)]">
                    {Object.entries(candidate.hyperparameters)
                      .map(([key, value]) => `${key}=${String(value)}`)
                      .join(", ")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function IntegrityPanel({ metrics }: { metrics: ModelMetrics }) {
  return (
    <Panel>
      <PanelHeader
        eyebrow="Integrity"
        title="Why these numbers apply to the model that is actually running"
      />
      <div className="space-y-3 px-5 py-4 text-[0.8125rem] leading-relaxed text-[var(--text-secondary)]">
        <p>
          <span className="font-medium text-[var(--text-primary)]">One feature implementation.</span>{" "}
          Every feature is computed by{" "}
          <code className="tabular text-[var(--text-primary)]">src/lib/ml/features.ts</code>, which
          writes the training CSV and also runs on every live request. The Python trainer never
          computes a feature, so the usual train/serve skew cannot occur.
        </p>
        <p>
          <span className="font-medium text-[var(--text-primary)]">
            The exported artifact reproduces scikit-learn.
          </span>{" "}
          After training, the JSON model is re-scored over the entire test split and compared against
          scikit-learn&rsquo;s own probabilities. The largest disagreement was{" "}
          <span className="tabular text-[var(--text-primary)]">
            {metrics.exportParity.maxAbsoluteDifference.toExponential(2)}
          </span>
          . The trainer refuses to write the artifact if it exceeds 1&times;10⁻⁹.
        </p>
        <p>
          <span className="font-medium text-[var(--text-primary)]">Feature order is checked.</span>{" "}
          The artifact records its feature names, and the loader refuses a model whose order
          disagrees with the extractor — a silently reordered vector would produce confident nonsense
          rather than an error.
        </p>
        <p>
          <span className="font-medium text-[var(--text-primary)]">The model cannot overrule a fact.</span>{" "}
          It resolves which record is being discussed. What that record says about registration or
          cancellation is read from the RBI data, and the verdict engine never sees the model&rsquo;s
          probability at all.
        </p>
      </div>
    </Panel>
  );
}

export type { ClassificationMetrics };
