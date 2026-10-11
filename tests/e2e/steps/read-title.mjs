// readTitle: the page's title, once it has held still.
//
// WHY IT EXISTS. A count with a selector on the head's title element reads 0:
// the engine that reads text reads what the page draws, and the title is drawn
// nowhere in the page. This step reads the title through the browser's own
// reading of it (`document.title`, never a selector), and, as `readCount` does
// for a count, returns it only once it has held still for a whole settle
// window, so a title the page sets a moment after it loads is never read as the
// one it had before.
import { quotedName } from "./page-controls.mjs";
import { READING_BOUND_MS, pathOf, pause, refuse, refuseFrameScope, requireMs, requireRecord, within } from "./step-kit.mjs";

const STEP = "readTitle";

/** How long the title must hold still before it is returned. */
export const TITLE_SETTLE_MS = 1_000;
/** How often the title is read while it settles. */
export const TITLE_POLL_MS = 100;
/** How long the step gives the title to hold still at all. */
export const TITLE_BOUND_MS = 15_000;

/** The options the step takes. */
const OPTIONS = Object.freeze(["record", "settleMs", "pollMs", "bound"]);

/** Runs IN THE PAGE: the browser's own reading of the document's title. */
function titleInPage() {
  return document.title;
}

/**
 * A title, for a line: quoted and cut as a name is; an empty one, and a reading
 * that could not be taken (null), said to be one.
 * @param {string | null} title
 */
const describeTitle = (title) => (title === null ? "no reading (the page could not be read)" : title === "" ? "an empty title" : quotedName(title));

/**
 * Read the document's title on the caller's page once it has held still for
 * `settleMs`, write it on one line, and resolve `{ title, path }` (the page's
 * path, never its address). An empty title is a title: it resolves as the empty
 * string, and the line says so. Refuses, as a StepRefusal, arguments it cannot
 * use (`input`) and a title that does not hold still within `bound`
 * (`unsteady`, naming the last two titles it read).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   record: import("./step-kit.mjs").StepRecord,
 *   settleMs?: number,
 *   pollMs?: number,
 *   bound?: number,
 * }} options
 * @returns {Promise<{ title: string, path: string }>}
 */
export async function readTitle(page, options = /** @type {any} */ ({})) {
  const given = options && typeof options === "object" ? options : {};
  const { record, settleMs = TITLE_SETTLE_MS, pollMs = TITLE_POLL_MS, bound = TITLE_BOUND_MS } = /** @type {any} */ (given);
  refuseFrameScope(STEP, record, page, "nothing was read");
  requireRecord(STEP, record);
  const nothing = "nothing was read";
  for (const name of Object.keys(given)) {
    if (!OPTIONS.includes(name)) throw refuse(STEP, record, "input", `there is no option named ${name}; the bounds are settleMs, pollMs and bound — ${nothing}`);
  }
  requireMs(STEP, record, "settleMs", settleMs, nothing);
  requireMs(STEP, record, "pollMs", pollMs, nothing);
  requireMs(STEP, record, "bound", bound, nothing);

  /** One reading of the title; null when the page could not be read. */
  const read = async () => {
    const title = await within(page.evaluate(titleInPage), READING_BOUND_MS);
    return typeof title === "string" ? title : null;
  };

  // The title holds still when two readings at least `settleMs` apart agree and
  // every reading between them agreed too. A reading that could not be taken
  // agrees with nothing. The decision is only ever taken on a fresh reading.
  const start = performance.now();
  /** @type {string | null | undefined} the title before the last change, once there was one */
  let before;
  let value = await read();
  let since = performance.now();
  for (;;) {
    await pause(pollMs);
    const next = await read();
    const now = performance.now();
    if (next !== value || next === null) {
      if (next !== value) before = value;
      value = next;
      since = now;
    } else if (now - since >= settleMs) {
      const path = pathOf(page.url());
      record(value === "" ? `${STEP}: the page on ${path} has an empty title` : `${STEP}: the title of the page on ${path} reads ${quotedName(value)}`);
      return { title: value, path };
    }
    if (now - start >= bound) {
      const lastTwo = before === undefined ? `it read only ${describeTitle(value)}` : `the last two titles it read: ${describeTitle(before)}, then ${describeTitle(value)}`;
      throw refuse(STEP, record, "unsteady", `the title of the page on ${pathOf(page.url())} did not hold still for ${settleMs} ms within ${bound} ms (${lastTwo})`);
    }
  }
}
