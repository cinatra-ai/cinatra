// pressKey: one key of a closed list pressed on the control that has the
// focus, the focused control read before and after, and the page's next
// settled state.
//
// WHY IT EXISTS. A picture round proves what a key does (the arrows moving
// between the entries of a group, Tab moving the focus, Enter or Space taking
// a control) only through a maintained step: a round presses no key of its
// own. `press` clicks, and `typeInWindow` types text.
//
// THE KEYS. Only the keys of PRESS_KEYS: the four arrows, Home, End, Tab,
// Enter and Space. Any other key is refused before anything is pressed: this
// step proves keyboard behaviour, it never types text and never presses a
// chord.
//
// THE FOCUS. The key goes to the control that has the focus. With `focus`, the
// step first finds a control exactly as `press` finds one (its role, its name,
// within one named part of the page) and gives it the focus without pressing
// it. The focused control is read by its role, its accessible name and its
// state before the key and once the page has settled; nothing focused, a focus
// inside a frame, a page without the focus or a focused element that is not
// shown is refused before the key.
//
// SETTLED. The key is read as a press is (press-settle.mjs): no start signal
// within the start bound, and the page stayed; a start signal, and the
// navigation must land within the settle bound.
import {
  CONTROL_HYDRATION_BOUND_MS,
  CONTROL_MARK,
  CONTROL_NAMES_LISTED,
  describeMatches,
  describeNames,
  describePart,
  markedBy,
  newMark,
  plainName,
  quotedName,
  readPageControls,
  unspacedNote,
  waitForPageHydration,
} from "./page-controls.mjs";
import { PRESS_BOUNDS, PRESS_ROLES, ROLE_WORDS } from "./press.mjs";
import { pressAndSettle } from "./press-settle.mjs";
import { READING_BOUND_MS, errorClass, pathOf, readBounds, refuse, refuseFrameScope, requireRecord, within } from "./step-kit.mjs";

const STEP = "pressKey";

