import { describe, it, expect, vi, beforeEach } from "vitest";

// Pure unit tests for the host agent_task executor and child-run poller:
// the agents store + enqueue chokepoint are mocked so we exercise the tenancy
// guard, idempotent re-enqueue skip, never-throws contract, and the status
// mapping without a DB.

const mocks = vi.hoisted(() => ({
  createAgentRun: vi.fn(),
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAgentTemplateByPackageName: vi.fn(),
  readAgentVersionsByTemplate: vi.fn(),
  enqueueAgentRun: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  createAgentRun: mocks.createAgentRun,
  readAgentRunById: mocks.readAgentRunById,
  readAgentTemplateById: mocks.readAgentTemplateById,
  readAgentTemplateByPackageName: mocks.readAgentTemplateByPackageName,
  readAgentVersionsByTemplate: mocks.readAgentVersionsByTemplate,
  TERMINAL_RUN_STATUSES: new Set(["completed", "failed", "stopped"]),
}));
vi.mock("@/lib/agent-run-enqueue", () => ({ enqueueAgentRun: mocks.enqueueAgentRun }));

import {
  buildWorkflowAgentTaskExecutor,
  getWorkflowChildRunStatus,
} from "@/lib/workflow-agent-executor";

const prov = {
  orgId: "org-A",
  projectId: null,
  runBy: "u1",
  source: "workflow-reconciler",
  workflowId: "wf1",
  workflowTaskId: "t1",
};

const input = (agentRef: Record<string, unknown>) => ({
  task: { id: "t1", key: "k", type: "agent_task", title: "T", input: { foo: 1 }, agentRef, assigneeLevel: null, assigneeId: null },
  provenance: prov as unknown as Record<string, unknown>,
  idempotencyKey: "wf1:t1:1",
  attemptNo: 1,
});

describe("buildWorkflowAgentTaskExecutor - tenancy + dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAgentVersionsByTemplate.mockResolvedValue([{ id: "v1" }]);
  });

  it("rejects a foreign-org template, fail-closed", async () => {
    mocks.readAgentTemplateByPackageName.mockResolvedValue({ id: "tmpl-B", orgId: "org-B", connectorDependencies: {} });
    const out = await buildWorkflowAgentTaskExecutor()(input({ package: "@x/foreign" }));
    expect(out.status).toBe("failed");
    expect(out.error?.code).toBe("AGENT_CROSS_ORG");
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("allows a public/null-origin template", async () => {
    mocks.readAgentTemplateByPackageName.mockResolvedValue({ id: "tmpl-pub", orgId: null, connectorDependencies: {} });
    mocks.createAgentRun.mockImplementation(async (i: { id: string }) => ({ id: i.id }));
    const out = await buildWorkflowAgentTaskExecutor()(input({ package: "@x/public" }));
    expect(out.status).toBe("running");
    expect(mocks.createAgentRun).toHaveBeenCalledOnce();
  });

  it("allows an own-org template; stamps provenance + idempotency key; enqueues a fresh run", async () => {
    mocks.readAgentTemplateById.mockResolvedValue({ id: "tmpl-A", orgId: "org-A", connectorDependencies: { "@c/x": "^1" } });
    mocks.createAgentRun.mockImplementation(async (i: { id: string }) => ({ id: i.id })); // newly inserted (echoes id)
    const out = await buildWorkflowAgentTaskExecutor()(input({ templateId: "tmpl-A" }));
    expect(out.status).toBe("running");
    const arg = mocks.createAgentRun.mock.calls[0][0];
    expect(arg.orgId).toBe("org-A");
    expect(arg.runBy).toBe("u1");
    expect(arg.idempotencyKey).toBe("wf1:t1:1");
    expect(arg.workflowId).toBe("wf1");
    expect(arg.workflowTaskId).toBe("t1");
    expect(arg.inputParams).toEqual({ foo: 1 });
    expect(mocks.enqueueAgentRun).toHaveBeenCalledOnce();
  });

  it("skips re-enqueue on an idempotent hit whose run already left the queue", async () => {
    mocks.readAgentTemplateById.mockResolvedValue({ id: "tmpl-A", orgId: "org-A", connectorDependencies: {} });
    // hit returns a different id from the generated one, already picked up by a worker
    mocks.createAgentRun.mockResolvedValue({ id: "existing-run", status: "running" });
    const out = await buildWorkflowAgentTaskExecutor()(input({ templateId: "tmpl-A" }));
    expect(out.status).toBe("running");
    expect(out.childRunId).toBe("existing-run");
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("repairs the enqueue gap: an idempotent hit still `queued` is re-enqueued", async () => {
    // Crash-mid-dispatch repair: the prior dispatch crashed AFTER createAgentRun
    // committed but BEFORE enqueueAgentRun, so the lease-based re-dispatch finds
    // the existing run still `queued` and must enqueue it (idempotent — the
    // worker's queued→running CAS guards a double-enqueue) or it polls forever.
    mocks.readAgentTemplateById.mockResolvedValue({ id: "tmpl-A", orgId: "org-A", connectorDependencies: {} });
    mocks.createAgentRun.mockResolvedValue({ id: "existing-run", status: "queued" });
    const out = await buildWorkflowAgentTaskExecutor()(input({ templateId: "tmpl-A" }));
    expect(out.status).toBe("running");
    expect(out.childRunId).toBe("existing-run");
    expect(mocks.enqueueAgentRun).toHaveBeenCalledOnce();
    expect(mocks.enqueueAgentRun.mock.calls[0][0]).toEqual({ runId: "existing-run" });
  });

  it("returns AGENT_UNRESOLVED when no template resolves", async () => {
    mocks.readAgentTemplateByPackageName.mockResolvedValue(null);
    const out = await buildWorkflowAgentTaskExecutor()(input({ package: "@x/missing" }));
    expect(out.status).toBe("failed");
    expect(out.error?.code).toBe("AGENT_UNRESOLVED");
  });

  it("never throws; wraps a dependency error as a failed outcome", async () => {
    mocks.readAgentTemplateById.mockRejectedValue(new Error("db down"));
    const out = await buildWorkflowAgentTaskExecutor()(input({ templateId: "tmpl-A" }));
    expect(out.status).toBe("failed");
    expect(out.error?.code).toBe("AGENT_DISPATCH_FAILED");
  });
});

describe("getWorkflowChildRunStatus - status mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when the run is not found (transient)", async () => {
    mocks.readAgentRunById.mockResolvedValue(null);
    expect(await getWorkflowChildRunStatus("r")).toBeNull();
  });

  it.each([
    ["completed", { terminal: true, failed: false, hitl: false }],
    ["failed", { terminal: true, failed: true, hitl: false }],
    ["stopped", { terminal: true, failed: true, hitl: false }],
    ["pending_approval", { terminal: false, failed: false, hitl: true }],
    ["running", { terminal: false, failed: false, hitl: false }],
    ["queued", { terminal: false, failed: false, hitl: false }],
  ])("maps %s correctly", async (status, expected) => {
    mocks.readAgentRunById.mockResolvedValue({ status, error: null });
    const r = await getWorkflowChildRunStatus("r");
    expect(r).toMatchObject({ status, ...expected });
  });

  it("surfaces the run error message on failure", async () => {
    mocks.readAgentRunById.mockResolvedValue({ status: "failed", error: "boom" });
    const r = await getWorkflowChildRunStatus("r");
    expect(r?.error).toEqual({ message: "boom" });
  });
});
