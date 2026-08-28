// ---------------------------------------------------------------------------
// THE COMMITTED S9d-REWORK WALK PLAN, as a fixture.
//
// `s9d-rework-walk-plan.json` is the round-5 plan BYTE FOR BYTE as it was
// committed (blob de51e2d0e3aa30e1d8f5df589286877beebfb84c). It is a real test
// input: two suites read it and grade it through the shipped `validateWalkPlan`,
// so it has to be a plan the walk vocabulary really accepted, not a hand-made
// stand-in. It moved here from the proof-artifact tree that carried it, which is
// gone; the bytes did not change on the way.
//
// WHY IT IS RE-ROOTED BEFORE IT IS GRADED. The plan's ten cells name the
// OUTPUT paths that round wrote its pictures to, under the proof-artifact root
// captures were minted into at the time. A run now mints under
// `CAPTURE_OUTPUT_ROOT`, and the shipped validator refuses any other output root
// -- correctly: that is the rule keeping pictures out of the product tree. So
// the historical output root is rewritten onto the current one HERE, in one
// place, and nothing else about the plan is touched. Every cell id, host, kind,
// state, viewport and assertion the suites actually grade is the committed one.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CAPTURE_OUTPUT_ROOT } from "../../lib/chat-hitl-capture-recorder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The fixture's path, for a suite that wants to name it in a message. */
export const WALK_PLAN_PATH = join(HERE, "s9d-rework-walk-plan.json");

/** The historical output root the committed plan was written against. */
export const HISTORICAL_OUTPUT_ROOT = "evidence/";

/** The plan exactly as committed — no rewriting. */
export function readCommittedWalkPlan() {
  return JSON.parse(readFileSync(WALK_PLAN_PATH, "utf8"));
}

/**
 * The committed plan with its cell OUTPUT paths moved onto the current capture
 * root. Returns a fresh object every call, so a suite may mutate it freely.
 */
export function loadWalkPlan() {
  const plan = readCommittedWalkPlan();
  for (const step of plan.steps ?? []) {
    for (const cell of step.cells ?? []) {
      if (typeof cell.screenshot === "string" && cell.screenshot.startsWith(HISTORICAL_OUTPUT_ROOT)) {
        cell.screenshot = CAPTURE_OUTPUT_ROOT + cell.screenshot.slice(HISTORICAL_OUTPUT_ROOT.length);
      }
    }
  }
  return plan;
}
