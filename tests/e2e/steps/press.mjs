// press: a control pressed by its accessible name, and the page's next settled
// state.
//
// WHY IT EXISTS. A run that presses a control by a selector it wrote itself
// presses whatever that selector finds first, and reads the page before the
// press has taken it anywhere. This step finds the control as a person does, by
// its role and its name; presses it only when exactly one shown control carries
// that name; and returns once the page has settled.
//
// SETTLED. The press is read with the start signal `navigateTo` reads: a
// navigation request of the page, the page's own request for a link's path when
// a client-side router navigates in place, or another path in the address.
//   - When none of these comes within the start bound, no navigation started:
//     the page stayed where it was, and the step returns then.
//   - When one comes, the navigation must land within the settle bound: a new
//     document that has loaded, or, in place, the same document on another path.
// A press whose navigation starts later than the start bound (a handler that
// waits for a slow answer first) reads as one that stayed; lengthen `startMs`
// for such a control.
//
// NEVER A GUESS. When several shown controls of the role carry the name, the
// step presses nothing and names each one by the part of the page it sits in.
import {
  CONTROL_ACTION_BOUND_MS,
  CONTROL_MARK,
  CONTROL_NAMES_LISTED,
  CONTROL_POLL_MS,
  describeMatches,
  describeNames,
  forgetDocument,
  markedBy,
  newMark,
  plainName,
  quotedName,
  readControls,
  readDocument,
  unmarkControls,
} from "./page-controls.mjs";
import { startsNavigation } from "./navigate-to.mjs";
import { originOf } from "./read-standing-requests.mjs";
import { READING_BOUND_MS, elapsedSince, errorClass, pathOf, pause, readBounds, refuse, requireRecord, within } from "./step-kit.mjs";

const STEP = "press";

/** The roles a press takes, and how a line names each. */
export const PRESS_ROLES = Object.freeze(["button", "link", "menuitem", "tab"]);
const ROLE_WORDS = Object.freeze({ button: "button", link: "link", menuitem: "menu item", tab: "tab" });

/**
 * From the press to the start of a navigation. Short on purpose: when no
 * navigation started within it, the page stayed where it was.
 */
export const PRESS_START_BOUND_MS = 2_000;
/** From the press to the landing of a navigation it started. A development server compiles a route on its first request. */
export const PRESS_SETTLE_BOUND_MS = 60_000;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const PRESS_BOUNDS = Object.freeze({
  actionMs: CONTROL_ACTION_BOUND_MS,
  startMs: PRESS_START_BOUND_MS,
  settleMs: PRESS_SETTLE_BOUND_MS,
  pollMs: CONTROL_POLL_MS,
});

/**
 * Press the one shown control of `role` (a button by default; a link, a menu
 * item or a tab) whose accessible name is `name`, and resolve
 * `{ name, role, from, path, navigated, elapsedMs }` once the page has settled:
 * `navigated` is false when no navigation started within the start bound, and
 * `path` is where the page is then. Refuses, as a StepRefusal, arguments it
 * cannot use, a name no shown control of the role carries (`no-control`, naming
 * those it shows), a name several carry (`ambiguous`, naming where each sits), a
 * disabled control (`disabled`), a press that could not be made
 * (`driver-failure`) and a navigation that does not land within the settle bound
 * (`unsettled`).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   name: string,
 *   role?: "button" | "link" | "menuitem" | "tab",
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof PRESS_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ name: string, role: string, from: string, path: string, navigated: boolean, elapsedMs: number }>}
 */
