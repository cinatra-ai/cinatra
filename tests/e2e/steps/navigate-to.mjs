// navigateTo: reaching a page through the product's own navigation.
//
// WHY IT EXISTS. A page reached by typing its address proves nothing about the
// road a person takes to it, and it can reach a page the product no longer
// links to at all. This step presses a visible link on the current page that
// leads to the path it is given, waits for the landing, and records where it
// landed. It never types an address: with no such link on the page, it refuses.
//
// A link counts when its `href` is the path, or the path followed by a query
// string or a fragment, and it opens in this tab. Lines name pages by their path
// alone, never by an address or a query string.
//
// A FURTHER PAGE. With `furtherPage: true` the step presses the same link with
// the modifier that opens it in a further page of the same browser context, as a
// person does, and leaves the current page where it is. Before it presses, it
// reads the requests that stand open on the current page's origin (see
// read-standing-requests.mjs): at or above the bound, or with a page it cannot
// read, it opens nothing and refuses, naming the count, the bound and the pages.
import {
  STANDING_REQUEST_BOUND,
  describeHolders,
  describeUnknown,
  originOf,
  standingRequests,
  takeStandingReading,
} from "./read-standing-requests.mjs";
import { READING_BOUND_MS, elapsedSince, errorClass, isPagePath, pathOf, readBounds, refuse, requireRecord, within } from "./step-kit.mjs";

const STEP = "navigateTo";

/** The press: how long the link may take to be ready. */
export const NAVIGATE_ACTION_BOUND_MS = 30_000;
/** From the press to the landing. A development boot compiles a route on its first request. */
export const NAVIGATE_LANDING_BOUND_MS = 120_000;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const NAVIGATE_BOUNDS = Object.freeze({
  actionMs: NAVIGATE_ACTION_BOUND_MS,
  landingMs: NAVIGATE_LANDING_BOUND_MS,
});

/** The modifier held while pressing a link to open it in a further page: Meta on macOS, Control elsewhere. */
export const FURTHER_PAGE_MODIFIER = "ControlOrMeta";

/** @param {string} path */
function linksTo(path) {
  return [`a[href="${path}"]`, `a[href^="${path}?"]`, `a[href^="${path}#"]`]
    .map((selector) => `${selector}:not([target="_blank"])`)
    .join(", ");
}

/**
 * The visible links on `page` that lead to `path`, or a refusal when there are none.
 * @param {import("@playwright/test").Page} page
 * @param {string} path
 * @param {string} from
 * @param {import("./step-kit.mjs").StepRecord} record
 */
async function visibleLinks(page, path, from, record) {
  const links = page.locator(linksTo(path)).filter({ visible: true });
  let found;
  try {
    found = await links.count();
  } catch (error) {
    throw refuse(STEP, record, "unreadable", `the links on ${from} could not be read (${errorClass(error)})`);
  }
  if (found === 0) throw refuse(STEP, record, "no-link", `no visible link on ${from} leads to ${path} — no address was typed`);
  return links;
}

/**
 * Reach `path` from the caller's current page by pressing the first visible link
 * that leads there, and resolve `{ path, from, pressed, elapsedMs }` once the
 * page has landed. Already on `path`, it presses nothing. Refuses, as a
 * StepRefusal, a path it cannot use, a page with no visible link to it, and a
 * press that does not land on it within the bound.
 *
 * With `furtherPage: true` it opens `path` in a further page instead, once the
 * standing requests on the current page's origin are below `standingBound`
 * (STANDING_REQUEST_BOUND by default), and resolves
 * `{ path, from, pressed, elapsedMs, furtherPage, standing }`, where
 * `furtherPage` is the page it opened and `standing` is `{ count, bound, counted }`.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   path: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof NAVIGATE_BOUNDS, number>>,
 *   furtherPage?: boolean,
 *   standingBound?: number,
 * }} options
 * @returns {Promise<{ path: string, from: string, pressed: boolean, elapsedMs: number, furtherPage?: import("@playwright/test").Page, standing?: { count: number, bound: number, counted: boolean } }>}
 */