/** The keys the step presses, by Playwright's names for them, and no other. */
export const PRESS_KEYS = Object.freeze(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Tab", "Enter", "Space"]);

/** A reading of the focus for the answer: where it is, and the control's role, name and state. */
const focusOf = (/** @type {any} */ reading) =>
  reading.on === "control" ? { on: "control", role: reading.role, name: reading.name, state: reading.state } : { on: reading.on, role: "", name: "", state: null };

/** A focused control, for a line. */
function describeFocus(/** @type {{ role: string, name: string, state: string | null }} */ focus) {
  const word = ROLE_WORDS[/** @type {keyof typeof ROLE_WORDS} */ (focus.role)]?.[0] ?? (focus.role || "element");
  const named = focus.name ? quotedName(focus.name) : "without a name";
  return `the ${word} ${named}${focus.state ? ` (${focus.state})` : ""}`;
}

/**
 * Press `key`, one of PRESS_KEYS, on the control that has the focus on the
 * caller's page (with `focus`, on the one shown control of `focus.role`, a
 * button by default, named `focus.name`, within the one shown part of the page
 * named `focus.within` when given, focused first without a press), and resolve
 * `{ key, from, path, navigated, elapsedMs, before, after, moved }` once the
 * page has settled: `before` and `after` are `{ on, role, name, state }` (`on`
 * is `control`, `none`, `frame` or `outside`), and `moved` is false when the
 * same control has the focus after the key. Refuses, as a StepRefusal, a frame
 * scope and arguments it cannot use (`input`), a page that does not hydrate or
 * cannot be read (`unreadable`), with `focus` press's `no-scope`, `no-control`,
 * `ambiguous` and `disabled` and a control that did not take the focus
 * (`not-focused`), a page where nothing shown has the focus (`no-focus`), all
 * before the key; a key that could not be pressed (`driver-failure`) and a
 * navigation that does not land within the settle bound (`unsettled`).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End" | "Tab" | "Enter" | "Space",
 *   record: import("./step-kit.mjs").StepRecord,
 *   focus?: { name: string, role?: "button" | "link" | "menuitem" | "tab" | "checkbox" | "radio" | "switch", within?: string },
 *   bounds?: Partial<Record<keyof typeof PRESS_BOUNDS, number>>,
 * }} options
 */
export async function pressKey(page, { key, record, focus, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was pressed";
  refuseFrameScope(STEP, record, page, nothing);
  if (typeof key !== "string" || !PRESS_KEYS.includes(key)) {
    throw refuse(STEP, record, "input", `key must be ${PRESS_KEYS.slice(0, -1).join(", ")} or ${PRESS_KEYS.at(-1)} — ${nothing}`);
  }
  /** @type {{ name: string, role: string, within: string } | null} */
  let wanted = null;
  if (focus !== undefined) {
    const given = /** @type {any} */ (focus);
    if (!given || typeof given !== "object" || Array.isArray(given)) {
      throw refuse(STEP, record, "input", `focus must name a control, such as { name: "Save", role: "button" } — ${nothing}`);
    }
    // As press reads its role: a button only when no role is given; any other value is checked.
    const role = given.role === undefined ? "button" : given.role;
    const name = plainName(given.name);
    const scope = plainName(given.within);
    if (typeof given.name !== "string" || name === "") throw refuse(STEP, record, "input", `name the control to focus by its accessible name, such as Save — ${nothing}`);
    if (!PRESS_ROLES.includes(role)) {
      throw refuse(STEP, record, "input", `the role of the control to focus must be ${PRESS_ROLES.slice(0, -1).join(", ")} or ${PRESS_ROLES.at(-1)} — ${nothing}`);
    }
    if (given.within !== undefined && (typeof given.within !== "string" || scope === "")) {
      throw refuse(STEP, record, "input", `name the scope by the name of a landmark, a heading or a labelled section, such as Settings — ${nothing}`);
    }
    wanted = { name, role, within: scope };
  }
  const bound = readBounds(STEP, record, PRESS_BOUNDS, bounds, nothing);

  const from = pathOf(page.url());
  if (!(await waitForPageHydration(page))) {
    throw refuse(STEP, record, "unreadable", `the page on ${from} did not hydrate within ${CONTROL_HYDRATION_BOUND_MS} ms — ${nothing}`);
  }
  const mark = newMark();
  try {
    if (wanted) {
      const [word, words] = ROLE_WORDS[/** @type {keyof typeof ROLE_WORDS} */ (wanted.role)];
      const named = quotedName(wanted.name);
      const query = { mode: "press", role: wanted.role, name: wanted.name, within: wanted.within, attribute: CONTROL_MARK, mark, listed: CONTROL_NAMES_LISTED };
      const reading = await within(readPageControls(page, query), READING_BOUND_MS);
      if (!reading) throw refuse(STEP, record, "unreadable", `the controls on ${from} could not be read — ${nothing}`);
      const { scope: part, matches } = reading;
      if (part && part.found === 0) {
        throw refuse(STEP, record, "no-scope", `no shown part of the page on ${from} is named ${quotedName(wanted.within)} — the named parts it shows: ${describeNames(part.parts)}; ${nothing}`);
      }
      if (part && part.found > 1) {
        const where = part.matches.map((/** @type {any} */ one, /** @type {number} */ index) => `${index + 1} a ${one.kind} ${describePart(one.part)}`).join(", ");
        throw refuse(
          STEP,
          record,
          "ambiguous",
          `${part.found} shown parts of the page on ${from} are named ${quotedName(wanted.within)}${unspacedNote(part.unspaced, part.named)}: ${where} — ${nothing}, since a press never guesses`,
        );
      }
      const at = `${part ? ` in the ${part.kind} ${quotedName(wanted.within)}` : ""} on ${from}`;
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
      if (matches[0].disabled) throw refuse(STEP, record, "disabled", `the ${word} ${named}${at} is disabled — ${nothing}`);
      try {
        await page.locator(markedBy(mark)).focus({ timeout: bound.actionMs });
      } catch (error) {
        throw refuse(STEP, record, "driver-failure", `the ${word} ${named}${at} could not be focused (${errorClass(error)}) — ${nothing}`);
      }
    }

    // The focus before the key: the focused element carries the mark from here on.
    const before = await within(readPageControls(page, { mode: "focus", attribute: CONTROL_MARK, mark, set: true }), READING_BOUND_MS);
    if (!before) throw refuse(STEP, record, "unreadable", `the focus on ${from} could not be read — ${nothing}`);
    if (before.on === "none") throw refuse(STEP, record, "no-focus", `nothing on ${before.path} has the focus — ${nothing}`);
    if (before.on === "frame") throw refuse(STEP, record, "no-focus", `the focus on ${before.path} is in a frame of the page — ${nothing}`);
    if (before.on === "outside") throw refuse(STEP, record, "no-focus", `the page on ${before.path} does not have the focus — ${nothing}`);
    if (!before.shown) throw refuse(STEP, record, "no-focus", `the element that has the focus on ${before.path} is not shown — ${nothing}`);
    if (wanted && !before.same) {
      throw refuse(STEP, record, "not-focused", `the ${ROLE_WORDS[/** @type {keyof typeof ROLE_WORDS} */ (wanted.role)][0]} ${quotedName(wanted.name)} on ${from} did not take the focus — ${nothing}`);
    }

    // The key, read as a press is read; the settle's own mark is placed nowhere, so M stays for the reading after.
    const { settled, elapsedMs } = await pressAndSettle(page, {
      step: STEP,
      record,
      mark: newMark(),
      from,
      href: null,
      bound,
      what: `the key ${key} on ${describeFocus(before)} on ${from}`,
      nothing,
      act: () => page.keyboard.press(key),
    });
    if (!settled) {
      throw refuse(
        STEP,
        record,
        "unsettled",
        `the key ${key} on ${describeFocus(before)} started a navigation from ${from} that did not land within ${bound.settleMs} ms (the page is on ${pathOf(page.url())})`,
      );
    }
    const reading = await within(readPageControls(page, { mode: "focus", attribute: CONTROL_MARK, mark, set: false }), READING_BOUND_MS);
    if (!reading) throw refuse(STEP, record, "unreadable", `the focus on ${settled.path} could not be read after the key ${key} — the key was pressed`);
    const after = focusOf(reading);
    const moved = !(reading.on === "control" && reading.same);
    let change;
    if (reading.on === "none") change = "the focus is now on nothing";
    else if (reading.on === "frame") change = "the focus is now in a frame of the page";
    else if (reading.on === "outside") change = "the page no longer has the focus";
    else change = `the focus ${moved ? "moved to" : "stayed on"} ${describeFocus(after)}`;
    const startBound = Math.min(bound.startMs, bound.settleMs);
    const landing = settled.navigated
      ? `landed on ${settled.path} after ${elapsedMs} ms`
      : `no navigation started within ${startBound} ms, and the page stayed on ${settled.path}`;
    const first = wanted ? ", focused by its name first" : "";
    record(`${STEP}: pressed ${key} on ${describeFocus(focusOf(before))} on ${from}${first} — ${change}; ${landing}`);
    return { key, from, path: settled.path, navigated: settled.navigated, elapsedMs, before: focusOf(before), after, moved };
  } finally {
    // The focused element may stand inside an open shadow root, where the shared reading does not look: M comes off there too, whatever happened.
    await within(page.evaluate(unmarkDeep, { attribute: CONTROL_MARK, mark }), READING_BOUND_MS);
  }
}

/** Removes the mark `mark` from every element that carries it, inside open shadow roots too. */
function unmarkDeep({ attribute, mark }) {
  const walk = (root) => {
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (element.getAttribute(attribute) === mark) element.removeAttribute(attribute);
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(document);
  return true;
}
