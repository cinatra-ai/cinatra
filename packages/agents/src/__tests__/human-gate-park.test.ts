// Regression suite for the human-approval-gate park seam.
//
// The bug this pins: a run could enter `pending_approval` while its ONLY
// human-answerable artifact — the AG-UI INTERRUPT frame the approval surfaces
// read back — was never materialized. The park committed first, the emit was
// fire-and-forget with a swallowing catch, and the background job still
// reported success. The run then sat in `pending_approval` with zero approval
// artifacts, no error, and nothing a human could answer.
//
// PURE: `../human-gate-park` imports nothing (no db, no Redis, no transport),
// so every effect here is an injected spy and the invariant is asserted
// directly.
import { describe, expect, it, vi } from "vitest";

import {
  HUMAN_GATE_ARTIFACT_FAILURE,
  parkRunOnHumanGate,
  type HumanGateArtifact,
  type ParkRunOnHumanGateOptions,
  type ReadBackGate,
} from "../human-gate-park";

const RUN_ID = "run-under-test";
const GATE_ID = "setup-run-under-test";

const ARTIFACT: HumanGateArtifact = {
  schema: { type: "string", title: "brief" },
  xRenderer: "@cinatra-ai/agent-builder:schema-field-fallback",
  values: {},
  reviewTaskId: GATE_ID,
  fieldName: "brief",
};

const READABLE: ReadBackGate = {
  reviewTaskId: GATE_ID,
  xRenderer: ARTIFACT.xRenderer,
};

/** Verified-happy-path harness; each test overrides exactly the effect it bends. */
function harness(overrides: Partial<ParkRunOnHumanGateOptions> = {}) {
  const emitInterrupt = vi.fn<(a: HumanGateArtifact) => void>();
  const parkRun = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const failRun = vi.fn<(error: string) => Promise<void>>().mockResolvedValue(undefined);
  const readBackGate = vi
    .fn<(id: string) => Promise<ReadBackGate>>()
    .mockResolvedValue(READABLE);
  const options: ParkRunOnHumanGateOptions = {
    runId: RUN_ID,
    gateLabel: "setup field 'brief'",
    alreadyParked: false,
    buildArtifact: async () => ARTIFACT,
    emitInterrupt,
    readBackGate,
    parkRun,
    failRun,
    // Deterministic: no wall-clock, and a retry budget the tests can exhaust.
    attempts: 3,
    delayMs: 0,
    sleep: async () => {},
    ...overrides,
  };
  return { options, emitInterrupt, parkRun, failRun, readBackGate };
}

