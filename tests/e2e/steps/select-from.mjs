// selectFrom: an entry selected by its visible text in a picker found by its
// accessible name, and the selection waited for until the page reflects it.
//
// WHY IT EXISTS. A selection typed by hand clicked an option by a selector and
// read the page at once: a picker that opens its list first, or a page that
// takes a moment to take the choice, left the run reading the old value. This
// step finds the picker and the entry by name, selects the entry the way the
// picker takes it, and returns only once the selection shows.
//
// THE PICKERS, each found by its accessible name:
//   - a select: the entry is one of its options, selected as a person selects it;
//   - a radio group (`role="radiogroup"`, or a fieldset or group that holds
//     radios): the entry is one of its radios, by its label, and is checked;
//   - a listbox: the entry is one of its options, and is pressed;
//   - a combobox that is not a text field: it is pressed first to open the list
//     it controls (`aria-controls`), and the entry is one of that list's options;
//   - a search field, a combobox that is a text input (the entity search draws
//     one): the entry's text is typed into it, and the entry is one of the
//     options of the list that opens (see SEARCHED).
//
// A COMBOBOX WITH NO ACCESSIBLE NAME, as the shared select draws one, is found
// once no picker carries the name, by the text a person reads for it, road by
// road: the placeholder it shows, the value it shows, or the label element
// before it in its form group. More than one match on the road that finds one
// is refused, as a name several pickers carry is. A search field with no
// accessible name is found the same way: by its placeholder while it is empty,
// or by the text it holds.
//
// OPENED. Once the step has opened a combobox, it reads it again by the mark it
// put on it before opening, never by its name: while the list is open, the
// shared select hides everything outside it from assistive technology, the
// combobox included, so no name finds the combobox then.
//
// CLOSED. A combobox the step opened is waited for until its list has closed,
// when the list still hides the combobox from assistive technology once the
// choice shows: the shared select shows the choice while its list is still
// closing, and while it is open it hides the rest of the page, so the next pick
// on the page would find no picker. The wait reads the combobox by its mark, as
// the open wait does, with the same bound, and refuses a list that stays open.
//
// SEARCHED. A search field lists its entries only once text is typed into it.
// The step types the entry's text, reads the field again by its mark (the
// typed text has hidden its placeholder and changed its value), and waits,
// within the reflect bound, until its list shows an option of the entry's name.
// A search list draws each entry as a row, the entry's name first and then
// what tells it apart (a detail line, a status), so an option is named by its
// first text. The one option of the name is pressed; several are refused, and
// none, once the bound has run out, is refused naming the entries the list
// showed. The choice is read back from the page, never from the list: the row
// a list marks selected is its active one, the one a key press would choose.
// The field shows the entry once its list has closed, or the page draws the
// entry (a row, a chip) more often than before the press. The field or the page
// showing another entry of the list instead is refused.
//
// READ, NOT CHOSEN. readOptions finds the picker as selectFrom finds it and
// reads its entries in the page's order and the entry it shows, choosing
// nothing. A combobox whose list is not shown is opened as selectFrom opens it,
// read by its mark (see OPENED), and closed again with the Escape key, the
// list's own close; the step then waits for the list itself to close, read as
// CLOSED reads it, whether or not the list hides the page.
//
// REFLECTED. The selection shows when the entry reads as selected (a select's
// selected option, a checked radio, an option or radio marked selected or
// checked, a combobox that shows the entry), or when the page confirms it: a
// live region (a status, an alert, a toast) that names the entry and did not
// before the selection. A search field's choice shows as SEARCHED says.
import {
  CONTROL_ACTION_BOUND_MS,
  CONTROL_HYDRATION_BOUND_MS,
  CONTROL_MARK,
  CONTROL_NAMES_LISTED,
  CONTROL_POLL_MS,
  describeNames,
  markedBy,
  newMark,
  plainName,
  quotedName,
  readPageControls,
  unmarkControls,
  unspacedNote,
  waitForPageHydration,
} from "./page-controls.mjs";
import { READING_BOUND_MS, elapsedSince, errorClass, pathOf, pause, readBounds, refuse, requireRecord, within } from "./step-kit.mjs";

