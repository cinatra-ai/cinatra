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
// A PRESS THAT GOES NOWHERE. A link can be a fallback only: its own handler
// cancels the press and opens a dialog in place. A press that navigates shows it
// within moments, however long its landing takes: a navigation request of the
// page, the app's own request for the path when it navigates in place (a
// client-side router requests the page before it moves the address), or another
// path in the address. When none of these comes within the start bound, the step
// refuses at once, naming the link it pressed and the dialog or panel the page
// shows instead, and does not wait out the landing bound.
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
import { READING_BOUND_MS, elapsedSince, errorClass, isPagePath, pathOf, pause, readBounds, refuse, requireRecord, within } from "./step-kit.mjs";

const STEP = "navigateTo";

/** The press: how long the link may take to be ready. */
export const NAVIGATE_ACTION_BOUND_MS = 30_000;
/**
 * From the press to the start of its navigation. Short on purpose: a press that
 * navigates starts its navigation at once, even when the landing takes minutes,
 * so a press that started none within a few seconds (a link whose own handler
 * opens a dialog instead) is refused then, not at the end of the landing bound.
 */
export const NAVIGATE_START_BOUND_MS = 5_000;
/** From the press to the landing. A development boot compiles a route on its first request. */
export const NAVIGATE_LANDING_BOUND_MS = 120_000;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const NAVIGATE_BOUNDS = Object.freeze({
  actionMs: NAVIGATE_ACTION_BOUND_MS,
  startMs: NAVIGATE_START_BOUND_MS,
  landingMs: NAVIGATE_LANDING_BOUND_MS,
});

/** How often the address is read while the step waits for the press's navigation to start. */
const START_POLL_MS = 50;
/** The most characters of a name read from the page that a line carries. */
const NAME_LENGTH = 60;

/** The modifier held while pressing a link to open it in a further page: Meta on macOS, Control elsewhere. */
export const FURTHER_PAGE_MODIFIER = "ControlOrMeta";

/**
 * The selector of the links that lead to `path` in this tab: its `href` is the
 * path, or the path with a query string or a fragment. openAddress reads the
 * page's links with it too.
 * @param {string} path
 */
export function linksTo(path) {
  return [`a[href="${path}"]`, `a[href^="${path}?"]`, `a[href^="${path}#"]`]
    .map((selector) => `${selector}:not([target="_blank"])`)
    .join(", ");
}

/**
 * The visible links on `page` that lead to `path`, and how many there are: the
 * reading of the links that navigateTo presses and openPageInOwnContext
 * follows. A page whose links cannot be read is refused in the name of `step`.
 * @param {import("@playwright/test").Page} page
 * @param {string} path
 * @param {{ step: string, from: string, record: import("./step-kit.mjs").StepRecord }} caller
 */
export async function visibleLinksTo(page, path, { step, from, record }) {
  const links = page.locator(linksTo(path)).filter({ visible: true });
  let found;
  try {
    found = await links.count();
  } catch (error) {
    throw refuse(step, record, "unreadable", `the links on ${from} could not be read (${errorClass(error)})`);
  }
  return { links, found };
}

/**
 * The visible links on `page` that lead to `path`, or a refusal when there are none.
 * @param {import("@playwright/test").Page} page
 * @param {string} path
 * @param {string} from
 * @param {import("./step-kit.mjs").StepRecord} record
 */
async function visibleLinks(page, path, from, record) {
  const { links, found } = await visibleLinksTo(page, path, { step: STEP, from, record });
  if (found === 0) throw refuse(STEP, record, "no-link", `no visible link on ${from} leads to ${path} — no address was typed`);
  return links;
}

/**
 * Whether `request` shows that a press started a navigation of `page`: a
 * navigation request of its main frame, or its main frame's own request for
 * `path` on `origin`, which a client-side router sends before it moves the
 * address in place.
 * @param {import("@playwright/test").Page} page
 * @param {import("@playwright/test").Request} request
 * @param {string | null} origin
 * @param {string} path
 */
