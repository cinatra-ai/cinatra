// The steps module's surface: what it offers, that every bound is a named
// constant, and that a plain Node process can load it.
//
// An external driver imports `tests/e2e/steps/index.mjs` from the checkout under
// test, with that checkout's own Playwright, in a Node process that knows
// nothing of TypeScript or of this repository's import aliases. So the module is
// plain ESM that imports Node's builtins and its own files, and nothing else.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { theSteps } from "./backends.mjs";

const STEPS_DIR = fileURLToPath(new URL("..", import.meta.url));
const INDEX_URL = new URL("../index.mjs", import.meta.url).href;

const STEP_NAMES = ["navigateTo", "readCount", "readStandingRequests", "signInThroughPage", "waitForIsland", "watchRun"];

// Every bound, by the name a caller reads it by. A bound added, renamed or
// removed without this list changing fails here.
const BOUND_NAMES = [
  "COUNT_BOUND_MS",
  "COUNT_POLL_MS",
  "COUNT_SETTLE_MS",
  "FRAME_BOUND_MS",
  "ISLAND_POLL_MS",
  "ISLAND_WAIT_BOUND_MS",
  "NAVIGATE_ACTION_BOUND_MS",
  "NAVIGATE_LANDING_BOUND_MS",
  "NAVIGATE_START_BOUND_MS",
  "READING_BOUND_MS",
  "RUN_WATCH_BOUND_MS",
  "RUN_WATCH_POLL_MS",
  "SIGN_IN_ACTION_BOUND_MS",
  "SIGN_IN_ANSWER_BOUND_MS",
  "SIGN_IN_HYDRATION_BOUND_MS",
  "SIGN_IN_HYDRATION_POLL_MS",
  "SIGN_IN_NAVIGATION_BOUND_MS",
  "SIGN_IN_REQUEST_BOUND_MS",
];

// readRows, the landing of signInThroughPage, dispatchRun, press, selectFrom,
// uploadFile, fillForm, switchTheme and decideGate: their steps and their
// bounds join the lists above in this one place, and the bounds stay in order.
STEP_NAMES.push("decideGate", "dispatchRun", "fillForm", "press", "readRows", "selectFrom", "switchTheme", "uploadFile");
BOUND_NAMES.push(
  "CONTROL_ACTION_BOUND_MS",
  "CONTROL_HYDRATION_BOUND_MS",
  "CONTROL_POLL_MS",
  "DISPATCH_RUN_BOUND_MS",
  "DISPATCH_RUN_COMPOSER_BOUND_MS",
  "FORM_ACTION_BOUND_MS",
  "FORM_ERROR_BOUND_MS",
  "FORM_FIELDS_BOUND_MS",
  "FORM_POLL_MS",
  "GATE_ACTION_BOUND_MS",
  "GATE_FIND_BOUND_MS",
  "GATE_LEAVE_BOUND_MS",
  "GATE_POLL_MS",
  "PRESS_SETTLE_BOUND_MS",
  "PRESS_START_BOUND_MS",
  "READ_ROWS_BOUND_MS",
  "SELECT_REFLECT_BOUND_MS",
  "SIGN_IN_LANDING_BOUND_MS",
  "THEME_ACTION_BOUND_MS",
  "THEME_APPLIED_BOUND_MS",
  "THEME_CONTROL_BOUND_MS",
  "THEME_POLL_MS",
  "UPLOAD_ACTION_BOUND_MS",
  "UPLOAD_CHOOSER_BOUND_MS",
  "UPLOAD_CONTROL_BOUND_MS",
  "UPLOAD_POLL_MS",
  "UPLOAD_ROW_BOUND_MS",
);
BOUND_NAMES.sort();
// readControlNames joins the steps; its one bound of time is the shared reading
// bound, listed above already.
STEP_NAMES.push("readControlNames");
// armPageTape and readPageTape join the steps; their one bound is the shared
// reading bound too.
STEP_NAMES.push("armPageTape", "readPageTape");
// typeInWindow, waitForTurn, reloadPage, sendInComposer and openAddress: their
// steps and their bounds join the lists in this one place, and the bounds stay
// in order.
STEP_NAMES.push("openAddress", "reloadPage", "sendInComposer", "typeInWindow", "waitForTurn");
BOUND_NAMES.push(
  "COMPOSER_CARD_BOUND_MS",
  "OPEN_ADDRESS_BOUND_MS",
  "RELOAD_BOUND_MS",
  "TURN_BOUND_MS",
  "TURN_CEILING_MS",
  "TURN_POLL_MS",
  "WINDOW_FIELD_BOUND_MS",
  "WINDOW_SENT_BOUND_MS",
);
BOUND_NAMES.sort();
// pressByTestId and readTitle: their steps and their bounds join the lists in
// this one place, and the bounds stay in order. pressByTestId takes the bounds
// of press, listed above already.
STEP_NAMES.push("pressByTestId", "readTitle");
BOUND_NAMES.push("TITLE_BOUND_MS", "TITLE_POLL_MS", "TITLE_SETTLE_MS");
BOUND_NAMES.sort();
// openPageInOwnContext: its step and its bound join the lists in this one
// place, and the bounds stay in order.
STEP_NAMES.push("openPageInOwnContext");
BOUND_NAMES.push("OWN_CONTEXT_LANDING_BOUND_MS");
BOUND_NAMES.sort();
// readAddress and readOptions: their readings and the bounds of readAddress
// join the lists in this one place, and the bounds stay in order. readOptions
// takes the bounds of selectFrom, listed above already.
STEP_NAMES.push("readAddress", "readOptions");
BOUND_NAMES.push("ADDRESS_BOUND_MS", "ADDRESS_POLL_MS", "ADDRESS_SETTLE_MS");
BOUND_NAMES.sort();

