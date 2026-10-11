// openPageOfOrigin: an address of ANOTHER origin than the page's loaded, once,
// in a new page, and where it landed, with the status the response gave.
//
// WHY IT EXISTS. openAddress types an address of the page's own origin only,
// and refuses another origin by name. A product that is embedded in another
// site's page, such as the assistant widget a site mounts, is reached on that
// site: a page of another origin, which no link of the product leads to.
//
// WHERE IT OPENS. By default in a NEW browser context of the page's browser
// that starts EMPTY: no cookie and no storage of the page's context cross into
// it, as a person who never signed in to the product meets the site; it has the
// page's viewport. With `sameContext: true`, in a new page of the page's OWN
// context: the person's same browser, so what the product's tab holds, the new
// page holds too.
//
// NEVER AN ADDRESS IN A LINE. Its line says that an address of another origin
// was typed, and names the paths, and, with `params`, the values of the
// parameters the caller names; never the origin, the address or another value.
// The caller closes the page it opened, and the context it opened with it.
import { quotedName } from "./page-controls.mjs";
import { originOf } from "./read-standing-requests.mjs";
import { elapsedSince, errorClass, pathOf, queryOf, readBounds, refuse, refuseFrameScope, requireRecord } from "./step-kit.mjs";

const STEP = "openPageOfOrigin";

/** From the typed address to the landing. A site's page loads its own assets, and the product's frame on it compiles on a first request. */
export const OTHER_ORIGIN_BOUND_MS = 120_000;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const OTHER_ORIGIN_BOUNDS = Object.freeze({ loadMs: OTHER_ORIGIN_BOUND_MS });

/** The name of a query parameter a caller may name, as openAddress takes it. */
const PARAM_NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * Whether `params` names query parameters: a list of distinct names, one at least.
 * @param {unknown} params
 * @returns {params is string[]}
 */
const isParamList = (params) =>
  Array.isArray(params) &&
  params.length > 0 &&
  Array.from(params).every((name) => typeof name === "string" && PARAM_NAME.test(name)) &&
  new Set(params).size === params.length;

/**
 * A query, for a line, as openAddress writes one: each named parameter in the
 * order of `params`, and a count of the others, whose values are never written.
 * @param {{ query: Record<string, string | null>, others: number }} reading
 */
function describeQuery({ query, others }) {
  const named = Object.entries(query)
    .map(([name, value]) => (value === null ? `${name} absent` : value === "" ? `${name}=""` : `${name}=${quotedName(value)}`))
    .join(", ");
  return others > 0 ? `${named}, and ${others} other ${others === 1 ? "parameter" : "parameters"} not written` : named;
}

/**
 * Load `address`, an absolute http or https address of another origin than the
 * caller's page's, once, in a new page: of a new, empty browser context of the
 * page's browser (with the page's viewport), or with `sameContext` of the
 * page's own context. Resolves `{ furtherPage, path, status, from, elapsedMs }`:
 * the page it opened, the path it landed on, the status of the response (null
 * when there was none) and the page's own path; with `params`, `query` and
 * `others` as openAddress answers them. Refuses, as a StepRefusal, before
 * anything opens: `input` (a frame scope, an address that is no absolute http or
 * https address, one with a user or a password, a fragment, a query that names
 * a parameter `params` does not name, a bound it does not know), `same-origin`
 * (the page's own origin: openAddress's act) and `no-browser` (the page's
 * context has no browser to open a context on); after it opened,
 * `driver-failure` and `no-load` (what it opened is closed first).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   address: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   params?: string[],
 *   sameContext?: boolean,
 *   bounds?: Partial<Record<keyof typeof OTHER_ORIGIN_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ furtherPage: import("@playwright/test").Page, path: string, status: number | null, from: string, elapsedMs: number, query?: Record<string, string | null>, others?: number }>}
 */
