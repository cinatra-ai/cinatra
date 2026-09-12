/**
 * cinatra#3030 convergence round — THE RETENTION TIER HAS A PRODUCTION CALLER.
 *
 * Acceptance item 5 ("a run folder is gone after pickup plus the grace period")
 * is a promise about a running instance, not about a test that calls the sweep
 * itself. The boot phase below is the instance's own caller; the pickup runner
 * is the second (default-road-pickup-run.ts, which sweeps after every pickup).
 */
import { describe, it, expect } from "vitest";

import { systemLoopPhases } from "@/lib/boot/phases/system-loops";

describe("the run folder's retention sweep is wired into boot", () => {
  it("registers a run-folder-retention-sweep phase", () => {
    const names = systemLoopPhases().map((phase) => phase.name);
    expect(names).toContain("run-folder-retention-sweep");
  });
});
