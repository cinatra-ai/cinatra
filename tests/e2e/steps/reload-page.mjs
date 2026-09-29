// reloadPage: the browser's own reload of the page, until the new document's
// content has loaded, and the new document's time origin.
//
// WHY IT EXISTS. No step reloaded a page. A run reloaded by hand, or loaded the
// page's address again, which is another load, and either could land on
// another page (a redirect, such as to the sign-in page) without any line
// saying so.
//
// THE NEW DOCUMENT. The step reloads with the browser's own reload and waits
// until the new document's content has loaded (`DOMContentLoaded`), within its
// bound. It then reads the new document's time origin
// (`performance.timeOrigin`, which every new document has anew, as armPageTape
// reads it) and answers it with the path. A reload that lands on another path
// than the one the page was on is refused, naming where it landed.
import { READING_BOUND_MS, elapsedSince, errorClass, pathOf, readBounds, refuse, requireRecord, within } from "./step-kit.mjs";

const STEP = "reloadPage";

/** From the reload to the new document's content loaded. A development server compiles a page on its first request. */
export const RELOAD_BOUND_MS = 120_000;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const RELOAD_PAGE_BOUNDS = Object.freeze({ reloadMs: RELOAD_BOUND_MS, readingMs: READING_BOUND_MS });

// Runs IN THE PAGE: the document's time origin.
function readTimeOrigin() {
  return performance.timeOrigin;
}

/**
 * Reload the caller's page with the browser's own reload, and resolve
 * `{ path, timeOrigin, elapsedMs }` once the new document's content has loaded:
 * `timeOrigin` is the new document's, and `elapsedMs` how long the reload
 * took. Refuses, as a StepRefusal: `input` and `closed` (nothing was
 * reloaded), `no-load` (the reload did not end within the bound, or failed),
 * `landed-elsewhere` (the reload landed on another path) and `driver-failure`
 * (the new document could not be read within the reading bound).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof RELOAD_PAGE_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ path: string, timeOrigin: number, elapsedMs: number }>}
 */
export async function reloadPage(page, { record, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was reloaded";
  const bound = readBounds(STEP, record, RELOAD_PAGE_BOUNDS, bounds, nothing);
  const from = pathOf(page.url());
  if (page.isClosed()) throw refuse(STEP, record, "closed", `the page on ${from} is closed — ${nothing}`);

  const start = performance.now();
  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: bound.reloadMs });
  } catch (error) {
    throw refuse(STEP, record, "no-load", `the reload of ${from} did not end within ${bound.reloadMs} ms (${errorClass(error)}; the page is on ${pathOf(page.url())})`);
  }
  const elapsedMs = elapsedSince(start);
  const path = pathOf(page.url());
  if (path !== from) throw refuse(STEP, record, "landed-elsewhere", `the reload of ${from} landed on ${path}`);
  const timeOrigin = await within(page.evaluate(readTimeOrigin), bound.readingMs);
  if (typeof timeOrigin !== "number") {
    throw refuse(STEP, record, "driver-failure", `the new document on ${path} could not be read within ${bound.readingMs} ms`);
  }
  record(`${STEP}: reloaded ${path} after ${elapsedMs} ms; the new document's time origin is ${timeOrigin}`);
  return { path, timeOrigin, elapsedMs };
}