export async function openPageOfOrigin(page, { address, record, params, sameContext = false, bounds } = /** @type {any} */ ({})) {
  refuseFrameScope(STEP, record, page, "nothing was opened");
  requireRecord(STEP, record);
  const nothing = "nothing was opened";
  const input = (/** @type {string} */ why) => refuse(STEP, record, "input", `${why} — ${nothing}`);
  if (typeof sameContext !== "boolean") throw input("sameContext must be true or false");
  /** @type {URL | null} */
  let url = null;
  try {
    url = typeof address === "string" && /^https?:\/\//i.test(address.trim()) ? new URL(address.trim()) : null;
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) throw input("name the page by an absolute http or https address of another origin");
  if (url.username !== "" || url.password !== "") throw input("the address carries a user or a password, which a line could repeat and a step never types");
  if (url.hash !== "" || address.includes("#")) throw input("name the page without a fragment");
  const withQuery = params !== undefined;
  if (withQuery && !isParamList(params)) throw input("name each query parameter the address may carry, such as tab");
  for (const name of url.searchParams.keys()) {
    if (!withQuery || !params.includes(name)) throw input("the query of the address names a parameter that params does not name");
  }
  const bound = readBounds(STEP, record, OTHER_ORIGIN_BOUNDS, bounds, nothing);
  const from = pathOf(page.url());
  if (url.origin === originOf(page.url())) {
    throw refuse(STEP, record, "same-origin", `the address names the origin of the page on ${from}, and typing it is openAddress's act — ${nothing}`);
  }
  // What a line says of the address asked for: its path, and with `params` the named values of its query.
  const asked = withQuery ? `${pathOf(url.href)} with the query ${describeQuery(queryOf(url.href, params))}` : pathOf(url.href);

  const context = page.context();
  /** @type {import("@playwright/test").BrowserContext | null} */
  let own = null;
  if (!sameContext) {
    const browser = typeof context.browser === "function" ? context.browser() : null;
    if (!browser) {
      throw refuse(STEP, record, "no-browser", `the context of the page on ${from} has no browser to open an empty context on — ${nothing}`);
    }
    try {
      // An empty context: nothing of the page's context is handed to it, only the page's viewport.
      own = await browser.newContext(typeof page.viewportSize === "function" ? { viewport: page.viewportSize() } : {});
    } catch (error) {
      throw refuse(STEP, record, "driver-failure", `a browser context of its own could not be opened (${errorClass(error)}) — ${nothing}`);
    }
  }
  const where = own ? "a page of a browser context of its own" : "a further page of the page's own browser context";
  /** Close what the step opened, whatever it answers. */
  const closeOpened = async (/** @type {import("@playwright/test").Page | null} */ opened) => {
    if (opened) await opened.close().catch(() => {});
    if (own) await own.close().catch(() => {});
  };
  /** @type {import("@playwright/test").Page} */
  let further;
  try {
    further = await (own ?? context).newPage();
  } catch (error) {
    await closeOpened(null);
    throw refuse(STEP, record, "driver-failure", `no page could be opened in ${where} (${errorClass(error)}), and what was opened was closed`);
  }

  const start = performance.now();
  /** @type {import("@playwright/test").Response | null} */
  let response;
  try {
    response = await further.goto(url.href, { waitUntil: "load", timeout: bound.loadMs });
  } catch (error) {
    await closeOpened(further);
    throw refuse(
      STEP,
      record,
      "no-load",
      `the address of ${asked} on another origin was typed into ${where}, and its load did not end within ${bound.loadMs} ms (${errorClass(error)}); what was opened was closed`,
    );
  }
  const elapsedMs = elapsedSince(start);
  const landed = pathOf(further.url());
  const status = response ? response.status() : null;
  const reached = withQuery ? queryOf(further.url(), params) : null;
  record(
    `${STEP}: typed the address of ${asked} on another origin than the page's on ${from} into ${where}; it landed on ${landed}${reached ? ` with the query ${describeQuery(reached)}` : ""} with ${status === null ? "no response" : `status ${status}`} after ${elapsedMs} ms`,
  );
  const answer = { furtherPage: further, path: landed, status, from, elapsedMs };
  return reached ? { ...answer, ...reached } : answer;
}
