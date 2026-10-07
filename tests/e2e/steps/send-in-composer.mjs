// sendInComposer: one message sent through the conversation's composer, and
// the card that answers it waited for.
//
// WHY IT EXISTS. dispatchRun sends through the composer too, but it is the act
// of starting a run: it requires a new run, or a notification of one, after the
// send, and refuses a message that starts none. A chat message whose answer is
// a card and no run (a schedule's proposal, a preview, the sources of an
// answer) had no step.
//
// THE COMPOSER. The one shown text box of role textbox named `composer` (the
// product's is "Send message"), typed into on typeInWindow's road: through the
// keyboard, in place of the text the composer held (a stored draft), so that
// the message is the prompt alone, and sent through the composer's own send
// control. No line carries the prompt.
//
// THE ANSWER'S CARD. A card is what the conversation draws for an answer that
// is not text: a lifecycle card (`data-lifecycle-card`, whose value is its
// kind) or a renderable view (`data-view-type`, whose value is its kind). The
// step reads the shown cards of each kind right before the press and waits for
// one the conversation did not show then; it answers that card's kind. An
// answer with no card within the bound is refused, naming an error the page
// shows, the conversation's error card among them.
//
// DEFAULT: NO RUN. The page is read as dispatchRun reads it (readRunSignals): the run
// page's surface or the run panel the conversation draws, and a notification of
// a run. A send after which either shows has started a run, which is
// dispatchRun's act: it is refused, as soon as it shows.
import { CONTROL_ACTION_BOUND_MS, CONTROL_POLL_MS, forgetDocument, newMark, plainName, quotedName } from "./page-controls.mjs";
import {
  DISPATCH_RUN_COMPOSER_BOUND_MS,
  DISPATCH_RUN_ERROR_SELECTOR,
  DISPATCH_RUN_NOTIFICATION_SELECTOR,
  DISPATCH_RUN_SELECTOR,
  newRunSignal,
  readRunSignals,
} from "./dispatch-run.mjs";
import { READING_BOUND_MS, elapsedSince, pathOf, pause, readBounds, refuse, refuseStaleScope, requireRecord, within } from "./step-kit.mjs";
import { CONTROL_CHARACTER, WINDOW_SENT_BOUND_MS, typeThrough } from "./type-in-window.mjs";
import { RUN_COMPLETION_SELECTOR, RUN_STATUS_SELECTOR } from "./watch-run.mjs";

const STEP = "sendInComposer";

// Runs in the caller's document (including a frame scope). Chat admits a run
// card before its progress panel can stand: an open review replaces that panel.
// Its passive wrapper carries the actual run ID, independent of its contents.
function readInlineRuns() {
  const shown = (element) => {
    if (!element.isConnected || getComputedStyle(element).visibility === "hidden") return false;
    for (let node = element; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || getComputedStyle(node).display === "none") return false;
    }
    return true;
  };
  return {
    threadPath: location.pathname,
    ids: Array.from(document.querySelectorAll("[data-inline-run-card]"))
      .filter(shown)
      .map((card) => card.getAttribute("data-inline-run-card"))
      .filter((id) => typeof id === "string" && id.trim() !== ""),
  };
}

/** A card the conversation draws for an answer: a lifecycle card, or a renderable view. */
export const COMPOSER_CARD_SELECTOR = "[data-lifecycle-card], [data-view-type]";
/** The attributes a card's kind is read from, in this order. */
export const COMPOSER_CARD_KIND_ATTRIBUTES = Object.freeze(["data-lifecycle-card", "data-view-type"]);
/** An error the page shows, named in the refusal when no card shows: dispatchRun's, and the conversation's error card. */
export const COMPOSER_ERROR_SELECTOR = `${DISPATCH_RUN_ERROR_SELECTOR}, [data-chat-error-card]`;
/** From the send to the answer's card. An answer that calls a model and its tools can take a minute or two. */
export const COMPOSER_CARD_BOUND_MS = 120_000;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const SEND_IN_COMPOSER_BOUNDS = Object.freeze({
  composerMs: DISPATCH_RUN_COMPOSER_BOUND_MS,
  actionMs: CONTROL_ACTION_BOUND_MS,
  sentMs: WINDOW_SENT_BOUND_MS,
  cardMs: COMPOSER_CARD_BOUND_MS,
  pollMs: CONTROL_POLL_MS,
});

