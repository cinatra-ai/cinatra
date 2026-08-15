// The DURABLE gate row written by the park seam (cinatra#2748).
//
// The defect this pins: a paused run's only human-answerable artifact lived in
// the Redis run event log, which expires. When the key was gone the gate was
// gone from every store and the run rendered an unanswerable banner forever.
// The seam now writes a Postgres row for the gate it just verified.
//
// The contract asserted here:
//   - the row is written on the VERIFIED path, once, with the verified artifact;
//   - it is written BEFORE the run is parked, so a parked run always has one;
//   - a re-emit of an already-parked gate writes too (the row is idempotent);
//   - NO row is written on any path that fails the run — a build failure, an
//     emit failure, or an unverifiable read-back;
//   - a failing write does NOT fail the run: the event-log frame was already
//     proven readable, so the gate stays answerable without its safety net.
//
// PURE: `../human-gate-park` imports nothing, so every effect is an injected spy.
//
//   cd packages/agents && pnpm exec vitest run \
//     src/__tests__/human-gate-park-durable-row.test.ts
import { describe, expect, it, vi } from "vitest";

import {
  parkRunOnHumanGate,
  type HumanGateArtifact,
  type ParkRunOnHumanGateOptions,
  type ReadBackGate,
} from "../human-gate-park";

const RUN_ID = "run-2748";
const GATE_ID = "setup-run-2748";

const ARTIFACT: HumanGateArtifact = {
  schema: { type: "string", title: "brief" },
  xRenderer: "@cinatra-ai/agent-builder:schema-field-fallback",
  values: { brief: "draft" },
  reviewTaskId: GATE_ID,
  fieldName: "brief",
};

const READABLE: ReadBackGate = {
  reviewTaskId: GATE_ID,
  xRenderer: ARTIFACT.xRenderer,
};

function harness(overrides: Partial<ParkRunOnHumanGateOptions> = {}) {
  const order: string[] = [];
  const persistArtifact = vi
    .fn<(a: HumanGateArtifact) => Promise<void>>()
    .mockImplementation(async () => {
      order.push("persist");
    });
  const parkRun = vi.fn<() => Promise<void>>().mockImplementation(async () => {
    order.push("park");
  });
  const failRun = vi.fn<(error: string) => Promise<void>>().mockResolvedValue(undefined);
  const emitInterrupt = vi.fn<(a: HumanGateArtifact) => void>();
  const options: ParkRunOnHumanGateOptions = {
    runId: RUN_ID,
    gateLabel: "setup field 'brief'",
    alreadyParked: false,
    buildArtifact: async () => ARTIFACT,
    emitInterrupt,
    readBackGate: async () => READABLE,
    parkRun,
    failRun,
    persistArtifact,
    attempts: 2,
    delayMs: 0,
    sleep: async () => {},
    ...overrides,
  };
  return { options, persistArtifact, parkRun, failRun, emitInterrupt, order };
}

describe("parkRunOnHumanGate — the durable gate row", () => {
  it("writes the verified artifact exactly once, before the run is parked", async () => {
    const { options, persistArtifact, parkRun, order } = harness();

    await expect(parkRunOnHumanGate(options)).resolves.toEqual({ outcome: "parked" });

    expect(persistArtifact).toHaveBeenCalledTimes(1);
    expect(persistArtifact).toHaveBeenCalledWith(ARTIFACT);
    expect(parkRun).toHaveBeenCalledTimes(1);
    // A parked run must never exist without its durable row.
    expect(order).toEqual(["persist", "park"]);
  });

  it("writes on a verified re-emit of an already-parked gate", async () => {
    const { options, persistArtifact, parkRun } = harness({ alreadyParked: true });

    await expect(parkRunOnHumanGate(options)).resolves.toEqual({ outcome: "re-emitted" });

    expect(persistArtifact).toHaveBeenCalledTimes(1);
    expect(persistArtifact).toHaveBeenCalledWith(ARTIFACT);
    // `pending_approval -> pending_approval` is not a legal edge.
    expect(parkRun).not.toHaveBeenCalled();
  });

  it("writes no row when the artifact cannot be built", async () => {
    const { options, persistArtifact, failRun, parkRun } = harness({
      buildArtifact: async () => {
        throw new Error("schema enrichment exploded");
      },
    });

    const result = await parkRunOnHumanGate(options);

    expect(result.outcome).toBe("failed");
    expect(persistArtifact).not.toHaveBeenCalled();
    expect(parkRun).not.toHaveBeenCalled();
    expect(failRun).toHaveBeenCalledTimes(1);
  });

  it("writes no row when the artifact cannot be emitted", async () => {
    const { options, persistArtifact, failRun } = harness({
      emitInterrupt: () => {
        throw new Error("event log unreachable");
      },
    });

    const result = await parkRunOnHumanGate(options);

    expect(result.outcome).toBe("failed");
    expect(persistArtifact).not.toHaveBeenCalled();
    expect(failRun).toHaveBeenCalledTimes(1);
  });

  it("writes no row when the emitted artifact is not readable back", async () => {
    const { options, persistArtifact, failRun, parkRun } = harness({
      readBackGate: async () => null,
    });

    const result = await parkRunOnHumanGate(options);

    expect(result.outcome).toBe("failed");
    expect(persistArtifact).not.toHaveBeenCalled();
    expect(parkRun).not.toHaveBeenCalled();
    expect(failRun).toHaveBeenCalledTimes(1);
  });

  it("writes no row when the readable gate belongs to a different gate", async () => {
    const { options, persistArtifact, failRun } = harness({
      readBackGate: async () => ({ reviewTaskId: "setup-other-run", xRenderer: "r" }),
    });

    const result = await parkRunOnHumanGate(options);

    expect(result.outcome).toBe("failed");
    expect(persistArtifact).not.toHaveBeenCalled();
    expect(failRun).toHaveBeenCalledTimes(1);
  });

  it("still parks the run when the durable write fails", async () => {
    const persistArtifact = vi
      .fn<(a: HumanGateArtifact) => Promise<void>>()
      .mockRejectedValue(new Error("store unavailable"));
    const { options, parkRun, failRun } = harness({ persistArtifact });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(parkRunOnHumanGate(options)).resolves.toEqual({ outcome: "parked" });
      expect(parkRun).toHaveBeenCalledTimes(1);
      expect(failRun).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("parks unchanged when no durable store is wired at all", async () => {
    const { options, parkRun, failRun } = harness({ persistArtifact: undefined });

    await expect(parkRunOnHumanGate(options)).resolves.toEqual({ outcome: "parked" });

    expect(parkRun).toHaveBeenCalledTimes(1);
    expect(failRun).not.toHaveBeenCalled();
  });
});