export function startsNavigation(page, request, origin, path) {
  try {
    if (request.frame() !== page.mainFrame()) return false;
    if (request.isNavigationRequest()) return true;
    const url = new URL(request.url());
    return url.origin === origin && url.pathname === path;
  } catch {
    // A request of no frame, such as a service worker's, navigates no page.
    return false;
  }
}

/**
 * Whether the press's navigation started within `bound`: `hasStarted()` says
 * so, or the page is on another path than `from`. A new query string or
 * fragment on the same path, as a dialog may write, takes the page nowhere.
 * @param {import("@playwright/test").Page} page
 * @param {string} from
 * @param {() => boolean} hasStarted
 * @param {number} bound
 */
async function startedWithin(page, from, hasStarted, bound) {
  const until = performance.now() + bound;
  for (;;) {
    if (hasStarted() || pathOf(page.url()) !== from) return true;
    const remaining = until - performance.now();
    if (remaining <= 0) return false;
    await pause(Math.min(START_POLL_MS, remaining));
  }
}

// Runs IN THE PAGE: nothing of this module may be used inside it. It answers
// the name of the first shown link that `selector` matches, the names of the
// open dialogs, and the names of the shown panels that link controls; a name is
// "" when the page gives none.
function readInstead({ selector }) {
  const text = (value) => String(value || "").replace(/\s+/g, " ").trim();
  // Shown: attached and drawn. A modal dialog hides the rest of the page from
  // assistive technology only, so `aria-hidden` is not read.
  const shown = (element) => {
    if (!element || !element.isConnected || getComputedStyle(element).visibility === "hidden") return false;
    for (let node = element; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || getComputedStyle(node).display === "none") return false;
    }
    return true;
  };
  const byIds = (element, attribute) =>
    text(element.getAttribute(attribute))
      .split(" ")
      .filter(Boolean)
      .map((id) => document.getElementById(id));
  const labelledBy = (element) => text(byIds(element, "aria-labelledby").map((node) => (node ? node.textContent : "")).join(" "));
  const nameOf = (element) => {
    const heading = element.querySelector("h1, h2, h3, h4, h5, h6, [role='heading']");
    return text(element.getAttribute("aria-label")) || labelledBy(element) || (heading ? text(heading.textContent) : "");
  };
  const link = Array.from(document.querySelectorAll(selector)).find(shown);
  const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [role='alertdialog'], dialog[open]")).filter(shown);
  const panels = link ? byIds(link, "aria-controls").filter((panel) => shown(panel) && !dialogs.includes(panel)) : [];
  return {
    link: link ? text(link.getAttribute("aria-label")) || labelledBy(link) || text(link.textContent) : "",
    dialogs: dialogs.map(nameOf),
    panels: panels.map(nameOf),
  };
}

/**
 * A name read from the page, for a line: without an address, without double
 * quotes, and at most NAME_LENGTH characters.
 * @param {string} name
 */
