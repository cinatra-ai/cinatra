// armPageTape and readPageTape: the document's time origin, and the main
// frame's navigations counted from one moment on, so a check can prove that a
// page changed in place: the same document, not reloaded, between two moments.
//
// WHY THEY EXIST. A check that a page changed in place had no step to stand on:
// no step read the document's time origin or counted the navigations of the
// main frame.
//
// THE TAPE. armPageTape reads the document's time origin
// (`performance.timeOrigin`, which every new document has anew) and its path,
// and from then on counts the navigations of the page's main frame on the
// driver's side, from the page's own navigation events. The tape belongs to the
// page object: two pages hold two tapes, a tape lasts through the page's new
// documents and changes of address, and it ends with the page. The module keeps
// no state of its own.
//
// A NEW DOCUMENT OR A CHANGE IN PLACE. The page announces every navigation of
// its main frame (`framenavigated`), a new document and a change of the address
// in place alike. A new document is one that a navigation request of the main
// frame led to: a request for the same address (without its fragment) that has
// not failed. A document of another origin, or of none (the browser's own error
// page), is always a new one. A change in place (a state pushed into the
// history, a new fragment, a step back within the document) sends no request.
// A state written into the history at the same address is announced as well,
// and is no change of the address.
import { originOf } from "./read-standing-requests.mjs";
import { READING_BOUND_MS, errorClass, pathOf, readBounds, refuse, refuseFrameScope, requireRecord } from "./step-kit.mjs";

const ARM = "armPageTape";
const READ = "readPageTape";

/** Every bound of the two steps, by the name `bounds` overrides it with. */
export const PAGE_TAPE_BOUNDS = Object.freeze({ readingMs: READING_BOUND_MS });

/** Where a page keeps its tape: on the page object itself, so that the tape ends with the page. */
const TAPE = Symbol("page tape");

/**
 * An address without its fragment, as a navigation request carries it.
 * @param {string} url
 */
const withoutFragment = (url) => {
  const at = url.indexOf("#");
  return at < 0 ? url : url.slice(0, at);
};

/**
 * The frame a request was made in, or null: a service worker's request has none.
 * @param {import("@playwright/test").Request} request
 */
function frameOf(request) {
  try {
    return request.frame();
  } catch {
    return null;
  }
}

/** Reads, IN THE PAGE, the document's address and its time origin. */
function readOrigin() {
  return { href: location.href, timeOrigin: performance.timeOrigin };
}

/**
 * One reading of the document within `readingMs`: its path, its address and
 * its time origin. A refusal keeps only the error's class.
 * @param {import("@playwright/test").Page} page
 * @param {string} step
 * @param {import("./step-kit.mjs").StepRecord} record
 * @param {number} readingMs
 * @param {string} nothing what a refusal says was not done
 * @returns {Promise<{ path: string, href: string, timeOrigin: number }>}
 */
async function readDocument(page, step, record, readingMs, nothing) {
  const on = pathOf(page.url());
  const EXPIRED = Symbol("expired");
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const expired = new Promise((done) => {
    timer = setTimeout(() => done(EXPIRED), readingMs);
  });
  /** @type {any} */
  let reading;
  try {
    reading = await Promise.race([page.evaluate(readOrigin), expired]);
  } catch (error) {
    throw refuse(step, record, "driver-failure", `the page on ${on} could not be read (${errorClass(error)}) — ${nothing}`);
  } finally {
    clearTimeout(timer);
  }
  if (reading === EXPIRED) throw refuse(step, record, "driver-failure", `the page on ${on} could not be read within ${readingMs} ms — ${nothing}`);
  if (!reading || typeof reading.href !== "string" || typeof reading.timeOrigin !== "number") {
    throw refuse(step, record, "driver-failure", `the page on ${on} could not be read — ${nothing}`);
  }
  return { path: pathOf(reading.href), href: reading.href, timeOrigin: reading.timeOrigin };
}

/**
 * @typedef {{ armedTimeOrigin: number, documents: number, addressChanges: number, ended: boolean, stop: () => void }} Tape
 */

/**
 * A tape that counts the navigations of the page's main frame from the
 * address `href` on, until it is stopped: when the page closes, or when a tape
 * is armed on the page again.
 * @param {import("@playwright/test").Page} page
 * @param {string} href
 * @param {number} armedTimeOrigin
 * @returns {Tape}
 */
