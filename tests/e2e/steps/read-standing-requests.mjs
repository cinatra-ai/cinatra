// readStandingRequests: the requests that stand open on each origin, and the
// pages that hold them.
//
// WHY IT EXISTS. A browser opens at most six connections to one origin over
// plain HTTP, and a request whose response has not ended keeps its connection:
// a stream a page listens to stands open as long as the page. With several pages
// of one session open, their streams can take every connection of the origin;
// the next press then waits in the browser and never reaches the server, and a
// further page never loads. This step reads, per origin, how many requests stand
// open and which pages hold them, so a run closes a page it no longer needs
// before it opens another one.
//
// TWO READINGS, and the result says which number comes from which:
//   - `events`: the requests the browser context's own request events showed
//     without an end (neither `requestfinished` nor `requestfailed`) since the
//     step was first called on the context. A page that closes takes its
//     requests with it, and reports nothing.
//   - `timing`: the entries of each page's resource timing without a response
//     end. A browser lists a subresource there only once its response has ended,
//     so this reading sees a document whose own response is still streaming; it
//     also gives each origin's protocol (the next-hop protocol).
// A request both readings show is counted once.
//
// UNKNOWN, NEVER ZERO. A page that cannot be read within the reading bound, and
// a page whose document was already open when the step was first called on the
// context (what it sent before was never seen), is named as unknown with its
// reason. It is never counted as holding nothing.
//
// THE BOUND. Six connections less two kept free, so that a page load and a
// press stay possible: four standing requests. An origin served over HTTP/2 or
// HTTP/3 is not counted against it, because one connection carries all of its
// requests. The protocol is read from the resource timing; an origin whose
// protocol the browser does not give counts as plain HTTP.
import { READING_BOUND_MS, pathOf, readBounds, refuse, refuseFrameScope, requireRecord, within } from "./step-kit.mjs";

const STEP = "readStandingRequests";

/** How many connections a browser opens to one origin over plain HTTP (HTTP/1.1). */
export const ORIGIN_CONNECTIONS = 6;
/** The connections kept free on an origin: one for a page load, one for a press. */
export const CONNECTIONS_KEPT_FREE = 2;
/** At or above this many standing requests on an origin, no further page is opened on it. */
export const STANDING_REQUEST_BOUND = ORIGIN_CONNECTIONS - CONNECTIONS_KEPT_FREE;
/** The next-hop protocols that carry every request of an origin over one connection. */
export const MULTIPLEXED_PROTOCOLS = Object.freeze(["h2", "h3"]);

/** Every bound of the step, by the name `bounds` overrides it with. */
export const STANDING_BOUNDS = Object.freeze({
  readingMs: READING_BOUND_MS,
});

/** Why a page is unknown when its document was open before the first reading. */
const OPEN_BEFORE = "open before the first reading, so its earlier requests were not seen";

/**
 * @typedef {{ place: number | null, path: string | null, standing: number, events: number, timing: number }} StandingHolder
 *   A page that holds standing requests on one origin: its place among the
 *   context's open pages (1 for the first) and its path, or null for both when
 *   the request belongs to no page; its count, and each reading's count.
 */

/**
 * @typedef {{
 *   origin: string,
 *   protocols: string[],
 *   counted: boolean,
 *   standing: number,
 *   events: number,
 *   timing: number,
 *   holders: StandingHolder[],
 * }} StandingOrigin
 *   One origin. `events` comes from the context's request events, `timing` and
 *   `protocols` from the pages' resource timing; `standing` is `events` plus the
 *   timing entries the events did not show. `counted` is false only when every
 *   protocol the browser gave for the origin is HTTP/2 or HTTP/3.
 */

/**
 * @typedef {{ place: number, path: string, reason: string }} UnknownPage
 *   A page whose standing requests could not all be read, and why.
 */

/** @typedef {{ origins: StandingOrigin[], unknown: UnknownPage[] }} StandingReading */

/**
 * What the step has seen of each context: the requests without an end, and the
 * pages that were open before its first reading, with the document each showed.
 * @type {WeakMap<object, { open: Set<any>, before: Map<any, number | null | undefined> }>}
 */
const watchers = new WeakMap();

