import { describe, it, expect } from "vitest";
import {
  evaluateTaskGates,
  resolveDependency,
  buildExecutorRegistry,
  retryBackoffMs,
  ENGINE_OPS,
} from "../engine";

describe("resolveDependency (per-edge outcome semantics)", () => {
  it("success edge", () => {
    expect(resolveDependency("succeeded", "success")).toBe("satisfied");
    expect(resolveDependency("failed", "success")).toBe("blocked");
    expect(resolveDependency("skipped", "success")).toBe("blocked");
    expect(resolveDependency("cancelled", "success")).toBe("blocked");
    expect(resolveDependency("running", "success")).toBe("pending");
  });
  it("skipped edge tolerates skip", () => {
    expect(resolveDependency("succeeded", "skipped")).toBe("satisfied");
    expect(resolveDependency("skipped", "skipped")).toBe("satisfied");
    expect(resolveDependency("failed", "skipped")).toBe("blocked");
  });
  it("failed edge (compensation)", () => {
    expect(resolveDependency("failed", "failed")).toBe("satisfied");
    expect(resolveDependency("succeeded", "failed")).toBe("blocked");
    expect(resolveDependency("idle", "failed")).toBe("pending");
  });
});

describe("evaluateTaskGates", () => {
  const now = new Date("2026-06-10T00:00:00Z");

  it("passes timing when due, pends when not", () => {
    const past = evaluateTaskGates({ dueAtUtc: new Date("2026-06-09T00:00:00Z"), now, dependencies: [], depStatusById: new Map(), hasApproval: false });
    expect(past.find((g) => g.kind === "timing")!.state).toBe("passed");
    const future = evaluateTaskGates({ dueAtUtc: new Date("2026-06-11T00:00:00Z"), now, dependencies: [], depStatusById: new Map(), hasApproval: false });
    expect(future.find((g) => g.kind === "timing")!.state).toBe("pending");
  });

  it("blocks on an unmet dependency outcome and explains why", () => {
    const gates = evaluateTaskGates({
      dueAtUtc: null,
      now,
      dependencies: [{ dependsOnTaskId: "t1", dependsOnKey: "blog", outcome: "success" }],
      depStatusById: new Map([["t1", "failed"]]),
      hasApproval: false,
    });
    const dep = gates.find((g) => g.kind === "dependency")!;
    expect(dep.state).toBe("blocked");
    expect(dep.blockerRefs).toContain("blog");
  });

  it("pends on a running dependency", () => {
    const gates = evaluateTaskGates({
      dueAtUtc: null,
      now,
      dependencies: [{ dependsOnTaskId: "t1", outcome: "success" }],
      depStatusById: new Map([["t1", "running"]]),
      hasApproval: false,
    });
    expect(gates.find((g) => g.kind === "dependency")!.state).toBe("pending");
  });

  it("approval gate pends until granted; not_required when absent", () => {
    const pending = evaluateTaskGates({ dueAtUtc: null, now, dependencies: [], depStatusById: new Map(), hasApproval: true, approvalStatus: "pending" });
    expect(pending.find((g) => g.kind === "approval")!.state).toBe("pending");
    const granted = evaluateTaskGates({ dueAtUtc: null, now, dependencies: [], depStatusById: new Map(), hasApproval: true, approvalStatus: "granted" });
    expect(granted.find((g) => g.kind === "approval")!.state).toBe("passed");
    const none = evaluateTaskGates({ dueAtUtc: null, now, dependencies: [], depStatusById: new Map(), hasApproval: false });
    expect(none.find((g) => g.kind === "approval")!.state).toBe("not_required");
  });
});

describe("executor registry + ops", () => {
  it("built-in non-agent executors resolve", async () => {
    const reg = buildExecutorRegistry();
    const input = { task: { id: "t", key: "k", type: "checkpoint", title: "T", input: null, agentRef: null, assigneeLevel: null, assigneeId: null }, provenance: {}, idempotencyKey: "k:1", attemptNo: 1 };
    expect((await reg.checkpoint(input)).status).toBe("succeeded");
    expect((await reg.wait(input)).status).toBe("succeeded");
    expect((await reg.manual(input)).status).toBe("running"); // awaits human
    expect((await reg.notification(input)).status).toBe("succeeded"); // default no-op
    expect((await reg.agent_task(input)).status).toBe("running"); // unwired
  });

  it("uses injected notification/agent executors", async () => {
    const reg = buildExecutorRegistry({
      notification: () => ({ status: "succeeded", note: "sent" }),
      agent_task: () => ({ status: "running", childRunId: "run-1" }),
    });
    const input = { task: { id: "t", key: "k", type: "notification", title: "T", input: null, agentRef: null, assigneeLevel: null, assigneeId: null }, provenance: {}, idempotencyKey: "k:1", attemptNo: 1 };
    expect((await reg.notification(input)).note).toBe("sent");
    expect((await reg.agent_task(input)).childRunId).toBe("run-1");
  });

  it("exponential retry backoff", () => {
    expect(retryBackoffMs(1)).toBe(ENGINE_OPS.retryBackoffMs);
    expect(retryBackoffMs(2)).toBe(ENGINE_OPS.retryBackoffMs * 2);
    expect(retryBackoffMs(3)).toBe(ENGINE_OPS.retryBackoffMs * 4);
  });
});
