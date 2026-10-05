// dispatchRun: a run started from its card, or sent through the conversation's
// composer, and the run or its notification waited for.
//
// WHY IT EXISTS. A run started by hand was a press on whatever a selector found
// first, and a wait for whatever the run happened to draw. One such wait looked
// for the composer by its placeholder, "Type a message": an empty conversation
// draws the same composer with "Ask anything", so the wait ran out and the run
// never started. This step finds the card and the composer by their names,
// presses only when exactly one of each carries the name it was given, and
// waits, within its bound, for the page to show the run.
//
// THE CARD. A card is an `article`, or an element the design system marks as a
// card (`data-slot="card"`, or a `data-slot` that ends in `-card`). Its name is
// its `aria-label`, the text `aria-labelledby` names, or the text of its title:
// the element the design system marks as the card's name or title, or its first
// heading. Its run control is the one shown button or link in it whose
// accessible name is `control` ("Run" by default).
//
// THE COMPOSER. With `prompt`, the run is sent through the conversation's
// composer: the one shown text box whose accessible name is `composer` ("Send
// message"). The product gives its composer that name in an empty conversation
// and in one with messages alike; only the placeholder differs, and a
// placeholder contributes only when the browser names the field from it. The step waits for it in either state,
// types the prompt, and presses the send control, the button of the same name.
// With both `card` and `prompt`, the card is pressed first.
//
// THE RUN, OR ITS NOTIFICATION. After the press that sends the run, the step
// reads, on a fixed cadence, what the page shows that it did not show before:
//   - the run itself: the run page's surface (`data-conformance-id="run-surface"`)
//     or the run panel the conversation draws (`data-run-progress-panel`), with
//     the newest run's state read as `watchRun` reads it; or
//   - a notification: a toast that is not an error, or a row of the
//     notifications list.
// When neither shows within the bound, the step refuses and names the page it is
// on, and an error the page shows, if any.
import {
  CONTROL_ACTION_BOUND_MS,
  CONTROL_HYDRATION_BOUND_MS,
  CONTROL_MARK,
  CONTROL_NAMES_LISTED,
  CONTROL_POLL_MS,
  describeNames,
  forgetDocument,
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
import { RUN_COMPLETION_SELECTOR, RUN_STATUS_SELECTOR, RUN_SURFACE_SELECTOR } from "./watch-run.mjs";

const STEP = "dispatchRun";

/** The accessible name of a card's run control, unless the caller names another. */
export const DISPATCH_RUN_CONTROL = "Run";
/**
 * The accessible name of the conversation's composer, and of its send control:
 * the same in an empty conversation and in one with messages.
 */
export const DISPATCH_RUN_COMPOSER = "Send message";
/** What the page draws for a run: the run page's surface, or the run panel the conversation draws. */
export const DISPATCH_RUN_SELECTOR = `${RUN_SURFACE_SELECTOR}, [data-run-progress-panel]`;
/** A notification the page shows: a toast that is neither an error nor still loading, or a row of the notifications list. */
export const DISPATCH_RUN_NOTIFICATION_SELECTOR =
  '[data-sonner-toast]:not([data-type="error"]):not([data-type="loading"]), [data-conformance-id="notification-row"]';
/** An error the page shows, named in the refusal when no run shows. */
export const DISPATCH_RUN_ERROR_SELECTOR = '[data-sonner-toast][data-type="error"], [role="alert"]';
/** From the press to the run or its notification. A development server compiles the run page on its first request. */
export const DISPATCH_RUN_BOUND_MS = 120_000;
/** From the call, or the card's press, to the composer: an empty conversation draws it at once, one with messages once they have loaded. */
export const DISPATCH_RUN_COMPOSER_BOUND_MS = 30_000;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const DISPATCH_RUN_BOUNDS = Object.freeze({
  actionMs: CONTROL_ACTION_BOUND_MS,
  composerMs: DISPATCH_RUN_COMPOSER_BOUND_MS,
  runMs: DISPATCH_RUN_BOUND_MS,
  pollMs: CONTROL_POLL_MS,
});

// Runs IN THE PAGE: nothing of this module may be used inside it. `set` notes
// the document under `key`; the reading says whether the page still shows it.
// Runs are counted by their outermost element; the newest is the last of them.
// sendInComposer reads the page with it too, to refuse a send that starts a run.
export function readRunSignals({ key, set, run, status, completion, notification, error }) {
  if (set) window[key] = true;
  const text = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  const shown = (element) => {
    if (!element || !element.isConnected || getComputedStyle(element).visibility === "hidden") return false;
    for (let node = element; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || getComputedStyle(node).display === "none") return false;
    }
    return true;
  };
  const found = Array.from(document.querySelectorAll(run)).filter(shown);
  const runs = found.filter((root) => !found.some((other) => other !== root && other.contains(root)));
  let state = "";
  if (runs.length > 0) {
    const newest = runs[runs.length - 1];
    const card = newest.querySelector(completion);
    const pill = newest.querySelector(status);
    state = card
      ? "completion:" + (card.getAttribute("data-run-completion-evidence") || "unmarked")
      : pill
        ? "status:" + (pill.getAttribute("data-status") || "unmarked")
        : "unmarked";
  }
  const texts = (selector) =>
    Array.from(document.querySelectorAll(selector))
      .filter(shown)
      .map((element) => text(element.textContent));
  return { same: window[key] === true, path: location.pathname, runs: runs.length, state, notes: texts(notification), errors: texts(error) };
}

