// typeInWindow: text typed into a window's text box through the keyboard, as a
// person types it, read back from the box, and, when asked, sent through the
// window's own send control.
//
// WHY IT EXISTS. A run window's text box is no form field: the product draws it
// as a box whose content is editable (role textbox, named by `aria-label`), not
// as an input, a textarea or a select, so fillForm finds no field in it, and a
// fill sets no value on it. A driver that used only the maintained steps could
// not type a message into a run window or a review window.
//
// THE BOX AND ITS SEND CONTROL. The box is the one shown text box of role
// textbox named `field`, found with the reader of the control steps (see
// page-controls.mjs), never by a test id; with `within`, only inside the one
// shown part of the page of that name, for a page that shows more than one
// window. The product names a window's box and its send control alike (the run
// window's "Apply AI suggestion", the conversation's composer "Send message"),
// so the send control is the shown button of the box's own name, looked for
// from the box outwards: the one in the nearest part of the page that holds
// one. While an answer is pending, the product locks the box and gives the send
// control its stop name: a locked box is refused, and nothing is typed.
//
// TYPED, AS A PERSON TYPES. The step presses into the box, puts the caret at
// the end of its text (or, with `replace`, selects its text and deletes it with
// Backspace), and types the text key by key. A line break would press Enter,
// which sends, so a text that holds one, or any other control character, is
// refused. The text is read back from the box, and a box that does not read
// back what was typed (a handler of the page changed it) is refused. No line
// carries the text.
//
// SENT. With `send`, the step presses the send control once the text is in
// (the product enables it only then) and waits until the window has taken the
// message: the product empties the box as it takes it. Right before the press
// it notes, in the page's document, the entries of the person and of the
// assistant the window shows, so that waitForTurn counts the turn from the send
// even when the answer stands before the wait begins.
import {
  CONTROL_ACTION_BOUND_MS,
  CONTROL_MARK,
  CONTROL_NAMES_LISTED,
  CONTROL_POLL_MS,
  describeMatches,
  describeNames,
  describePart,
  markedBy,
  newMark,
  plainName,
  quotedName,
  readControls,
  unmarkControls,
  unspacedNote,
} from "./page-controls.mjs";
import { READING_BOUND_MS, errorClass, pathOf, pause, readBounds, refuse, requireRecord, within } from "./step-kit.mjs";

const STEP = "typeInWindow";

/** The accessible name of a run window's text box, and of its send control, on every surface the window stands on. */
export const RUN_WINDOW_FIELD = "Apply AI suggestion";
/** The attribute the product marks each entry of a window's conversation with: `person` or `assistant`. */
export const RUN_WINDOW_ENTRY_ATTRIBUTE = "data-run-window-entry";
/** Where a send notes, in the page's document, the entries its window showed right before the press. */
export const WINDOW_TURN_NOTE = "__stepWindowTurns";
/** From the call to the text box shown with its name: a window mounts once its page has loaded what it answers about. */
export const WINDOW_FIELD_BOUND_MS = 30_000;
/** From the press on the send control to the window taking the message: the product empties the box at once. */
export const WINDOW_SENT_BOUND_MS = 5_000;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const TYPE_IN_WINDOW_BOUNDS = Object.freeze({
  fieldMs: WINDOW_FIELD_BOUND_MS,
  actionMs: CONTROL_ACTION_BOUND_MS,
  sentMs: WINDOW_SENT_BOUND_MS,
  pollMs: CONTROL_POLL_MS,
});

/** A character typing cannot carry as text: a line break presses Enter, which sends, and a tab moves the focus. */
export const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

// Runs IN THE PAGE: nothing of this module may be used inside it. Puts the
// caret at the end of the marked box's text, or, with `all`, selects that text.
function placeCaret({ attribute, mark, all }) {
  const box = document.querySelector(`[${attribute}="${mark}"]`);
  if (!box) return false;
  if (box.localName === "input" || box.localName === "textarea") {
    const end = box.value.length;
    box.setSelectionRange(all ? 0 : end, end);
    return true;
  }
  const range = document.createRange();
  range.selectNodeContents(box);
  if (!all) range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * The typing road typeInWindow and sendInComposer share. It finds the one shown
 * text box of role textbox named `field` (inside the one shown part of the page
 * named `scope`, when given) within `bound.fieldMs`, types `text` into it
 * through the keyboard (with `replace`, in place of the text it holds), reads
 * the text back, and with `send` presses the box's own send control and waits,
 * within `bound.sentMs`, until the window has taken the message. `beforeSend`
 * runs right before that press. Refusals are the calling step's, `missing`
 * being the kind of the refusal for a box the page does not show. Resolves
 * `{ field, text, sent, path, inPart, pressedAt }`, where `text` is what the
 * box read back, `inPart` names the part of the page the box was looked for in
 * (for a line; empty without one) and `pressedAt` is the moment of the send.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   step: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   field: string,
 *   text: string,
 *   replace: boolean,
 *   send: boolean,
 *   scope: string,
 *   bound: { fieldMs: number, actionMs: number, sentMs: number, pollMs: number },
 *   missing: string,
 *   beforeSend?: (path: string) => Promise<void>,
 * }} road
 * @returns {Promise<{ field: string, text: string, sent: boolean, path: string, inPart: string, pressedAt: number }>}
 */
