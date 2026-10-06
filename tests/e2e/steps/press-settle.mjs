// What the two pressing steps share, press and pressByTestId: the press on the
// one marked element, and the reading of the page's next settled state.
//
// SETTLED. The press is read with the start signal `navigateTo` reads: a
// navigation request of the page, the page's own request for a link's path when
// a client-side router navigates in place, or another path in the address.
//   - When none of these comes within the start bound, no navigation started:
//     the page stayed where it was, and the step returns then.
//   - When one comes, the navigation must land within the settle bound: a new
//     document that has loaded, or, in place, the same document on another path.
//     A browser holds a reading sent while a navigation is in flight until the
//     navigation ends; the step waits for such a reading no longer than the
//     settle bound leaves, so a navigation that lands late is refused at the
//     bound, with the page still on the document it started from.
// A press whose navigation starts later than the start bound (a handler that
// waits for a slow answer first) reads as one that stayed; lengthen `startMs`
// for such a control.
//
// Plain ESM with JSDoc types and Node's builtins only, like every file in this
// directory.
import { CONTROL_MARK, forgetDocument, markedBy, readPageControls, readDocument, unmarkControls } from "./page-controls.mjs";
import { startsNavigation } from "./navigate-to.mjs";
import { originOf } from "./read-standing-requests.mjs";
import { READING_BOUND_MS, elapsedSince, errorClass, pause, refuse, within } from "./step-kit.mjs";

/**
 * @typedef {{ actionMs: number, startMs: number, settleMs: number, pollMs: number }} PressBounds
 *   The bounds of a press: the press itself, the start of a navigation, its
 *   landing, and how often the page is read.
 */

/**
 * Press the element that carries `mark` (a step marked it, and it alone) and
 * read the page's next settled state. It notes the document the press starts
 * from, listens for the start signal from before the press, presses, and reads
 * the page until it has settled; with `checks`, it reads the element's checked
 * state once the page has settled. The mark and the note come off again,
 * whatever happens. Refuses, as a StepRefusal, a page it could not read before
 * the press (`unreadable`, and the mark comes off) and a press that could not be
 * made (`driver-failure`); `what` names the element in that refusal, such as
 * `the button "Save" on /agents`.
 *
 * `settled` is null when a navigation started and did not land within the settle
 * bound: the caller refuses it in its own words. `checked` is null when it was
 * not read, or could not be.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   step: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   mark: string,
 *   from: string,
 *   href: { origin: string, path: string } | null,
 *   bound: PressBounds,
 *   what: string,
 *   nothing: string,
 *   checks?: boolean,
 * }} press
 * @returns {Promise<{ settled: { navigated: boolean, path: string } | null, checked: boolean | "mixed" | null, elapsedMs: number }>}
 */
export async function pressAndSettle(page, { step, record, mark, from, href, bound, what, nothing, checks = false }) {
  // The document the press starts from, noted so that a new one is known.
  const key = `__stepPress${mark}`;
  const noted = await within(page.evaluate(readDocument, { key, set: true }), READING_BOUND_MS);
  if (!noted || !noted.same) {
    await within(page.evaluate(unmarkControls, { attribute: CONTROL_MARK, mark }), READING_BOUND_MS);
    throw refuse(step, record, "unreadable", `the page on ${from} could not be read before the press — ${nothing}`);
  }

  // The start signal, listened for from before the press. A link's own path
  // counts only when it leads away from this path.
  const origin = originOf(page.url());
  const linkPath = href && href.origin === origin && href.path !== from ? href.path : null;
  let started = false;
  const onRequest = (/** @type {import("@playwright/test").Request} */ request) => {
    if (!started) started = startsNavigation(page, request, origin, /** @type {string} */ (linkPath));
  };
  /** @type {{ navigated: boolean, path: string } | null} */
  let settled = null;
  /** @type {boolean | "mixed" | null} */
  let checked = null;
  let pressedAt = performance.now();
  page.on("request", onRequest);
  try {
    try {
      // `noWaitAfter`: the press returns once made; where it leads is read below.
      await page.locator(markedBy(mark)).click({ timeout: bound.actionMs, noWaitAfter: true });
    } catch (error) {
      throw refuse(step, record, "driver-failure", `${what} could not be pressed (${errorClass(error)})`);
    }
    pressedAt = performance.now();
    settled = await settle(page, { key, from, hasStarted: () => started, bound, pressedAt });
    // The checked state once the page has settled, read before the mark is taken off.
    if (settled && checks) {
      const after = await within(readPageControls(page, { mode: "checked", attribute: CONTROL_MARK, mark }), READING_BOUND_MS);
      checked = after ? after.checked : null;
    }
  } finally {
    page.off("request", onRequest);
    // The page is the app's again. A page that has navigated since carries neither.
    // While the press's navigation is still in flight, the browser holds these two
    // readings until it ends: they take effect then on the document the press
    // started from, or that document is gone and its mark with it. They are not
    // waited for past a poll, so the step keeps its settle bound.
    const cleanupMs = settled || !started ? READING_BOUND_MS : bound.pollMs;
    await within(page.evaluate(unmarkControls, { attribute: CONTROL_MARK, mark }), cleanupMs);
    await within(page.evaluate(forgetDocument, { key }), cleanupMs);
  }
  return { settled, checked, elapsedMs: elapsedSince(pressedAt) };
}

/**
 * The page's next settled state after the press: a new document that has
 * loaded, the same document on another path, or, once the start bound has run
 * out without a start signal, the same document where it was. Null when a
 * navigation started and did not land within the settle bound.
 * @param {import("@playwright/test").Page} page
 * @param {{ key: string, from: string, hasStarted: () => boolean, bound: PressBounds, pressedAt: number }} watch
 * @returns {Promise<{ navigated: boolean, path: string } | null>}
 */
export async function settle(page, { key, from, hasStarted, bound, pressedAt }) {
  const startBound = Math.min(bound.startMs, bound.settleMs);
  for (;;) {
    // A reading sent while a navigation is in flight is held until the navigation
    // ends, and fails once a new document has committed: it is waited for no
    // longer than the bound leaves.
    const left = bound.settleMs - (performance.now() - pressedAt);
    const reading = await within(page.evaluate(readDocument, { key, set: false }), Math.max(1, Math.min(READING_BOUND_MS, left)));
    const elapsed = performance.now() - pressedAt;
    if (reading) {
      if (!reading.same && reading.state === "complete") return { navigated: true, path: reading.path };
      if (reading.same && reading.path !== from) return { navigated: true, path: reading.path };
      if (reading.same && !hasStarted() && elapsed >= startBound) return { navigated: false, path: reading.path };
    }
    const remaining = bound.settleMs - elapsed;
    if (remaining <= 0) return null;
    await pause(Math.min(bound.pollMs, remaining));
  }
}
