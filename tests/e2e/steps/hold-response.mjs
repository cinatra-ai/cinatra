// holdResponse and releaseResponse: the requests of a page that a pattern
// matches, held unsent from the arming until the caller releases them, so the
// state their answers would end stays on the page for as long as the caller
// needs it: a frame of a short-lived state, taken without a race.
//
// WHY THEY EXIST. A state that lasts less than a wait and a shutter, such as
// the moment between a decision and the page's refresh, could only be raced.
// By the time the wait had met and the shutter fired, the refresh had landed
// and the frame showed the next state. A state that a request's answer ends
// lasts as long as that request is unanswered, so holding the request holds the
// state, and nothing on the page is touched.
//
// EVERY MATCHING REQUEST, NOT THE FIRST ONE ALONE. A page can ask for the same
// answer twice: a refresh right after a decision, and a watcher's refresh a few
// seconds later. Holding the first alone would let the second end the state,
// and the race would be back. So every request the pattern matches between the
// arming and the release waits.
//
// THE HOLD. holdResponse routes the page's requests through one handler
// (Playwright's `page.route`) that catches each request whose address the
// pattern matches and whose method is the one named (any method when none is
// named). A caught request waits in the handler, UNSENT, until releaseResponse
// is called or the hold bound runs out. Then every caught request goes on
// unchanged, in the order it was caught (`route.fallback()` with no
// overrides: the page's other routes see it, then the network), and its answer
// reaches the page as the app sends it. The step never reads, builds or
// changes a response. Every other request goes on at once. Once the held
// requests have gone on, the handler is removed, and a later request goes on
// unheld.
//
// THE BOUNDS. A pattern that matches no request within the match bound is
// refused (`no-match`) when the bound runs out, and the handler is removed;
// releaseResponse then refuses the same. No request is held past the hold
// bound, counted from the first catch: the step lets the held requests go on
// by itself and writes that it did, and releaseResponse answers
// `released: "bound"`.
//
// The hold belongs to the page object, as the page tape does: one hold at a
// time on a page, and it ends with the page. The module keeps no state of its
// own.
import { elapsedSince, errorClass, pathOf, readBounds, refuse, refuseFrameScope, requireRecord } from "./step-kit.mjs";

const HOLD = "holdResponse";
const RELEASE = "releaseResponse";

/** From the arming to the first request the pattern matches: the act that sends it follows the arming at once. */
export const HOLD_MATCH_BOUND_MS = 30_000;

/** The longest a request is held, from the first catch: room for a gate, the readings and a frame, and never an endless wait. */
export const HOLD_BOUND_MS = 120_000;

/** Every bound of the hold, by the name `bounds` overrides it with. */
export const HOLD_BOUNDS = Object.freeze({ matchMs: HOLD_MATCH_BOUND_MS, holdMs: HOLD_BOUND_MS });