// Runs IN THE PAGE: nothing of this module may be used inside it. The kind of
// every shown card, in the page's order: the value of the first of `kinds` the
// card carries.
function readCards({ selector, kinds }) {
  const shown = (element) => {
    if (!element.isConnected || getComputedStyle(element).visibility === "hidden") return false;
    for (let node = element; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || getComputedStyle(node).display === "none") return false;
    }
    return true;
  };
  return Array.from(document.querySelectorAll(selector))
    .filter(shown)
    .map((card) => {
      for (const attribute of kinds) {
        const kind = card.getAttribute(attribute);
        if (kind) return kind;
      }
      return "unmarked";
    });
}

/**
 * The kind of the last card `after` shows beyond the cards of each kind
 * `before` showed, or null: a conversation draws a new card after the old ones.
 * @param {string[]} before
 * @param {string[]} after
 */
function newCard(before, after) {
  const left = new Map();
  for (const kind of before) left.set(kind, (left.get(kind) ?? 0) + 1);
  /** @type {string | null} */
  let found = null;
  for (const kind of after) {
    const old = left.get(kind) ?? 0;
    if (old > 0) left.set(kind, old - 1);
    else found = kind;
  }
  return found;
}

/**
 * Send `prompt` through the conversation's composer on the caller's page (the
 * one shown text box named `composer`, typed into in place of what it held, and
 * its own send control), and resolve `{ composer, kind, path, elapsedMs }` once
 * a card the conversation did not show before the send stands: `kind` is that
 * card's kind, `path` the conversation's path then, and `elapsedMs` the time
 * from the send. Refuses, as a StepRefusal: `input` (nothing was sent), and on
 * typeInWindow's road `unreadable`, `no-composer` (naming the text boxes the
 * page shows), `ambiguous`, `disabled`, `no-control`, `driver-failure`,
 * `not-typed` and `not-sent`; then `starts-run` (the send started a run, as
 * dispatchRun reads one: that is dispatchRun's act) and `no-card` (no new card
 * within the bound, naming an error the page shows). No line carries the
 * prompt. With explicit `expect: "run"`, waits for a new visible inline run
 * card's concrete ID instead of a progress panel or notification and answers
 * `{ composer, runId, threadPath, elapsedMs }`. The thread path is read from
 * the caller's document; `no-run` refuses a missing ID within `cardMs`.
 *
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   prompt: string,
 *   composer: string,
 *   expect?: "card" | "run",
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof SEND_IN_COMPOSER_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ composer: string, kind: string, path: string, elapsedMs: number } | { composer: string, runId: string, threadPath: string, elapsedMs: number }>}
 */