function startTape(page, href, armedTimeOrigin) {
  const main = page.mainFrame();
  /** @type {Tape} */
  const tape = { armedTimeOrigin, documents: 0, addressChanges: 0, ended: false, stop: () => {} };
  let address = href;
  // The main frame's navigation requests that have neither failed nor led to a document yet.
  /** @type {Set<import("@playwright/test").Request>} */
  const pending = new Set();
  const onRequest = (/** @type {import("@playwright/test").Request} */ request) => {
    if (request.isNavigationRequest() && frameOf(request) === main) pending.add(request);
  };
  const onRequestFailed = (/** @type {import("@playwright/test").Request} */ request) => {
    pending.delete(request);
  };
  const onNavigated = (/** @type {import("@playwright/test").Frame} */ frame) => {
    if (frame !== main) return;
    const url = frame.url();
    const origin = originOf(url);
    const requested = [...pending].some((request) => withoutFragment(request.url()) === withoutFragment(url));
    if (requested || origin === null || origin !== originOf(address)) {
      tape.documents += 1;
      pending.clear();
    } else if (url !== address) {
      tape.addressChanges += 1;
    }
    address = url;
  };
  const onClose = () => tape.stop();
  /** @type {[string, (value: any) => void][]} */
  const listeners = [
    ["request", onRequest],
    ["requestfailed", onRequestFailed],
    ["framenavigated", onNavigated],
    ["close", onClose],
  ];
  tape.stop = () => {
    tape.ended = true;
    for (const [event, listener] of listeners) page.off(/** @type {any} */ (event), listener);
  };
  for (const [event, listener] of listeners) page.on(/** @type {any} */ (event), listener);
  return tape;
}

/**
 * Read the document's time origin and path, and start counting the
 * navigations of the page's main frame from now on, new documents and changes
 * of the address in place apart. A tape armed on the page before is stopped,
 * and the count starts again. Writes one line, `armPageTape: ` and the JSON of
 * `{ path, timeOrigin }`, with `"rearmed":true` when a tape was armed on the
 * page before, and resolves `{ path, timeOrigin, rearmed }`. Refuses, as a
 * StepRefusal, arguments it cannot use (`input`), a closed page (`closed`)
 * and a reading the driver could not take within the bound (`driver-failure`).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof PAGE_TAPE_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ path: string, timeOrigin: number, rearmed: boolean }>}
 */
export async function armPageTape(page, { record, bounds } = /** @type {any} */ ({})) {
  refuseFrameScope(ARM, record, page, "no tape was armed");
  requireRecord(ARM, record);
  const nothing = "no tape was armed";
  const bound = readBounds(ARM, record, PAGE_TAPE_BOUNDS, bounds, nothing);
  if (page.isClosed()) throw refuse(ARM, record, "closed", `the page on ${pathOf(page.url())} is closed — ${nothing}`);
  const { path, href, timeOrigin } = await readDocument(page, ARM, record, bound.readingMs, nothing);
  // No wait between the reading and the listeners: an event the driver hears after the reading is counted.
  /** @type {Tape | undefined} */
  const earlier = /** @type {any} */ (page)[TAPE];
  if (earlier) earlier.stop();
  /** @type {any} */ (page)[TAPE] = startTape(page, href, timeOrigin);
  const rearmed = Boolean(earlier);
  record(`${ARM}: ${JSON.stringify(rearmed ? { path, timeOrigin, rearmed } : { path, timeOrigin })}`);
  return { path, timeOrigin, rearmed };
}

/**
 * Read the page's tape: resolve `{ path, timeOrigin, armedTimeOrigin,
 * documents, addressChanges, sameDocument }`, where `documents` counts the new
 * documents of the main frame since the tape was armed, `addressChanges` its
 * changes of the address in place, and `sameDocument` is true only when the
 * time origin is still the armed one and no new document was counted. Writes
 * one line, `readPageTape: ` and the JSON of those fields. Refuses, as a
 * StepRefusal, arguments it cannot use (`input`), a closed page (`closed`), a
 * page on which no tape was armed (`no-tape`) and a reading the driver could
 * not take within the bound (`driver-failure`).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof PAGE_TAPE_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ path: string, timeOrigin: number, armedTimeOrigin: number, documents: number, addressChanges: number, sameDocument: boolean }>}
 */
export async function readPageTape(page, { record, bounds } = /** @type {any} */ ({})) {
  refuseFrameScope(READ, record, page, "nothing was read");
  requireRecord(READ, record);
  const nothing = "nothing was read";
  const bound = readBounds(READ, record, PAGE_TAPE_BOUNDS, bounds, nothing);
  const on = pathOf(page.url());
  /** @type {Tape | undefined} */
  const tape = /** @type {any} */ (page)[TAPE];
  if (page.isClosed() || (tape && tape.ended)) {
    throw refuse(READ, record, "closed", `the page on ${on} is closed${tape ? ", and its tape ended with it" : ""} — ${nothing}`);
  }
  if (!tape) throw refuse(READ, record, "no-tape", `no tape is armed on the page on ${on} — arm one with armPageTape first; ${nothing}`);
  const { path, timeOrigin } = await readDocument(page, READ, record, bound.readingMs, nothing);
  const { armedTimeOrigin, documents, addressChanges } = tape;
  const reading = { path, timeOrigin, armedTimeOrigin, documents, addressChanges, sameDocument: timeOrigin === armedTimeOrigin && documents === 0 };
  record(`${READ}: ${JSON.stringify(reading)}`);
  return reading;
}
