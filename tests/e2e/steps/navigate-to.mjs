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
import { elapsedSince, errorClass, isPagePath, pathOf, readBounds, refuse, requireRecord } from "./step-kit.mjs";

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

/** @param {string} path */
function linksTo(path) {
  return [`a[href="${path}"]`, `a[href^="${path}?"]`, `a[href^="${path}#"]`]
    .map((selector) => `${selector}:not([target="_blank"])`)
    .join(", ");
}

/**
 * Reach `path` from the caller's current page by pressing the first visible link
 * that leads there, and resolve `{ path, from, pressed, elapsedMs }` once the
 * page has landed. Already on `path`, it presses nothing. Refuses, as a
 * StepRefusal, a path it cannot use, a page with no visible link to it, and a
 * press that does not land on it within the bound.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   path: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof NAVIGATE_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ path: string, from: string, pressed: boolean, elapsedMs: number }>}
 */
export async function navigateTo(page, { path, record, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was pressed";
  if (!isPagePath(path) || /[?#]/.test(path)) {
    throw refuse(STEP, record, "input", `name the page by its path alone, such as /chat — ${nothing}`);
  }
  const bound = readBounds(STEP, record, NAVIGATE_BOUNDS, bounds, nothing);

  const from = pathOf(page.url());
  if (from === path) {
    record(`${STEP}: already on ${path} — nothing pressed`);
    return { path, from, pressed: false, elapsedMs: 0 };
  }

  const links = page.locator(linksTo(path)).filter({ visible: true });
  let found;
  try {
    found = await links.count();
  } catch (error) {
    throw refuse(STEP, record, "unreadable", `the links on ${from} could not be read (${errorClass(error)})`);
  }
  if (found === 0) throw refuse(STEP, record, "no-link", `no visible link on ${from} leads to ${path} — no address was typed`);

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