export async function press(page, { name, role = "button", record, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was pressed";
  const wanted = plainName(name);
  if (typeof name !== "string" || wanted === "") throw refuse(STEP, record, "input", `name the control by its accessible name, such as Save — ${nothing}`);
  if (!PRESS_ROLES.includes(role)) throw refuse(STEP, record, "input", `role must be button, link, menuitem or tab — ${nothing}`);
  const bound = readBounds(STEP, record, PRESS_BOUNDS, bounds, nothing);
  const word = ROLE_WORDS[role];
  const named = quotedName(wanted);

  const from = pathOf(page.url());
  const mark = newMark();
  const reading = await within(
    page.evaluate(readControls, { mode: "press", role, name: wanted, attribute: CONTROL_MARK, mark, listed: CONTROL_NAMES_LISTED }),
    READING_BOUND_MS,
  );
  if (!reading) throw refuse(STEP, record, "unreadable", `the controls on ${from} could not be read — ${nothing}`);
  const { matches } = reading;
  if (matches.length === 0) {
    throw refuse(STEP, record, "no-control", `no shown ${word} on ${from} is named ${named} — the ${word}s it shows: ${describeNames(reading.present)}; ${nothing}`);
  }
  if (matches.length > 1) {
    throw refuse(
      STEP,
      record,
      "ambiguous",
      `${matches.length} shown ${word}s on ${from} are named ${named}: ${describeMatches(matches)} — ${nothing}, since a press never guesses`,
    );
  }
  const [control] = matches;
  if (control.disabled) throw refuse(STEP, record, "disabled", `the ${word} ${named} on ${from} is disabled — ${nothing}`);

  // The document the press starts from, noted so that a new one is known.
  const key = `__stepPress${mark}`;
  const noted = await within(page.evaluate(readDocument, { key, set: true }), READING_BOUND_MS);
  if (!noted || !noted.same) {
    await within(page.evaluate(unmarkControls, { attribute: CONTROL_MARK, mark }), READING_BOUND_MS);
    throw refuse(STEP, record, "unreadable", `the page on ${from} could not be read before the press — ${nothing}`);
  }

  // The start signal, listened for from before the press. A link's own path
  // counts only when it leads away from this path.
  const origin = originOf(page.url());
  const linkPath = control.href && control.href.origin === origin && control.href.path !== from ? control.href.path : null;
  let started = false;
  const onRequest = (/** @type {import("@playwright/test").Request} */ request) => {
    if (!started) started = startsNavigation(page, request, origin, /** @type {string} */ (linkPath));
  };
  /** @type {{ navigated: boolean, path: string } | null} */
  let settled = null;
  let pressedAt = performance.now();
  page.on("request", onRequest);
  try {
    try {
      // `noWaitAfter`: the press returns once made; where it leads is read below.
      await page.locator(markedBy(mark)).click({ timeout: bound.actionMs, noWaitAfter: true });
    } catch (error) {
      throw refuse(STEP, record, "driver-failure", `the ${word} ${named} on ${from} could not be pressed (${errorClass(error)})`);
    }
    pressedAt = performance.now();
    settled = await settle(page, { key, from, hasStarted: () => started, bound, pressedAt });
  } finally {
    page.off("request", onRequest);
    // The page is the app's again. A page that has navigated since carries neither.
    await within(page.evaluate(unmarkControls, { attribute: CONTROL_MARK, mark }), READING_BOUND_MS);
    await within(page.evaluate(forgetDocument, { key }), READING_BOUND_MS);
  }
  const elapsedMs = elapsedSince(pressedAt);
  if (!settled) {
    throw refuse(
      STEP,
      record,
      "unsettled",
      `the press on the ${word} ${named} started a navigation from ${from} that did not land within ${bound.settleMs} ms (the page is on ${pathOf(page.url())})`,
    );
  }
  const startBound = Math.min(bound.startMs, bound.settleMs);
  record(
    settled.navigated
      ? `${STEP}: pressed the ${word} ${named} on ${from} — landed on ${settled.path} after ${elapsedMs} ms`
      : `${STEP}: pressed the ${word} ${named} on ${from} — no navigation started within ${startBound} ms, and the page stayed on ${settled.path}`,
  );
  return { name: wanted, role, from, path: settled.path, navigated: settled.navigated, elapsedMs };
}

/**
 * The page's next settled state after the press: a new document that has
 * loaded, the same document on another path, or, once the start bound has run
 * out without a start signal, the same document where it was. Null when a
 * navigation started and did not land within the settle bound.
 * @param {import("@playwright/test").Page} page
 * @param {{ key: string, from: string, hasStarted: () => boolean, bound: typeof PRESS_BOUNDS, pressedAt: number }} watch
 * @returns {Promise<{ navigated: boolean, path: string } | null>}
 */
async function settle(page, { key, from, hasStarted, bound, pressedAt }) {
  const startBound = Math.min(bound.startMs, bound.settleMs);
  for (;;) {
    // A reading taken while a navigation is in flight fails: the page is moving.
    const reading = await within(page.evaluate(readDocument, { key, set: false }), READING_BOUND_MS);
    const elapsed = performance.now() - pressedAt;
    if (reading) {
      if (!reading.same && reading.state === "complete") return { navigated: true, path: reading.path };
      if (reading.same && reading.path !== from) return { navigated: true, path: reading.path };
      if (reading.same && !hasStarted() && elapsed >= startBound) return { navigated: false, path: reading.path };
    }
    const remaining = bound.settleMs - elapsed;
    if (remaining <= 0) return null;
    await pause(Math.min(bound.pollMs, remaining));
  }
}