function lineName(name) {
  const plain = name.replace(/\b[a-z][a-z\d+.-]*:\/\/\S*/gi, "an address").replace(/"/g, "'");
  return plain.length > NAME_LENGTH ? `${plain.slice(0, NAME_LENGTH - 1).trimEnd()}…` : plain;
}

/**
 * What the page shows in place of a landing, for the refusal.
 * @param {{ dialogs: string[], panels: string[] } | null} reading
 */
function describeInstead(reading) {
  if (!reading) return "what it shows instead could not be read";
  const shown = [
    ...reading.dialogs.map((name) => (name ? `a dialog "${lineName(name)}"` : "a dialog without a name")),
    ...reading.panels.map((name) => (name ? `a panel "${lineName(name)}" that the link controls` : "a panel without a name that the link controls")),
  ];
  return shown.length > 0 ? `it shows instead: ${shown.join(" and ")}` : "it shows no dialog and no panel that the link controls";
}

/**
 * Reach `path` from the caller's current page by pressing the first visible link
 * that leads there, and resolve `{ path, from, pressed, elapsedMs }` once the
 * page has landed. Already on `path`, it presses nothing. Refuses, as a
 * StepRefusal, a path it cannot use, a page with no visible link to it, a press
 * that starts no navigation within the start bound, and a press that does not
 * land on it within the landing bound.
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

  // The start of the press's navigation, listened for from before the press, so
  // a request the press sends at once is not missed.
  const origin = originOf(page.url());
  let started = false;
  const onRequest = (/** @type {import("@playwright/test").Request} */ request) => {
    if (!started) started = startsNavigation(page, request, origin, path);
  };
  // The landing bound is the step's whole wait after the press: the start bound never outlasts it.
  const startBound = Math.min(bound.startMs, bound.landingMs);
  const start = performance.now();
  let pressed = start;
  let moved = false;
  page.on("request", onRequest);
  try {
    try {
      // `noWaitAfter`: without it the click itself waits, within the press's bound,
      // for the navigation it started, and a slow landing reads as a failed press.
      // The landing is waited for below, within its own bound.
      await links.first().click({ timeout: bound.actionMs, noWaitAfter: true });
    } catch (error) {
      throw refuse(STEP, record, "driver-failure", `the link to ${path} could not be pressed (${errorClass(error)})`);
    }
    pressed = performance.now();
    moved = await startedWithin(page, from, () => started, startBound);
  } finally {
    page.off("request", onRequest);
  }
  if (!moved) {
    const reading = await within(page.evaluate(readInstead, { selector: linksTo(path) }), READING_BOUND_MS);
    const link = reading?.link ? `the link "${lineName(reading.link)}" to ${path}` : `the link to ${path}`;
    throw refuse(
      STEP,
      record,
      "no-navigation",
      `the press on ${link} started no navigation within ${startBound} ms, and the page stayed on ${from}; ${describeInstead(reading)}`,
    );
  }
  try {
    const left = Math.max(1, bound.landingMs - (performance.now() - pressed));
    await page.waitForURL((url) => url.pathname === path, { timeout: left, waitUntil: "load" });
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
  const previousPages = new Set(context.pages());
  let started = false;
  /** @type {(opened: any) => void} */
  let noteOpened = () => {};
  const opened = new Promise((done) => {
    noteOpened = (further) => {
      started = true;
      done(further);
    };
  });
  const onRequest = (/** @type {import("@playwright/test").Request} */ request) => {
    if (started) return;
    started = startsNavigation(page, request, origin, path);
    if (started) return;
    try {
      const requestedPage = request.frame().page();
      if (!previousPages.has(requestedPage)) started = startsNavigation(requestedPage, request, origin, path);
    } catch {
      // A popup's initial navigation can precede both its frame and its page
      // event. Its matching navigation request still proves the open started.
      if (request.isNavigationRequest()) {
        const requested = new URL(request.url());
        started = requested.origin === origin && requested.pathname === path;
      }
    }
  };
  const start = performance.now();
  /** @type {import("@playwright/test").Page | null} */
  let further = null;
  context.on("page", noteOpened);
  context.on("request", onRequest);
  try {
    try {
      await links.first().click({ timeout: bound.actionMs, noWaitAfter: true, modifiers: [FURTHER_PAGE_MODIFIER] });
    } catch (error) {
      throw refuse(STEP, record, "driver-failure", `the link to ${path} could not be pressed (${errorClass(error)})`);
    }
    const pressed = performance.now();
    const startBound = Math.min(bound.startMs, bound.landingMs);
    if (!(await startedWithin(page, from, () => started, startBound))) {
      const instead = await within(page.evaluate(readInstead, { selector: linksTo(path) }), READING_BOUND_MS);
      const link = instead?.link ? `the link "${lineName(instead.link)}" to ${path}` : `the link to ${path}`;
      throw refuse(
        STEP,
        record,
        "no-further-page",
        `the press on ${link} started no navigation within ${startBound} ms, and opened no further page (this page is on ${pathOf(page.url())}); ${describeInstead(instead)}`,
      );
    }
    const left = Math.max(1, bound.landingMs - (performance.now() - pressed));
    further = await within(opened, left);
  } finally {
    context.off("page", noteOpened);
    context.off("request", onRequest);
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
