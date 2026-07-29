// cinatra#1941 S2 — boot-phase test for "register-job-system-runtime".
//
// Two things pinned:
//   - it MUST be the first phase in systemLoopPhases() — the job-system
//     runtime has to be registered BEFORE any loop seed runs, mirroring this
//     file's own documented ordering guarantee for the loop-seeds-then-
//     eager-worker split;
//   - it wires the frame module's exports into registerJobSystemRuntime with
//     the exact shape the dispatcher/registry's globalThis-slot readers
//     expect (runWithJobFrame, buildSystemIdentity, auditUnclassifiedRefusal,
//     auditFrameAnomaly).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { registerMock } = vi.hoisted(() => ({
  registerMock: vi.fn(),
}));

function runWithJobFrameRef() {}
function buildJobSystemIdentityRef() {}
function auditUnclassifiedRefusalRef() {}
function auditFrameAnomalyRef() {}

vi.mock("@/lib/background-jobs-system-frame", () => ({
  registerJobSystemRuntime: registerMock,
  runWithJobFrame: runWithJobFrameRef,
  buildJobSystemIdentity: buildJobSystemIdentityRef,
  auditUnclassifiedRefusal: auditUnclassifiedRefusalRef,
  auditFrameAnomaly: auditFrameAnomalyRef,
}));

import { systemLoopPhases } from "@/lib/boot/phases/system-loops";

beforeEach(() => {
  registerMock.mockClear();
});

describe("register-job-system-runtime boot phase", () => {
  it("is the FIRST phase — registers before any loop seed below it runs", () => {
    const phases = systemLoopPhases();
    expect(phases[0]?.name).toBe("register-job-system-runtime");
  });

  it("wires the frame module's exports into registerJobSystemRuntime with the documented shape", async () => {
    const phase = systemLoopPhases().find((p) => p.name === "register-job-system-runtime");
    expect(phase).toBeDefined();

    await phase!.run();

    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(registerMock).toHaveBeenCalledWith({
      runWithJobFrame: runWithJobFrameRef,
      buildSystemIdentity: buildJobSystemIdentityRef,
      auditUnclassifiedRefusal: auditUnclassifiedRefusalRef,
      auditFrameAnomaly: auditFrameAnomalyRef,
    });
  });
});
