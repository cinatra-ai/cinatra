// pressByTestId: an element without a role pressed by its test id and its text,
// and the page's next settled state.
//
// WHY IT EXISTS. `press` finds a control as a person with a screen reader finds
// it, by its role and its accessible name. Some elements the product draws to
// be pressed carry no role at all, such as the rows of the type picker in the
// upload dialog: list items with a click handler and a test id. `press` has
// nothing to name there. This step finds such an element as the product's own
// browser tests find it, by its test id (`data-testid`) and its text, with the
// guarantees of `press`:
//   - it presses only when exactly one shown element carries the test id and,
//     as its own text, the text wanted, compared whole: a text that holds the
//     wanted text as a part is no match. No match and several matches are
//     refused, naming what was found;
//   - with `within`, it looks only inside the one shown part of the page of
//     that name, found as `press` finds it;
//   - it reads the page's next settled state with the reading `press` uses
//     (press-settle.mjs), within the same bounds, and answers the same fields.
//
// THE ACCESSIBLE ROAD FIRST. An element that carries a role `press` presses and
// an accessible name is `press`'s: the step refuses it and presses nothing. An
// element pressed by its test id is one a person who uses the keyboard or a
// screen reader cannot find by a name; the step says so in the record before
// the press, so every record of a run that needs it carries that fault.
import {
  CONTROL_MARK,
  CONTROL_NAMES_LISTED,
  describeMatches,
  describeNames,
  describePart,
  newMark,
  plainName,
  quotedName,
  readPageControls,
  unspacedNote,
} from "./page-controls.mjs";
import { PRESS_BOUNDS, PRESS_ROLES, ROLE_WORDS } from "./press.mjs";
import { pressAndSettle } from "./press-settle.mjs";
import { READING_BOUND_MS, pathOf, readBounds, refuse, requireRecord, within } from "./step-kit.mjs";

const STEP = "pressByTestId";

/** The attribute the product's browser tests read a test id from. */
export const TEST_ID_ATTRIBUTE = "data-testid";

/** Every bound of the step, by the name `bounds` overrides it with: the bounds of `press`. */
export const PRESS_BY_TEST_ID_BOUNDS = PRESS_BOUNDS;

/**
 * Texts read from the page, for a line: each quoted and cut as a name is, at
 * most as many as a refusal lists names, the rest counted; an element that
 * shows no text is said to be one.
 * @param {{ names: string[], more: number }} list
 */
function describeTexts(list) {
  const texts = list.names.map((one) => (one ? quotedName(one) : "one without text")).join(", ");
  return list.more > 0 ? `${texts} and ${list.more} more` : texts;
}

/**
 * Press the one shown element that carries the test id `testId` and whose own
 * text is `text`, within the one shown part of the page named `within` when
 * given, and resolve `{ name, role, testId, from, path, navigated, elapsedMs }`
 * once the page has settled, as `press` resolves: `name` is the text, `role` is
 * the element's role (empty for none), `navigated` is false when no navigation
 * started within the start bound. Before the press, it writes one line that
 * the element carries no role and was found by its test id. Refuses, as a
 * StepRefusal, arguments it cannot use, a scope no shown part of the page
 * carries (`no-scope`) or several carry (`ambiguous`), no shown element of the
 * test id and the text (`no-control`, naming how many carry the test id and
 * their texts), several (`ambiguous`, naming where each sits), an element with
 * a role `press` presses and an accessible name (`has-role`), a page it could
 * not read (`unreadable`), a press that could not be made (`driver-failure`)
 * and a navigation that does not land within the settle bound (`unsettled`).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   testId: string,
 *   text: string,
 *   within?: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof PRESS_BY_TEST_ID_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ name: string, role: string, testId: string, from: string, path: string, navigated: boolean, elapsedMs: number }>}
 */
