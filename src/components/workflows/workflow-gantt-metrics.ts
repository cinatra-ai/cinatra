/**
 * Planned-vs-actual overlay metrics.
 *
 * Pure module — NO `"use client"`, NO React, NO SVAR. Unit-testable in isolation.
 * Consumed by `workflow-gantt.tsx`'s `taskTemplate` to render the inner
 * `.gantt-actual-bar` ghost overlay inside the SVAR bar.
 *
 * Coordinates are expressed as PERCENTAGES of the planned bar (left/width), so
 * the overlay tracks the SVAR bar's geometry through scroll/resize/view-switch
 * automatically (no separate rAF loop).
 */

/** Input to the metrics computation. All ms epoch instants. */
export type ActualBarInput = {
  plannedStartMs: number;
  plannedEndMs: number;
  /** Actual-start instant. `null`/`undefined` → no overlay. */
  actualStartMs?: number | null;
  /** Actual-end instant. `null`/`undefined` for a running task → clamp to `nowMs`. */
  actualEndMs?: number | null;
  /** "Now" for clamping running tasks. Defaults to `Date.now()`. */
  nowMs?: number;
};

/** Pixel-relative metrics for the inner ghost bar, expressed as percentages of
 *  the planned bar. `null` when nothing should render (no actuals, or planned
 *  is a milestone with zero width). */
export type ActualBarMetrics = {
  /** % from the planned bar's left, in [0, 100]. */
  leftPct: number;
  /** % width inside the planned bar, in [0, 100]. */
  widthPct: number;
  /** Days the actual end ran past the planned end (rounded down). 0 for
   *  running tasks (`actualEndMs` undefined) — can't be "late" until finished. */
  slipDays: number;
};

const DAY_MS = 86_400_000;

/**
 * Compute the planned-vs-actual overlay percentages + late-slip days.
 *
 * Rules:
 * - No actuals (`actualStartMs == null`) → return `null`.
 * - Milestone (`plannedEndMs <= plannedStartMs`) → return `null` (zero-width
 *   planned bar can't host a meaningful overlay).
 * - Running task (`actualEndMs == null`) → `endMs = nowMs ?? Date.now()`;
 *   `slipDays = 0` (running can't be "late" yet).
 * - Completed → `endMs = actualEndMs`; `slipDays = max(0, (actualEndMs −
 *   plannedEndMs) / DAY)`.
 * - Clip to the visible overlap with the planned bar: early starts clamp
 *   `leftPct` to 0; late ends clamp the right side to 100. Both are
 *   independent — an actual fully outside the planned window collapses to
 *   `widthPct === 0` (still returned so callers can decide whether to render).
 */
export function computeActualBarMetrics(input: ActualBarInput): ActualBarMetrics | null {
  const { plannedStartMs, plannedEndMs, actualStartMs, actualEndMs, nowMs } = input;
  if (actualStartMs == null) return null;
  const span = plannedEndMs - plannedStartMs;
  if (span <= 0) return null;
  const endMs = actualEndMs != null ? actualEndMs : (nowMs ?? Date.now());
  const rawLeftPct = ((actualStartMs - plannedStartMs) / span) * 100;
  const rawRightPct = ((endMs - plannedStartMs) / span) * 100;
  const leftPct = Math.max(0, Math.min(100, rawLeftPct));
  const rightPct = Math.max(0, Math.min(100, rawRightPct));
  const widthPct = Math.max(0, rightPct - leftPct);
  const slipDays =
    actualEndMs == null ? 0 : Math.max(0, Math.floor((actualEndMs - plannedEndMs) / DAY_MS));
  return { leftPct, widthPct, slipDays };
}
