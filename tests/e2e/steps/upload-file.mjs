// uploadFile: a file upload through the page's own upload control.
//
// WHY IT EXISTS. An upload written by hand for each run set the file on the
// page's hidden input directly, past the control a person presses, and read the
// list before the app had filed the upload. This step presses the page's own
// upload control, found by its accessible name, answers the file chooser the
// press opens with the file, and waits for the uploaded item's row in the list.
//
// THE CONTROL. The library's Upload button opens a hidden file input; a shown
// file input with a label of its own is the same kind of control, and a browser
// names both as buttons. The first shown button with the name is pressed. A
// press that opens no file chooser within the chooser bound (a press the page's
// handler has not taken over yet opens nothing) is refused at once.
//
// THE ROW. The library draws every filed item as a row of its list. The upload
// is acknowledged when a row that names the file appears beyond the rows that
// named it before the press, so a file uploaded twice needs its second row.
//
// Lines name the file by its name alone, never by the place it was read from.
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename } from "node:path";

import { NAMES_LISTED, listed, quoted } from "./control-kit.mjs";
import { READING_BOUND_MS, elapsedSince, errorClass, pathOf, pause, pollUntilSettled, readBounds, refuse, refuseFrameScope, requireRecord, within } from "./step-kit.mjs";

const STEP = "uploadFile";

/** The rows of the library's list: one per filed item. */
export const UPLOAD_ROW_SELECTOR = '[data-conformance-id="artifacts-library-list"] > li';
/** How long the named control may take to be shown. */
export const UPLOAD_CONTROL_BOUND_MS = 15_000;
/** The press, and handing the file to the chooser. */
export const UPLOAD_ACTION_BOUND_MS = 30_000;
/**
 * From the press to the file chooser. Short on purpose: a press that opens a
 * chooser opens it at once, so one that opened none within a few seconds is
 * refused then.
 */
export const UPLOAD_CHOOSER_BOUND_MS = 5_000;
/** From the file handed over to its row. The app files and types the upload, and a development server compiles the route on its first request. */
export const UPLOAD_ROW_BOUND_MS = 120_000;
/** How often the control and the list are read. */
export const UPLOAD_POLL_MS = 250;
/** From the file handed over to the caller's own completion signal. */
const UPLOAD_DONE_BOUND_MS = 60_000;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const UPLOAD_BOUNDS = Object.freeze({
  controlMs: UPLOAD_CONTROL_BOUND_MS,
  actionMs: UPLOAD_ACTION_BOUND_MS,
  chooserMs: UPLOAD_CHOOSER_BOUND_MS,
  rowMs: UPLOAD_ROW_BOUND_MS,
  pollMs: UPLOAD_POLL_MS,
});

// These run IN THE PAGE: nothing of this module may be used inside them.

/** The page's file inputs: each one's label, whether it is shown, and its test id. */
function readFileInputs() {
  const text = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const shown = (element) => {
    if (!element.isConnected || getComputedStyle(element).visibility === "hidden") return false;
    for (let node = element; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || getComputedStyle(node).display === "none") return false;
    }
    return true;
  };
  return Array.from(document.querySelectorAll('input[type="file"]'), (input) => {
    const labelledBy = text(input.getAttribute("aria-labelledby"))
      .split(" ")
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((node) => text(node.textContent))
      .join(" ");
    const label = labelledBy || text(input.getAttribute("aria-label")) || Array.from(input.labels || [], (node) => text(node.textContent)).join(" ");
    return { label, shown: shown(input), testId: input.getAttribute("data-testid") || "" };
  });
}

/**
 * The rows of the list: each row's name (its first text) and how many rows name
 * the file (hold a text that is exactly its name). The state is `filed` once
 * more rows name it than `before`.
 */
function readRows({ selector, name, before }) {
  const text = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const textsOf = (row) => {
    const found = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement && node.parentElement.closest('[aria-hidden="true"]')) continue;
      const value = text(node.nodeValue);
      if (value) found.push(value);
    }
    return found;
  };
  const rows = Array.from(document.querySelectorAll(selector), textsOf);
  const matching = rows.filter((texts) => texts.includes(name)).length;
  return { state: matching > before ? "filed" : "waiting", rows: rows.map((texts) => texts[0] || ""), matching };
}