describe("parkRunOnHumanGate", () => {
  // -------------------------------------------------------------------------
  // (c) happy path — behaviour is unchanged for a gate that materializes.
  // -------------------------------------------------------------------------
  it("parks the run once the emitted gate is readable back", async () => {
    const { options, emitInterrupt, parkRun, failRun } = harness();

    await expect(parkRunOnHumanGate(options)).resolves.toEqual({ outcome: "parked" });

    expect(emitInterrupt).toHaveBeenCalledTimes(1);
    expect(emitInterrupt).toHaveBeenCalledWith(ARTIFACT);
    expect(parkRun).toHaveBeenCalledTimes(1);
    expect(failRun).not.toHaveBeenCalled();
  });

  it("emits the gate BEFORE the run is parked", async () => {
    const order: string[] = [];
    const { options } = harness({
      emitInterrupt: () => {
        order.push("emit");
      },
      parkRun: async () => {
        order.push("park");
      },
    });

    await parkRunOnHumanGate(options);

    expect(order).toEqual(["emit", "park"]);
  });

  it("tolerates a read-back that only becomes readable on a later attempt", async () => {
    const readBackGate = vi
      .fn<(id: string) => Promise<ReadBackGate>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(READABLE);
    const { options, parkRun, failRun } = harness({ readBackGate });

    await expect(parkRunOnHumanGate(options)).resolves.toEqual({ outcome: "parked" });

    expect(readBackGate).toHaveBeenCalledTimes(2);
    expect(parkRun).toHaveBeenCalledTimes(1);
    expect(failRun).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (a) prompt persistence fails → named error state, never a phantom wait.
  // -------------------------------------------------------------------------
  it("fails the run with a named error when the gate is never readable back", async () => {
    const { options, parkRun, failRun } = harness({
      readBackGate: async () => null,
    });

    const result = await parkRunOnHumanGate(options);

    expect(result.outcome).toBe("failed");
    expect(parkRun).not.toHaveBeenCalled();
    expect(failRun).toHaveBeenCalledTimes(1);
    const recorded = failRun.mock.calls[0]![0];
    expect(recorded).toContain(HUMAN_GATE_ARTIFACT_FAILURE);
    expect(recorded).toContain("setup field 'brief'");
    expect(recorded).toContain("no approval prompt is readable");
  });

  it("fails the run when the read-back itself is unavailable", async () => {
    const { options, parkRun, failRun } = harness({
      readBackGate: async () => {
        throw new Error("redis unreachable");
      },
    });

    const result = await parkRunOnHumanGate(options);

    expect(result.outcome).toBe("failed");
    expect(parkRun).not.toHaveBeenCalled();
    expect(failRun.mock.calls[0]![0]).toContain("redis unreachable");
  });

  it("fails the run when the readable prompt belongs to a different gate", async () => {
    const { options, parkRun, failRun } = harness({
      readBackGate: async () => ({ reviewTaskId: "wayflow-other", xRenderer: "r" }),
    });

    const result = await parkRunOnHumanGate(options);

    expect(result.outcome).toBe("failed");
    expect(parkRun).not.toHaveBeenCalled();
    expect(failRun.mock.calls[0]![0]).toContain("belongs to a different gate");
  });

  it("fails the run when the readable prompt carries no renderer", async () => {
    // An empty renderer is exactly the unanswerable shell the approval surfaces
    // render as "awaiting approval" with no form.
    const { options, parkRun, failRun } = harness({
      readBackGate: async () => ({ reviewTaskId: GATE_ID, xRenderer: "" }),
    });

    const result = await parkRunOnHumanGate(options);

    expect(result.outcome).toBe("failed");
    expect(parkRun).not.toHaveBeenCalled();
    expect(failRun.mock.calls[0]![0]).toContain("carries no renderer");
  });

  // -------------------------------------------------------------------------
  // (b) the gate never reaches the run at all → named error, not a park.
  // -------------------------------------------------------------------------
  it("fails the run with a named error when the emit throws", async () => {
    const { options, parkRun, failRun, readBackGate } = harness({
      emitInterrupt: () => {
        throw new Error("publish refused");
      },
    });

    const result = await parkRunOnHumanGate(options);

    expect(result.outcome).toBe("failed");
    expect(parkRun).not.toHaveBeenCalled();
    expect(readBackGate).not.toHaveBeenCalled();
    expect(failRun.mock.calls[0]![0]).toContain("could not be emitted");
    expect(failRun.mock.calls[0]![0]).toContain("publish refused");
  });

  it("fails the run with a named error when the gate payload cannot be built", async () => {
    // Schema enrichment used to run AFTER the park committed, so a throw here
    // left the run parked on a gate that was never emitted at all.
    const { options, emitInterrupt, parkRun, failRun } = harness({
      buildArtifact: async () => {
        throw new Error("schema enrichment failed");
      },
    });

    const result = await parkRunOnHumanGate(options);

    expect(result.outcome).toBe("failed");
    expect(emitInterrupt).not.toHaveBeenCalled();
    expect(parkRun).not.toHaveBeenCalled();
    expect(failRun.mock.calls[0]![0]).toContain("could not be built");
  });

  // -------------------------------------------------------------------------
  // multi-gate re-emit
  // -------------------------------------------------------------------------
  it("re-emits without transitioning when the run is already parked", async () => {
    const { options, emitInterrupt, parkRun, failRun } = harness({ alreadyParked: true });

    await expect(parkRunOnHumanGate(options)).resolves.toEqual({ outcome: "re-emitted" });

    expect(emitInterrupt).toHaveBeenCalledTimes(1);
    expect(parkRun).not.toHaveBeenCalled();
    expect(failRun).not.toHaveBeenCalled();
  });

  it("fails an already-parked run whose re-emitted gate is unreadable", async () => {
    const { options, parkRun, failRun } = harness({
      alreadyParked: true,
      readBackGate: async () => null,
    });

    const result = await parkRunOnHumanGate(options);

    expect(result.outcome).toBe("failed");
    expect(parkRun).not.toHaveBeenCalled();
    expect(failRun.mock.calls[0]![0]).toContain(HUMAN_GATE_ARTIFACT_FAILURE);
  });

  // -------------------------------------------------------------------------
  // the seam never silently leaves a run parked
  // -------------------------------------------------------------------------
  it("always drives exactly one landing effect", async () => {
    const readBacks: Array<(id: string) => Promise<ReadBackGate>> = [
      async () => READABLE,
      async () => null,
      async () => ({ reviewTaskId: "other", xRenderer: "r" }),
    ];
    for (const readBackGate of readBacks) {
      const { options, parkRun, failRun } = harness({ readBackGate });
      await parkRunOnHumanGate(options);
      expect(parkRun.mock.calls.length + failRun.mock.calls.length).toBe(1);
    }
  });
});
