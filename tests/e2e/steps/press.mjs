// press: a control pressed by its accessible name, and the page's next settled
// state.
//
// WHY IT EXISTS. A run that presses a control by a selector it wrote itself
// presses whatever that selector finds first, and reads the page before the
// press has taken it anywhere. This step finds the control as a person does, by
// its role and its name; presses it only when exactly one shown control carries
// that name; and returns once the page has settled.
//
// SETTLED. The press is read with the start signal `navigateTo` reads, by the
// reading it shares with pressByTestId (press-settle.mjs): no start signal
// within the start bound, and the page stayed where it was; a start signal, and
// the navigation must land within the settle bound, or the press is refused.
// A press whose navigation starts later than the start bound (a handler that
// waits for a slow answer first) reads as one that stayed; lengthen `startMs`
// for such a control.
//
// NEVER A GUESS. When several shown controls of the role carry the name, the
// step presses nothing and names each one by the part of the page it sits in.
// With `within`, it looks for the name only inside the one shown part of the
// page of that name (a landmark, or a section named by its label or its
// heading), and presses nothing when no part or several parts carry it.
//
// CHECKED. A checkbox, a radio or a switch is pressed like a button; its checked
// state is read before the press and once the page has settled, and a press
// that did not change it is refused.
import {
  CONTROL_ACTION_BOUND_MS,
  CONTROL_MARK,
  CONTROL_NAMES_LISTED,
  CONTROL_POLL_MS,
  describeMatches,
  describeNames,
  describePart,
  newMark,
  plainName,
  quotedName,
  readPageControls,
  unspacedNote,
} from "./page-controls.mjs";
import { pressAndSettle } from "./press-settle.mjs";
import { READING_BOUND_MS, pathOf, readBounds, refuse, requireRecord, within } from "./step-kit.mjs";

const STEP = "press";

/** The roles a press takes, and how a line names each, one and several. */
export const PRESS_ROLES = Object.freeze(["button", "link", "menuitem", "tab", "checkbox", "radio", "switch"]);
export const ROLE_WORDS = Object.freeze({
  button: ["button", "buttons"],
  link: ["link", "links"],
  menuitem: ["menu item", "menu items"],
  tab: ["tab", "tabs"],
  checkbox: ["checkbox", "checkboxes"],
  radio: ["radio", "radios"],
  switch: ["switch", "switches"],
});
/** The roles whose press must change their checked state. */
const CHECKED_ROLES = Object.freeze(["checkbox", "radio", "switch"]);
/** A checked state, for a line. */
const stateWord = (/** @type {boolean | "mixed" | null} */ state) => (state === "mixed" ? "mixed" : state ? "checked" : "unchecked");

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
 * item, a tab, a checkbox, a radio or a switch) whose accessible name is
 * `name`, within the one shown part of the page named `within` when given, and
 * resolve `{ name, role, from, path, navigated, elapsedMs }` once the page has
 * settled: `navigated` is false when no navigation started within the start
 * bound, and `path` is where the page is then. Refuses, as a StepRefusal,
 * arguments it cannot use, a scope no shown part of the page carries
 * (`no-scope`, naming those it shows) or several carry (`ambiguous`), a name no
 * shown control of the role carries (`no-control`, naming those it shows), a
 * name several carry (`ambiguous`, naming where each sits), a disabled control
 * (`disabled`), a press that could not be made (`driver-failure`), a navigation
 * that does not land within the settle bound (`unsettled`) and a checkbox, a
 * radio or a switch whose checked state did not change (`unchanged`).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   name: string,
 *   role?: "button" | "link" | "menuitem" | "tab" | "checkbox" | "radio" | "switch",
 *   within?: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof PRESS_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ name: string, role: string, from: string, path: string, navigated: boolean, elapsedMs: number }>}
 */