export async function navigateTo(page, { path, record, bounds, furtherPage, standingBound } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was pressed";
  if (!isPagePath(path) || /[?#]/.test(path)) {
    throw refuse(STEP, record, "input", `name the page by its path alone, such as /chat — ${nothing}`);
  }
  const bound = readBounds(STEP, record, NAVIGATE_BOUNDS, bounds, nothing);
  if (furtherPage !== undefined && typeof furtherPage !== "boolean") {
    throw refuse(STEP, record, "input", `furtherPage must be true or false — ${nothing}`);
  }
  if (furtherPage) return openFurtherPage(page, { path, record, bound, standingBound, nothing });

  const from = pathOf(page.url());
  if (from === path) {
    record(`${STEP}: already on ${path} — nothing pressed`);
    return { path, from, pressed: false, elapsedMs: 0 };
  }

  const links = await visibleLinks(page, path, from, record);

  const start = performance.now();
  try {
    // `noWaitAfter`: without it the click itself waits, within the press's bound,
    // for the navigation it started, and a slow landing reads as a failed press.
    // The landing is waited for below, within its own bound.
    await links.first().click({ timeout: bound.actionMs, noWaitAfter: true });
  } catch (error) {
    throw refuse(STEP, record, "driver-failure", `the link to ${path} could not be pressed (${errorClass(error)})`);
  }
  try {
    await page.waitForURL((url) => url.pathname === path, { timeout: bound.landingMs, waitUntil: "load" });
  } catch {
    throw refuse(STEP, record, "landed-elsewhere", `the press did not land on ${path} within ${bound.landingMs} ms (the page is on ${pathOf(page.url())})`);
  }
  const elapsedMs = elapsedSince(start);
  record(`${STEP}: landed on ${path} from ${from} after ${elapsedMs} ms`);
  return { path, from, pressed: true, elapsedMs };
}

/**
 * The further page: the standing requests on the current page's origin first,
 * then the press with the modifier, then the further page's landing.
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   path: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   bound: typeof NAVIGATE_BOUNDS,
 *   standingBound?: number,
 *   nothing: string,
 * }} options
 */
async function openFurtherPage(page, { path, record, bound, standingBound = STANDING_REQUEST_BOUND, nothing }) {
  if (!Number.isInteger(standingBound) || standingBound < 1) {
    throw refuse(STEP, record, "input", `standingBound must be a whole number of requests, at least 1 — ${nothing}`);
  }
  const notOpened = "no further page was opened";
  const from = pathOf(page.url());
  const context = page.context();

  // The origin the further page opens on is the current page's: the link's path is on it.
  const origin = originOf(page.url());
  const reading = await takeStandingReading(context, READING_BOUND_MS);
  const read = reading.origins.find((candidate) => candidate.origin === origin);
  const count = read ? read.standing : 0;
  const counted = read ? read.counted : true;
  const held = read && read.standing > 0 ? `, ${describeHolders(read)}` : "";
  const are = count === 1 ? "is" : "are";
  if (counted && count >= standingBound) {
    throw refuse(
      STEP,
      record,
      "standing-requests",
      `${standingRequests(count)} on the origin of ${from} ${are} at or above the bound of ${standingBound}${held} — close a page that is no longer needed; ${notOpened}`,
    );
  }
  if (counted && reading.unknown.length > 0) {
    throw refuse(
      STEP,
      record,
      "standing-unknown",
      `${standingRequests(count)} on the origin of ${from} ${are} below the bound of ${standingBound}${held}, but the count is unknown: ${describeUnknown(reading.unknown)} — ${notOpened}`,
    );
  }

  const links = await visibleLinks(page, path, from, record);

  // The further page is the first page the context opens after the press.
  /** @type {(opened: any) => void} */
  let noteOpened = () => {};
  const opened = new Promise((done) => {
    noteOpened = done;
  });
  const start = performance.now();
  /** @type {import("@playwright/test").Page | null} */
  let further = null;
  context.on("page", noteOpened);
  try {
    try {
      await links.first().click({ timeout: bound.actionMs, noWaitAfter: true, modifiers: [FURTHER_PAGE_MODIFIER] });
    } catch (error) {
      throw refuse(STEP, record, "driver-failure", `the link to ${path} could not be pressed (${errorClass(error)})`);
    }
    further = await within(opened, bound.landingMs);
  } finally {
    context.off("page", noteOpened);
  }
  if (!further) {
    throw refuse(STEP, record, "no-further-page", `the press opened no further page within ${bound.landingMs} ms (this page is on ${pathOf(page.url())})`);
  }
  try {
    const left = Math.max(1, bound.landingMs - (performance.now() - start));
    await further.waitForURL((url) => url.pathname === path, { timeout: left, waitUntil: "load" });
  } catch {
    const landed = pathOf(further.url());
    // The step opened it, so the step closes it: a page left behind would hold its own requests.
    await further.close().catch(() => {});
    throw refuse(STEP, record, "landed-elsewhere", `the further page did not land on ${path} within ${bound.landingMs} ms (it was on ${landed}, and it was closed)`);
  }
  const elapsedMs = elapsedSince(start);
  const standing = counted
    ? `${standingRequests(count)} on its origin, below the bound of ${standingBound}`
    : `${standingRequests(count)} on its origin, served over ${read?.protocols.join(" and ")} and not counted`;
  record(`${STEP}: landed on ${path} in a further page from ${from} after ${elapsedMs} ms (${standing})`);
  return { path, from, pressed: true, elapsedMs, furtherPage: further, standing: { count, bound: standingBound, counted } };
}
