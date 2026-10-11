// openPageInOwnContext: a further page in a browser context of its own, signed
// in by the session the first page carries.
//
// WHY IT EXISTS. A run page holds several requests open on its origin for as
// long as it is open, and over plain HTTP a browser opens at most six
// connections to one origin in one browser context. A further page in the same
// context takes what is left, and the first page's own send can then wait
// forever; navigateTo refuses a further page at four standing requests for that
// reason. A state that needs two people at once, one on a run's pending gate
// and one who settles it, needs a second page all the same. A second browser
// context has connections of its own.
//
// WHAT IT DOES, in order:
//   1. refuses, before the page is touched, a path that is no page path or
//      carries a query string or a fragment, the sign-in page, and a bound it
//      does not know;
//   2. reads the visible links on the current page that lead to the path, as
//      navigateTo reads them: with none, it opens nothing. It never invents an
//      address: it follows the one the link leads to;
//   3. opens a new browser context on the same browser, from the storage state
//      of the page's context (its cookies and its storage) and the page's
//      viewport. The state is handed from one call into the other: it is never
//      written to a file, recorded or logged, and no sign-in is made;
//   4. starts the reading of standing requests on the new context before its
//      page opens, so the page is never unknown to it;
//   5. loads the link's address in a new page of that context and waits for the
//      landing as navigateTo does. A landing on the sign-in page, or on another
//      path within the bound, is refused, and the new context is closed first.
// The caller closes the further page's context when it is done with it.
import { visibleLinksTo } from "./navigate-to.mjs";
import { originOf, standingRequests, takeStandingReading } from "./read-standing-requests.mjs";
import { SIGN_IN_PAGE_PATH } from "./sign-in-through-page.mjs";
import { READING_BOUND_MS, elapsedSince, errorClass, isPagePath, pathOf, readBounds, refuse, refuseFrameScope, requireRecord, within } from "./step-kit.mjs";

const STEP = "openPageInOwnContext";

/** From the new context to the landing of its page. A development server compiles a route on its first request. */
export const OWN_CONTEXT_LANDING_BOUND_MS = 120_000;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const OWN_CONTEXT_BOUNDS = Object.freeze({
  landingMs: OWN_CONTEXT_LANDING_BOUND_MS,
  readingMs: READING_BOUND_MS,
});

/**
 * Close a context the step opened, whatever it answers.
 * @param {import("@playwright/test").BrowserContext} context
 */
async function closeContext(context) {
  await context.close().catch(() => {});
}

/**
 * Open `path` in a page of a browser context of its own, from the first
 * visible link on the caller's page that leads there, signed in by the session
 * that page's context carries, and resolve
 * `{ path, from, elapsedMs, furtherPage, standing }` once it has landed:
 * `furtherPage` is the page it opened, and `standing` the new context's own
 * reading of standing requests (see readStandingRequests). The caller closes
 * `furtherPage.context()` when it is done. Refuses, as a StepRefusal: `input`
 * (the page was not touched), `unreadable`, `no-link` and `no-browser` (no
 * context was opened), `driver-failure`, and `session-lost` and
 * `landed-elsewhere` (the new context was closed).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   path: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof OWN_CONTEXT_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{
 *   path: string,
 *   from: string,
 *   elapsedMs: number,
 *   furtherPage: import("@playwright/test").Page,
 *   standing: import("./read-standing-requests.mjs").StandingReading,
 * }>}
 */
