import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message } from "@a2a-js/sdk";
import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";

// cinatra#1040 S7 — proves the REQUIRED-pin snapshot id is THREADED from the
// request-time resolver, through MultiAgentExecutor, to the seam the owning
// InProcessAgentExecutor reads at run creation (getPinnedSnapshotIdForTask) — so
// the created agent_runs row carries the fail-closed marker (versionId +
// packageVersion). A default resolution threads no snapshot id. Both are pruned
// after the run.

// Captured from the (mocked) sub-executor: the values it reads DURING execute
// (mirroring the real createAgentRun call site) + the live snapshot-id lookup.
let capturedDuringRun: { version?: string; snapshotId?: string } = {};
let capturedSnapshotLookup: ((taskId: string) => string | undefined) | undefined;

vi.mock("../agent-executor", () => {
  class MockInProcessAgentExecutor {
    private readonly opts: {
      getPinnedVersionForTask?: (t: string) => string | undefined;
      getPinnedSnapshotIdForTask?: (t: string) => string | undefined;
    };
    constructor(opts: unknown) {
      this.opts = opts as MockInProcessAgentExecutor["opts"];
      capturedSnapshotLookup = this.opts.getPinnedSnapshotIdForTask;
    }
    execute = vi.fn(async (ctx: RequestContext) => {
      const taskId = ctx.taskId ?? ctx.contextId ?? "unknown";
      capturedDuringRun = {
        version: this.opts.getPinnedVersionForTask?.(taskId),
        snapshotId: this.opts.getPinnedSnapshotIdForTask?.(taskId),
      };
    });
    cancelTask = vi.fn(async () => {});
  }
  return { InProcessAgentExecutor: MockInProcessAgentExecutor };
});

vi.mock("../version-pinning", () => ({
  resolveVersionBeforeRun: vi.fn(),
}));

import { resolveVersionBeforeRun } from "../version-pinning";
import { MultiAgentExecutor } from "../multi-agent-executor";

const resolveMock = resolveVersionBeforeRun as unknown as ReturnType<typeof vi.fn>;

const templates = [{ id: "t-a", packageName: "pkg-a", name: "A", packageVersion: "1.0.0" }];

function buildCtx(taskId: string): RequestContext {
  const msg: Message = {
    kind: "message",
    messageId: "m-1",
    role: "user",
    parts: [],
    metadata: { skillId: "pkg-a" },
  } as Message;
  return { userMessage: msg, taskId, contextId: taskId } as RequestContext;
}

function buildBus(): ExecutionEventBus {
  return {
    publish: vi.fn(),
    finished: vi.fn(),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
  } as unknown as ExecutionEventBus;
}

describe("MultiAgentExecutor — S7 snapshot-id threading", () => {
  beforeEach(() => {
    capturedDuringRun = {};
    capturedSnapshotLookup = undefined;
    resolveMock.mockReset();
  });

  it("threads the REQUIRED-pin snapshot id to the sub-executor during the run", async () => {
    resolveMock.mockResolvedValueOnce({
      templateId: "t-a",
      resolvedVersion: "1.2.3",
      snapshotId: "snap-xyz",
    });
    const exec = new MultiAgentExecutor({ templates: templates as never, enqueueJob: vi.fn() });
    await exec.execute(buildCtx("task-1"), buildBus());

    // The sub-executor read BOTH the semver and the snapshot id at run creation.
    expect(capturedDuringRun).toEqual({ version: "1.2.3", snapshotId: "snap-xyz" });
    // Pruned after the run — a later lookup no longer resolves it.
    expect(capturedSnapshotLookup?.("task-1")).toBeUndefined();
  });

  it("threads NO snapshot id for a default resolution (marker stays best-effort)", async () => {
    resolveMock.mockResolvedValueOnce({
      templateId: "t-a",
      resolvedVersion: "1.0.0",
      // no snapshotId — default resolution
    });
    const exec = new MultiAgentExecutor({ templates: templates as never, enqueueJob: vi.fn() });
    await exec.execute(buildCtx("task-2"), buildBus());

    expect(capturedDuringRun.version).toBe("1.0.0");
    expect(capturedDuringRun.snapshotId).toBeUndefined();
  });
});