describe("the steps module", () => {
  it("offers the six steps, the once-only budget and the refusal", () => {
    const steps = theSteps(...STEP_NAMES, "createSignInBudget");
    const budget = steps.createSignInBudget();
    expect(budget).toEqual({ spent: 0 });
    expect(steps.createSignInBudget(), "each run gets a budget of its own").not.toBe(budget);
    expect(steps.SIGN_IN_ALLOWANCE).toBe(1);
    const refusal = new steps.StepRefusal("readCount", "input", "a reason");
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.message).toBe("readCount refused (input): a reason");
    expect({ step: refusal.step, kind: refusal.kind, reason: refusal.reason }).toEqual({
      step: "readCount",
      kind: "input",
      reason: "a reason",
    });
  });

  it("names every bound as an exported constant of whole, positive milliseconds", () => {
    const steps = theSteps(...STEP_NAMES);
    const exported = Object.keys(steps).filter((name) => name.endsWith("_MS")).sort();
    expect(exported).toEqual(BOUND_NAMES);
    for (const name of BOUND_NAMES) {
      expect(Number.isInteger(steps[name]) && steps[name] > 0, `${name} is not a whole, positive number of milliseconds`).toBe(true);
    }
  });

  it("names the bound of standing requests: six connections to one origin, less two kept free", () => {
    const steps = theSteps("readStandingRequests", "navigateTo");
    expect(steps.ORIGIN_CONNECTIONS).toBe(6);
    expect(steps.CONNECTIONS_KEPT_FREE).toBe(2);
    expect(steps.STANDING_REQUEST_BOUND).toBe(4);
    expect(steps.MULTIPLEXED_PROTOCOLS).toEqual(["h2", "h3"]);
    expect(steps.STANDING_BOUNDS).toEqual({ readingMs: steps.READING_BOUND_MS });
    expect(steps.FURTHER_PAGE_MODIFIER).toBe("ControlOrMeta");
  });

  it("names the start bound of a press: a few seconds, beside the press and the landing", () => {
    const steps = theSteps("navigateTo");
    expect(steps.NAVIGATE_START_BOUND_MS).toBe(5_000);
    expect(steps.NAVIGATE_BOUNDS).toEqual({
      actionMs: steps.NAVIGATE_ACTION_BOUND_MS,
      startMs: steps.NAVIGATE_START_BOUND_MS,
      landingMs: steps.NAVIGATE_LANDING_BOUND_MS,
    });
  });

  it("loads in a plain Node process, with no TypeScript and no aliases", () => {
    const script = `const m = await import(${JSON.stringify(INDEX_URL)}); process.stdout.write(Object.keys(m).sort().join(","));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(child.status, `a plain Node process could not load the module: ${child.stderr.split("\n")[0]}`).toBe(0);
    const names = child.stdout.split(",");
    for (const name of STEP_NAMES) expect(names).toContain(name);
  });

  it("imports nothing but Node's builtins and its own files", () => {
    const files = readdirSync(STEPS_DIR).filter((name) => name.endsWith(".mjs"));
    expect(files).toContain("index.mjs");
    for (const file of files) {
      // Comments are left out: a JSDoc type may name Playwright's types, which costs a Node process nothing.
      const source = readFileSync(`${STEPS_DIR}${file}`, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(
        (match) => match[1] ?? match[2],
      );
      for (const specifier of specifiers) {
        expect(
          specifier.startsWith("node:") || specifier.startsWith("./"),
          `${file} imports ${specifier}, which a plain Node process may not resolve`,
        ).toBe(true);
      }
    }
  });
});

describe("the steps that drive a page's own controls", () => {
  it("name each bound by the key the step's bounds take it by", () => {
    const steps = theSteps("uploadFile", "fillForm", "switchTheme", "decideGate");
    expect(steps.UPLOAD_BOUNDS).toEqual({
      controlMs: steps.UPLOAD_CONTROL_BOUND_MS,
      actionMs: steps.UPLOAD_ACTION_BOUND_MS,
      chooserMs: steps.UPLOAD_CHOOSER_BOUND_MS,
      rowMs: steps.UPLOAD_ROW_BOUND_MS,
      pollMs: steps.UPLOAD_POLL_MS,
    });
    expect(steps.FORM_BOUNDS).toEqual({
      fieldsMs: steps.FORM_FIELDS_BOUND_MS,
      actionMs: steps.FORM_ACTION_BOUND_MS,
      errorMs: steps.FORM_ERROR_BOUND_MS,
      pollMs: steps.FORM_POLL_MS,
    });
    expect(steps.THEME_BOUNDS).toEqual({
      controlMs: steps.THEME_CONTROL_BOUND_MS,
      actionMs: steps.THEME_ACTION_BOUND_MS,
      appliedMs: steps.THEME_APPLIED_BOUND_MS,
      pollMs: steps.THEME_POLL_MS,
    });
    expect(steps.GATE_BOUNDS).toEqual({
      findMs: steps.GATE_FIND_BOUND_MS,
      actionMs: steps.GATE_ACTION_BOUND_MS,
      leaveMs: steps.GATE_LEAVE_BOUND_MS,
      pollMs: steps.GATE_POLL_MS,
    });
  });

  it("keep the waits for a chooser, a field's error and the applied theme short", () => {
    const steps = theSteps("uploadFile", "fillForm", "switchTheme");
    expect(steps.UPLOAD_CHOOSER_BOUND_MS).toBe(5_000);
    expect(steps.FORM_ERROR_BOUND_MS).toBe(5_000);
    expect(steps.THEME_APPLIED_BOUND_MS).toBe(10_000);
  });

  it("name the product's own controls and markers", () => {
    const steps = theSteps("uploadFile", "switchTheme", "decideGate");
    expect(steps.UPLOAD_ROW_SELECTOR).toBe('[data-conformance-id="artifacts-library-list"] > li');
    expect(steps.THEME_CONTROL_NAME).toBe("Toggle theme");
    expect(steps.THEME_ROOT_CLASSES).toEqual({ light: "cinatra", dark: "dark" });
    expect(steps.ISLAND_THEME_ATTRIBUTE).toBe("data-island-color-scheme");
    expect(steps.GATE_SELECTOR).toBe("[data-lifecycle-card]");
    expect(steps.GATE_WAITING_STATUS).toBe("needs-review");
    expect(steps.GATE_LEFT_STATES).toEqual(["settled", "decided"]);
  });
});