export async function typeThrough(page, { step, record, field, text, replace, send, scope, bound, missing, beforeSend }) {
  const nothing = "nothing was typed";
  const mark = newMark();
  const query = {
    mode: "window",
    field,
    within: scope,
    attribute: CONTROL_MARK,
    mark,
    listed: CONTROL_NAMES_LISTED,
    entry: RUN_WINDOW_ENTRY_ATTRIBUTE,
    noteKey: WINDOW_TURN_NOTE,
    note: "",
  };
  /** @returns {Promise<any>} */
  const read = (note = "") => within(page.evaluate(readControls, { ...query, note }), READING_BOUND_MS);
  const named = quotedName(field);
  try {
    // The box, shown with its name: a window mounts once its page has loaded.
    const waitedFrom = performance.now();
    /** @type {any} */
    let reading = null;
    for (;;) {
      reading = (await read()) ?? reading;
      if (reading && (reading.found > 0 || (reading.scope && reading.scope.found > 1))) break;
      const remaining = bound.fieldMs - (performance.now() - waitedFrom);
      if (remaining <= 0) break;
      await pause(Math.min(bound.pollMs, remaining));
    }
    if (!reading) throw refuse(step, record, "unreadable", `the text boxes on ${pathOf(page.url())} could not be read — ${nothing}`);
    const part = reading.scope;
    if (part && part.found === 0) {
      throw refuse(
        step,
        record,
        "no-scope",
        `no shown part of the page on ${reading.path} is named ${quotedName(scope)} within ${bound.fieldMs} ms — the named parts it shows: ${describeNames(part.parts)}; ${nothing}`,
      );
    }
    if (part && part.found > 1) {
      const where = part.matches.map((/** @type {any} */ one, /** @type {number} */ index) => `${index + 1} a ${one.kind} ${describePart(one.part)}`).join(", ");
      throw refuse(
        step,
        record,
        "ambiguous",
        `${part.found} shown parts of the page on ${reading.path} are named ${quotedName(scope)}${unspacedNote(part.unspaced, part.named)}: ${where} — ${nothing}, since typing never guesses`,
      );
    }
    const inPart = part ? ` in the ${part.kind} ${quotedName(scope)}` : "";
    const at = `${inPart} on ${reading.path}`;
    if (reading.found === 0) {
      throw refuse(step, record, missing, `no shown text box${at} is named ${named} within ${bound.fieldMs} ms — the text boxes it shows: ${describeNames(reading.boxes)}; ${nothing}`);
    }
    if (reading.found > 1) {
      throw refuse(
        step,
        record,
        "ambiguous",
        `${reading.found} shown text boxes${at} are named ${named}${unspacedNote(reading.unspaced, reading.named)}: ${describeMatches(reading.matches)} — ${nothing}, since typing never guesses`,
      );
    }
    if (!reading.editable) {
      throw refuse(step, record, "disabled", `the text box ${named}${at} cannot be typed into: it is locked, as a window's box is while its answer is pending — ${nothing}`);
    }
    /** The refusal of a send control that is not there, or not one. */
    const noSend = (/** @type {any} */ now, /** @type {string} */ done) =>
      now.sends === 0
        ? refuse(step, record, "no-control", `the text box ${named}${at} has no shown send control beside it, a button named ${named} — the buttons nearest to it: ${describeNames(now.beside)}; ${done}`)
        : refuse(step, record, "ambiguous", `the text box ${named}${at} has ${now.sends} shown send controls beside it, buttons named ${named} — ${done}, since a send never guesses`);
    if (send && reading.sends !== 1) throw noSend(reading, nothing);

    // Typed as a person types: pressed into, the caret put at the end of its text (or its text selected), and key by key.
    try {
      await page.locator(markedBy(`${mark}t`)).click({ timeout: bound.actionMs });
      const placed = await within(page.evaluate(placeCaret, { attribute: CONTROL_MARK, mark: `${mark}t`, all: replace }), READING_BOUND_MS);
      if (!placed) throw new Error("the box was gone before the caret was put in it");
      if (replace && reading.text !== "") await page.keyboard.press("Backspace");
      await page.keyboard.type(text);
    } catch (error) {
      // The driver's own message can repeat what it was given to type: only the error's class is kept.
      throw refuse(step, record, "driver-failure", `the text box ${named}${at} could not be typed into (${errorClass(error)})`);
    }

    // Read back from the box, found by its name again: the page may have drawn it anew.
    const back = await read();
    const expected = replace ? text : `${reading.text}${text}`;
    if (!back || back.found !== 1 || back.text !== expected) {
      throw refuse(step, record, "not-typed", `the text box ${named}${at} does not read back the text typed into it — ${send ? "nothing was sent" : "the text stays in the box"}`);
    }
    if (!send) return { field, text: back.text, sent: false, path: back.path, inPart, pressedAt: performance.now() };

    // Right before the press: the entries the window shows, noted in the document for the wait that follows.
    const kept = "the text stays in the box, and nothing was sent";
    const noted = await read("set");
    if (!noted || noted.found !== 1) throw refuse(step, record, "unreadable", `the text box ${named}${at} could not be read before the send — ${kept}`);
    if (noted.sends !== 1) throw noSend(noted, kept);
    if (beforeSend) await beforeSend(noted.path);
    try {
      // `noWaitAfter`: the press returns once made; the window taking the message is read below.
      await page.locator(markedBy(`${mark}s`)).click({ timeout: bound.actionMs, noWaitAfter: true });
    } catch (error) {
      throw refuse(step, record, "driver-failure", `the send control of the text box ${named}${at} could not be pressed (${errorClass(error)}) — the text stays in the box`);
    }
    const pressedAt = performance.now();
    // Taken: the window empties its box as it takes the message.
    for (;;) {
      const now = await read();
      if (now && now.found === 1 && now.text.trim() === "") return { field, text: back.text, sent: true, path: now.path, inPart, pressedAt };
      const remaining = bound.sentMs - (performance.now() - pressedAt);
      if (remaining <= 0) break;
      await pause(Math.min(bound.pollMs, remaining));
    }
    throw refuse(
      step,
      record,
      "not-sent",
      `the press on the send control of the text box ${named}${at} did not send the message: the box still held it ${bound.sentMs} ms after the press`,
    );
  } finally {
    await within(page.evaluate(unmarkControls, { attribute: CONTROL_MARK, mark }), READING_BOUND_MS);
  }
}

