// waitForTurn: a turn of a window's conversation waited for, without a reload:
// a new entry of the assistant stands in the window, and its send control is
// idle again.
//
// WHY IT EXISTS. After a message was sent in a run window or a review window,
// nothing waited for the answer: a run reloaded the page to read it, which
// reads what the run stored and not the window a person watches, or it slept.
//
// THE ENTRIES. The product marks each entry of a window's conversation with
// `data-run-window-entry`: `person` or `assistant`. The step counts the shown
// ones in the page, or in the one shown part of it named `within`, for a page
// that shows more than one window.
//
// IDLE. The window is named by its text box: the run window's "Apply AI
// suggestion" unless `field` names another, found with the reader of the
// control steps as typeInWindow finds it. While an answer is pending, the
// product locks the box and gives the send control its stop name. The send
// control is idle once the box takes text again and a shown button of the
// box's own name stands beside it again.
//
// FROM THE SEND. A send made by typeInWindow notes, in the page's document, the
// entries its window showed right before the press. The wait counts from that
// note when there is one for the same window (the same `field` and `within`),
// so an answer that stood before the wait began is still the new turn; without
// one it counts from its own first reading. A wait that sees the turn takes the
// note away, and a new document has none.
//
// NEVER A RELOAD. The step only reads the page, on a fixed cadence, until a new
// entry of the assistant stands and the send control is idle, or its bound runs
// out; it then refuses, and names what was missing. The bound may be raised up
// to a ceiling, and no further: a turn that takes longer is not coming.
import { CONTROL_MARK, CONTROL_NAMES_LISTED, describeMatches, describeNames, describePart, plainName, quotedName, readControls, unspacedNote } from "./page-controls.mjs";
import { READING_BOUND_MS, elapsedSince, pathOf, pause, readBounds, refuse, requireRecord, within } from "./step-kit.mjs";
import { RUN_WINDOW_ENTRY_ATTRIBUTE, RUN_WINDOW_FIELD, WINDOW_TURN_NOTE } from "./type-in-window.mjs";

const STEP = "waitForTurn";

/** From the start of the wait to the turn: an answer that calls a model and its tools can take a minute or two. */
export const TURN_BOUND_MS = 120_000;
/** The most `turnMs` may be raised to. A turn that takes longer is not coming. */
export const TURN_CEILING_MS = 600_000;
/** How often the window is read. */
export const TURN_POLL_MS = 250;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const WAIT_FOR_TURN_BOUNDS = Object.freeze({ turnMs: TURN_BOUND_MS, pollMs: TURN_POLL_MS });

/**
 * How the counts moved, for a line.
 * @param {{ person: number, assistant: number }} before
 * @param {{ person: number, assistant: number }} after
 */
function moved(before, after) {
  const how = (/** @type {number} */ from, /** @type {number} */ to) => (from === to ? `stayed at ${to}` : `went from ${from} to ${to}`);
  return `the person's entries ${how(before.person, after.person)} and the assistant's ${how(before.assistant, after.assistant)}`;
}

/** Whether a reading shows the window's send control idle: the box takes text, and a send control of its name stands beside it. */
const isIdle = (/** @type {any} */ reading) => Boolean(reading && reading.found === 1 && reading.editable && reading.sends > 0);

/**
 * Why a reading shows the send control not idle, for a refusal.
 * @param {any} reading
 */
function notIdle(reading) {
  if (!reading) return "the window could not be read at the last reading";
  if (reading.found !== 1) return "the window was not shown at the last reading";
  const why = [];
  if (!reading.editable) why.push("the text box is locked");
  if (reading.sends === 0) why.push(reading.beside.names.length > 0 ? `the buttons nearest to it read ${describeNames(reading.beside)}` : "no button is shown near it");
  return why.join(", and ");
}

/**
 * Wait, never reloading, until a new entry of the assistant stands in the
 * window of the caller's page whose text box is named `field` (the run window's
 * "Apply AI suggestion" unless named otherwise; inside the one shown part of
 * the page named `within`, when given) and the window's send control is idle,
 * and resolve `{ field, before, after, since, elapsedMs, path }`: `before` and
 * `after` count the entries of the person and of the assistant
 * (`{ person, assistant }`), `since` is `send` when `before` is the note of a
 * send typeInWindow made in the same window and `wait` when it is the wait's
 * own first reading, and `elapsedMs` is the time it waited. Refuses, as a
 * StepRefusal: `input` (nothing was waited for; `turnMs` above
 * TURN_CEILING_MS included), `unreadable`, `no-scope`, `no-window` (naming the
 * text boxes the page shows) and `ambiguous`, all at once, and `no-turn` at the
 * bound, naming what was missing: the new entry, the idle send control, or both.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   record: import("./step-kit.mjs").StepRecord,
 *   field?: string,
 *   within?: string,
 *   bounds?: Partial<Record<keyof typeof WAIT_FOR_TURN_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ field: string, before: { person: number, assistant: number }, after: { person: number, assistant: number }, since: "send" | "wait", elapsedMs: number, path: string }>}
 */