/**
 * What a reading of readRunSignals shows of a run that the reading `before`
 * did not: the run (`via: "run"`, its state as watchRun reads it) or a
 * notification of it (`via: "notification"`, its text), or null. A new
 * document counts every run and notification it shows.
 * @param {{ runs: number, notes: string[] }} before
 * @param {{ same: boolean, runs: number, state: string, notes: string[] }} reading
 * @returns {{ via: "run" | "notification", state: string } | null}
 */
export function newRunSignal(before, reading) {
  const fresh = !reading.same;
  if (reading.runs > (fresh ? 0 : before.runs)) return { via: "run", state: reading.state };
  const note = fresh
    ? reading.notes[0]
    : (reading.notes.find((line) => !before.notes.includes(line)) ?? (reading.notes.length > before.notes.length ? reading.notes.at(-1) : undefined));
  return note === undefined ? null : { via: "notification", state: note };
}

/**
 * Start a run on the caller's page, from the card named `card` (press its one
 * shown button or link named `control`, "Run" by default), or through the
 * composer with `prompt` (type it into the one shown text box named `composer`,
 * "Send message" by default, and press the button of that name), or both, the
 * card first. Resolves `{ card, via, state, path, elapsedMs }` once the page
 * shows the run (`via: "run"`, `state` read as watchRun reads it) or a
 * notification of it (`via: "notification"`, `state` its text). Refuses, as a
 * StepRefusal, arguments it cannot use, a card no shown card carries the name of
 * (`no-card`, naming the cards it shows), a name several cards, controls or
 * composers carry (`ambiguous`), a card without the control or a composer
 * without its send control (`no-control`), a disabled control (`disabled`), a
 * composer that does not show within its bound (`no-composer`, naming the text
 * boxes the page shows), a press or a typing that could not be made
 * (`driver-failure`) and a press after which neither the run nor a notification
 * shows within the bound (`no-run`). No line carries the prompt.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   card?: string,
 *   control?: string,
 *   prompt?: string,
 *   composer?: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof DISPATCH_RUN_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ card: string | null, via: "run" | "notification", state: string, path: string, elapsedMs: number }>}
 */
