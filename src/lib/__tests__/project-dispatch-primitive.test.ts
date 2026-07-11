import { describe, it, expect, vi, beforeEach } from "vitest";

// Pure unit tests for the dynamic dispatch primitive (cinatra#1032
// deliverable 2). The agents store, the dispatch ledger, and the enqueue
// chokepoint are mocked; the DETERMINISTIC POLICY layer — the template-task
// worker binding, the allowlist, and the shared ready-item validator from
// @cinatra-ai/sdk-extensions — runs REAL, so the tests prove the acceptance
// property directly: a pick or worker failing the deterministic validators
// NEVER reaches createAgentRun. The lease-fenced ledger + CAS settle behavior
// against real Postgres is covered by the DB-gated integration test in
// packages/agents (project-dispatch-ledger-lease.integration.test.ts).

const mocks = vi.hoisted(() => ({
  createAgentRun: vi.fn(),
  readAgentRunById: vi.fn(),
  readAgentTemplateByPackageName: vi.fn(),
  readAgentVersionsByTemplate: vi.fn(async () => [{ id: "v1" }]),
  enqueueAgentRun: vi.fn(),
  readEffectiveStatusByPackageNames: vi.fn(
    async () => new Map<string, "active" | "archived">(),
  ),
  beginDispatchAttempt: vi.fn(),
  settleDispatchAttempt: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  createAgentRun: mocks.createAgentRun,
  readAgentRunById: mocks.readAgentRunById,
  readAgentTemplateByPackageName: mocks.readAgentTemplateByPackageName,
  readAgentVersionsByTemplate: mocks.readAgentVersionsByTemplate,
}));
// The PURE runtime-lifecycle decision is used UNMOCKED (no IO); only the
// canonical-store READ (the IO boundary) is mocked — the workflow-agent-executor
// test's exact split.
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readEffectiveStatusByPackageNames: mocks.readEffectiveStatusByPackageNames,
}));
vi.mock("@cinatra-ai/agents/project-dispatch-ledger-store", () => ({
  beginDispatchAttempt: mocks.beginDispatchAttempt,
  settleDispatchAttempt: mocks.settleDispatchAttempt,
}));
vi.mock("@/lib/agent-run-enqueue", () => ({
  enqueueAgentRun: mocks.enqueueAgentRun,
  enqueueDepsForTemplate: (t: { packageName?: string | null; packageVersion?: string | null } | null | undefined) => ({
    agentPackage: t?.packageName ? { name: t.packageName, version: t.packageVersion ?? null } : undefined,
  }),
}));

import { OboCeilingCompositionError } from "@cinatra-ai/mcp-server/obo-ceiling";
import {
  PROJECT_TEMPLATE_FORMAT_VERSION,
  type ProjectTemplate,
  type ReadyItemView,
} from "@cinatra-ai/sdk-extensions/project-template-contract";
import { dispatchProjectWorker } from "@/lib/project-dispatch";

const WORKER_PKG = "@cinatra-ai/draft-writer-agent";

const template: ProjectTemplate = {
  formatVersion: PROJECT_TEMPLATE_FORMAT_VERSION,
  id: "launch-plan",
  name: "Launch plan",
  anchor: { id: "launch" },
  tasks: [
    {
      id: "draft",
      title: "Write the draft",
      worker: {
        role: "draft-writer",
        packageName: WORKER_PKG,
        versionConstraint: { kind: "exact", version: "1.0.0" },
      },
    },
    {
      id: "review",
      title: "Human review",
      dependsOn: ["draft"],
      worker: null,
      approval: { id: "sign-off" },
    },
  ],
};

const items: ReadyItemView[] = [
  { naturalKey: "proj-1/draft", status: "todo", assigneeIds: [], dependsOn: [] },
  { naturalKey: "proj-1/review", status: "backlog", assigneeIds: [], dependsOn: ["proj-1/draft"] },
];

