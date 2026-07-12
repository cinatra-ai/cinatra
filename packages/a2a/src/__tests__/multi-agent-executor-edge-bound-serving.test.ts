import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message } from "@a2a-js/sdk";
import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";

// cinatra#1392 Gap 2 — proves the injected TRUSTED edge-bound serving decision is
// resolved BEFORE the untrusted client requestedVersion and drives the run
// FAIL-CLOSED: a non-default pin threads the snapshot + stamps the dependent
// install id (overriding the client version); a default serve stamps the id with
// NO snapshot and resolves the default WITHOUT the client version; a refuse
// publishes a failed event and creates NO run; an unexpected resolver error fails
// closed; a forged dependent id in client metadata is never consulted.

let capturedDuringRun: {
  version?: string;
  snapshotId?: string;
  dependentInstallId?: string;
} = {};
let subExecuteCalls = 0;

vi.mock("../agent-executor", () => {
  class MockInProcessAgentExecutor {
    private readonly opts: {
      getPinnedVersionForTask?: (t: string) => string | undefined;
      getPinnedSnapshotIdForTask?: (t: string) => string | undefined;
      getPinnedDependentInstallIdForTask?: (t: string) => string | undefined;
    };
    constructor(opts: unknown) {
      this.opts = opts as MockInProcessAgentExecutor["opts"];
    }
    execute = vi.fn(async (ctx: RequestContext) => {
      subExecuteCalls += 1;
      const taskId = ctx.taskId ?? ctx.contextId ?? "unknown";
      // Mirror the real createAgentRun call site: read all three pinned lookups.
      capturedDuringRun = {
        version: this.opts.getPinnedVersionForTask?.(taskId),
        snapshotId: this.opts.getPinnedSnapshotIdForTask?.(taskId),
        dependentInstallId: this.opts.getPinnedDependentInstallIdForTask?.(taskId),
      };
    });
    cancelTask = vi.fn(async () => {});
  }
  return { InProcessAgentExecutor: MockInProcessAgentExecutor };
});

vi.mock("../version-pinning", () => ({ resolveVersionBeforeRun: vi.fn() }));

import { resolveVersionBeforeRun } from "../version-pinning";
import {
  MultiAgentExecutor,
  type EdgeBoundServingDecision,
} from "../multi-agent-executor";

const resolveMock = resolveVersionBeforeRun as unknown as ReturnType<typeof vi.fn>;
const templates = [{ id: "t-a", packageName: "pkg-a", name: "A", packageVersion: "1.0.0" }];

function buildCtx(
  taskId: string,
  metadata: Record<string, unknown> = { skillId: "pkg-a" },
): RequestContext {
  const msg = {
    kind: "message",
    messageId: "m-1",
    role: "user",
    parts: [],
    metadata,
  } as Message;
  return { userMessage: msg, taskId, contextId: taskId } as RequestContext;
}

type PublishBus = ExecutionEventBus & { publish: ReturnType<typeof vi.fn> };
function buildBus(): PublishBus {
  return {
    publish: vi.fn(),
    finished: vi.fn(),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
  } as unknown as PublishBus;
}

// publishFailed emits a status-update whose message part carries "[CODE] message".
function failedText(bus: PublishBus): string {
  for (const call of bus.publish.mock.calls) {
    const ev = call[0] as {
      status?: { message?: { parts?: Array<{ text?: string }> } };
    };
    const text = ev?.status?.message?.parts?.[0]?.text;
    if (text) return text;
  }
  return "";
}

