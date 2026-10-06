// watchRun: a run's watch on the run page, kept to its bound.
//
// WHY IT EXISTS. A watch that ends early (on its first reading that was not
// "running", on a reading taken mid-reload, or on a timeout shorter than the run)
// takes its picture of a moment nobody chose, or none at all. This step
// reads the run's drawn state on a fixed cadence, ends only when the run has
// settled or its bound has run out, and takes the frame either way.
//
// THE STATE IT READS, from what the run page draws:
//   - `completion:<evidence>`: the completion card (`data-run-completion`), with
//     the reading its output rests on (`data-run-completion-evidence`). Settled,
//     unless that reading is `pending`: the output is still loading.
//   - `status:<status>`: the run's own status pill in the run surface, the one
//     drawn with the dot (`data-slot="status-pill"`, `data-glyph="dot"`); a pill
//     the surface draws for something else is never the run's status. Settled
//     when the run no longer moves by itself: `approved` (completed), `failed`, or
//     `needs-review` (the run waits for a person).
//   - `absent` (no run surface on the page), `unmarked` (a run surface that draws
//     no status, as when the run's first step is an input step on the rail) and
//     `unreadable` (the page could not be read at that moment). None of them
//     settles: the watch holds to its bound and takes the frame there.
import { pollUntilSettled, refuse, requireMs, requireRecord, takeFrame } from "./step-kit.mjs";

const STEP = "watchRun";

/** The run surface: the run page's rail and run detail. */
export const RUN_SURFACE_SELECTOR = '[data-conformance-id="run-surface"]';
/** The run's own status pill inside the run surface. */
export const RUN_STATUS_SELECTOR = '[data-slot="status-pill"][data-glyph="dot"]';
/** The card the run page draws once the run has completed. */
export const RUN_COMPLETION_SELECTOR = "[data-run-completion]";
/** The pill statuses at which a run no longer moves by itself. */
export const RUN_SETTLED_STATUSES = Object.freeze(["approved", "failed", "needs-review"]);
/** The completion reading that is still moving: the output is loading. */
export const RUN_OUTPUT_PENDING = "pending";
/** How long the step watches a run. A run that calls a model can take minutes. */
export const RUN_WATCH_BOUND_MS = 300_000;
/** How often the run's state is read. */
export const RUN_WATCH_POLL_MS = 1_000;

// Runs IN THE PAGE: nothing of this module may be used inside it.
function readRun({ surface, status, completion }) {
  const card = document.querySelector(completion);
  if (card) return { state: "completion:" + (card.getAttribute("data-run-completion-evidence") || "unmarked") };
  const root = document.querySelector(surface);
  if (!root) return { state: "absent" };
  const pill = root.querySelector(status);
  if (!pill) return { state: "unmarked" };
  return { state: "status:" + (pill.getAttribute("data-status") || "unmarked") };
}

/** @param {string} state */
function runSettled(state) {
  if (state.startsWith("completion:")) return state !== `completion:${RUN_OUTPUT_PENDING}`;
  if (state.startsWith("status:")) return RUN_SETTLED_STATUSES.includes(state.slice("status:".length));
  return false;
}

/**
 * Watch the run on the caller's page until it settles or the bound runs out, and
 * take the frame either way. Writes exactly one line (settled or ran out, with
 * the elapsed time and the state) and resolves `{ state, settled, elapsedMs, path }`,
 * where `path` is the frame the shutter answered. Refuses, as a StepRefusal,
 * arguments it cannot use and a shutter that takes no frame.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   record: import("./step-kit.mjs").StepRecord,
 *   shutter: import("./step-kit.mjs").StepShutter,
 *   bound?: number,
 *   pollMs?: number,
 * }} options
 * @returns {Promise<{ state: string, settled: boolean, elapsedMs: number, path: string }>}
 */
export async function watchRun(page, { record, shutter, bound = RUN_WATCH_BOUND_MS, pollMs = RUN_WATCH_POLL_MS } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was read";
  if (typeof shutter !== "function") throw refuse(STEP, record, "input", `hand the step a shutter that takes the frame — ${nothing}`);
  requireMs(STEP, record, "bound", bound, nothing);
  requireMs(STEP, record, "pollMs", pollMs, nothing);

  const { reading, settled, elapsedMs } = await pollUntilSettled(page, {
    read: readRun,
    arg: { surface: RUN_SURFACE_SELECTOR, status: RUN_STATUS_SELECTOR, completion: RUN_COMPLETION_SELECTOR },
    isSettled: runSettled,
    bound,
    pollMs,
  });
  const state = reading.state;
  const path = await takeFrame(STEP, record, shutter, { step: STEP, state, settled, elapsedMs });
  record(`${STEP}: ${settled ? "settled" : "ran out"} after ${elapsedMs} ms (state ${state}); frame ${path}`);
  return { state, settled, elapsedMs, path };
}