const attempt = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "pda_1",
  orgId: "org-A",
  projectRef: "proj-1",
  itemNaturalKey: "proj-1/draft",
  actionVersion: 0,
  workerRole: "draft-writer",
  workerPackage: WORKER_PKG,
  workerVersionConstraint: "exact:1.0.0",
  idempotencyKey: "project:org-A:proj-1/draft:0",
  runId: null,
  status: "pending",
  error: null,
  version: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const baseInput = () => ({
  orgId: "org-A",
  projectRef: "proj-1",
  projectId: null,
  items,
  pick: "proj-1/draft",
  asOf: "2026-07-10",
  actionVersion: 0,
  role: "draft-writer",
  template,
  runInput: { topic: "x" },
  runBy: "u1",
  lease: { holderId: "tick-run-9", version: 3 },
  parentRun: { id: "run_parent", oboCeiling: null },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readAgentVersionsByTemplate.mockResolvedValue([{ id: "v1" }]);
  mocks.readEffectiveStatusByPackageNames.mockResolvedValue(new Map());
  mocks.readAgentTemplateByPackageName.mockResolvedValue({
    id: "tmpl-1",
    orgId: null,
    packageName: WORKER_PKG,
    packageVersion: "1.0.0",
  });
  mocks.beginDispatchAttempt.mockResolvedValue({ kind: "inserted", attempt: attempt() });
  mocks.settleDispatchAttempt.mockImplementation(async (input: { status: string; runId?: string | null }) => ({
    kind: "settled",
    attempt: attempt({ status: input.status, runId: input.runId ?? null, version: 1 }),
  }));
  mocks.createAgentRun.mockImplementation(async (input: { id: string }) => ({
    id: input.id,
    status: "queued",
  }));
});

describe("deterministic policy rejections (never reach createAgentRun)", () => {
  it("rejects a role that is not the template task's worker binding", async () => {
    const out = await dispatchProjectWorker({ ...baseInput(), role: "rogue-role" });
    expect(out).toMatchObject({ status: "rejected", code: "WORKER_NOT_ALLOWLISTED" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
    expect(mocks.beginDispatchAttempt).not.toHaveBeenCalled();
  });

  it("rejects dispatching a human/manual task (no worker binding)", async () => {
    const readyItems: ReadyItemView[] = [
      { naturalKey: "proj-1/draft", status: "done" },
      { naturalKey: "proj-1/review", status: "todo", assigneeIds: [], dependsOn: ["proj-1/draft"] },
    ];
    const out = await dispatchProjectWorker({
      ...baseInput(),
      items: readyItems,
      pick: "proj-1/review",
      role: "draft-writer",
    });
    expect(out).toMatchObject({ status: "rejected", code: "WORKER_NOT_ALLOWLISTED" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
  });

  it("rejects a pick outside the project scope / unknown to the template / absent from the items", async () => {
    for (const pick of ["other-proj/draft", "proj-1/nonexistent-task"]) {
      const out = await dispatchProjectWorker({ ...baseInput(), pick, role: "draft-writer" });
      expect(out).toMatchObject({ status: "rejected", code: "PICK_UNKNOWN" });
    }
    const out = await dispatchProjectWorker({ ...baseInput(), items: [items[1]] });
    expect(out).toMatchObject({ status: "rejected", code: "PICK_UNKNOWN" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
    expect(mocks.beginDispatchAttempt).not.toHaveBeenCalled();
  });

  it("rejects a not-ready pick with the validator's reason (deps_unmet / claimed)", async () => {
    const claimed = await dispatchProjectWorker({
      ...baseInput(),
      items: [{ ...items[0], assigneeIds: ["someone"] }, items[1]],
    });
    expect(claimed).toMatchObject({
      status: "rejected",
      code: "ITEM_NOT_READY",
      notReadyReason: "claimed",
    });

    const withDep: ReadyItemView[] = [
      { naturalKey: "proj-1/draft", status: "todo", assigneeIds: [], dependsOn: ["proj-1/other"] },
      { naturalKey: "proj-1/other", status: "in_progress" },
    ];
    const deps = await dispatchProjectWorker({ ...baseInput(), items: withDep });
    expect(deps).toMatchObject({
      status: "rejected",
      code: "ITEM_NOT_READY",
      notReadyReason: "deps_unmet",
    });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
    expect(mocks.beginDispatchAttempt).not.toHaveBeenCalled();
  });

  it("rejects invalid actionVersion / asOf shapes", async () => {
    expect(await dispatchProjectWorker({ ...baseInput(), actionVersion: -1 })).toMatchObject({
      status: "rejected",
      code: "INVALID_INPUT",
    });
    expect(await dispatchProjectWorker({ ...baseInput(), actionVersion: 1.5 })).toMatchObject({
      status: "rejected",
      code: "INVALID_INPUT",
    });
    // Above the PostgreSQL `integer` bound: rejected up front, not in SQL.
    expect(
      await dispatchProjectWorker({ ...baseInput(), actionVersion: 2_147_483_648 }),
    ).toMatchObject({ status: "rejected", code: "INVALID_INPUT" });
    expect(await dispatchProjectWorker({ ...baseInput(), asOf: "not-a-date" })).toMatchObject({
      status: "rejected",
      code: "INVALID_INPUT",
    });
    expect(mocks.beginDispatchAttempt).not.toHaveBeenCalled();
  });
});

describe("lease fencing", () => {
  it("rejects when the lease-fenced ledger claim reports the lease is not held", async () => {
    mocks.beginDispatchAttempt.mockResolvedValue({ kind: "lease_not_held" });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "LEASE_NOT_HELD" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
  });

  it("passes the caller's lease (holder + fencing version) to the ledger claim", async () => {
    await dispatchProjectWorker(baseInput());
    expect(mocks.beginDispatchAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ lease: { holderId: "tick-run-9", version: 3 } }),
    );
  });
});

describe("happy path", () => {
  it("dispatches through the verbatim gate chain with the ledgered idempotency key", async () => {
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({
      status: "dispatched",
      attemptId: "pda_1",
      idempotencyKey: "project:org-A:proj-1/draft:0",
    });
    expect(mocks.createAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: "tmpl-1",
        versionId: "v1",
        orgId: "org-A",
        idempotencyKey: "project:org-A:proj-1/draft:0",
        parentRunId: "run_parent",
        parentOboCeiling: null,
      }),
    );
    expect(mocks.enqueueAgentRun).toHaveBeenCalledWith(
      { runId: expect.stringMatching(/^run_/) },
      expect.objectContaining({ softPreflight: true }),
    );
    expect(mocks.settleDispatchAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pda_1", expectedVersion: 0, status: "dispatched" }),
    );
  });

  it("threads the parent run's OBO ceiling chain as the compose operand", async () => {
    const chain = [{ anchor: "org-A" }] as never;
    await dispatchProjectWorker({ ...baseInput(), parentRun: { id: "run_p", oboCeiling: chain } });
    expect(mocks.createAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ parentRunId: "run_p", parentOboCeiling: chain }),
    );
  });
});

