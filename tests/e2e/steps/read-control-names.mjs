// readControlNames: every shown control of a page, read by its role and its
// accessible name, as a person with a screen reader finds it.
//
// WHY IT EXISTS. The steps read a page's controls by role and name only inside
// press, selectFrom and dispatchRun, to find the one control they act on, and
// no step answered that reading. A check that a screen's controls carry
// accessible names (a section named by its heading, a picker and a button named
// for the row they belong to) had no step to stand on.
//
// ONE READER. The reading is the in-page reader of the control steps
// (`readControls` in page-controls.mjs): the same order of name sources, the
// same rule for what counts as shown and the same roles, so a name this step
// reads is the name `press` looks for. Beside the roles of controls it reads
// the parts of a page a person moves between: a region (a section with a name),
// a group, a dialog or an alert dialog, a form with a name, a navigation and a
// search landmark. An element takes the role its tag gives it when it has no
// `role` of its own; one with neither is not listed.
//
// NOTHING LEFT OUT. A control without a name is listed, with an empty name: a
// reading that left it out could not show that its name is missing.
import { CONTROL_NAMES_LISTED, describeNames, describePart, plainName, quotedName, readControls, unspacedNote, withoutAddress } from "./page-controls.mjs";
import { READING_BOUND_MS, errorClass, pathOf, readBounds, refuse, requireRecord } from "./step-kit.mjs";

const STEP = "readControlNames";

/** The most controls one reading lists; `more` counts the rest. */
export const READ_CONTROL_NAMES_LIMIT = 400;
/** The most characters of a name one line carries; a longer name is cut and ends with an ellipsis. */
export const READ_CONTROL_NAME_LENGTH = 300;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const READ_CONTROL_NAMES_BOUNDS = Object.freeze({ readingMs: READING_BOUND_MS });

/**
 * A name read from the page, for a line: whole up to READ_CONTROL_NAME_LENGTH
 * characters, a longer one cut and ending with an ellipsis, and an address in
 * it written as "an address".
 * @param {string} name
 */
function lineName(name) {
  const plain = withoutAddress(name);
  return plain.length > READ_CONTROL_NAME_LENGTH ? `${plain.slice(0, READ_CONTROL_NAME_LENGTH - 1).trimEnd()}…` : plain;
}

/**
 * Read every shown control of the page, or of the one shown part of the page
 * named `within` (a landmark, or a section named by its label or its heading,
 * as `press` finds it), and resolve `{ controls, more }`: `controls` lists
 * `{ role, name, from, description }` in the page's order, at most
 * READ_CONTROL_NAMES_LIMIT of them, and `more` counts those beyond. `from` is
 * where the name comes from (`aria-labelledby`, `aria-label`, `label`, `text` or
 * `title`), and `description` the text `aria-describedby` names; both are empty
 * when there is none, as the name of a control without one is. Writes one line
 * per control, `readControlNames: ` and the JSON of its role, its name (see
 * lineName) and `from`, and one more, `readControlNames: {"more":N}`, when the
 * limit cut controls off. Refuses, as a StepRefusal, arguments it cannot use
 * (`input`), a reading the driver could not take within the bound
 * (`driver-failure`), a part no shown part of the page carries (`no-scope`,
 * naming those it shows) or several carry (`ambiguous`, naming where each
 * sits), and a page, or a part, that shows no control (`no-control`).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   record: import("./step-kit.mjs").StepRecord,
 *   within?: string,
 *   bounds?: Partial<Record<keyof typeof READ_CONTROL_NAMES_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ controls: { role: string, name: string, from: string, description: string }[], more: number }>}
 */
export async function readControlNames(page, { record, within: scope, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was read";
  const scopeName = plainName(scope);
  if (scope !== undefined && (typeof scope !== "string" || scopeName === "")) {
    throw refuse(STEP, record, "input", `name the part of the page by the name of a landmark, a heading or a labelled section, such as Settings — ${nothing}`);
  }
  const bound = readBounds(STEP, record, READ_CONTROL_NAMES_BOUNDS, bounds, nothing);

  const on = pathOf(page.url());
  const query = { mode: "names", within: scopeName, limit: READ_CONTROL_NAMES_LIMIT, listed: CONTROL_NAMES_LISTED };
  // One reading, within its bound; a refusal keeps only the error's class.
  const EXPIRED = Symbol("expired");
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const expired = new Promise((done) => {
    timer = setTimeout(() => done(EXPIRED), bound.readingMs);
  });
  /** @type {any} */
  let reading;
  try {
    reading = await Promise.race([page.evaluate(readControls, query), expired]);
  } catch (error) {
    throw refuse(STEP, record, "driver-failure", `the controls on ${on} could not be read (${errorClass(error)})`);
  } finally {
    clearTimeout(timer);
  }
  if (reading === EXPIRED) throw refuse(STEP, record, "driver-failure", `the controls on ${on} could not be read within ${bound.readingMs} ms`);
  if (!reading || !Array.isArray(reading.controls)) throw refuse(STEP, record, "driver-failure", `the controls on ${on} could not be read`);

  const listed = "nothing was listed";
  const { scope: part } = reading;
  if (part && part.found === 0) {
    throw refuse(
      STEP,
      record,
      "no-scope",
      `no shown part of the page on ${on} is named ${quotedName(scopeName)} — the named parts it shows: ${describeNames(part.parts)}; ${listed}`,
    );
  }
  if (part && part.found > 1) {
    const where = part.matches.map((/** @type {any} */ one, /** @type {number} */ index) => `${index + 1} a ${one.kind} ${describePart(one.part)}`).join(", ");
    throw refuse(
      STEP,
      record,
      "ambiguous",
      `${part.found} shown parts of the page on ${on} are named ${quotedName(scopeName)}${unspacedNote(part.unspaced, part.named)}: ${where} — ${listed}, since a reading never guesses`,
    );
  }
  const at = `${part ? ` in the ${part.kind} ${quotedName(scopeName)}` : ""} on ${on}`;
  if (reading.controls.length === 0) throw refuse(STEP, record, "no-control", `no control is shown${at} — ${listed}`);

  /** @type {{ role: string, name: string, from: string, description: string }[]} */
  const controls = reading.controls.map((/** @type {any} */ one) => ({ role: one.role, name: one.name, from: one.from, description: one.description }));
  for (const { role, name, from } of controls) record(`${STEP}: ${JSON.stringify({ role, name: lineName(name), from })}`);
  const more = Number(reading.more) || 0;
  if (more > 0) record(`${STEP}: ${JSON.stringify({ more })}`);
  return { controls, more };
}