export async function pressByTestId(page, { testId, text, within: scope, record, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was pressed";
  if (typeof testId !== "string" || testId.trim() === "") {
    throw refuse(STEP, record, "input", `name the element by its test id, such as artifacts-picker-type — ${nothing}`);
  }
  const wanted = plainName(text);
  if (typeof text !== "string" || wanted === "") throw refuse(STEP, record, "input", `name the element by the text it shows, such as Note — ${nothing}`);
  const scopeName = plainName(scope);
  if (scope !== undefined && (typeof scope !== "string" || scopeName === "")) {
    throw refuse(STEP, record, "input", `name the scope by the name of a landmark, a heading or a labelled section, such as Settings — ${nothing}`);
  }
  const bound = readBounds(STEP, record, PRESS_BY_TEST_ID_BOUNDS, bounds, nothing);
  const id = quotedName(testId);
  const shows = quotedName(wanted);

  const from = pathOf(page.url());
  const mark = newMark();
  const query = {
    mode: "testid",
    testIdAttribute: TEST_ID_ATTRIBUTE,
    testId,
    text: wanted,
    within: scopeName,
    roles: PRESS_ROLES,
    attribute: CONTROL_MARK,
    mark,
    listed: CONTROL_NAMES_LISTED,
  };
  const reading = await within(readPageControls(page, query), READING_BOUND_MS);
  if (!reading) throw refuse(STEP, record, "unreadable", `the elements on ${from} could not be read — ${nothing}`);
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
  // Where the element is looked for, for a line: the part of the page, when named, and the page.
  const inPart = part ? ` in the ${part.kind} ${quotedName(scopeName)}` : "";
  const at = `${inPart} on ${from}`;
  const carrying = `the test id ${id}`;
  if (matches.length === 0) {
    const carriers =
      reading.carriers === 0
        ? "no shown element carries it"
        : reading.carriers === 1
          ? `1 shown element carries it, with the text ${describeTexts(reading.texts)}`
          : `${reading.carriers} shown elements carry it, with the texts ${describeTexts(reading.texts)}`;
    throw refuse(STEP, record, "no-control", `no shown element${at} carries ${carrying} with the text ${shows} — ${carriers}; ${nothing}`);
  }
  if (matches.length > 1) {
    throw refuse(
      STEP,
      record,
      "ambiguous",
      `${matches.length} shown elements${at} carry ${carrying} with the text ${shows}: ${describeMatches(matches)} — ${nothing}, since a press never guesses`,
    );
  }
  const [element] = matches;
  if (PRESS_ROLES.includes(element.role) && element.name) {
    throw refuse(
      STEP,
      record,
      "has-role",
      `the element of ${carrying} with the text ${shows}${at} is a ${ROLE_WORDS[element.role][0]} named ${quotedName(element.name)} — ` +
        `press is the step for it, by its role and its name; ${nothing}`,
    );
  }

  // The fault the press rests on, said before the press: a person finds this element by no role and no name.
  const carries = element.role
    ? PRESS_ROLES.includes(element.role)
      ? `carries the role ${element.role} but no accessible name`
      : `carries the role ${element.role}, which press does not press`
    : "carries no role";
  record(`${STEP}: on ${from}, the element of ${carrying} with the text ${shows}${inPart} ${carries}; it was found by its test id`);

  const { settled, elapsedMs } = await pressAndSettle(page, {
    step: STEP,
    record,
    mark,
    from,
    href: element.href,
    bound,
    what: `the element of ${carrying} with the text ${shows}${at}`,
    nothing,
  });
  if (!settled) {
    throw refuse(
      STEP,
      record,
      "unsettled",
      `the press on the element of ${carrying} with the text ${shows}${inPart} started a navigation from ${from} that did not land within ${bound.settleMs} ms (the page is on ${pathOf(page.url())})`,
    );
  }
  const startBound = Math.min(bound.startMs, bound.settleMs);
  record(
    settled.navigated
      ? `${STEP}: pressed the element of ${carrying} with the text ${shows}${at} — landed on ${settled.path} after ${elapsedMs} ms`
      : `${STEP}: pressed the element of ${carrying} with the text ${shows}${at} — no navigation started within ${startBound} ms, and the page stayed on ${settled.path}`,
  );
  return { name: wanted, role: element.role, testId, from, path: settled.path, navigated: settled.navigated, elapsedMs };
}