describe("host gate chain failures (attempt settled 'failed')", () => {
  it("AGENT_UNRESOLVED when the worker package resolves to no template", async () => {
    mocks.readAgentTemplateByPackageName.mockResolvedValue(null);
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "AGENT_UNRESOLVED" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
    expect(mocks.settleDispatchAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("AGENT_CROSS_ORG fail-closed on a foreign-org template", async () => {
    mocks.readAgentTemplateByPackageName.mockResolvedValue({
      id: "tmpl-1",
      orgId: "org-B",
      packageName: WORKER_PKG,
    });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "AGENT_CROSS_ORG" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
  });

  it("AGENT_NOT_INSTALLED fail-closed when the canonical store reports the agent archived", async () => {
    mocks.readEffectiveStatusByPackageNames.mockResolvedValue(
      new Map([[WORKER_PKG, "archived" as const]]),
    );
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "AGENT_NOT_INSTALLED" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
  });

  it("stays runnable (fail-open) on a canonical-store outage", async () => {
    mocks.readEffectiveStatusByPackageNames.mockRejectedValue(new Error("status store down"));
    const out = await dispatchProjectWorker(baseInput());
    expect(out.status).toBe("dispatched");
  });

  it("OBO_CEILING_DISJOINT fails closed when the child ceiling composition throws", async () => {
    mocks.createAgentRun.mockRejectedValue(
      new OboCeilingCompositionError({
        reason: "cross_org",
        tier: "organization",
        ids: ["org-A", "org-B"],
      }),
    );
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "OBO_CEILING_DISJOINT" });
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("never throws — an unexpected error resolves to PROJECT_DISPATCH_FAILED", async () => {
    mocks.createAgentRun.mockRejectedValue(new Error("connection reset"));
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "PROJECT_DISPATCH_FAILED" });
  });
});

describe("crash-window recovery (Acceptance 2: no duplicate, no lost item)", () => {
  it("recovers a crashed tick: existing 'pending' attempt re-dispatches with the SAME key and converges on the SAME run", async () => {
    // Tick 1 crashed after createAgentRun, before settle. Tick 2's begin
    // returns the existing pending row; the idempotent createAgentRun hit
    // returns the ALREADY-CREATED run (different id from this pass's fresh
    // run id, still queued) → enqueue repaired, ledger settled to that run.
    mocks.beginDispatchAttempt.mockResolvedValue({ kind: "existing", attempt: attempt() });
    mocks.createAgentRun.mockResolvedValue({ id: "run_original", status: "queued" });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "dispatched", runId: "run_original" });
    expect(mocks.createAgentRun).toHaveBeenCalledTimes(1);
    expect(mocks.createAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "project:org-A:proj-1/draft:0" }),
    );
    expect(mocks.enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(mocks.settleDispatchAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ status: "dispatched", runId: "run_original" }),
    );
  });

  it("short-circuits an already-dispatched attempt, repairing the enqueue of a still-queued run", async () => {
    mocks.beginDispatchAttempt.mockResolvedValue({
      kind: "existing",
      attempt: attempt({ status: "dispatched", runId: "run_done", version: 1 }),
    });
    mocks.readAgentRunById.mockResolvedValue({ id: "run_done", status: "queued" });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toEqual({ status: "already_dispatched", runId: "run_done", attemptId: "pda_1" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
    expect(mocks.enqueueAgentRun).toHaveBeenCalledWith(
      { runId: "run_done" },
      expect.objectContaining({ softPreflight: true }),
    );
  });

  it("does NOT re-enqueue an already-running dispatched run", async () => {
    mocks.beginDispatchAttempt.mockResolvedValue({
      kind: "existing",
      attempt: attempt({ status: "dispatched", runId: "run_done", version: 1 }),
    });
    mocks.readAgentRunById.mockResolvedValue({ id: "run_done", status: "running" });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "already_dispatched", runId: "run_done" });
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("DISPATCH_RUN_MISSING when a dispatched attempt's run no longer exists — never re-dispatches", async () => {
    mocks.beginDispatchAttempt.mockResolvedValue({
      kind: "existing",
      attempt: attempt({ status: "dispatched", runId: "run_gone", version: 1 }),
    });
    mocks.readAgentRunById.mockResolvedValue(null);
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "DISPATCH_RUN_MISSING" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
  });

  it("DISPATCH_ATTEMPT_CONFLICT on immutable-binding drift — a template change needs a new actionVersion", async () => {
    mocks.beginDispatchAttempt.mockResolvedValue({
      kind: "existing",
      attempt: attempt({ workerPackage: "@cinatra-ai/other-agent" }),
    });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "DISPATCH_ATTEMPT_CONFLICT" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
  });

  it("DISPATCH_ATTEMPT_CONFLICT when only the VERSION CONSTRAINT drifted (same role + package)", async () => {
    mocks.beginDispatchAttempt.mockResolvedValue({
      kind: "existing",
      attempt: attempt({ workerVersionConstraint: "exact:2.0.0" }),
    });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "DISPATCH_ATTEMPT_CONFLICT" });
    expect(mocks.createAgentRun).not.toHaveBeenCalled();
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("gates the enqueue-REPAIR of an already-dispatched run: an archived agent is refused (no revival)", async () => {
    mocks.beginDispatchAttempt.mockResolvedValue({
      kind: "existing",
      attempt: attempt({ status: "dispatched", runId: "run_done", version: 1 }),
    });
    mocks.readAgentRunById.mockResolvedValue({ id: "run_done", status: "queued" });
    mocks.readEffectiveStatusByPackageNames.mockResolvedValue(
      new Map([[WORKER_PKG, "archived" as const]]),
    );
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "AGENT_NOT_INSTALLED" });
    expect(mocks.enqueueAgentRun).not.toHaveBeenCalled();
    // The attempt is already settled 'dispatched' — the gate failure must NOT re-settle it.
    expect(mocks.settleDispatchAttempt).not.toHaveBeenCalled();
  });

  it("surfaces (never overwrites) a concurrent different settle as DISPATCH_ATTEMPT_CONFLICT", async () => {
    mocks.settleDispatchAttempt.mockResolvedValue({
      kind: "conflict",
      attempt: attempt({ status: "failed", version: 2 }),
    });
    const out = await dispatchProjectWorker(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "DISPATCH_ATTEMPT_CONFLICT" });
  });
});
