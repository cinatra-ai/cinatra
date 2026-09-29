// openAddress: an address of the page's own origin loaded, once, in the
// caller's page, where no visible link leads; and where it landed, with the
// status the response gave.
//
// WHY IT EXISTS. navigateTo presses a link and never types an address, so a
// page that exists only for a wrong address, such as the not-found page, could
// not be reached by the maintained steps at all: no link leads to it, by
// definition.
//
// THE ONE STEP THAT TYPES AN ADDRESS, and only where no press can reach. It
// refuses a path a visible link on the current page leads to, read as
// navigateTo reads its links, since pressing that link is navigateTo's act; an
// address of another origin; and anything that is no page path. It loads the
// path once, on the current page's origin, in the caller's page, so the session
// the page is signed in with goes with it, and it answers the path the load
// landed on and the status of the response. Its line says that an address was
// typed.
import { linksTo } from "./navigate-to.mjs";
import { originOf } from "./read-standing-requests.mjs";
import { READING_BOUND_MS, elapsedSince, errorClass, isPagePath, pathOf, readBounds, refuse, requireRecord, within } from "./step-kit.mjs";

const STEP = "openAddress";

/** From the typed address to the landing. A development server compiles a page on its first request. */
export const OPEN_ADDRESS_BOUND_MS = 120_000;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const OPEN_ADDRESS_BOUNDS = Object.freeze({ loadMs: OPEN_ADDRESS_BOUND_MS, readingMs: READING_BOUND_MS });

/** An address that names an origin of its own: one with a scheme, or one that starts with two slashes. */
const NAMES_AN_ORIGIN = /^(?:[a-z][a-z\d+.-]*:|[/\\]{2})/i;

/**
 * Load `path` on the caller's page's own origin, once, when no visible link on
 * the page leads to it, and resolve `{ path, status, from, elapsedMs }`: `path`
 * is where the load landed, `status` the status of the response (null when
 * there was none), and `from` the path the page was on. Refuses, as a
 * StepRefusal: `input` (a path that is no page path of the page's own origin),
 * `other-origin` (an address of another origin), `unreadable` (the page's
 * links could not be read) and `has-link` (a visible link leads to the path:
 * that press is navigateTo's), all before anything is loaded; and `no-load`
 * (the load did not end within the bound, or failed).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   path: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof OPEN_ADDRESS_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ path: string, status: number | null, from: string, elapsedMs: number }>}
 */
export async function openAddress(page, { path, record, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "no address was typed";
  const from = pathOf(page.url());
  const origin = originOf(page.url());
  if (typeof path === "string" && NAMES_AN_ORIGIN.test(path.trim())) {
    let elsewhere = true;
    try {
      elsewhere = origin === null || new URL(path.trim(), page.url()).origin !== origin;
    } catch {
      elsewhere = true;
    }
    if (elsewhere) throw refuse(STEP, record, "other-origin", `the address names another origin than the page's on ${from} — ${nothing}`);
  }
  if (!isPagePath(path) || /[?#]/.test(path)) throw refuse(STEP, record, "input", `name the page by its path alone, such as /chat — ${nothing}`);
  const bound = readBounds(STEP, record, OPEN_ADDRESS_BOUNDS, bounds, nothing);
  if (origin === null) throw refuse(STEP, record, "input", `the page is on ${from}, which has no origin to load the path on — ${nothing}`);

  // A link a person could press: navigateTo's reading of the page's links.
  const links = await within(page.locator(linksTo(path)).filter({ visible: true }).count(), bound.readingMs);
  if (links === null) throw refuse(STEP, record, "unreadable", `the links on ${from} could not be read within ${bound.readingMs} ms — ${nothing}`);
  if (links > 0) throw refuse(STEP, record, "has-link", `a visible link on ${from} leads to ${path}, and pressing it is navigateTo's act — ${nothing}`);

  const start = performance.now();
  /** @type {import("@playwright/test").Response | null} */
  let response;
  try {
    response = await page.goto(`${origin}${path}`, { waitUntil: "load", timeout: bound.loadMs });
  } catch (error) {
    throw refuse(
      STEP,
      record,
      "no-load",
      `the address of ${path} was typed, and its load did not end within ${bound.loadMs} ms (${errorClass(error)}; the page is on ${pathOf(page.url())})`,
    );
  }
  const elapsedMs = elapsedSince(start);
  const landed = pathOf(page.url());
  const status = response ? response.status() : null;
  record(
    `${STEP}: typed the address of ${path} into the page on ${from}, where no visible link leads to it; it landed on ${landed} with ${status === null ? "no response" : `status ${status}`} after ${elapsedMs} ms`,
  );
  return { path: landed, status, from, elapsedMs };
}