/** @param {any} context */
function watch(context) {
  const known = watchers.get(context);
  if (known) return known;
  const open = new Set();
  context.on("request", (/** @type {any} */ request) => open.add(request));
  context.on("requestfinished", (/** @type {any} */ request) => open.delete(request));
  context.on("requestfailed", (/** @type {any} */ request) => open.delete(request));
  // What these pages sent before this moment was never seen. Each page's
  // document is noted at the first reading; a page showing another document
  // since then has sent nothing unseen.
  const watcher = { open, before: new Map(context.pages().map((/** @type {any} */ page) => [page, undefined])) };
  watchers.set(context, watcher);
  return watcher;
}

// Runs IN THE PAGE: nothing of this module may be used inside it.
function readResourceTiming() {
  const origins = {};
  const entries = /** @type {PerformanceResourceTiming[]} */ (performance.getEntriesByType("navigation").concat(performance.getEntriesByType("resource")));
  for (const entry of entries) {
    let origin;
    try {
      origin = new URL(entry.name).origin;
    } catch {
      continue;
    }
    if (origin === "null") continue;
    const slot = origins[origin] || (origins[origin] = { protocols: [], open: [] });
    if (entry.nextHopProtocol && !slot.protocols.includes(entry.nextHopProtocol)) slot.protocols.push(entry.nextHopProtocol);
    if (!(entry.responseEnd > 0)) slot.open.push(entry.name);
  }
  return { timeOrigin: performance.timeOrigin, origins };
}

/**
 * The origin of a web address, or null for anything else (about:blank, an error page).
 * @param {string} url
 */
export function originOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Why a page is unknown, or null when both readings cover it.
 * @param {{ before: Map<any, number | null | undefined> }} watcher
 * @param {any} page
 * @param {{ timeOrigin: number } | null} timing
 * @param {number} readingMs
 */
function unknownReason(watcher, page, timing, readingMs) {
  if (watcher.before.has(page)) {
    const noted = watcher.before.get(page);
    if (noted === undefined) watcher.before.set(page, timing ? timing.timeOrigin : null);
    else if (noted !== null && timing && timing.timeOrigin !== noted) watcher.before.delete(page);
  }
  if (!timing) return `could not be read within ${readingMs} ms`;
  return watcher.before.has(page) ? OPEN_BEFORE : null;
}

/**
 * The requests that stand open on each origin, from both readings, and the
 * pages that could not be read. Writes nothing; the steps that call it do.
 * @param {any} context
 * @param {number} readingMs
 * @returns {Promise<StandingReading>}
 */
export async function takeStandingReading(context, readingMs) {
  const watcher = watch(context);
  /** @type {any[]} */
  const pages = context.pages();
  const timings = await Promise.all(pages.map((page) => within(page.evaluate(readResourceTiming), readingMs)));

  /** @type {Map<string, { protocols: Set<string>, own: boolean, holders: Map<any, { place: number | null, path: string | null, events: string[], timing: string[] }> }>} */
  const origins = new Map();
  const slotOf = (/** @type {string} */ origin) => {
    let slot = origins.get(origin);
    if (!slot) origins.set(origin, (slot = { protocols: new Set(), own: false, holders: new Map() }));
    return slot;
  };
  const holderOf = (/** @type {string} */ origin, /** @type {any} */ page) => {
    const { holders } = slotOf(origin);
    let holder = holders.get(page);
    if (!holder) {
      const at = pages.indexOf(page);
      const path = page ? pathOf(page.url()) : null;
      holders.set(page, (holder = { place: at >= 0 ? at + 1 : null, path, events: [], timing: [] }));
    }
    return holder;
  };

  /** @type {UnknownPage[]} */
  const unknown = [];
  pages.forEach((page, index) => {
    const timing = timings[index];
    const reason = unknownReason(watcher, page, timing, readingMs);
    if (reason) unknown.push({ place: index + 1, path: pathOf(page.url()), reason });
    const own = originOf(page.url());
    if (own) slotOf(own).own = true;
    if (!timing) return;
    for (const [origin, { protocols, open }] of Object.entries(timing.origins)) {
      for (const protocol of protocols) slotOf(origin).protocols.add(protocol);
      if (open.length > 0) holderOf(origin, page).timing.push(...open);
    }
  });
  for (const page of [...watcher.before.keys()]) if (!pages.includes(page)) watcher.before.delete(page);

  for (const request of [...watcher.open]) {
    /** @type {any} */
    let page = null;
    try {
      page = request.frame().page();
    } catch {
      // A request of no page, such as a service worker's: it still holds a connection.
    }
    if (page && page.isClosed()) {
      watcher.open.delete(request);
      continue;
    }
    const origin = originOf(request.url());
    if (origin) holderOf(origin, page).events.push(request.url());
  }

  /** @type {StandingOrigin[]} */
  const read = [];
  for (const [origin, slot] of origins) {
    const holders = [...slot.holders.values()]
      .map(({ place, path, events, timing }) => {
        // A timing entry the events also showed is the same request: counted once.
        const shown = [...events];
        const unseen = timing.filter((url) => {
          const at = shown.indexOf(url);
          if (at < 0) return true;
          shown.splice(at, 1);
          return false;
        });
        return { place, path, standing: events.length + unseen.length, events: events.length, timing: timing.length };
      })
      .filter((holder) => holder.standing > 0)
      .sort((a, b) => (a.place ?? Number.MAX_SAFE_INTEGER) - (b.place ?? Number.MAX_SAFE_INTEGER));
    const standing = holders.reduce((sum, holder) => sum + holder.standing, 0);
    if (standing === 0 && !slot.own) continue;
    const protocols = [...slot.protocols];
    read.push({
      origin,
      protocols,
      counted: !(protocols.length > 0 && protocols.every((protocol) => MULTIPLEXED_PROTOCOLS.includes(protocol))),
      standing,
      events: holders.reduce((sum, holder) => sum + holder.events, 0),
      timing: holders.reduce((sum, holder) => sum + holder.timing, 0),
      holders,
    });
  }
  return { origins: read, unknown };
}