/** The methods a hold may name. */
export const HOLD_METHODS = Object.freeze(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Where a page keeps its hold: on the page object itself, so that the hold ends with the page. */
const HELD = Symbol("held response");

/**
 * @typedef {{
 *   state: "armed" | "held" | "released" | "unmatched" | "closed",
 *   on: string,
 *   method: string | null,
 *   matchMs: number,
 *   holdMs: number,
 *   armedAt: number,
 *   caught: { method: string, path: string, afterMs: number }[],
 *   gone: Promise<void>[],
 *   heldMs: number,
 *   going: "call" | "bound" | "closed" | null,
 *   releasedBy: "call" | "bound" | "closed" | null,
 *   failure: string | null,
 *   go: (by: "call" | "bound" | "closed") => void,
 *   ended: Promise<void>,
 *   stop: () => Promise<void>,
 *   timers: Set<ReturnType<typeof setTimeout>>,
 * }} Hold
 */

/** The words for what a hold waits for: its method, or any. @param {string | null} method */
const wanted = (method) => (method === null ? "request of any method" : `${method} request`);

/** "1 held request" or "2 held requests". @param {number} n */
const heldCount = (n) => `${n} held request${n === 1 ? "" : "s"}`;

/**
 * Whether `pattern` is a regular expression, from any realm.
 * @param {unknown} pattern
 * @returns {pattern is RegExp}
 */
const isPattern = (pattern) => Object.prototype.toString.call(pattern) === "[object RegExp]";

/**
 * Arm a hold on the page: every request whose address `urlPattern` matches
 * (and whose method is `method`, when one is named) from now on is held unsent
 * until releaseResponse is called or the hold bound runs out, and then goes on
 * unchanged. Writes one line when it is armed, one for each request it catches,
 * and one when the hold bound lets the held requests go or when the match
 * bound runs out with nothing caught (that one as the refusal `no-match`).
 * Resolves `{ path, method, matchMs, holdMs }` as soon as the hold is armed,
 * before any request is caught. Refuses, as a StepRefusal and before anything
 * is armed, arguments it cannot use (`input`), a closed page (`closed`), a page
 * that holds a hold already (`held`) and a page whose requests could not be
 * routed (`driver-failure`).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   urlPattern: RegExp,
 *   method?: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof HOLD_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ path: string, method: string | null, matchMs: number, holdMs: number }>}
 */
export async function holdResponse(page, { urlPattern, method, record, bounds } = /** @type {any} */ ({})) {
  const nothing = "nothing was held";
  refuseFrameScope(HOLD, record, page, nothing);
  requireRecord(HOLD, record);
  const bound = readBounds(HOLD, record, HOLD_BOUNDS, bounds, nothing);
  if (!isPattern(urlPattern)) {
    throw refuse(HOLD, record, "input", `urlPattern must be a regular expression that a request's address is tested with — ${nothing}`);
  }
  if (urlPattern.global || urlPattern.sticky) {
    throw refuse(HOLD, record, "input", `urlPattern carries the g or the y flag, which makes each test depend on the one before — ${nothing}`);
  }
  if (method !== undefined && (typeof method !== "string" || !HOLD_METHODS.includes(method))) {
    throw refuse(HOLD, record, "input", `method must be one of ${HOLD_METHODS.join(", ")} — ${nothing}`);
  }
  const named = method === undefined ? null : method;
  const on = pathOf(page.url());
  if (page.isClosed()) throw refuse(HOLD, record, "closed", `the page on ${on} is closed — ${nothing}`);
  /** @type {Hold | undefined} */
  const earlier = /** @type {any} */ (page)[HELD];
  if (earlier && (earlier.state === "armed" || earlier.state === "held")) {
    throw refuse(HOLD, record, "held", `a hold is armed on the page on ${on} already — release it with releaseResponse first; ${nothing}`);
  }

  /** @type {(by: "call" | "bound" | "closed") => void} */
  let go = () => {};
  /** @type {Promise<"call" | "bound" | "closed">} */
  const released = new Promise((done) => {
    go = done;
  });
  /** @type {() => void} */
  let end = () => {};
  /** @type {Hold} */
  const hold = {
    state: "armed",
    on,
    method: named,
    matchMs: bound.matchMs,
    holdMs: bound.holdMs,
    armedAt: performance.now(),
    caught: [],
    gone: [],
    heldMs: 0,
    going: null,
    releasedBy: null,
    failure: null,
    // The first word wins: a release, the hold bound, or the page's close.
    go: (by) => {
      if (hold.going !== null) return;
      hold.going = by;
      go(by);
    },
    ended: new Promise((done) => {
      end = done;
    }),
    stop: async () => {},
    timers: new Set(),
  };
  /** @param {() => void} run @param {number} ms */
  const later = (run, ms) => {
    const timer = setTimeout(() => {
      hold.timers.delete(timer);
      run();
    }, ms);
    hold.timers.add(timer);
  };
  const clearTimers = () => {
    for (const timer of hold.timers) clearTimeout(timer);
    hold.timers.clear();
  };
  // The address alone decides the match; `lastIndex` is never read, as neither flag that uses it is taken.
  const matches = (/** @type {URL | string} */ url) => urlPattern.test(typeof url === "string" ? url : url.href);
  /** The held requests have gone on (or their page closed): the hold ends, and its route is removed. */
  const finish = async (/** @type {"call" | "bound" | "closed"} */ by, /** @type {number} */ firstAt) => {
    hold.heldMs = elapsedSince(firstAt);
    hold.releasedBy = by;
    const first = hold.caught[0];
    if (by === "bound") {
      record(
        `${HOLD}: the hold bound of ${hold.holdMs} ms ran out, so ${heldCount(hold.caught.length)} went on unchanged after ${hold.heldMs} ms held, the first ${first.method} ${first.path}`,
      );
    }
    await Promise.all(hold.gone);
    hold.state = by === "closed" ? "closed" : "released";
    await hold.stop();
    end();
  };
  /**
   * @param {import("@playwright/test").Route} route
   * @param {import("@playwright/test").Request} request
   */
  const handler = async (route, request) => {
    if ((hold.state !== "armed" && hold.state !== "held") || hold.going !== null || (named !== null && request.method() !== named)) {
      // Every request the hold does not want, or that comes once the hold is letting go, goes on at once, unchanged.
      await route.fallback().catch(() => {});
      return;
    }
    const first = hold.state === "armed";
    hold.state = "held";
    const caughtAt = performance.now();
    const caught = { method: request.method(), path: pathOf(request.url()), afterMs: Math.round(caughtAt - hold.armedAt) };
    hold.caught.push(caught);
    record(
      `${HOLD}: holding ${caught.method} ${caught.path} (held request ${hold.caught.length}), caught ${caught.afterMs} ms after the arming; it is not sent until the release`,
    );
    /** @type {() => void} */
    let wentOn = () => {};
    hold.gone.push(
      new Promise((done) => {
        wentOn = done;
      }),
    );
    if (first) {
      clearTimers();
      later(() => hold.go("bound"), hold.holdMs);
      released.then((by) => finish(by, caughtAt));
    }
    const by = await released;
    if (by !== "closed") {
      try {
        await route.fallback();
      } catch (error) {
        hold.failure = hold.failure ?? errorClass(error);
      }
    }
    wentOn();
  };
  const onClose = () => {
    clearTimers();
    if (hold.state === "held") hold.go("closed");
    else if (hold.state === "armed") {
      hold.state = "closed";
      end();
    }
  };
  hold.stop = async () => {
    clearTimers();
    page.off("close", onClose);
    await Promise.resolve()
      .then(() => page.unroute(matches, handler))
      .catch(() => {});
  };
  // The page owns the hold from here on, so a second arming that starts
  // while the route is being installed is refused as the one-hold rule says.
  /** @type {any} */ (page)[HELD] = hold;
  try {
    await page.route(matches, handler);
  } catch (error) {
    /** @type {any} */ (page)[HELD] = earlier;
    throw refuse(HOLD, record, "driver-failure", `the page on ${on} could not route its requests (${errorClass(error)}) — ${nothing}`);
  }
  page.on("close", onClose);
  if (page.isClosed()) {
    // The page closed while the route was being installed.
    hold.state = "closed";
    end();
    await hold.stop();
    throw refuse(HOLD, record, "closed", `the page on ${on} closed while it was being armed — ${nothing}`);
  }
  later(() => {
    if (hold.state !== "armed") return;
    hold.state = "unmatched";
    refuse(HOLD, record, "no-match", `no ${wanted(named)} whose address the pattern matches was made within ${hold.matchMs} ms of the arming on ${on} — ${nothing}`);
    hold.stop().then(end, end);
  }, Math.max(0, hold.matchMs - (performance.now() - hold.armedAt)));
  record(
    `${HOLD}: armed on ${on}: every ${wanted(named)} whose address the pattern matches is held unsent until the release (match bound ${hold.matchMs} ms, hold bound ${hold.holdMs} ms)`,
  );
  return { path: on, method: named, matchMs: hold.matchMs, holdMs: hold.holdMs };
}

/**
 * Release the page's hold: every held request goes on unchanged, in the order
 * it was caught, and the step resolves `{ method, path, caughtAfterMs, heldMs,
 * held, released }` once they have, where `method`, `path` and `caughtAfterMs`
 * name the first held request, `heldMs` is how long it was held, `held` counts
 * the held requests, and `released` is `"call"`, or `"bound"` when the hold
 * bound had let them go before this call. Writes one line. It never waits for
 * an answer: the caller waits for the page's next state with its own wait.
 * Refuses, as a StepRefusal, arguments it cannot use (`input`), a page that
 * holds no hold (`no-hold`), a hold that caught no request, within its match
 * bound or before this call (`no-match`; the hold is removed and the page goes
 * on unheld), a closed page (`closed`) and a held request that could not go on
 * (`driver-failure`). The hold ends with this call whatever it answers.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{ record: import("./step-kit.mjs").StepRecord }} options
 * @returns {Promise<{ method: string, path: string, caughtAfterMs: number, heldMs: number, held: number, released: "call" | "bound" }>}
 */
export async function releaseResponse(page, { record } = /** @type {any} */ ({})) {
  const nothing = "nothing was released";
  refuseFrameScope(RELEASE, record, page, nothing);
  requireRecord(RELEASE, record);
  const on = pathOf(page.url());
  /** @type {Hold | undefined} */
  const hold = /** @type {any} */ (page)[HELD];
  if (!hold) throw refuse(RELEASE, record, "no-hold", `no hold is armed on the page on ${on} — arm one with holdResponse first; ${nothing}`);
  delete (/** @type {any} */ (page)[HELD]);
  if (hold.state === "armed") {
    hold.state = "unmatched";
    await hold.stop();
    const afterMs = elapsedSince(hold.armedAt);
    throw refuse(RELEASE, record, "no-match", `the hold armed on ${hold.on} had caught no ${wanted(hold.method)} ${afterMs} ms after the arming — nothing was held, and the hold is removed`);
  }
  if (hold.state === "unmatched") {
    throw refuse(RELEASE, record, "no-match", `the hold armed on ${hold.on} caught no ${wanted(hold.method)} within its match bound of ${hold.matchMs} ms — nothing was held, and the page went on unheld`);
  }
  hold.go("call");
  await hold.ended;
  if (hold.state === "closed" || page.isClosed()) {
    throw refuse(RELEASE, record, "closed", `the page on ${on} is closed, and its hold ended with it — ${nothing}`);
  }
  const first = hold.caught[0];
  const held = hold.caught.length;
  if (hold.failure !== null) {
    throw refuse(RELEASE, record, "driver-failure", `a held request could not go on (${hold.failure}); the first, ${first.method} ${first.path}, was held ${hold.heldMs} ms`);
  }
  const released = hold.releasedBy === "bound" ? "bound" : "call";
  record(
    released === "call"
      ? `${RELEASE}: released ${heldCount(held)} after ${hold.heldMs} ms held, the first ${first.method} ${first.path}; each went on unchanged`
      : `${RELEASE}: ${heldCount(held)} had gone on already, by the hold bound, after ${hold.heldMs} ms held, the first ${first.method} ${first.path}`,
  );
  return { method: first.method, path: first.path, caughtAfterMs: first.afterMs, heldMs: hold.heldMs, held, released };
}
