// frameOf: the one frame of a page, found by its element, and a FRAME SCOPE that
// the control steps take in place of a page to read and act in that frame's
// document alone.
//
// WHY IT EXISTS. An application embedded in another site's page, such as the
// assistant widget a site mounts in a frame of its own, draws its controls in
// that frame's document. The control steps read the accessibility tree of the
// page they are handed and type through its keyboard, so a run that had to
// drive the frame wrote its own walk around them.
//
// THE FRAME. `frame` is a CSS selector of the one frame ELEMENT on the page,
// looked for as Playwright's locators look, through open shadow roots (a
// site's widget mounts its frame inside its own shadow root). The step waits,
// within its bound, until exactly one attached element matches and its frame's
// document has loaded; it never guesses between two.
//
// THE SCOPE. What it answers is no page: its address, its readings, its
// locators and its waits are the frame's; its keyboard, its mouse, its context
// and its events are its page's, since a browser types into the frame that has
// the focus and announces the frame's requests on its page; its main frame is
// the frame, and its frames the frame and the frames inside it. It has no
// reload, no address to go to, no picture and no close: the page has them. A
// scope is known by a mark the kit alone sets (step-kit.mjs), never by its
// shape. A frame that was replaced (the page reloaded, the frame mounted anew)
// leaves its scope stale; a step given it refuses, and the caller calls frameOf
// again.
import { CONTROL_POLL_MS, quotedName } from "./page-controls.mjs";
import {
  READING_BOUND_MS,
  elapsedSince,
  errorClass,
  markFrameScope,
  pathOf,
  pause,
  readBounds,
  refuse,
  refuseFrameScope,
  requireRecord,
  within,
} from "./step-kit.mjs";

const STEP = "frameOf";

/** From the call to the one frame element attached with its document loaded. A development server compiles the frame's page on its first request. */
export const FRAME_SCOPE_BOUND_MS = 120_000;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const FRAME_SCOPE_BOUNDS = Object.freeze({ frameMs: FRAME_SCOPE_BOUND_MS, pollMs: CONTROL_POLL_MS });

/** What a reading answers when the driver did not answer within its bound. */
const LATE = Symbol("late");

/**
 * `promise`, or LATE when it has not settled within `ms`; a failure is thrown.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T | typeof LATE>}
 */
