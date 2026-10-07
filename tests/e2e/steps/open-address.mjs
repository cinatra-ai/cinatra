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
//
// A QUERY ONLY BY NAME. A page that keeps its views at their own addresses
// (`?tab=locked`) is opened with the query when the caller names the parameters
// the path may carry (`params`): the step then answers, and writes, the values
// of those parameters only, and counts every other one. readAddress reads the
// same of the address the page is on, once it has held still.
import { linksTo } from "./navigate-to.mjs";
import { quotedName } from "./page-controls.mjs";
import { originOf } from "./read-standing-requests.mjs";
import {
  READING_BOUND_MS,
  elapsedSince,
  errorClass,
  isPagePath,
  pathOf,
  pause,
  queryOf,
  readBounds,
  refuse,
  refuseFrameScope,
  requireMs,
  requireRecord,
  within,
} from "./step-kit.mjs";

const STEP = "openAddress";

/** From the typed address to the landing. A development server compiles a page on its first request. */
export const OPEN_ADDRESS_BOUND_MS = 120_000;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const OPEN_ADDRESS_BOUNDS = Object.freeze({ loadMs: OPEN_ADDRESS_BOUND_MS, readingMs: READING_BOUND_MS });

/** An address that names an origin of its own: one with a scheme, or one that starts with two slashes. */
const NAMES_AN_ORIGIN = /^(?:[a-z][a-z\d+.-]*:|[/\\]{2})/i;

/** The name of a query parameter a caller may name. */
const PARAM_NAME = /^[A-Za-z0-9_.-]+$/;

/** What a refusal of `params` asks for. */
const NAME_THE_PARAMS = "name each query parameter the path may carry, such as tab";

/**
 * Whether `params` names query parameters: a list of distinct names, one at least,
 * every place of the list holding a name (a list with a hole names none there).
 * @param {unknown} params
 * @returns {params is string[]}
 */
const isParamList = (params) =>
  Array.isArray(params) &&
  params.length > 0 &&
  Array.from(params).every((name) => typeof name === "string" && PARAM_NAME.test(name)) &&
  new Set(params).size === params.length;

/**
 * A value of a named parameter, for a line: quoted and cut as a name is; an
 * empty one quoted as it is, and one the address does not carry said to be absent.
 * @param {string} name
 * @param {string | null} value
 */
const describeValue = (name, value) => (value === null ? `${name} absent` : value === "" ? `${name}=""` : `${name}=${quotedName(value)}`);

/**
 * A query, for a line: each named parameter in the order of `params`, and a
 * count of the others, whose values are never written.
 * @param {{ query: Record<string, string | null>, others: number }} reading
 */
function describeQuery({ query, others }) {
  const named = Object.entries(query)
    .map(([name, value]) => describeValue(name, value))
    .join(", ");
  return others > 0 ? `${named}, and ${others} other ${others === 1 ? "parameter" : "parameters"} not written` : named;
}

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
 * With `params`, the names of the query parameters the path may carry, the path
 * may carry a query of those names, and the step resolves `query` (each named
 * parameter's value where it landed, or null) and `others` (the count of the
 * parameters of any other name) as well. It then refuses as `input`, before
 * anything is loaded, `params` that is no list of distinct names, a path with a
 * fragment, and a query that names a parameter `params` does not name; a line
 * writes the values of the named parameters only.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   path: string,
 *   params?: string[],
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof OPEN_ADDRESS_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ path: string, status: number | null, from: string, elapsedMs: number, query?: Record<string, string | null>, others?: number }>}
 */
export async function openAddress(page, { path, params, record, bounds } = /** @type {any} */ ({})) {
  refuseFrameScope(STEP, record, page, "no address was typed");
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
  // With `params`, the path may carry a query of the parameters it names, and no other.
  const withQuery = params !== undefined;
  if (withQuery) {
    if (!isParamList(params)) throw refuse(STEP, record, "input", `${NAME_THE_PARAMS} — ${nothing}`);
    if (!isPagePath(path) || path.includes("#")) throw refuse(STEP, record, "input", `name the page by its path and its query, without a fragment — ${nothing}`);
    const at = path.indexOf("?");
    for (const name of new URLSearchParams(at < 0 ? "" : path.slice(at + 1)).keys()) {
      if (!params.includes(name)) throw refuse(STEP, record, "input", `the query of the path names a parameter that params does not name — ${nothing}`);
    }
  } else if (!isPagePath(path) || /[?#]/.test(path)) throw refuse(STEP, record, "input", `name the page by its path alone, such as /chat — ${nothing}`);
  const bound = readBounds(STEP, record, OPEN_ADDRESS_BOUNDS, bounds, nothing);
  if (origin === null) throw refuse(STEP, record, "input", `the page is on ${from}, which has no origin to load the path on — ${nothing}`);
  // What a line says of the path asked for: the path, and with `params` its path and the named values of its query.
  const asked = withQuery ? `${pathOf(`${origin}${path}`)} with the query ${describeQuery(queryOf(`${origin}${path}`, params))}` : path;

  // A link a person could press: navigateTo's reading of the page's links.
  const links = await within(page.locator(linksTo(path)).filter({ visible: true }).count(), bound.readingMs);
  if (links === null) throw refuse(STEP, record, "unreadable", `the links on ${from} could not be read within ${bound.readingMs} ms — ${nothing}`);
  if (links > 0) throw refuse(STEP, record, "has-link", `a visible link on ${from} leads to ${asked}, and pressing it is navigateTo's act — ${nothing}`);

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
      `the address of ${asked} was typed, and its load did not end within ${bound.loadMs} ms (${errorClass(error)}; the page is on ${pathOf(page.url())})`,
    );
  }
  const elapsedMs = elapsedSince(start);
  const landed = pathOf(page.url());
  const status = response ? response.status() : null;
  const reached = withQuery ? queryOf(page.url(), params) : null;
  record(
    `${STEP}: typed the address of ${asked} into the page on ${from}, where no visible link leads to it; it landed on ${landed}${reached ? ` with the query ${describeQuery(reached)}` : ""} with ${status === null ? "no response" : `status ${status}`} after ${elapsedMs} ms`,
  );
  return reached ? { path: landed, status, from, elapsedMs, ...reached } : { path: landed, status, from, elapsedMs };
}