describe("MultiAgentExecutor — Gap 2 edge-bound serving", () => {
  beforeEach(() => {
    capturedDuringRun = {};
    subExecuteCalls = 0;
    resolveMock.mockReset();
  });

  it("pins the resolved non-default snapshot + stamps the dependent id, overriding the client requestedVersion", async () => {
    const resolveEdgeBoundServing = vi.fn(
      async (): Promise<EdgeBoundServingDecision> => ({
        kind: "serve",
        targetInstallId: "iext_sib",
        snapshotId: "snap-edge",
        version: "1.4.0",
      }),
    );
    const exec = new MultiAgentExecutor({
      templates: templates as never,
      enqueueJob: vi.fn(),
      resolveEdgeBoundServing,
    });
    // Client asks for a DIFFERENT version — the trusted edge is authoritative.
    await exec.execute(buildCtx("task-1", { skillId: "pkg-a", version: "9.9.9" }), buildBus());
    expect(subExecuteCalls).toBe(1);
    expect(capturedDuringRun).toEqual({
      version: "1.4.0",
      snapshotId: "snap-edge",
      dependentInstallId: "iext_sib",
    });
    // resolveVersionBeforeRun is NOT consulted for a trusted non-default pin.
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("serves the DEFAULT (stamp id, no snapshot) resolving the default version WITHOUT the client requestedVersion", async () => {
    resolveMock.mockResolvedValueOnce({ templateId: "t-a", resolvedVersion: "2.0.0" });
    const resolveEdgeBoundServing = vi.fn(
      async (): Promise<EdgeBoundServingDecision> => ({
        kind: "serve",
        targetInstallId: "iext_def",
      }),
    );
    const exec = new MultiAgentExecutor({
      templates: templates as never,
      enqueueJob: vi.fn(),
      resolveEdgeBoundServing,
    });
    await exec.execute(buildCtx("task-2", { skillId: "pkg-a", version: "9.9.9" }), buildBus());
    expect(capturedDuringRun).toEqual({
      version: "2.0.0",
      snapshotId: undefined,
      dependentInstallId: "iext_def",
    });
    // Default version resolved WITHOUT the untrusted client requestedVersion.
    expect(resolveMock).toHaveBeenCalledWith({ packageName: "pkg-a" });
  });

  it("REFUSES with evidence and creates NO run when the decision is refuse", async () => {
    const resolveEdgeBoundServing = vi.fn(
      async (): Promise<EdgeBoundServingDecision> => ({
        kind: "refuse",
        code: "EDGE_BOUND_AGENT_UNREACHABLE",
        message: "no published snapshot for the resolved pin",
      }),
    );
    const bus = buildBus();
    const exec = new MultiAgentExecutor({
      templates: templates as never,
      enqueueJob: vi.fn(),
      resolveEdgeBoundServing,
    });
    await exec.execute(buildCtx("task-3"), bus);
    expect(subExecuteCalls).toBe(0); // no run created
    expect(failedText(bus)).toContain("[EDGE_BOUND_AGENT_UNREACHABLE]");
    expect(failedText(bus)).toContain("no published snapshot");
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED (no run, no default serve) when the injected resolver throws unexpectedly", async () => {
    const resolveEdgeBoundServing = vi.fn(async (): Promise<EdgeBoundServingDecision> => {
      throw new Error("db down");
    });
    const bus = buildBus();
    const exec = new MultiAgentExecutor({
      templates: templates as never,
      enqueueJob: vi.fn(),
      resolveEdgeBoundServing,
    });
    await exec.execute(buildCtx("task-4"), bus);
    expect(subExecuteCalls).toBe(0);
    expect(failedText(bus)).toContain("[EDGE_BOUND_RESOLUTION_FAILED]");
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("kind:none falls through to the legacy client requestedVersion path and stamps NO dependent id", async () => {
    resolveMock.mockResolvedValueOnce({
      templateId: "t-a",
      resolvedVersion: "3.3.3",
      snapshotId: "snap-req",
    });
    const resolveEdgeBoundServing = vi.fn(
      async (): Promise<EdgeBoundServingDecision> => ({ kind: "none" }),
    );
    const exec = new MultiAgentExecutor({
      templates: templates as never,
      enqueueJob: vi.fn(),
      resolveEdgeBoundServing,
    });
    await exec.execute(buildCtx("task-5", { skillId: "pkg-a", version: "3.3.3" }), buildBus());
    // Legacy path: the client requestedVersion IS honored here.
    expect(resolveMock).toHaveBeenCalledWith({
      packageName: "pkg-a",
      requestedVersion: "3.3.3",
    });
    expect(capturedDuringRun).toEqual({
      version: "3.3.3",
      snapshotId: "snap-req",
      dependentInstallId: undefined,
    });
  });

  it("without an injected resolver, behavior is unchanged (no dependent id; client version honored)", async () => {
    resolveMock.mockResolvedValueOnce({ templateId: "t-a", resolvedVersion: "1.0.0" });
    const exec = new MultiAgentExecutor({ templates: templates as never, enqueueJob: vi.fn() });
    await exec.execute(buildCtx("task-6"), buildBus());
    expect(capturedDuringRun.dependentInstallId).toBeUndefined();
    expect(resolveMock).toHaveBeenCalledWith({
      packageName: "pkg-a",
      requestedVersion: undefined,
    });
  });

  it("never consults a forged dependent id from client metadata (only the injected seam decides)", async () => {
    const resolveEdgeBoundServing = vi.fn(
      async (): Promise<EdgeBoundServingDecision> => ({ kind: "none" }),
    );
    resolveMock.mockResolvedValueOnce({ templateId: "t-a", resolvedVersion: "1.0.0" });
    const exec = new MultiAgentExecutor({
      templates: templates as never,
      enqueueJob: vi.fn(),
      resolveEdgeBoundServing,
    });
    // Attacker stuffs a dependent/target install id into client metadata.
    await exec.execute(
      buildCtx("task-7", {
        skillId: "pkg-a",
        dependentInstallId: "iext_forged",
        targetInstallId: "iext_forged",
      }),
      buildBus(),
    );
    // The forged id never reached the run; only the injected seam (none) decided.
    expect(capturedDuringRun.dependentInstallId).toBeUndefined();
    // The seam was invoked with ONLY the target package name — no client dependent id.
    expect(resolveEdgeBoundServing).toHaveBeenCalledWith({ targetPackageName: "pkg-a" });
  });
});
