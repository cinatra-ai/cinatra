// What every step shares: the refusal, the record, the frame, the bounded wait
// and the few readings that must never leak a value.
//
// Plain ESM with JSDoc types and Node's builtins only, like every file in this
// directory, so a plain Node process can import the steps with the checkout's
// own Playwright and nothing else.

/**
 * @typedef {(line: string) => void} StepRecord
 *   Receives one line per event. A step never writes a credential, an address
 *   or a query string through it: pages are named by their path.
 */

/**
 * @typedef {{ step: string, state: string, settled: boolean, elapsedMs: number }} FrameRequest
 *   What a step hands the shutter when it takes the frame.
 */

/**
 * @typedef {(request: FrameRequest) => string | Promise<string>} StepShutter
 *   Takes the frame (a screenshot, as the caller decides) and answers its path.
 */

/**
 * How long the shutter may take to answer with a frame. A full-page picture of
 * a heavy page takes seconds; a minute means it is not coming.
 */
export const FRAME_BOUND_MS = 60_000;

/**
 * How long one reading of the page may take. A page that is navigating or
 * frozen answers nothing, and the reading is then `unreadable`; a busy page
 * answers well within it. A watch can overrun its own bound by at most this.
 */
export const READING_BOUND_MS = 5_000;

/**
 * A step that did not do what it guarantees. The message names the step, the
 * kind of refusal and the reason on one line, and never carries a value, an
 * address or a query string.
 */
export class StepRefusal extends Error {
  /**
   * @param {string} step
   * @param {string} kind
   * @param {string} reason
   */
  constructor(step, kind, reason) {
    super(`${step} refused (${kind}): ${reason}`);
    this.name = "StepRefusal";
    this.step = step;
    this.kind = kind;
    this.reason = reason;
  }
}

/**
 * Build the refusal and write it through the record, for the caller to throw.
 * @param {string} step
 * @param {StepRecord} record
 * @param {string} kind
 * @param {string} reason
 */
export function refuse(step, record, kind, reason) {
  const refusal = new StepRefusal(step, kind, reason);
  record(refusal.message);
  return refusal;
}

/**
 * Every step writes through a record; without one, it does nothing at all.
 * @param {string} step
 * @param {unknown} record
 * @returns {asserts record is StepRecord}
 */
export function requireRecord(step, record) {
  if (typeof record !== "function") {
    throw new StepRefusal(step, "input", "hand the step a record callback — nothing was done");
  }
}

/**
 * A bound or a cadence must be a positive, finite number of milliseconds.
 * @param {string} step
 * @param {StepRecord} record
 * @param {string} name
 * @param {unknown} value
 * @param {string} nothing what the refusal says was not done
 */
export function requireMs(step, record, name, value, nothing) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw refuse(step, record, "input", `${name} must be a positive number of milliseconds — ${nothing}`);
  }
}

/**
 * The step's bounds: its defaults, with the caller's overrides checked by name.
 * @template {Record<string, number>} T
 * @param {string} step
 * @param {StepRecord} record
 * @param {T} defaults
 * @param {unknown} overrides
 * @param {string} nothing
 * @returns {T}
 */
export function readBounds(step, record, defaults, overrides, nothing) {
  const given = overrides && typeof overrides === "object" ? overrides : {};
  for (const [name, value] of Object.entries(given)) {
    if (!Object.hasOwn(defaults, name)) throw refuse(step, record, "input", `there is no bound named ${name} — ${nothing}`);
    requireMs(step, record, name, value, nothing);
  }
  return /** @type {T} */ ({ ...defaults, ...given });
}

/**
 * The class of an error, never its message: a message can repeat a filled
 * value, an address or what a selector matched.
 * @param {unknown} error
 */
export function errorClass(error) {
  const named = /** @type {{ name?: unknown, constructor?: { name?: unknown } } | null} */ (error);
  const name = String(named?.name || named?.constructor?.name || "Error");
  return name.replace(/[^A-Za-z]/g, "") || "Error";
}

/**
 * A page's path for a line: the path of a web address, and the scheme alone for
 * anything else. Never the origin, the query string or the fragment.
 * @param {string} url
 */
export function pathOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.pathname : parsed.protocol;
  } catch {
    return "an unreadable address";
  }
}

/**
 * A page path a step may name: absolute, on this origin, without spaces or quotes.
 * @param {unknown} path
 * @returns {path is string}
 */
export function isPagePath(path) {
  return typeof path === "string" && /^\/(?!\/)[^\s"'`<>\\]*$/.test(path);
}

/** @param {number} ms */
export const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Whole milliseconds since `start` (a `performance.now()` reading). */
export const elapsedSince = (/** @type {number} */ start) => Math.round(performance.now() - start);

/**
 * What `promise` settles to, or null when it failed or had not settled within `ms`.
 * @template T
 * @param {Promise<T> | T} promise
 * @param {number} ms
 * @returns {Promise<T | null>}
 */
export async function within(promise, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const expired = new Promise((done) => {
    timer = setTimeout(() => done(null), ms);
  });
  try {
    return await Promise.race([Promise.resolve(promise).catch(() => null), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the page on a fixed cadence until the reading settles or the bound runs
 * out. A reading that could not be taken (a navigation in flight, a page
 * mid-reload) is a reading, `unreadable`, and never the end of the wait: only
 * the bound ends it.
 * @template {{ state: string }} R
 * @param {import("@playwright/test").Page} page
 * @param {{ read: (arg: any) => R, arg: unknown, isSettled: (state: string) => boolean, bound: number, pollMs: number }} watch
 * @returns {Promise<{ reading: R | { state: string }, settled: boolean, elapsedMs: number }>}
 */
export async function pollUntilSettled(page, { read, arg, isSettled, bound, pollMs }) {
  const start = performance.now();
  for (;;) {
    const reading = (await within(page.evaluate(read, arg), READING_BOUND_MS)) ?? { state: "unreadable" };
    if (isSettled(reading.state)) return { reading, settled: true, elapsedMs: elapsedSince(start) };
    const remaining = bound - (performance.now() - start);
    if (remaining <= 0) return { reading, settled: false, elapsedMs: elapsedSince(start) };
    await pause(Math.min(pollMs, remaining));
  }
}

/**
 * Take the frame through the caller's shutter, within FRAME_BOUND_MS, and
 * answer its path.
 * @param {string} step
 * @param {StepRecord} record
 * @param {StepShutter} shutter
 * @param {FrameRequest} request
 */
export async function takeFrame(step, record, shutter, request) {
  const EXPIRED = Symbol("expired");
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const expired = new Promise((done) => {
    timer = setTimeout(() => done(EXPIRED), FRAME_BOUND_MS);
  });
  let answer;
  try {
    answer = await Promise.race([Promise.resolve().then(() => shutter(request)), expired]);
  } catch (error) {
    throw refuse(step, record, "no-frame", `the shutter failed (${errorClass(error)}) — no frame was taken`);
  } finally {
    clearTimeout(timer);
  }
  if (answer === EXPIRED) throw refuse(step, record, "no-frame", `the shutter took no frame within ${FRAME_BOUND_MS} ms`);
  if (typeof answer !== "string" || answer === "") throw refuse(step, record, "no-frame", "the shutter answered no frame path");
  return answer;
}
