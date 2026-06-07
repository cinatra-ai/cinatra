import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the worker handler so we can drive it without Redis.
let workerHandler: ((job: { data?: unknown }) => Promise<void>) | undefined;
const queueAdd = vi.fn();
const upsertJobScheduler = vi.fn();

vi.mock("bullmq", () => ({
  Queue: class {
    add = queueAdd;
    upsertJobScheduler = upsertJobScheduler;
    constructor(public name: string) {}
  },
  Worker: class {
    constructor(public name: string, handler: (job: { data?: unknown }) => Promise<void>) {
      workerHandler = handler;
    }
    on() {}
  },
}));
vi.mock("ioredis", () => ({ default: class {} }));
const reconcileWorkflow = vi.fn();
const reconcileDueWorkflows = vi.fn();
vi.mock("../engine/reconciler", () => ({ reconcileWorkflow: (...a: unknown[]) => reconcileWorkflow(...a) }));
vi.mock("../engine/lifecycle", () => ({ reconcileDueWorkflows: (...a: unknown[]) => reconcileDueWorkflows(...a) }));

import {
  ensureWorkflowEngine,
  enqueueWorkflowReconcile,
  __resetEngineRuntimeForTests,
} from "../engine/runtime";
import { ENGINE_OPS } from "../engine/ops";

describe("release-workflow engine runtime (mocked BullMQ)", () => {
  beforeEach(() => {
    __resetEngineRuntimeForTests();
    workerHandler = undefined;
    queueAdd.mockClear();
    upsertJobScheduler.mockClear();
    reconcileWorkflow.mockClear();
    reconcileDueWorkflows.mockClear();
  });

  it("boots a dedicated queue + repeatable tick scheduler", async () => {
    const rt = await ensureWorkflowEngine();
    expect(rt).not.toBeNull();
    expect((rt!.queue as unknown as { name: string }).name).toBe(ENGINE_OPS.queueName);
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      "workflows-reconciler-tick",
      { every: ENGINE_OPS.tickEveryMs },
      expect.objectContaining({ name: "tick" }),
    );
  });

  it("is idempotent (second boot is a no-op)", async () => {
    await ensureWorkflowEngine();
    const second = await ensureWorkflowEngine();
    expect(second).toBeNull();
  });

  it("worker handler reconciles one workflow on an on-demand job, all due on a tick", async () => {
    await ensureWorkflowEngine();
    await workerHandler!({ data: { workflowId: "wf-1" } });
    expect(reconcileWorkflow).toHaveBeenCalledWith("wf-1", expect.anything());
    await workerHandler!({ data: {} });
    expect(reconcileDueWorkflows).toHaveBeenCalled();
  });

  it("enqueueWorkflowReconcile adds an on-demand job after boot", async () => {
    expect(await enqueueWorkflowReconcile("wf-2")).toBe(false); // not booted yet
    await ensureWorkflowEngine();
    expect(await enqueueWorkflowReconcile("wf-2")).toBe(true);
    expect(queueAdd).toHaveBeenCalledWith(
      "reconcile",
      { workflowId: "wf-2" },
      expect.objectContaining({ jobId: "reconcile-wf-2" }),
    );
  });
});
