// readCount: a reading with a value, for a state whose precondition is absent on
// the boot.
//
// WHY IT EXISTS. When a drawn state cannot be shown because what it needs does
// not exist on the boot (no notifications, no second organisation, no failed
// run), the proof is a reading of the page that says so with a number, on one
// line, rather than a sentence. A count taken the instant a page loads can read
// a list that mounts a moment later as empty, so the step records the count only
// once it has held still for a whole settle window.
//
// It counts what is ATTACHED to the page, visible or not, as a locator counts.
import { errorClass, pathOf, pause, refuse, requireMs, requireRecord } from "./step-kit.mjs";

const STEP = "readCount";

/** How long the count must hold still before it is recorded. */
export const COUNT_SETTLE_MS = 1_000;
/** How often the count is read while it settles. */
export const COUNT_POLL_MS = 100;
/** How long the step gives the count to hold still at all. */
export const COUNT_BOUND_MS = 15_000;

/**
 * Count what `selector` matches on the caller's page once the count has held
 * still for `settleMs`, write it on one line, and resolve `{ selector, count, path }`
 * (the page's path, never its address). Refuses, as a StepRefusal, a selector
 * it cannot count and a count that does not hold still within `bound`.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   selector: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   settleMs?: number,
 *   pollMs?: number,
 *   bound?: number,
 * }} options
 * @returns {Promise<{ selector: string, count: number, path: string }>}
 */
export async function readCount(
  page,
  { selector, record, settleMs = COUNT_SETTLE_MS, pollMs = COUNT_POLL_MS, bound = COUNT_BOUND_MS } = /** @type {any} */ ({}),
) {
  requireRecord(STEP, record);
  const nothing = "nothing was read";
  if (typeof selector !== "string" || selector.trim() === "") throw refuse(STEP, record, "input", `name the selector to count — ${nothing}`);
  requireMs(STEP, record, "settleMs", settleMs, nothing);
  requireMs(STEP, record, "pollMs", pollMs, nothing);
  requireMs(STEP, record, "bound", bound, nothing);
  const named = selector.replace(/\s+/g, " ").trim();

  const count = async () => {
    try {
      return await page.locator(selector).count();
    } catch (error) {
      throw refuse(STEP, record, "unreadable", `${named} could not be counted (${errorClass(error)})`);
    }
  };

  // The count holds still when two readings at least `settleMs` apart agree and
  // every reading between them agreed too. The decision is only ever taken on a
  // fresh reading, so a stalled process never records a count it read long ago.
  const start = performance.now();
  let value = await count();
  let since = performance.now();
  for (;;) {
    await pause(pollMs);
    const next = await count();
    const now = performance.now();
    if (next !== value) {
      value = next;
      since = now;
    } else if (now - since >= settleMs) {
      const path = pathOf(page.url());
      record(`${STEP}: ${value} ${value === 1 ? "element matches" : "elements match"} ${named} on ${path}`);
      return { selector, count: value, path };
    }
    if (now - start >= bound) {
      throw refuse(STEP, record, "unsteady", `the count of ${named} did not hold still for ${settleMs} ms within ${bound} ms (last reading ${value})`);
    }
  }
}
