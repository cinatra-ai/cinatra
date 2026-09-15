/**
 * THE SCHEDULE DEFAULT IS STATED ONCE (cinatra#2936, epic #2926 W6).
 *
 * Plan (B) §7, wave 2: "the schedule default in the coordinator". The
 * coordinator declares and exports it, and this file pins that the exported
 * decision and the one every screen reads are THE SAME FUNCTION — not a copy
 * kept in step by review. It also pins the thing that made the duplicate
 * possible: the scheduling step holding a `defaultValues` literal of its own.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  scheduleDefaultForLaunch as decisionInTheRegistry,
  scheduleScreenSelection as mappingInTheRegistry,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

import {
  scheduleDefaultForLaunch,
  scheduleScreenSelection,
} from "../lifecycle-coordinator";
import { schedulePresenceForRun } from "../instance-screens";

describe("one statement", () => {
  it("what the coordinator exports IS what the screens read", () => {
    expect(scheduleDefaultForLaunch).toBe(decisionInTheRegistry);
    expect(scheduleScreenSelection).toBe(mappingInTheRegistry);
  });

  it("the scheduling step states no schedule default of its own", () => {
    const source = readFileSync(
      path.join(__dirname, "..", "trigger-screen-client.tsx"),
      "utf-8",
    );
    // What it does now: ask for the row the decision names.
    expect(source).toContain("defaultValues: scheduleFormDefaults(");
    // What it must never go back to: naming the row itself.
    expect(source).not.toMatch(/defaultValues:\s*\{\s*triggerType/);
  });

  it("the run page reads presence off the row, and `null` is not `nobody`", () => {
    // The rule the scheduling step's mount hands the decision, locked the way
    // this screen locks its other rules — independently of DB and auth.
    expect(schedulePresenceForRun({ humanPresent: true })).toBe(true);
    expect(schedulePresenceForRun({ humanPresent: null })).toBe(true);
    expect(schedulePresenceForRun({})).toBe(true);
    expect(schedulePresenceForRun(null)).toBe(true);
    // Recorded absence is taken at its word.
    expect(schedulePresenceForRun({ humanPresent: false })).toBe(false);
  });

  it("and the scheduling step's mount is what hands it over", () => {
    // The screen's own tests drive `humanPresent` directly, so they would go on
    // passing if the live mount stopped supplying it. Read off the mount: the
    // prop, fed by the rule above — no exact run-variable spelling and no
    // formatting pinned, and a rename of the rule moves this file's import with
    // it.
    const source = readFileSync(
      path.join(__dirname, "..", "instance-screens.tsx"),
      "utf-8",
    );
    expect(source).toMatch(/humanPresent=\{schedulePresenceForRun\(/);
  });
});