/** @param {number} count */
export const standingRequests = (count) => `${count} standing ${count === 1 ? "request" : "requests"}`;

/**
 * The pages that hold an origin's standing requests, for a line.
 * @param {StandingOrigin} origin
 */
export function describeHolders(origin) {
  const named = origin.holders.map((holder) => {
    const who = holder.place !== null ? `page ${holder.place} on ${holder.path}` : holder.path ? `a page on ${holder.path}` : "no page";
    return `${who} (${holder.standing})`;
  });
  return `held by ${named.length > 0 ? named.join(", ") : "no page"}`;
}

/** @param {UnknownPage[]} unknown */
export const describeUnknown = (unknown) => unknown.map((page) => `page ${page.place} on ${page.path} (${page.reason})`).join(", ");

/**
 * Read, per origin, the requests of the context's open pages that have no
 * response end yet and the pages that hold them; write the reading on one line
 * and resolve it as `{ origins, unknown }` (see StandingReading). The first call
 * on a context starts watching its request events: call it when the context is
 * created, before its pages load, so that every request is seen. Refuses, as a
 * StepRefusal, arguments it cannot use.
 *
 * @param {import("@playwright/test").BrowserContext} context
 * @param {{
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof STANDING_BOUNDS, number>>,
 * }} options
 * @returns {Promise<StandingReading>}
 */
export async function readStandingRequests(context, { record, bounds } = /** @type {any} */ ({})) {
  refuseFrameScope(STEP, record, context, "nothing was read");
  requireRecord(STEP, record);
  const nothing = "nothing was read";
  const given = /** @type {any} */ (context);
  if (!given || typeof given.pages !== "function" || typeof given.on !== "function") {
    throw refuse(STEP, record, "input", `hand the step the browser context whose pages it reads — ${nothing}`);
  }
  const bound = readBounds(STEP, record, STANDING_BOUNDS, bounds, nothing);
  const reading = await takeStandingReading(given, bound.readingMs);
  const origins = reading.origins.map((origin, index) => {
    const protocol = `${origin.protocols.join(" and ") || "protocol not given"}, ${origin.counted ? "counted" : "not counted"}`;
    const held = origin.standing > 0 ? `, ${describeHolders(origin)}` : "";
    return `${standingRequests(origin.standing)} on origin ${index + 1} (${protocol}; events ${origin.events}, timing ${origin.timing})${held}`;
  });
  const unknown = reading.unknown.length > 0 ? `unknown: ${describeUnknown(reading.unknown)}` : "no page is unknown";
  record(`${STEP}: ${origins.length > 0 ? origins.join("; ") : "no origin to read"}; ${unknown}`);
  return reading;
}