const STEP = "selectFrom";

/** What a combobox with no accessible name was found by, for a line: of one, and of several. */
const STAND_INS = Object.freeze({
  placeholder: ["its placeholder", "their placeholder"],
  value: ["its value", "their value"],
  label: ["the label before it", "the label before them"],
});

/** How a line says what showed a search field's choice. */
const SHOWN_BY = Object.freeze({ page: "the page draws it", field: "the field shows it" });

/**
 * From the selection to the page reflecting it; from opening a combobox to its
 * entries showing; from the selection to its list's close; from typing into a
 * search field to its entry in the list.
 */
export const SELECT_REFLECT_BOUND_MS = 5_000;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const SELECT_BOUNDS = Object.freeze({
  actionMs: CONTROL_ACTION_BOUND_MS,
  reflectMs: SELECT_REFLECT_BOUND_MS,
  pollMs: CONTROL_POLL_MS,
});

/**
 * The combobox the step opened, read by its mark, hidden from assistive
 * technology still: its list has not closed (see CLOSED).
 * @param {import("@playwright/test").Page} page
 * @param {string} mark
 */
const hidesCombobox = (page, mark) =>
  within(
    page.evaluate((selector) => {
      const combobox = document.querySelector(selector);
      return Boolean(combobox && combobox.closest("[aria-hidden='true']"));
    }, markedBy(`${mark}p`)),
    READING_BOUND_MS,
  );

/**
 * Waits until the list of the combobox the step opened has closed: the
 * combobox, read by its mark, reads closed and is hidden from assistive
 * technology no longer (see CLOSED), within `bound.reflectMs` of the call. With
 * `onlyWhileHidden`, a combobox that is not hidden when the wait starts is not
 * waited for (`waited` false). Answers whether the list closed, and after how
 * long.
 * @param {import("@playwright/test").Page} page
 * @param {{ mark: string, readMarked: () => Promise<any>, bound: { reflectMs: number, pollMs: number }, onlyWhileHidden: boolean }} wait
 * @returns {Promise<{ closed: boolean, waited: boolean, elapsedMs: number }>}
 */
async function waitForClose(page, { mark, readMarked, bound, onlyWhileHidden }) {
  const closingAt = performance.now();
  if (onlyWhileHidden && !(await hidesCombobox(page, mark))) return { closed: true, waited: false, elapsedMs: 0 };
  for (;;) {
    const closed = await readMarked();
    if (closed && closed.found === 1 && !closed.open && !(await hidesCombobox(page, mark))) break;
    const remaining = bound.reflectMs - (performance.now() - closingAt);
    if (remaining <= 0) return { closed: false, waited: true, elapsedMs: elapsedSince(closingAt) };
    await pause(Math.min(bound.pollMs, remaining));
  }
  return { closed: true, waited: true, elapsedMs: elapsedSince(closingAt) };
}

/**
 * Select `entry` (by its visible text) in the one shown picker, radio group or
 * listbox whose accessible name is `picker` (or, when none is, in the one shown
 * combobox with no accessible name that shows `picker` as its placeholder or
 * its value, or follows a label element of that text), and resolve
 * `{ picker, entry, kind, via, path, elapsedMs }` once the page reflects the
 * selection: `kind` is `select`, `radiogroup`, `listbox`, `combobox` or
 * `search`, and `via` is `state` (the entry reads as selected, or a search
 * field's page shows it) or `confirmation` (the page names it in a live
 * region). Refuses, as a StepRefusal, arguments it cannot use, a name no shown
 * picker carries (`no-picker`, naming those it shows), a name several pickers
 * or entries carry (`ambiguous`), an entry the picker does not have or a search
 * does not list (`no-entry`, naming its entries), a disabled picker or entry
 * (`disabled`), a selection that could not be made (`driver-failure`), a search
 * field's choice the page takes as another entry (`other-entry`) and a
 * selection the page does not reflect within the bound (`not-reflected`) and a
 * list that still hides the page once the bound has run out after the choice
 * (`not-closed`).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   picker: string,
 *   entry: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof SELECT_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ picker: string, entry: string, kind: string, via: "state" | "confirmation", path: string, elapsedMs: number }>}
 */