/** Read the named label's OWN input and the caller's completion in one reading.
 * React's server markup can already contain the input. It is ready only once
 * that host input belongs to the CURRENT committed root and owns onChange.
 * React's private host metadata is deliberately fail-closed if it changes. */
function readDirectUpload({ control, doneSelector, mark }) {
  const text = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const shown = (element) => {
    if (!element.isConnected) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || style.display === "none" || style.visibility === "hidden" || node.getAttribute("aria-hidden") === "true") return false;
    }
    return true;
  };
  let completed;
  try { completed = Array.from(document.querySelectorAll(doneSelector)).some(shown); }
  catch { return { state: "invalid" }; }
  if (completed) return { state: "stale" };
  const found = Array.from(document.querySelectorAll('input[type="file"]')).filter((input) => {
    const label = input.closest("label");
    if (!label || !shown(label) || input.disabled) return false;
    const parts = Array.from(label.querySelectorAll("p,span")).filter(shown).map((part) => text(part.textContent));
    return text(input.getAttribute("aria-label")) === control || text(label.innerText || label.textContent) === control ||
      parts.join(" ") === control || parts.includes(control);
  });
  if (found.length > 1) return { state: "ambiguous" };
  if (found.length === 0) return { state: "missing" };
  const input = found[0];
  const label = input.closest("label");
  const fiberKey = Object.keys(input).find((key) => key.startsWith("__reactFiber$"));
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  if (!fiberKey || !propsKey || typeof input[propsKey]?.onChange !== "function") return { state: "unhydrated" };
  let root = input[fiberKey];
  while (root?.return) {
    if (root.memoizedState?.dehydrated) return { state: "unhydrated" };
    root = root.return;
  }
  const current = root?.stateNode?.current;
  if (!current || current.memoizedState?.isDehydrated) return { state: "unhydrated" };
  // Merely having a fiber is insufficient: a work-in-progress or retired tree
  // may carry props before/after its event handler belongs to the live DOM.
  const pending = [current];
  const seen = new Set();
  let ownsInput = false;
  let ownsLabel = false;
  while (pending.length) {
    const node = pending.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    if (node.stateNode === input) ownsInput = true;
    if (node.stateNode === label) ownsLabel = true;
    if (node.child) pending.push(node.child);
    if (node.sibling) pending.push(node.sibling);
  }
  if (!ownsInput || !ownsLabel) return { state: "unhydrated" };
  if (mark) input.setAttribute("data-step-upload", mark);
  return { state: "ready" };
}

function readUploadCompletion({ selector, text }) {
  const shown = (element) => {
    if (!element.isConnected) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || style.display === "none" || style.visibility === "hidden" || node.getAttribute("aria-hidden") === "true") return false;
    }
    return true;
  };
  const values = Array.from(document.querySelectorAll(selector)).filter(shown).map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim());
  const actual = values.find((value) => value === text);
  return { state: actual !== undefined ? "completed" : "waiting", text: actual };
}