export async function dispatchRun(
  page,
  { card, control = DISPATCH_RUN_CONTROL, prompt, composer = DISPATCH_RUN_COMPOSER, record, bounds } = /** @type {any} */ ({}),
) {
  requireRecord(STEP, record);
  const nothing = "nothing was pressed";
  const input = (/** @type {string} */ why) => refuse(STEP, record, "input", `${why} — ${nothing}`);
  if (card === undefined && prompt === undefined) throw input("name the card to start the run from, or the prompt to send, or both");
  const wanted = plainName(card);
  if (card !== undefined && (typeof card !== "string" || wanted === "")) throw input("name the card by its accessible name, such as Research assistant");
  const controlName = plainName(control);
  if (typeof control !== "string" || controlName === "") throw input("name the card's run control, such as Run");
  if (prompt !== undefined && (typeof prompt !== "string" || prompt.trim() === "")) throw input("hand the step a prompt with some text to send");
  const composerName = plainName(composer);
  if (typeof composer !== "string" || composerName === "") throw input("name the composer, such as Send message");
  const bound = readBounds(STEP, record, DISPATCH_RUN_BOUNDS, bounds, nothing);
  const cardName = quotedName(wanted);
  const named = quotedName(controlName);
  const composerNamed = quotedName(composerName);

  const from = pathOf(page.url());
  const mark = newMark();
  const key = `__stepRun${mark}`;
  const signals = {
    key,
    run: DISPATCH_RUN_SELECTOR,
    status: RUN_STATUS_SELECTOR,
    completion: RUN_COMPLETION_SELECTOR,
    notification: DISPATCH_RUN_NOTIFICATION_SELECTOR,
    error: DISPATCH_RUN_ERROR_SELECTOR,
  };
  // What the page shows right before the press that sends the run, so that only what that press brought counts.
  const noteBefore = async (/** @type {string} */ where) => {
    const before = await within(page.evaluate(readRunSignals, { ...signals, set: true }), READING_BOUND_MS);
    if (!before || !before.same) throw refuse(STEP, record, "unreadable", `the page on ${where} could not be read before the press — ${nothing}`);
    return before;
  };
  /** @type {any} */
  let before = null;
  let pressedAt = performance.now();
  try {
    if (card !== undefined) {
      // Read only once the page has hydrated: a mark written before React has compared its element is a hydration mismatch.
      if (!(await waitForPageHydration(page))) {
        throw refuse(STEP, record, "unreadable", `the page on ${from} did not hydrate within ${CONTROL_HYDRATION_BOUND_MS} ms — ${nothing}`);
      }
      const reading = await within(
        readPageControls(page, { mode: "card", card: wanted, control: controlName, attribute: CONTROL_MARK, mark, listed: CONTROL_NAMES_LISTED }),
        READING_BOUND_MS,
      );
      if (!reading) throw refuse(STEP, record, "unreadable", `the cards on ${from} could not be read — ${nothing}`);
      if (reading.found === 0) {
        throw refuse(STEP, record, "no-card", `no shown card on ${from} is named ${cardName} — the cards it shows: ${describeNames(reading.cards)}; ${nothing}`);
      }
      if (reading.found > 1) {
        throw refuse(
          STEP,
          record,
          "ambiguous",
          `${reading.found} shown cards on ${from} are named ${cardName}${unspacedNote(reading.unspaced, reading.named)} — ${nothing}, since a run is never started from a guess`,
        );
      }
      const { matches } = reading;
      if (matches.length === 0) {
        throw refuse(
          STEP,
          record,
          "no-control",
          `the card ${cardName} on ${from} has no shown button or link named ${named} — its controls: ${describeNames(reading.controls)}; ${nothing}`,
        );
      }
      if (matches.length > 1) {
        const which = matches.map((/** @type {{ role: string }} */ match) => `a ${match.role}`).join(" and ");
        throw refuse(
          STEP,
          record,
          "ambiguous",
          `the card ${cardName} on ${from} has ${matches.length} shown controls named ${named}${unspacedNote(reading.controlUnspaced, reading.controlNamed)}, ${which} — ${nothing}, since a run is never started from a guess`,
        );
      }
      if (matches[0].disabled) throw refuse(STEP, record, "disabled", `the control ${named} of the card ${cardName} on ${from} is disabled — ${nothing}`);
      if (prompt === undefined) before = await noteBefore(from);
      try {
        // `noWaitAfter`: the press returns once made; what it brought is read below.
        await page.locator(markedBy(mark)).click({ timeout: bound.actionMs, noWaitAfter: true });
      } catch (error) {
        throw refuse(STEP, record, "driver-failure", `the control ${named} of the card ${cardName} on ${from} could not be pressed (${errorClass(error)})`);
      }
      pressedAt = performance.now();
    }

    if (prompt !== undefined) {
      // The composer, in an empty conversation or in one with messages: by its role and its name.
      const waitedFrom = performance.now();
      /** @type {any} */
      let reading = null;
      for (;;) {
        await within(page.evaluate(unmarkControls, { attribute: CONTROL_MARK, mark }), READING_BOUND_MS);
        // The page the card's press landed on hydrates anew: its composer is read only once it has.
        if (!(await waitForPageHydration(page))) {
          throw refuse(STEP, record, "unreadable", `the page on ${pathOf(page.url())} did not hydrate within ${CONTROL_HYDRATION_BOUND_MS} ms — no prompt was sent`);
        }
        reading = (await within(readPageControls(page, { mode: "composer", composer: composerName, attribute: CONTROL_MARK, mark, listed: CONTROL_NAMES_LISTED }), READING_BOUND_MS)) ?? reading;
        if (reading && reading.found > 0) break;
        const remaining = bound.composerMs - (performance.now() - waitedFrom);
        if (remaining <= 0) break;
        await pause(Math.min(bound.pollMs, remaining));
      }
      const on = pathOf(page.url());
      if (!reading || reading.found === 0) {
        const boxes = reading ? describeNames(reading.boxes) : "none it could read";
        throw refuse(
          STEP,
          record,
          "no-composer",
          `no shown text box on ${on} is named ${composerNamed} within ${bound.composerMs} ms — the text boxes it shows: ${boxes}; no prompt was sent`,
        );
      }
      if (reading.found > 1) {
        throw refuse(
          STEP,
          record,
          "ambiguous",
          `${reading.found} shown text boxes on ${on} are named ${composerNamed}${unspacedNote(reading.unspaced, reading.named)} — no prompt was sent, since a run is never started from a guess`,
        );
      }
      if (reading.sends !== 1) {
        throw refuse(
          STEP,
          record,
          reading.sends === 0 ? "no-control" : "ambiguous",
          `the composer ${composerNamed} on ${on} has ${reading.sends === 0 ? "no shown send control" : `${reading.sends} shown send controls`}, a button named ${composerNamed}${unspacedNote(reading.sends > 1 && reading.sendsUnspaced, reading.sendsNamed)} — no prompt was sent`,
        );
      }
      before = await noteBefore(on);
      try {
        // The prompt goes into the box and nowhere else; a failure keeps only the error's class.
        await page.locator(markedBy(`${mark}t`)).fill(prompt, { timeout: bound.actionMs });
      } catch (error) {
        throw refuse(STEP, record, "driver-failure", `the composer ${composerNamed} on ${on} could not be filled (${errorClass(error)}) — no prompt was sent`);
      }
      try {
        // The send control may enable itself only once the prompt is in: the press waits for it.
        await page.locator(markedBy(`${mark}s`)).click({ timeout: bound.actionMs, noWaitAfter: true });
      } catch (error) {
        throw refuse(STEP, record, "driver-failure", `the send control ${composerNamed} on ${on} could not be pressed (${errorClass(error)})`);
      }
      pressedAt = performance.now();
    }
  } finally {
    await within(page.evaluate(unmarkControls, { attribute: CONTROL_MARK, mark }), READING_BOUND_MS);
  }

  const started = prompt === undefined ? `the run from the card ${cardName}` : card === undefined ? `the run sent through the composer ${composerNamed}` : `the run from the card ${cardName}, sent through the composer ${composerNamed}`;
  const pressed = prompt === undefined ? `the press on ${named} in the card ${cardName}` : `the prompt sent through the composer ${composerNamed}`;
  /** @type {any} */
  let last = null;
  try {
    for (;;) {
      // A reading taken while the page navigates fails: the run is still to come.
      const reading = await within(page.evaluate(readRunSignals, { ...signals, set: false }), READING_BOUND_MS);
      const elapsedMs = elapsedSince(pressedAt);
      if (reading) {
        last = reading;
        const signal = newRunSignal(before, reading);
        if (signal && signal.via === "run") {
          record(`${STEP}: ${started} shows on ${reading.path} after ${elapsedMs} ms (${signal.state})`);
          return { card: card === undefined ? null : wanted, via: "run", state: signal.state, path: reading.path, elapsedMs };
        }
        if (signal) {
          record(`${STEP}: the page notifies of ${started} after ${elapsedMs} ms: ${quotedName(signal.state)}`);
          return { card: card === undefined ? null : wanted, via: "notification", state: signal.state, path: reading.path, elapsedMs };
        }
      }
      if (elapsedMs >= bound.runMs) break;
      await pause(Math.min(bound.pollMs, bound.runMs - elapsedMs));
    }
  } finally {
    await within(page.evaluate(forgetDocument, { key }), READING_BOUND_MS);
  }
  const errors = last ? last.errors.filter((/** @type {string} */ line) => line && !before.errors.includes(line)) : [];
  const shows = errors.length > 0 ? `; it shows an error: ${quotedName(errors[0])}` : "";
  throw refuse(
    STEP,
    record,
    "no-run",
    `${pressed} showed neither a run nor a notification within ${bound.runMs} ms (the page is on ${pathOf(page.url())})${shows}`,
  );
}
