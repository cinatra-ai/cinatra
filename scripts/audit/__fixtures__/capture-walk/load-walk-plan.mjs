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
// THE RE-ROOTING LIVES IN THE SHIPPED RECORDER, not here. This file only names
// the fixture and hands it to `readWalkPlan` -- the SAME call the capture driver
// makes for `--walk`. When the transform lived in this file instead, the suites
// graded a plan the real CLI never saw and the documented
// `--walk <this fixture>` command died in preflight.
// ---------------------------------------------------------------------------

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPTURE_OUTPUT_ROOT,
  HISTORICAL_OUTPUT_ROOT,
  readWalkPlan,
} from "../../lib/chat-hitl-capture-recorder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The fixture's path — the one the capture index documents. */
export const WALK_PLAN_PATH = join(HERE, "s9d-rework-walk-plan.json");

export { CAPTURE_OUTPUT_ROOT, HISTORICAL_OUTPUT_ROOT };

/**
 * The committed plan, loaded exactly as the driver loads it. Returns a fresh
 * object every call, so a suite may mutate it freely.
 */
export function loadWalkPlan() {
  return readWalkPlan(WALK_PLAN_PATH);
}