async function uploadToCompletion(page, { named, path, name, at, done, record, bound }) {
  const mark = randomUUID();
  const selector = `[data-step-upload="${mark}"]`;
  const start = performance.now();
  let state = "missing";
  try {
    for (;;) {
      const reading = await within(page.evaluate(readDirectUpload, { control: named, doneSelector: done.selector, mark }), READING_BOUND_MS);
      state = reading?.state ?? "unreadable";
      if (state === "ready") break;
      if (state === "invalid") throw refuse(STEP, record, "input", "done.selector must be a valid CSS selector — no file was handed over");
      if (state === "stale") throw refuse(STEP, record, "stale-completion", "the caller's completion signal was already shown — no file was handed over");
      if (state === "ambiguous") throw refuse(STEP, record, "ambiguous", `more than one own file input belongs to ${quoted(named)} on ${at} — no file was handed over`);
      const remaining = bound.controlMs - (performance.now() - start);
      if (remaining <= 0) throw refuse(STEP, record, state === "missing" ? "no-control" : "unhydrated", `the named upload control did not own a committed change handler within ${bound.controlMs} ms — no file was handed over`);
      await pause(Math.min(bound.pollMs, remaining));
    }
    try {
      await page.locator(selector).setInputFiles(path, { timeout: bound.actionMs });
    } catch (error) {
      throw refuse(STEP, record, "driver-failure", `the named control did not take ${quoted(name)} (${errorClass(error)})`);
    }
    const { reading, settled } = await pollUntilSettled(page, {
      read: readUploadCompletion,
      arg: done,
      isSettled: (value) => value === "completed",
      bound: bound.doneMs,
      pollMs: bound.pollMs,
    });
    if (!settled) throw refuse(STEP, record, "no-completion", `the caller's completion signal did not appear within ${bound.doneMs} ms after the file was handed over`);
    const elapsedMs = elapsedSince(start);
    const landed = pathOf(page.url());
    record(`${STEP}: handed ${quoted(name)} to the hydrated control ${quoted(named)} on ${at}; ${quoted(done.selector)} read ${quoted(reading.text)} after ${elapsedMs} ms`);
    return { control: named, file: name, path: landed, elapsedMs };
  } finally {
    await page.evaluate((value) => {
      for (const input of document.querySelectorAll(`[data-step-upload="${value}"]`)) input.removeAttribute("data-step-upload");
    }, mark).catch(() => {});
  }
}

/** @param {{ label: string, shown: boolean, testId: string }} input */
function describeFileInput(input) {
  const named = input.label ? `one labelled ${quoted(input.label)}` : "one without a label";
  return `${named}${input.shown ? "" : ", hidden"}${input.testId ? ` (test id ${quoted(input.testId)})` : ""}`;
}

/**
 * Upload the file at `path` through the caller's page: press the first shown
 * control named `control`, answer the file chooser it opens with the file, and
 * resolve `{ control, file, path, elapsedMs }` once a row naming the file has
 * appeared in the list (`file` is the file's name, `path` the page's path).
 * With `done`, wait for the named label's own input to have committed event
 * handling, hand the file to that input, and await the selector's exact text
 * within `doneMs` instead. No pointer press or consent change is made.
 * Refuses, as a StepRefusal: `input` (nothing was pressed), `no-control` (no
 * shown control with the name, naming the page's file inputs), `driver-failure`
 * (the press or the hand-over failed), `no-chooser` (the press opened no file
 * chooser) and `no-row` (no row named the file within the bound, naming the
 * rows the list shows).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   control: string,
 *   path: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof UPLOAD_BOUNDS | "doneMs", number>>,
 *   done?: { selector: string, text: string },
 * }} options
 * @returns {Promise<{ control: string, file: string, path: string, elapsedMs: number }>}
 */