const READ_STEP = "readAddress";

/** How long the address must hold still before it is read. */
export const ADDRESS_SETTLE_MS = 1_000;
/** How often the address is read while it settles. */
export const ADDRESS_POLL_MS = 100;
/** How long the step gives the address to hold still at all. */
export const ADDRESS_BOUND_MS = 15_000;

/** The options readAddress takes. */
const ADDRESS_OPTIONS = Object.freeze(["params", "record", "settleMs", "pollMs", "bound"]);

/**
 * Read the address of the caller's page once its path and the values of the
 * query parameters `params` names have held still for `settleMs`, write them on
 * one line, and resolve `{ path, query, others }`: `path` the page's path,
 * `query` each named parameter's value (null when the address does not carry
 * it), and `others` the count of the parameters of any other name, whose values
 * are never read into a line. The address is read on the driver's side, as the
 * page's address is, so a change in place (a state pushed into the history) is
 * read as a load is. Refuses, as a StepRefusal, arguments it cannot use
 * (`input`) and an address that does not hold still within `bound`
 * (`unsteady`, naming the last two readings).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   params: string[],
 *   record: import("./step-kit.mjs").StepRecord,
 *   settleMs?: number,
 *   pollMs?: number,
 *   bound?: number,
 * }} options
 * @returns {Promise<{ path: string, query: Record<string, string | null>, others: number }>}
 */
export async function readAddress(page, options = /** @type {any} */ ({})) {
  const given = options && typeof options === "object" ? options : {};
  const { params, record, settleMs = ADDRESS_SETTLE_MS, pollMs = ADDRESS_POLL_MS, bound = ADDRESS_BOUND_MS } = /** @type {any} */ (given);
  refuseFrameScope(READ_STEP, record, page, "nothing was read");
  requireRecord(READ_STEP, record);
  const nothing = "nothing was read";
  for (const name of Object.keys(given)) {
    if (!ADDRESS_OPTIONS.includes(name)) {
      throw refuse(READ_STEP, record, "input", `there is no option named ${name}; the options are params, settleMs, pollMs and bound — ${nothing}`);
    }
  }
  if (!isParamList(params)) throw refuse(READ_STEP, record, "input", `${NAME_THE_PARAMS} — ${nothing}`);
  requireMs(READ_STEP, record, "settleMs", settleMs, nothing);
  requireMs(READ_STEP, record, "pollMs", pollMs, nothing);
  requireMs(READ_STEP, record, "bound", bound, nothing);

  /** One reading of the address: its path, the named values and the count of the others. */
  const read = () => {
    const url = page.url();
    const reading = { path: pathOf(url), ...queryOf(url, params) };
    return { ...reading, key: JSON.stringify([reading.path, reading.query]) };
  };
  /** A reading for a line: the path and the named values only. */
  const describeReading = (reading) => `${reading.path} with the query ${describeQuery({ query: reading.query, others: 0 })}`;

  // The address holds still when two readings at least `settleMs` apart agree
  // and every reading between them agreed too. The decision is only ever taken
  // on a fresh reading.
  const start = performance.now();
  /** @type {ReturnType<typeof read> | undefined} the reading before the last change, once there was one */
  let before;
  let value = read();
  let since = performance.now();
  for (;;) {
    await pause(pollMs);
    const next = read();
    const now = performance.now();
    if (next.key !== value.key) {
      before = value;
      value = next;
      since = now;
    } else if (now - since >= settleMs) {
      record(`${READ_STEP}: the page is on ${next.path} with the query ${describeQuery(next)}`);
      return { path: next.path, query: next.query, others: next.others };
    }
    if (now - start >= bound) {
      const lastTwo = before === undefined ? `it read only ${describeReading(value)}` : `the last two readings: ${describeReading(before)}, then ${describeReading(value)}`;
      throw refuse(READ_STEP, record, "unsteady", `the address of the page on ${value.path} did not hold still for ${settleMs} ms within ${bound} ms (${lastTwo})`);
    }
  }
}