export async function selectFrom(page, { picker, entry, record, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was selected";
  const pickerName = plainName(picker);
  const entryText = plainName(entry);
  if (typeof picker !== "string" || pickerName === "") throw refuse(STEP, record, "input", `name the picker by its accessible name, such as Size — ${nothing}`);
  if (typeof entry !== "string" || entryText === "") throw refuse(STEP, record, "input", `name the entry by its visible text, such as Medium — ${nothing}`);
  const bound = readBounds(STEP, record, SELECT_BOUNDS, bounds, nothing);
  let pickerNamed = quotedName(pickerName);
  const entryNamed = quotedName(entryText);

  const from = pathOf(page.url());
  const mark = newMark();
  const query = { mode: "picker", picker: pickerName, entry: entryText, attribute: CONTROL_MARK, mark, listed: CONTROL_NAMES_LISTED };
  const read = () => within(readPageControls(page, query), READING_BOUND_MS);
  // The picker the step has opened, read again by its mark (see OPENED).
  const readMarked = () => within(readPageControls(page, { ...query, marked: true }), READING_BOUND_MS);
  let openedHere = false;
  // Waits until the list the step opened has closed; answers what the log line adds.
  const waitForListToClose = async (entryNamed) => {
    const closing = await waitForClose(page, { mark, readMarked, bound, onlyWhileHidden: true });
    if (!closing.closed) {
      throw refuse(STEP, record, "not-closed", `the list of the picker ${pickerNamed} on ${from} did not close within ${bound.reflectMs} ms of the selection of ${entryNamed}`);
    }
    return closing.waited ? `; its list closed after ${closing.elapsedMs} ms` : "";
  };
  // Read only once the page has hydrated: a mark written before React has compared its element is a hydration mismatch.
  if (!(await waitForPageHydration(page))) {
    throw refuse(STEP, record, "unreadable", `the page on ${from} did not hydrate within ${CONTROL_HYDRATION_BOUND_MS} ms — ${nothing}`);
  }
  try {
    let reading = await read();
    if (!reading) throw refuse(STEP, record, "unreadable", `the pickers on ${from} could not be read — ${nothing}`);
    if (reading.found === 0) {
      throw refuse(
        STEP,
        record,
        "no-picker",
        `no shown picker, radio group or listbox on ${from} is named ${pickerNamed} — the pickers it shows: ${describeNames(reading.pickers)}; ${nothing}`,
      );
    }
    const standIn = STAND_INS[reading.by];
    const noName = reading.fallbackNamed ? "no explicit accessible name" : "no accessible name";
    if (reading.found > 1 && standIn) {
      throw refuse(
        STEP,
        record,
        "ambiguous",
        `${reading.found} shown comboboxes on ${from} have ${noName} and are found by ${standIn[1]}: ${pickerNamed}${unspacedNote(reading.unspaced, reading.named)} — ${nothing}, since a selection never guesses`,
      );
    }
    if (reading.found > 1) {
      throw refuse(
        STEP,
        record,
        "ambiguous",
        `${reading.found} shown pickers on ${from} are named ${pickerNamed}${unspacedNote(reading.unspaced, reading.named)} — ${nothing}, since a selection never guesses`,
      );
    }
    // A line says what a combobox with no accessible name was found by.
    if (standIn) pickerNamed = `${pickerNamed} (a combobox with ${noName}, found by ${standIn[0]})`;
    if (reading.disabled) throw refuse(STEP, record, "disabled", `the picker ${pickerNamed} on ${from} is disabled — ${nothing}`);

    if (reading.kind === "search") {
      // A search field lists its entries only once the entry's text is typed into it (see SEARCHED).
      try {
        await page.locator(markedBy(`${mark}p`)).fill(entryText, { timeout: bound.actionMs });
      } catch (error) {
        throw refuse(STEP, record, "driver-failure", `the text of ${entryNamed} could not be typed into the picker ${pickerNamed} on ${from} (${errorClass(error)}) — ${nothing}`);
      }
      const typedAt = performance.now();
      let last = null;
      for (;;) {
        const listed = await readMarked();
        if (listed && listed.found === 1) last = listed;
        if (last && last.open && last.entryFound > 0) {
          reading = last;
          break;
        }
        const remaining = bound.reflectMs - (performance.now() - typedAt);
        if (remaining <= 0) {
          if (!last || !last.open) {
            throw refuse(STEP, record, "no-entry", `the picker ${pickerNamed} on ${from} showed no list of entries within ${bound.reflectMs} ms of typing ${entryNamed} — ${nothing}`);
          }
          throw refuse(
            STEP,
            record,
            "no-entry",
            `the list of the picker ${pickerNamed} on ${from} showed no entry ${entryNamed} within ${bound.reflectMs} ms of typing it — the entries it showed: ${describeNames(last.entries)}; ${nothing}`,
          );
        }
        await pause(Math.min(bound.pollMs, remaining));
      }
    } else if (!reading.open) {
      // A combobox shows its entries only once it is open.
      try {
        await page.locator(markedBy(`${mark}p`)).click({ timeout: bound.actionMs, noWaitAfter: true });
      } catch (error) {
        throw refuse(STEP, record, "driver-failure", `the picker ${pickerNamed} on ${from} could not be opened (${errorClass(error)}) — ${nothing}`);
      }
      openedHere = true;
      const openedAt = performance.now();
      for (;;) {
        const opened = await readMarked();
        if (opened && opened.found === 1 && opened.open) {
          reading = opened;
          break;
        }
        const remaining = bound.reflectMs - (performance.now() - openedAt);
        if (remaining <= 0) {
          throw refuse(STEP, record, "no-entry", `the picker ${pickerNamed} on ${from} showed no list of entries within ${bound.reflectMs} ms of being opened — ${nothing}`);
        }
        await pause(Math.min(bound.pollMs, remaining));
      }
    }

    if (reading.entryFound === 0) {
      throw refuse(STEP, record, "no-entry", `the picker ${pickerNamed} on ${from} has no entry ${entryNamed} — its entries: ${describeNames(reading.entries)}; ${nothing}`);
    }
    if (reading.entryFound > 1) {
      throw refuse(
        STEP,
        record,
        "ambiguous",
        `the picker ${pickerNamed} on ${from} has ${reading.entryFound} entries ${entryNamed}${unspacedNote(reading.entryUnspaced, reading.entryNamed)} — ${nothing}, since a selection never guesses`,
      );
    }
    if (reading.entryDisabled) throw refuse(STEP, record, "disabled", `the entry ${entryNamed} of the picker ${pickerNamed} on ${from} is disabled — ${nothing}`);

    // The selection, the way the picker takes it.
    const { kind, index } = reading;
    const before = reading.live;
    try {
      if (kind === "select") {
        await page.locator(markedBy(`${mark}p`)).selectOption({ index }, { timeout: bound.actionMs });
      } else if (reading.native) {
        await page.locator(markedBy(`${mark}e`)).check({ timeout: bound.actionMs });
      } else {
        await page.locator(markedBy(`${mark}e`)).click({ timeout: bound.actionMs, noWaitAfter: true });
      }
    } catch (error) {
      throw refuse(STEP, record, "driver-failure", `the entry ${entryNamed} of the picker ${pickerNamed} on ${from} could not be selected (${errorClass(error)})`);
    }

    const selectedAt = performance.now();
    const { drawn } = reading;
    // The page shows the entry as it reads it, which may differ from the wanted text in white space.
    const shownAs = reading.chosen || entryText;
    for (;;) {
      const shown = await within(readPageControls(page, { mode: "reflected", kind, index, entry: shownAs, before, drawn, attribute: CONTROL_MARK, mark }), READING_BOUND_MS);
      const elapsedMs = elapsedSince(selectedAt);
      if (shown && shown.instead) {
        const where = shown.instead.where === "field" ? "the field shows" : "the page draws";
        throw refuse(
          STEP,
          record,
          "other-entry",
          `the press on ${entryNamed} in the list of the picker ${pickerNamed} on ${from} took another entry: ${where} ${quotedName(shown.instead.text)}`,
        );
      }
      if (shown && (shown.state || shown.confirmation)) {
        const via = shown.state ? "state" : "confirmation";
        const how = shown.state
          ? `${SHOWN_BY[shown.shows] ?? "its selected state shows it"} after ${elapsedMs} ms`
          : `the page confirms it after ${elapsedMs} ms: ${quotedName(shown.confirmation)}`;
        const closedNote = openedHere ? await waitForListToClose(entryNamed) : "";
        record(`${STEP}: selected ${entryNamed} in the picker ${pickerNamed} on ${from} — ${how}${closedNote}`);
        return { picker: pickerName, entry: entryText, kind, via, path: shown.path, elapsedMs };
      }
      if (elapsedMs >= bound.reflectMs) break;
      await pause(Math.min(bound.pollMs, bound.reflectMs - elapsedMs));
    }
    const unseen =
      kind === "search"
        ? "the field does not show it with its list closed, and no new text on the page names it"
        : "the entry does not read as selected, and the page shows no confirmation that names it";
    throw refuse(
      STEP,
      record,
      "not-reflected",
      `the selection of ${entryNamed} in the picker ${pickerNamed} on ${from} was not reflected within ${bound.reflectMs} ms: ${unseen}`,
    );
  } finally {
    await within(page.evaluate(unmarkControls, { attribute: CONTROL_MARK, mark }), READING_BOUND_MS);
  }
}

const READ_STEP = "readOptions";

/**
 * Read the entries of the one shown picker, radio group or listbox whose
 * accessible name is `picker` (found as selectFrom finds it), in the page's
 * order, and the entry it shows as chosen, choosing nothing; write them on one
 * line, and resolve `{ picker, kind, entries, more, shows, path }`: `entries`
 * the names of at most CONTROL_NAMES_LISTED entries, `more` the count of the
 * rest, and `shows` the entry the picker showed when the step found it (the
 * empty string when it shows none). A select, a radio group, a listbox, and a
 * combobox whose list is shown already, are read as they are; a combobox whose
 * list is not shown is opened as selectFrom opens it, read, and closed again
 * with the Escape key, and the step waits until the list has closed. Refuses,
 * as a StepRefusal, arguments it cannot use (`input`), a page it cannot read
 * (`unreadable`), a name no shown picker carries (`no-picker`), a name several
 * pickers carry (`ambiguous`), a disabled picker (`disabled`), a search field,
 * which lists entries only for typed text (`no-list`), a combobox whose list
 * does not show once it is opened (`no-entry`), a press or a key the page does
 * not take (`driver-failure`) and a list that does not close within the bound
 * of the Escape key (`not-closed`).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   picker: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof SELECT_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ picker: string, kind: string, entries: string[], more: number, shows: string, path: string }>}
 */
export async function readOptions(page, { picker, record, bounds } = /** @type {any} */ ({})) {
  requireRecord(READ_STEP, record);
  const nothing = "nothing was read";
  const pickerName = plainName(picker);
  if (typeof picker !== "string" || pickerName === "") throw refuse(READ_STEP, record, "input", `name the picker by its accessible name, such as Size — ${nothing}`);
  const bound = readBounds(READ_STEP, record, SELECT_BOUNDS, bounds, nothing);
  let pickerNamed = quotedName(pickerName);

  const from = pathOf(page.url());
  const mark = newMark();
  const query = { mode: "picker", picker: pickerName, attribute: CONTROL_MARK, mark, listed: CONTROL_NAMES_LISTED };
  // The picker the step has opened, read again by its mark (see OPENED).
  const readMarked = () => within(readPageControls(page, { ...query, marked: true }), READING_BOUND_MS);
  // Read only once the page has hydrated: a mark written before React has compared its element is a hydration mismatch.
  if (!(await waitForPageHydration(page))) {
    throw refuse(READ_STEP, record, "unreadable", `the page on ${from} did not hydrate within ${CONTROL_HYDRATION_BOUND_MS} ms — ${nothing}`);
  }
  try {
    const first = await within(readPageControls(page, query), READING_BOUND_MS);
    if (!first) throw refuse(READ_STEP, record, "unreadable", `the pickers on ${from} could not be read — ${nothing}`);
    if (first.found === 0) {
      throw refuse(
        READ_STEP,
        record,
        "no-picker",
        `no shown picker, radio group or listbox on ${from} is named ${pickerNamed}; the pickers it shows: ${describeNames(first.pickers)} — ${nothing}`,
      );
    }
    const standIn = STAND_INS[first.by];
    const noName = first.fallbackNamed ? "no explicit accessible name" : "no accessible name";
    if (first.found > 1 && standIn) {
      throw refuse(
        READ_STEP,
        record,
        "ambiguous",
        `${first.found} shown comboboxes on ${from} have ${noName} and are found by ${standIn[1]}: ${pickerNamed}${unspacedNote(first.unspaced, first.named)}, and a reading never guesses — ${nothing}`,
      );
    }
    if (first.found > 1) {
      throw refuse(
        READ_STEP,
        record,
        "ambiguous",
        `${first.found} shown pickers on ${from} are named ${pickerNamed}${unspacedNote(first.unspaced, first.named)}, and a reading never guesses — ${nothing}`,
      );
    }
    // A line says what a combobox with no accessible name was found by.
    if (standIn) pickerNamed = `${pickerNamed} (a combobox with ${noName}, found by ${standIn[0]})`;
    if (first.disabled) throw refuse(READ_STEP, record, "disabled", `the picker ${pickerNamed} on ${from} is disabled — ${nothing}`);
    if (first.kind === "search") throw refuse(READ_STEP, record, "no-list", `the picker ${pickerNamed} on ${from} is a search field, which lists entries only for typed text — ${nothing}`);

    let reading = first;
    let closedNote = "";
    if (!first.open) {
      // A combobox shows its entries only once it is open: opened as selectFrom opens it.
      try {
        await page.locator(markedBy(`${mark}p`)).click({ timeout: bound.actionMs, noWaitAfter: true });
      } catch (error) {
        throw refuse(READ_STEP, record, "driver-failure", `the picker ${pickerNamed} on ${from} could not be opened (${errorClass(error)}) — ${nothing}`);
      }
      const openedAt = performance.now();
      for (;;) {
        const opened = await readMarked();
        if (opened && opened.found === 1 && opened.open) {
          reading = opened;
          break;
        }
        const remaining = bound.reflectMs - (performance.now() - openedAt);
        if (remaining <= 0) {
          throw refuse(READ_STEP, record, "no-entry", `the picker ${pickerNamed} on ${from} showed no list of entries within ${bound.reflectMs} ms of being opened — ${nothing}`);
        }
        await pause(Math.min(bound.pollMs, remaining));
      }
      // The list's own close, the Escape key, and nothing chosen; then the wait for the list itself.
      const pressed = await within(page.keyboard.press("Escape").then(() => true), bound.actionMs);
      if (!pressed) {
        throw refuse(READ_STEP, record, "driver-failure", `the Escape key could not be pressed within ${bound.actionMs} ms to close the list of the picker ${pickerNamed} on ${from}`);
      }
      const closing = await waitForClose(page, { mark, readMarked, bound, onlyWhileHidden: false });
      if (!closing.closed) {
        throw refuse(READ_STEP, record, "not-closed", `the list of the picker ${pickerNamed} on ${from} did not close within ${bound.reflectMs} ms of the Escape key`);
      }
      closedNote = `; its list closed after ${closing.elapsedMs} ms`;
    }

    const { names, more } = reading.entries;
    const shows = first.shows || "";
    record(`${READ_STEP}: the picker ${pickerNamed} on ${from} lists ${describeNames(reading.entries)} in this order and ${shows ? `shows ${quotedName(shows)}` : "shows no entry"}${closedNote}`);
    return { picker: pickerName, kind: reading.kind, entries: names, more, shows, path: from };
  } finally {
    await within(page.evaluate(unmarkControls, { attribute: CONTROL_MARK, mark }), READING_BOUND_MS);
  }
}
