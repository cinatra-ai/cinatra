/**
 * TriggerWaitNode foundation regression gate.
 *
 * Verifies the foundation pieces of the OAS-native trigger-pause primitive:
 *   1. Run status enum has `waiting_trigger`
 *   2. Legal transitions cover the in-flow pause/resume lifecycle
 *   3. The Python TriggerWaitNode executor stub exists on disk
 *
 * Live runtime wiring (Python yield contract, TS worker marker detection,
 * release-job resume) is covered by integration tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

import type { AgentRunStatus } from "../store";
import { __LEGAL_TRANSITIONS__ } from "../store";

describe("TriggerWaitNode foundation", () => {
  it("AgentRunStatus type includes waiting_trigger", () => {
    // Compile-time + runtime check: assignable as AgentRunStatus.
    const status: AgentRunStatus = "waiting_trigger";
    expect(status).toBe("waiting_trigger");
  });

  it("legal transitions: running → waiting_trigger", () => {
    expect(__LEGAL_TRANSITIONS__.has("running->waiting_trigger")).toBe(true);
  });

  it("legal transitions: waiting_trigger → running (A2A resume)", () => {
    expect(__LEGAL_TRANSITIONS__.has("waiting_trigger->running")).toBe(true);
  });

  it("legal transitions: waiting_trigger → stopped (cancel during wait)", () => {
    expect(__LEGAL_TRANSITIONS__.has("waiting_trigger->stopped")).toBe(true);
  });

  it("legal transitions: waiting_trigger → failed (timeout / resume failure)", () => {
    expect(__LEGAL_TRANSITIONS__.has("waiting_trigger->failed")).toBe(true);
  });

  it("Python executor stub exists at docker/wayflow/cinatra_executors/trigger_wait.py", () => {
    const pyPath = path.resolve(
      __dirname,
      "../../../../docker/wayflow/cinatra_executors/trigger_wait.py",
    );
    expect(fs.existsSync(pyPath)).toBe(true);
    const content = fs.readFileSync(pyPath, "utf8");
    expect(content).toContain("CinatraTriggerWaitNodeExecutor");
    expect(content).toContain("TRIGGER_WAIT_RESUME_SOURCE");
    expect(content).toContain('"trigger-release"');
  });
});