export async function press(page, { name, role = "button", within: scope, record, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was pressed";
  const wanted = plainName(name);
  if (typeof name !== "string" || wanted === "") throw refuse(STEP, record, "input", `name the control by its accessible name, such as Save — ${nothing}`);
  if (!PRESS_ROLES.includes(role)) {
    throw refuse(STEP, record, "input", `role must be ${PRESS_ROLES.slice(0, -1).join(", ")} or ${PRESS_ROLES.at(-1)} — ${nothing}`);
  }
  const scopeName = plainName(scope);
  if (scope !== undefined && (typeof scope !== "string" || scopeName === "")) {
    throw refuse(STEP, record, "input", `name the scope by the name of a landmark, a heading or a labelled section, such as Settings — ${nothing}`);
  }
  const bound = readBounds(STEP, record, PRESS_BOUNDS, bounds, nothing);
  const [word, words] = ROLE_WORDS[role];
  const named = quotedName(wanted);
  const checks = CHECKED_ROLES.includes(role);

  const from = pathOf(page.url());
  const mark = newMark();
  const query = { mode: "press", role, name: wanted, within: scopeName, attribute: CONTROL_MARK, mark, listed: CONTROL_NAMES_LISTED };
  const reading = await within(readPageControls(page, query), READING_BOUND_MS);
  if (!reading) throw refuse(STEP, record, "unreadable", `the controls on ${from} could not be read — ${nothing}`);
  const { scope: part, matches } = reading;
  if (part && part.found === 0) {
    throw refuse(
      STEP,
      record,
      "no-scope",
      `no shown part of the page on ${from} is named ${quotedName(scopeName)} — the named parts it shows: ${describeNames(part.parts)}; ${nothing}`,
    );
  }
  if (part && part.found > 1) {
    const where = part.matches.map((one, index) => `${index + 1} a ${one.kind} ${describePart(one.part)}`).join(", ");
    throw refuse(
      STEP,
      record,
      "ambiguous",
      `${part.found} shown parts of the page on ${from} are named ${quotedName(scopeName)}${unspacedNote(part.unspaced, part.named)}: ${where} — ${nothing}, since a press never guesses`,
    );
  }
  // Where the control is looked for, for a line: the part of the page, when named, and the page.
  const inPart = part ? ` in the ${part.kind} ${quotedName(scopeName)}` : "";
  const at = `${inPart} on ${from}`;
  if (matches.length === 0) {
    throw refuse(STEP, record, "no-control", `no shown ${word}${at} is named ${named} — the ${words} it shows: ${describeNames(reading.present)}; ${nothing}`);
  }
  if (matches.length > 1) {
    throw refuse(
      STEP,
      record,
      "ambiguous",
      `${matches.length} shown ${words}${at} are named ${named}${unspacedNote(reading.unspaced, reading.named)}: ${describeMatches(matches)} — ${nothing}, since a press never guesses`,
    );
  }
  const [control] = matches;
  if (control.disabled) throw refuse(STEP, record, "disabled", `the ${word} ${named}${at} is disabled — ${nothing}`);

  const { settled, checked, elapsedMs } = await pressAndSettle(page, {
    step: STEP,
    record,
    mark,
    from,
    href: control.href,
    bound,
    what: `the ${word} ${named}${at}`,
    nothing,
    checks,
  });
  if (!settled) {
    throw refuse(
      STEP,
      record,
      "unsettled",
      `the press on the ${word} ${named}${inPart} started a navigation from ${from} that did not land within ${bound.settleMs} ms (the page is on ${pathOf(page.url())})`,
    );
  }
  if (checks && checked === null) {
    throw refuse(STEP, record, "unchanged", `the checked state of the ${word} ${named}${at} could not be read after the press, so no change of it was seen`);
  }
  if (checks && checked === control.checked) {
    throw refuse(STEP, record, "unchanged", `the ${word} ${named}${at} still reads ${stateWord(checked)} after the press — its checked state did not change`);
  }
  const change = checks ? ` it went from ${stateWord(control.checked)} to ${stateWord(checked)};` : "";
  const startBound = Math.min(bound.startMs, bound.settleMs);
  record(
    settled.navigated
      ? `${STEP}: pressed the ${word} ${named}${at} —${change} landed on ${settled.path} after ${elapsedMs} ms`
      : `${STEP}: pressed the ${word} ${named}${at} —${change} no navigation started within ${startBound} ms, and the page stayed on ${settled.path}`,
  );
  return { name: wanted, role, from, path: settled.path, navigated: settled.navigated, elapsedMs };
}