/**
 * Type `text` into the one shown text box of role textbox named `field` on the
 * caller's page (inside the one shown part of the page named `within`, when
 * given), through the keyboard, and resolve `{ field, text, sent, path }` once
 * the box reads the text back: `text` is what it read back (the text it held
 * before, then the text typed, or with `replace` the text typed alone), and
 * `sent` whether the message was sent. With `send`, it presses the box's own
 * send control, the shown button of the box's name nearest to it, and resolves
 * once the window has taken the message (the product empties the box as it
 * takes it). Refuses, as a StepRefusal: `input` (nothing was typed),
 * `unreadable`, `no-scope`, `no-field` (naming the text boxes the page shows),
 * `ambiguous` and `disabled` (the box is locked, as a window's is while its
 * answer is pending), and with `send` `no-control` (no send control beside the
 * box, naming the buttons nearest to it), all before anything is typed;
 * `driver-failure`, `not-typed` (the box does not read back what was typed)
 * and `not-sent` (the window did not take the message within the bound). No
 * line carries the text.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   field: string,
 *   text: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   send?: boolean,
 *   replace?: boolean,
 *   within?: string,
 *   bounds?: Partial<Record<keyof typeof TYPE_IN_WINDOW_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ field: string, text: string, sent: boolean, path: string }>}
 */
export async function typeInWindow(page, { field, text, record, send = false, replace = false, within: scope, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was typed";
  const input = (/** @type {string} */ why) => refuse(STEP, record, "input", `${why} — ${nothing}`);
  const wanted = plainName(field);
  if (typeof field !== "string" || wanted === "") throw input(`name the text box by its accessible name, such as ${RUN_WINDOW_FIELD}`);
  if (typeof text !== "string" || text === "") throw input("hand the step the text to type");
  if (CONTROL_CHARACTER.test(text)) throw input("the text is typed key by key, so it may hold no line break or other control character: a line break would press Enter");
  if (typeof send !== "boolean") throw input("send must be true or false");
  if (typeof replace !== "boolean") throw input("replace must be true or false");
  const scopeName = plainName(scope);
  if (scope !== undefined && (typeof scope !== "string" || scopeName === "")) {
    throw input("name the part of the page by the name of a landmark, a heading or a labelled section, such as Review");
  }
  const bound = readBounds(STEP, record, TYPE_IN_WINDOW_BOUNDS, bounds, nothing);

  const typed = await typeThrough(page, { step: STEP, record, field: wanted, text, replace, send, scope: scopeName, bound, missing: "no-field" });
  const act = replace ? "replaced the text of" : "typed into";
  const took = typed.sent ? ", and pressed its send control: the window took the message" : "";
  record(`${STEP}: ${act} the text box ${quotedName(wanted)}${typed.inPart} on ${typed.path}${took}`);
  return { field: wanted, text: typed.text, sent: typed.sent, path: typed.path };
}