async function bounded(promise, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((done) => {
    timer = setTimeout(() => done(LATE), ms);
  });
  promise.catch(() => {});
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The frame and every frame inside it, the frame first.
 * @param {import("@playwright/test").Frame} frame
 * @returns {import("@playwright/test").Frame[]}
 */
function framesUnder(frame) {
  return [frame, ...frame.childFrames().flatMap((child) => framesUnder(child))];
}

/**
 * The scope of `frame` on `page`: the frame's readings and acts, the page's
 * keyboard, mouse, context and events, marked by the kit.
 * @param {import("@playwright/test").Page} page
 * @param {import("@playwright/test").Frame} frame
 */
function scopeOf(page, frame) {
  /** @type {any} */
  const scope = {
    url: () => frame.url(),
    evaluate: (/** @type {any} */ fn, /** @type {any} */ arg) => frame.evaluate(fn, arg),
    locator: (/** @type {string} */ selector, /** @type {any} */ options) => frame.locator(selector, options),
    waitForFunction: (/** @type {any} */ fn, /** @type {any} */ arg, /** @type {any} */ options) => frame.waitForFunction(fn, arg, options),
    getByRole: (/** @type {any} */ role, /** @type {any} */ options) => frame.getByRole(role, options),
    keyboard: page.keyboard,
    mouse: page.mouse,
    context: () => page.context(),
    on: (/** @type {any} */ event, /** @type {any} */ listener) => {
      page.on(event, listener);
      return scope;
    },
    off: (/** @type {any} */ event, /** @type {any} */ listener) => {
      page.off(event, listener);
      return scope;
    },
    waitForEvent: (/** @type {any} */ event, /** @type {any} */ options) => page.waitForEvent(event, options),
    mainFrame: () => frame,
    frames: () => framesUnder(frame),
    isClosed: () => page.isClosed() || frame.isDetached(),
  };
  return markFrameScope(scope);
}

/**
 * The frame element `frame` selects on the caller's page, once exactly one is
 * attached and its frame's document has loaded, and resolve
 * `{ scope, path, elapsedMs }`: `scope` is a frame scope the control steps
 * (readCount, press, pressByTestId, dispatchRun, sendInComposer,
 * typeInWindow, waitForTurn, fillForm and readControlNames) take in place of a
 * page, and `path` the frame's path. Refuses, as a StepRefusal: `input` (no
 * selector, a bound it does not know, or a scope in place of a page),
 * `no-frame` (no such element with a loaded document within the bound, naming
 * how many matched then), `ambiguous` (several match, naming how many) and
 * `driver-failure` (the selector could not be read).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   frame: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof FRAME_SCOPE_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ scope: any, path: string, elapsedMs: number }>}
 */
export async function frameOf(page, { frame: selector, record, bounds } = /** @type {any} */ ({})) {
  refuseFrameScope(STEP, record, page, "no frame was read");
  requireRecord(STEP, record);
  const nothing = "no frame was read";
  if (typeof selector !== "string" || selector.trim() === "") {
    throw refuse(STEP, record, "input", `name the frame element by a CSS selector, such as iframe.cw-frame — ${nothing}`);
  }
  const bound = readBounds(STEP, record, FRAME_SCOPE_BOUNDS, bounds, nothing);
  const named = quotedName(selector.replace(/\s+/g, " ").trim());
  const from = pathOf(page.url());

  const start = performance.now();
  // What is left of the bound: every reading is cut to it, so no answer comes after the bound ran out.
  const left = () => bound.frameMs - (performance.now() - start);
  const cut = () => Math.max(1, Math.min(READING_BOUND_MS, left()));
  const ambiguous = (/** @type {number} */ many) =>
    refuse(STEP, record, "ambiguous", `${many} attached elements on ${from} match the selector ${named} — ${nothing}, since a frame is never guessed`);
  const countOf = async (/** @type {any} */ elements) => {
    try {
      return await bounded(elements.count(), cut());
    } catch (error) {
      throw refuse(STEP, record, "driver-failure", `the selector ${named} could not be read on ${from} (${errorClass(error)}) — ${nothing}`);
    }
  };
  let count = 0;
  for (;;) {
    const elements = page.locator(selector);
    const read = await countOf(elements);
    if (read !== LATE) count = read;
    if (read !== LATE && read > 1) throw ambiguous(read);
    if (read === 1) {
      const found = await within(
        (async () => {
          const handle = await elements.elementHandle({ timeout: cut() });
          try {
            return await handle.contentFrame();
          } finally {
            await handle.dispose();
          }
        })(),
        cut(),
      );
      // Loaded: the frame stands on its own document (no longer the empty one a frame starts with), and that document has loaded.
      const loaded =
        found && !found.isDetached() && found.url() !== "about:blank"
          ? await within(
              found.evaluate(() => document.readyState === "complete"),
              cut(),
            )
          : false;
      if (found && loaded) {
        // Read again once the document has answered: still the one element of the selector, its frame still attached, within the bound.
        const again = await countOf(elements);
        if (again !== LATE) count = again;
        if (again !== LATE && again > 1) throw ambiguous(again);
        if (again === 1 && !found.isDetached() && left() >= 0) {
          const scope = scopeOf(page, found);
          const path = pathOf(found.url());
          const elapsedMs = elapsedSince(start);
          record(`${STEP}: on ${from}, the frame of the selector ${named} stands on ${path}; the steps given its scope read and act in that frame's document alone`);
          return { scope, path, elapsedMs };
        }
      }
    }
    const remaining = left();
    if (remaining <= 0) break;
    await pause(Math.min(bound.pollMs, remaining));
  }
  const matched = count === 0 ? "no attached element matched it" : `${count} attached ${count === 1 ? "element matched it" : "elements matched it"}, without a loaded frame`;
  throw refuse(STEP, record, "no-frame", `no frame of the selector ${named} on ${from} loaded within ${bound.frameMs} ms: ${matched} — ${nothing}`);
}
