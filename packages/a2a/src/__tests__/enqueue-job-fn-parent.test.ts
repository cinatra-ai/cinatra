// Tests for EnqueueJobFn parentFlowJobId behavior.
//
// Verifies that the default EnqueueJobFn implementation:
//   - delegates to the underlying enqueueJob when parentFlowJobId is NOT set
//     (preserving the existing enqueue path)
//   - no-ops with a traceable console.warn when parentFlowJobId IS set, per
//     the locked architectural decision (BullMQ 5.x FlowProducer has no
//     post-hoc child attachment API, so the orchestrator worker composes its
//     tree upfront via `enqueueChildFlow`)

import { describe, expect, it, vi, beforeEach } from "vitest";

import { createDefaultEnqueueJobFn, type EnqueueJobFn } from "../agent-executor";

describe("EnqueueJobFn — parentFlowJobId extension", () => {
  let underlying: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    underlying = vi.fn().mockResolvedValue(undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warnSpy.mockClear();
  });

  it("without parentFlowJobId, delegates to the underlying enqueueJob", async () => {
    const enqueue: EnqueueJobFn = createDefaultEnqueueJobFn(underlying as unknown as (j: string, d: unknown) => Promise<void>);

    await enqueue("AGENT_BUILDER_EXECUTION", { runId: "r1" });

    expect(underlying).toHaveBeenCalledTimes(1);
    expect(underlying).toHaveBeenCalledWith("AGENT_BUILDER_EXECUTION", {
      runId: "r1",
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("with parentFlowJobId set, does NOT call the underlying enqueueJob", async () => {
    const enqueue: EnqueueJobFn = createDefaultEnqueueJobFn(underlying as unknown as (j: string, d: unknown) => Promise<void>);

    await enqueue(
      "AGENT_BUILDER_EXECUTION",
      { runId: "r2" },
      { parentFlowJobId: "parent_1" },
    );

    expect(underlying).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("warning mentions FlowProducer and enqueueChildFlow for log traceability", async () => {
    const enqueue: EnqueueJobFn = createDefaultEnqueueJobFn(underlying as unknown as (j: string, d: unknown) => Promise<void>);

    await enqueue(
      "AGENT_BUILDER_EXECUTION",
      { runId: "r3" },
      { parentFlowJobId: "parent_2" },
    );

    const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("FlowProducer");
    expect(msg).toContain("enqueueChildFlow");
    expect(msg).toContain("parent_2");
  });

  it("parentFlowJobId is optional — omitting the third arg type-checks", async () => {
    // Compile-time assertion is implicit here — if the signature were
    // required, this call would not typecheck.
    const enqueue: EnqueueJobFn = createDefaultEnqueueJobFn(underlying as unknown as (j: string, d: unknown) => Promise<void>);
    await enqueue("AGENT_BUILDER_EXECUTION", { runId: "r4" });
    expect(underlying).toHaveBeenCalledTimes(1);

    // And providing it also type-checks.
    await enqueue(
      "AGENT_BUILDER_EXECUTION",
      { runId: "r5" },
      { parentFlowJobId: "parent_3" },
    );
    // underlying was only called once (second call no-op'd).
    expect(underlying).toHaveBeenCalledTimes(1);
  });
});