export async function waitForTurn(page, { record, field = RUN_WINDOW_FIELD, within: scope, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was waited for";
  const input = (/** @type {string} */ why) => refuse(STEP, record, "input", `${why} — ${nothing}`);
  const wanted = plainName(field);
  if (typeof field !== "string" || wanted === "") throw input(`name the window by the accessible name of its text box, such as ${RUN_WINDOW_FIELD}`);
  const scopeName = plainName(scope);
  if (scope !== undefined && (typeof scope !== "string" || scopeName === "")) {
    throw input("name the part of the page by the name of a landmark, a heading or a labelled section, such as Review");
  }
  const bound = readBounds(STEP, record, WAIT_FOR_TURN_BOUNDS, bounds, nothing);
  if (bound.turnMs > TURN_CEILING_MS) throw input(`turnMs may be raised up to ${TURN_CEILING_MS} ms and no further`);

  // The window is only read: no mark is put on it.
  const query = {
    mode: "window",
    field: wanted,
    within: scopeName,
    attribute: CONTROL_MARK,
    mark: "",
    listed: CONTROL_NAMES_LISTED,
    entry: RUN_WINDOW_ENTRY_ATTRIBUTE,
    noteKey: WINDOW_TURN_NOTE,
    note: "",
  };
  /** @returns {Promise<any>} */
  const read = (note = "") => within(page.evaluate(readControls, { ...query, note }), READING_BOUND_MS);
  const named = quotedName(wanted);
  const start = performance.now();
  const first = await read();
  const on = pathOf(page.url());
  if (!first) throw refuse(STEP, record, "unreadable", `the window on ${on} could not be read — ${nothing}`);
  const part = first.scope;
  if (part && part.found === 0) {
    throw refuse(STEP, record, "no-scope", `no shown part of the page on ${first.path} is named ${quotedName(scopeName)} — the named parts it shows: ${describeNames(part.parts)}; ${nothing}`);
  }
  if (part && part.found > 1) {
    const where = part.matches.map((/** @type {any} */ one, /** @type {number} */ index) => `${index + 1} a ${one.kind} ${describePart(one.part)}`).join(", ");
    throw refuse(
      STEP,
      record,
      "ambiguous",
      `${part.found} shown parts of the page on ${first.path} are named ${quotedName(scopeName)}${unspacedNote(part.unspaced, part.named)}: ${where} — ${nothing}, since a wait never guesses`,
    );
  }
  const at = `${part ? ` in the ${part.kind} ${quotedName(scopeName)}` : ""} on ${first.path}`;
  if (first.found === 0) {
    throw refuse(STEP, record, "no-window", `no shown text box${at} is named ${named} — the text boxes it shows: ${describeNames(first.boxes)}; ${nothing}`);
  }
  if (first.found > 1) {
    throw refuse(
      STEP,
      record,
      "ambiguous",
      `${first.found} shown text boxes${at} are named ${named}${unspacedNote(first.unspaced, first.named)}: ${describeMatches(first.matches)} — ${nothing}, since a wait never guesses`,
    );
  }

  // Counted from the send, when typeInWindow noted one in this window; else from this first reading.
  const since = first.noted ? "send" : "wait";
  /** @type {{ person: number, assistant: number }} */
  const before = first.noted ? { person: first.noted.person, assistant: first.noted.assistant } : first.entries;
  const answered = (/** @type {any} */ reading) => Boolean(reading && reading.entries.assistant > before.assistant);
  /** @type {any} */
  let last = first;
  for (;;) {
    if (answered(last) && isIdle(last)) break;
    const remaining = bound.turnMs - (performance.now() - start);
    if (remaining <= 0) {
      const counts = last ? last.entries : before;
      const counted = `${moved(before, counts)}${since === "send" ? ", counted from the send" : ""}`;
      const missing = !answered(last)
        ? `no new entry of the assistant stood in the window ${named}${at}${isIdle(last) ? "" : `, and its send control was not idle (${notIdle(last)})`}`
        : `the send control of the window ${named}${at} was not idle (${notIdle(last)})`;
      throw refuse(STEP, record, "no-turn", `within ${bound.turnMs} ms ${missing}; ${counted} — nothing was reloaded`);
    }
    await pause(Math.min(bound.pollMs, remaining));
    // A reading that could not be taken is a reading, and never the end of the wait.
    last = await read();
  }
  const elapsedMs = elapsedSince(start);
  // The turn stands: the note of its send has served.
  if (since === "send") await read("forget");
  const after = { person: last.entries.person, assistant: last.entries.assistant };
  record(
    `${STEP}: a new entry of the assistant stands in the window ${named}${at} after ${elapsedMs} ms, and its send control is idle; ` +
      `${moved(before, after)}${since === "send" ? ", counted from the send" : ""}`,
  );
  return { field: wanted, before, after, since, elapsedMs, path: last.path };
}