export async function openPageInOwnContext(page, { path, record, bounds } = /** @type {any} */ ({})) {
  refuseFrameScope(STEP, record, page, "nothing was opened");
  requireRecord(STEP, record);
  const nothing = "nothing was opened";
  if (!isPagePath(path) || /[?#]/.test(path)) {
    throw refuse(STEP, record, "input", `name the page by its path alone, such as /chat — ${nothing}`);
  }
  if (path === SIGN_IN_PAGE_PATH) {
    throw refuse(STEP, record, "input", `the sign-in page is signInThroughPage's, and this step carries a session — ${nothing}`);
  }
  const bound = readBounds(STEP, record, OWN_CONTEXT_BOUNDS, bounds, nothing);

  const notOpened = "no context was opened";
  const from = pathOf(page.url());
  const { links, found } = await visibleLinksTo(page, path, { step: STEP, from, record });
  if (found === 0) {
    const shown = await within(page.locator("a[href]").filter({ visible: true }).count(), bound.readingMs);
    const read = shown === null ? "the visible links on the page could not be counted" : `0 of the ${shown} visible ${shown === 1 ? "link" : "links"} on the page`;
    throw refuse(STEP, record, "no-link", `no visible link on ${from} leads to ${path} (${read}) — ${notOpened}`);
  }
  const origin = originOf(page.url());
  if (origin === null) {
    throw refuse(STEP, record, "input", `the page is on ${from}, which has no origin to open the path on — ${notOpened}`);
  }
  // The address the link leads to, as a person pressing it would follow it: its query string and fragment go with the load.
  const href = await within(links.first().getAttribute("href", { timeout: bound.readingMs }), bound.readingMs);
  /** @type {URL | null} */
  let address = null;
  try {
    address = typeof href === "string" ? new URL(href, origin) : null;
  } catch {
    address = null;
  }
  if (!address || address.origin !== origin || address.pathname !== path) {
    throw refuse(STEP, record, "unreadable", `the link to ${path} on ${from} could not be read within ${bound.readingMs} ms — ${notOpened}`);
  }

  const context = page.context();
  const browser = typeof context.browser === "function" ? context.browser() : null;
  if (!browser) {
    throw refuse(STEP, record, "no-browser", `the context of the page on ${from} has no browser to open a context of its own from — ${notOpened}`);
  }

  const start = performance.now();
  /** @type {import("@playwright/test").BrowserContext} */
  let own;
  try {
    // The session goes from one call straight into the other: it is never written to a file, and never read here.
    own = await browser.newContext({
      storageState: await context.storageState(),
      ...(typeof page.viewportSize === "function" ? { viewport: page.viewportSize() } : {}),
    });
  } catch (error) {
    throw refuse(STEP, record, "driver-failure", `a browser context of its own could not be opened (${errorClass(error)}) — ${notOpened}`);
  }
  // Started before its first page opens: every request of that page is seen, and the page is never unknown.
  await takeStandingReading(own, bound.readingMs);
  /** @type {import("@playwright/test").Page} */
  let further;
  try {
    further = await own.newPage();
  } catch (error) {
    await closeContext(own);
    throw refuse(STEP, record, "driver-failure", `no page could be opened in the browser context of its own (${errorClass(error)}), and its context was closed`);
  }

  const left = () => Math.max(1, bound.landingMs - (performance.now() - start));
  try {
    await further.goto(address.href, { waitUntil: "load", timeout: left() });
  } catch {
    // Where it landed is read below, within what is left of the bound.
  }
  try {
    await further.waitForURL((url) => url.pathname === path || url.pathname === SIGN_IN_PAGE_PATH, { timeout: left(), waitUntil: "load" });
  } catch {
    // Refused below, naming where it was.
  }
  const landed = pathOf(further.url());
  if (landed === SIGN_IN_PAGE_PATH) {
    await closeContext(own);
    throw refuse(
      STEP,
      record,
      "session-lost",
      `the page in a browser context of its own landed on the sign-in page ${SIGN_IN_PAGE_PATH}, not on ${path}: the session of the page on ${from} did not sign it in, and its context was closed`,
    );
  }
  if (landed !== path) {
    await closeContext(own);
    throw refuse(
      STEP,
      record,
      "landed-elsewhere",
      `the page in a browser context of its own did not land on ${path} within ${bound.landingMs} ms (it was on ${landed}), and its context was closed`,
    );
  }
  const elapsedMs = elapsedSince(start);
  const standing = await takeStandingReading(own, bound.readingMs);
  const read = standing.origins.find((candidate) => candidate.origin === origin);
  record(
    `${STEP}: landed on ${path} from ${from} after ${elapsedMs} ms in a page that stands in a browser context of its own (${standingRequests(read ? read.standing : 0)} on its origin there)`,
  );
  return { path, from, elapsedMs, furtherPage: further, standing };
}