export async function sendInComposer(page, { prompt, composer, expect = "card", record, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was sent";
  const input = (/** @type {string} */ why) => refuse(STEP, record, "input", `${why} — ${nothing}`);
  if (typeof prompt !== "string" || prompt.trim() === "") throw input("hand the step a prompt with some text to send");
  if (CONTROL_CHARACTER.test(prompt)) throw input("the prompt is typed key by key, so it may hold no line break or other control character: a line break would press Enter");
  if (expect !== "card" && expect !== "run") throw input("expect must be card or run");
  const composerName = plainName(composer);
  if (typeof composer !== "string" || composerName === "") throw input("name the composer, such as Send message");
  const bound = readBounds(STEP, record, SEND_IN_COMPOSER_BOUNDS, bounds, nothing);
  refuseStaleScope(STEP, record, page, nothing);
  const named = quotedName(composerName);

  const key = `__stepComposer${newMark()}`;
  const signals = {
    key,
    run: DISPATCH_RUN_SELECTOR,
    status: RUN_STATUS_SELECTOR,
    completion: RUN_COMPLETION_SELECTOR,
    notification: DISPATCH_RUN_NOTIFICATION_SELECTOR,
    error: COMPOSER_ERROR_SELECTOR,
  };
  const cards = { selector: COMPOSER_CARD_SELECTOR, kinds: COMPOSER_CARD_KIND_ATTRIBUTES };
  /** @type {any} */
  let before = null;
  /** @type {string[]} */
  let cardsBefore = [];
  /** @type {string[]} */
  let runsBefore = [];
  const from = pathOf(page.url());
  try {
    // What the page shows right before the press, so that only what the send brought counts.
    const noteBefore = async (/** @type {string} */ on) => {
      before = await within(page.evaluate(readRunSignals, { ...signals, set: true }), READING_BOUND_MS);
      const read = await within(page.evaluate(readCards, cards), READING_BOUND_MS);
      const inline = expect === "run" ? await within(page.evaluate(readInlineRuns), READING_BOUND_MS) : null;
      if (!before || !before.same || !read || (expect === "run" && !inline)) {
        throw refuse(STEP, record, "unreadable", `the page on ${on} could not be read before the send — the text stays in the composer, and nothing was sent`);
      }
      cardsBefore = read;
      runsBefore = inline?.ids ?? [];
    };
    const sent = await typeThrough(page, {
      step: STEP,
      record,
      field: composerName,
      text: prompt,
      replace: true,
      send: true,
      scope: "",
      bound: { fieldMs: bound.composerMs, actionMs: bound.actionMs, sentMs: bound.sentMs, pollMs: bound.pollMs },
      missing: "no-composer",
      beforeSend: noteBefore,
    });

    const message = `the message sent through the composer ${named} on ${from}`;
    /** @type {any} */
    let last = null;
    for (;;) {
      // A reading taken while the page navigates fails: what the send brings is still to come.
      const reading = await within(page.evaluate(readRunSignals, { ...signals, set: false }), READING_BOUND_MS);
      const shown = reading ? await within(page.evaluate(readCards, cards), READING_BOUND_MS) : null;
      const elapsedMs = elapsedSince(sent.pressedAt);
      if (reading) {
        last = reading;
        if (expect === "run") {
          const inline = await within(page.evaluate(readInlineRuns), READING_BOUND_MS);
          const runId = inline?.ids.find((/** @type {string} */ id) => !runsBefore.includes(id));
          if (runId) {
            record(`${STEP}: ${message} started run ${quotedName(runId)} on ${inline.threadPath} after ${elapsedMs} ms`);
            return { composer: composerName, runId, threadPath: inline.threadPath, elapsedMs };
          }
        }
        const run = expect === "card" ? newRunSignal(before, reading) : null;
        if (run) {
          const how = run.via === "run" ? `it shows on ${reading.path} (${run.state})` : `the page notifies of it: ${quotedName(run.state)}`;
          throw refuse(STEP, record, "starts-run", `${message} started a run: ${how} — starting a run is dispatchRun's act`);
        }
        const kind = expect === "card" && shown ? newCard(cardsBefore, shown) : null;
        if (kind !== null) {
          record(`${STEP}: ${message} is answered with a card ${kind} on ${reading.path} after ${elapsedMs} ms`);
          return { composer: composerName, kind, path: reading.path, elapsedMs };
        }
      }
      if (elapsedMs >= bound.cardMs) break;
      await pause(Math.min(bound.pollMs, bound.cardMs - elapsedMs));
    }
    const errors = last ? last.errors.filter((/** @type {string} */ line) => line && !before.errors.includes(line)) : [];
    const shows = errors.length > 0 ? `; it shows an error: ${quotedName(errors[0])}` : "";
    if (expect === "run") {
      throw refuse(STEP, record, "no-run", `${message} showed no new run ID within ${bound.cardMs} ms (the page is on ${pathOf(page.url())})${shows}`);
    }
    throw refuse(STEP, record, "no-card", `${message} was answered with no card within ${bound.cardMs} ms (the page is on ${pathOf(page.url())})${shows}`);
  } finally {
    // The document's note of this send comes off, where the document still holds it.
    await within(page.evaluate(forgetDocument, { key }), READING_BOUND_MS);
  }
}
