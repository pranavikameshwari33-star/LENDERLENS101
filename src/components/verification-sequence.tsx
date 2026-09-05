"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * The loading state.
 *
 * It lists the stages that will actually run for THIS check, and greys out the
 * ones that cannot — no website supplied, no loan terms entered. That is the
 * whole point of showing it: before the answer arrives, the user already knows
 * how much of the system their input was able to reach.
 *
 * The stages advance on a short timer rather than on real progress, because the
 * server returns one response and there is no stream to follow. The timer stops
 * at the last stage and waits, so it never invents a long "AI analysis" the
 * machine is not performing.
 */

export interface SequenceStage {
  readonly id: string;
  readonly label: string;
  /** False when the stage cannot run because its input was not supplied. */
  readonly runs: boolean;
}

const STEP_MS = 170;

export function VerificationSequence({ stages }: { stages: readonly SequenceStage[] }) {
  const runnableCount = stages.filter((stage) => stage.runs).length;
  const [reached, setReached] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setReached((current) => (current >= runnableCount ? current : current + 1));
    }, STEP_MS);
    return () => clearInterval(timer);
  }, [runnableCount]);

  // Each runnable stage needs its position among the runnable ones, so that a
  // skipped stage does not consume a tick. Computed up front rather than by
  // mutating a counter inside the render.
  const positions = useMemo(() => {
    let next = 0;
    return stages.map((stage) => (stage.runs ? next++ : -1));
  }, [stages]);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-5 py-5">
      <p className="eyebrow">Running the check</p>
      <ol className="mt-4 space-y-2">
        {stages.map((stage, index) => {
          const position = positions[index];
          const done = stage.runs && position < reached;
          const current = stage.runs && position === reached;

          return (
            <li
              key={stage.id}
              className={`flex items-center gap-3 text-[0.8125rem] ${stage.runs ? "" : "opacity-40"}`}
            >
              <span
                aria-hidden="true"
                className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[0.5625rem] ${
                  done
                    ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                    : current
                      ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-secondary)]"
                      : "border-[var(--border-strong)] text-[var(--text-muted)]"
                }`}
              >
                {done ? "✓" : stage.runs ? "" : "–"}
              </span>
              <span
                className={
                  done || current
                    ? "stage-in text-[var(--text-primary)]"
                    : "text-[var(--text-muted)]"
                }
              >
                {stage.label}
              </span>
              {!stage.runs ? (
                <span className="text-xs text-[var(--text-muted)]">— not supplied, skipped</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