export async function uploadFile(page, { control, path, record, bounds, done } = /** @type {any} */ ({})) {
  refuseFrameScope(STEP, record, page, "nothing was pressed");
  requireRecord(STEP, record);
  const nothing = "nothing was pressed";
  if (typeof control !== "string" || control.trim() === "") {
    throw refuse(STEP, record, "input", `name the upload control by its accessible name, such as Upload — ${nothing}`);
  }
  let isFile = false;
  try {
    isFile = typeof path === "string" && path !== "" && statSync(path).isFile();
  } catch {
    isFile = false;
  }
  // The path is never repeated: it names a place on the machine that runs the step.
  if (!isFile) throw refuse(STEP, record, "input", `hand the step the path of a file that exists — ${nothing}`);
  const bound = readBounds(STEP, record, done === undefined ? UPLOAD_BOUNDS : { ...UPLOAD_BOUNDS, doneMs: UPLOAD_DONE_BOUND_MS }, bounds, nothing);
  const name = basename(path);
  const named = control.replace(/\s+/g, " ").trim();
  const at = pathOf(page.url());
  if (done !== undefined) {
    if (!done || typeof done !== "object" || typeof done.selector !== "string" || done.selector.trim() === "" || typeof done.text !== "string" || done.text.trim() === "") {
      throw refuse(STEP, record, "input", "done must name a nonempty CSS selector and expected text — no file was handed over");
    }
    const expected = { selector: done.selector, text: done.text.replace(/\s+/g, " ").trim() };
    return uploadToCompletion(page, { named, path, name, at, done: expected, record, bound });
  }

  // The control, shown and named: it may take a moment to be drawn.
  const controls = page.getByRole("button", { name: named, exact: true });
  const looked = performance.now();
  for (;;) {
    if (((await within(controls.count(), READING_BOUND_MS)) ?? 0) > 0) break;
    const remaining = bound.controlMs - (performance.now() - looked);
    if (remaining <= 0) {
      const inputs = await within(page.evaluate(readFileInputs), READING_BOUND_MS);
      const more = inputs && inputs.length > NAMES_LISTED ? ` and ${inputs.length - NAMES_LISTED} more` : "";
      const described = !inputs
        ? "its file inputs could not be read"
        : inputs.length === 0
          ? "it has no file input"
          : `its file inputs: ${inputs.slice(0, NAMES_LISTED).map(describeFileInput).join(", ")}${more}`;
      throw refuse(STEP, record, "no-control", `no shown control named ${quoted(named)} on ${at} within ${bound.controlMs} ms; ${described} — ${nothing}`);
    }
    await pause(Math.min(bound.pollMs, remaining));
  }

  // The rows that already name the file: the upload's own row comes beyond them.
  let before;
  try {
    before = await page.evaluate(readRows, { selector: UPLOAD_ROW_SELECTOR, name, before: 0 });
  } catch (error) {
    throw refuse(STEP, record, "driver-failure", `the list on ${at} could not be read before the press (${errorClass(error)}) — ${nothing}`);
  }

  // The chooser, listened for from before the press, so one the press opens at once is not missed.
  const opened = page.waitForEvent("filechooser", { timeout: bound.actionMs + bound.chooserMs }).catch(() => null);
  const start = performance.now();
  try {
    await controls.first().click({ timeout: bound.actionMs });
  } catch (error) {
    throw refuse(STEP, record, "driver-failure", `the control ${quoted(named)} could not be pressed (${errorClass(error)}) — no file was handed over`);
  }
  const chooser = await within(opened, bound.chooserMs);
  if (!chooser) {
    throw refuse(
      STEP,
      record,
      "no-chooser",
      `the press on ${quoted(named)} opened no file chooser within ${bound.chooserMs} ms, and the page stayed on ${pathOf(page.url())} — no file was handed over`,
    );
  }
  try {
    await chooser.setFiles(path, { timeout: bound.actionMs });
  } catch (error) {
    throw refuse(STEP, record, "driver-failure", `the file chooser did not take ${quoted(name)} (${errorClass(error)})`);
  }

  const { reading, settled } = await pollUntilSettled(page, {
    read: readRows,
    arg: { selector: UPLOAD_ROW_SELECTOR, name, before: before.matching },
    isSettled: (state) => state === "filed",
    bound: bound.rowMs,
    pollMs: bound.pollMs,
  });
  const landed = pathOf(page.url());
  if (!settled) {
    const rows = /** @type {{ rows?: string[] }} */ (reading).rows;
    const shown = !rows ? "the list could not be read" : rows.length === 0 ? "the list shows no row" : `its rows: ${listed(rows, "")}`;
    throw refuse(STEP, record, "no-row", `no new row naming ${quoted(name)} appeared in the list on ${landed} within ${bound.rowMs} ms; ${shown}`);
  }
  const elapsedMs = elapsedSince(start);
  record(`${STEP}: pressed ${quoted(named)} on ${at} and handed ${quoted(name)} to its file chooser; its row appeared after ${elapsedMs} ms`);
  return { control: named, file: name, path: landed, elapsedMs };
}
