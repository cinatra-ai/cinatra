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
