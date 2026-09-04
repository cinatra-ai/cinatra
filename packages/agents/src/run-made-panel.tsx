import Link from "next/link";
import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";
import {
  RUN_MADE_PANEL_TITLE,
  buildRunArtifactList,
  runArtifactListSummary,
  type RunArtifactRecord,
} from "./run-artifact-list";
import type { AgentRunStatus } from "./run-status";

// ---------------------------------------------------------------------------
// "What this run made" — the panel of the rail's last entry (cinatra#3029, epic
// #3023 W5; Agents Lifecycle (C) §6 step 6, and the ratified drawing's section
// on the run's last step).
//
// The reading and every row are built by the PURE model in `./run-artifact-list`
// (fixture-pinned in `__tests__/run-artifact-list.test.ts`); this file is the
// drawing of that model and holds no reading of its own. A row is a POINTER —
// title, the type that owns it, the revision the run filed or read, and the
// control that opens it on its own page.
//
// Two things live in the DRAWING rather than in the model, and are pinned in
// `__tests__/run-made-panel.test.tsx`:
//
//   * the panel title is PAIRED WITH THE RUN'S STATE, so the panel says whose
//     record this is and in what state that run ended; and
//   * the row's muted line WRAPS. It carries the identity, the revision and the
//     MIME, and a reader who needs to know the form an artifact took cannot get
//     it from a line that ends "text/markdo…". The rail's own lifecycle reason
//     already states the house rule ("it WRAPS inside the narrow rail (never
//     truncates) — a clipped reason answers nothing").
// ---------------------------------------------------------------------------

/**
 * THE PILL'S VOCABULARY IS THE DRAWING'S, AND THE DRAWING GIVES ONE WORD.
 *
 * The ratified drawing's section on the run's last step draws this pill twice --
 * once beside the list of what the run made, once beside the empty reading --
 * and both times it reads "Finished". The panel drew the product's own status
 * word "Completed" there instead, which is not a word the drawing writes.
 *
 * ONLY THREE STATES CAN EVER REACH THIS PANEL. It is the rail's LAST entry and
 * the screen builds it only for a run that has ENDED (`isTerminalRunStatus`), so
 * the terminal three are the whole table. The seven further readings this table
 * used to carry described states the panel is never handed, and no sentence of
 * the drawing supplies a word for any of them -- so they are gone rather than
 * invented.
 *
 * THE DRAWING SUPPLIES NO WORD FOR A RUN THAT FAILED OR WAS STOPPED. Those two
 * keep the run's own truthful reading rather than borrowing the finished one --
 * a failed run must not read as a finished run -- and the missing sentence is
 * carried as an open question on the record rather than answered here by
 * invention.
 */
const RUN_STATE_PILL: Partial<
  Record<AgentRunStatus, { pill: StatusPillStatus; label: string }>
> = {
  completed: { pill: "approved", label: "Finished" },
  failed: { pill: "failed", label: "Failed" },
  stopped: { pill: "archived", label: "Stopped" },
};

export function RunMadePanel({
  records,
  runStatus,
}: {
  records: readonly RunArtifactRecord[];
  /** The run whose record this panel is — `agent_runs.status` as the row
   *  carries it. Drawn beside the title as the state pill the ratified drawing
   *  pairs with the heading. */
  runStatus: string;
}) {
  const list = buildRunArtifactList(records, (id) => `/artifacts/${encodeURIComponent(id)}`);
  // A status outside the union still gets a pill reading its own raw value —
  // the panel never goes silent about whose record it is showing.
  const state =
    RUN_STATE_PILL[runStatus as AgentRunStatus] ??
    ({ pill: "idle", label: runStatus } as { pill: StatusPillStatus; label: string });
  return (
    <section
      aria-label={RUN_MADE_PANEL_TITLE}
      className="rounded-lg border border-border bg-card p-4"
    >
      <div
        data-run-made-header=""
        className="flex flex-wrap items-center justify-between gap-2"
      >
        <h3 className="text-sm font-semibold text-foreground">{RUN_MADE_PANEL_TITLE}</h3>
        <StatusPill status={state.pill} data-run-made-run-status={runStatus}>
          {state.label}
        </StatusPill>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{runArtifactListSummary(list)}</p>
      {list.kind === "rows" ? (
        <ul className="mt-3 flex flex-col gap-2">
          {list.rows.map((row) => (
            <li
              key={row.key}
              className="flex items-start justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{row.title}</span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-badge-xs text-muted-foreground">
                    {row.typeBadge}
                  </span>
                  {row.usedMark ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-badge-xs text-muted-foreground">
                      Used
                    </span>
                  ) : null}
                </div>
                {/* The muted line WRAPS. `truncate` clipped the MIME off the end
                    of the row on the measured surface; the row grows instead. */}
                <div
                  data-run-made-detail=""
                  className="mt-0.5 font-mono text-badge-xs leading-4 whitespace-normal break-words text-muted-foreground"
                >
                  {row.detail}
                </div>
              </div>
              <Link
                href={row.href}
                className="shrink-0 text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                {row.openLabel}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
