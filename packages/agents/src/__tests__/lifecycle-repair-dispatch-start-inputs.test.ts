import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// Only external persistence, queue and identity-reading ports are replaced.
// The real dispatcher, coordinator, system authority mint, ActorContext
// builder and current CMS task projection execute. No run or queue job exists.
const ports = vi.hoisted(() => ({
  reads: [] as unknown[][],
  readConditions: [] as unknown[],
  updateResults: [] as unknown[][],
  writes: [] as { values: Record<string, unknown>; condition?: unknown }[],
  created: [] as { input: Record<string, unknown>; authority: unknown }[],
  target: null as Record<string, unknown> | null,
  role: "member" as "member" | undefined,
  createFailure: null as Error | null,
  queued: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../db", () => ({
  db: {
    select: () => {
      const result = ports.reads.shift();
      if (!result) throw new Error("Unexpected database read");
      const query = {
        from: () => query,
        where: (condition: unknown) => { ports.readConditions.push(condition); return query; },
        orderBy: () => query,
        limit: async () => {
          const row = result[0] as { orgId?: string } | undefined;
          const condition = ports.readConditions.at(-1) as Parameters<PgDialect["sqlToQuery"]>[0];
          const params = new PgDialect().sqlToQuery(condition).params;
          return row?.orgId && params.includes("repair-org") && row.orgId !== "repair-org" ? [] : result;
        },
      };
      return query;
    },
    update: () => {
      const query = {
        set: (values: Record<string, unknown>) => {
          ports.writes.push({ values });
          return query;
        },
        where: (condition: unknown) => {
          ports.writes.at(-1)!.condition = condition;
          return query;
        },
        returning: async () => {
          const result = ports.updateResults.shift();
          if (!result) throw new Error("Unexpected database write");
          return result;
        },
      };
      return query;
    },
  },
}));
vi.mock("../store", () => ({
  createAgentRun: async (input: Record<string, unknown>, authority: unknown) => {
    if (ports.createFailure) {
      const failure = ports.createFailure;
      ports.createFailure = null;
      throw failure;
    }
    ports.created.push({ input, authority });
    return { id: input.id, orgId: input.orgId, runBy: input.runBy, status: input.initialStatus };
  },
  createAgentRunPendingInput: () => { throw new Error("Unexpected pending-input creation"); },
  readAgentRunById: () => { throw new Error("Unexpected run read-back"); },
  recordRunLifecycleMoment: () => { throw new Error("Unexpected moment write"); },
  transitionRunStatus: () => { throw new Error("Unexpected transition"); },
  RunTransitionError: class extends Error {},
}));
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: vi.fn(async () => ports.role),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readOrgsWithTeamsForUser: async () => [{ id: "repair-org", teams: [] }],
  readProjectGrantsForUser: async () => [],
  readUserIsPlatformAdmin: async () => false,
}));
vi.mock("@/lib/agent-run-enqueue", () => ({
  enqueueAgentRun: ports.queued,
}));
vi.mock("../cms-snapshot-readback-store", () => ({
  readCmsSnapshotTargetByArtifact: async () => ports.target,
  readCmsSnapshotTargetByArtifactAndRevision: () => { throw new Error("Unexpected completion read"); },
}));
vi.mock("../cms-repaired-capture-port", () => ({
  attemptRepairedCapture: () => { throw new Error("No picture operation is allowed in this test"); },
  leavesUncapturedSide: () => { throw new Error("No completion operation is allowed in this test"); },
}));

import { dispatchPendingProducerRepairs, repairRunId } from "../lifecycle-repair-dispatch-store";
import { resolveOrgRoleForUser } from "@/lib/auth-session";

const currentFinding = { id: "finding-current", path: "title", message: "Use the current reviewed title", severity: "minor" };
function pendingRepair(overrides: Record<string, unknown> = {}) {
  return {
    id: "repair-current", orgId: "repair-org", gateId: "gate-current", lineageId: "lineage-current",
    attempt: 2, baseArtifactId: "artifact-base", baseRepresentationRevisionId: "revision-base",
    expectedBaseRevisionId: "revision-base", producerRunId: "producer-original",
    route: "producer_repair", status: "requested", continuationMode: "async_effects_gated",
    continuationAddress: null, findings: [currentFinding], ...overrides,
  };
}
function arrangeProducer(input: unknown, overrides: Record<string, unknown> = {}) {
  const row = pendingRepair();
  ports.reads = [[row], [{ templateId: "template-producing", orgId: "repair-org", runBy: "human-origin", oboCeiling: null,
    inputParams: typeof input === "string" ? input : JSON.stringify(input), ...overrides }],
    [{ id: "template-producing", packageName: "@any-vendor/repair-producer" }], []];
  ports.updateResults = [[{ id: row.id }]];
  return row;
}
function cmsTarget(resourceType = "page") {
  return { artifactId: "artifact-base", snapshotRevisionId: "revision-base", connectorInstance: "cms-site",
    resourceType, resourceId: "content-42", scopeManifest: { paths: ["title"] } };
}
function inputParams() {
  return ports.created[0].input.inputParams as Record<string, unknown>;
}
beforeEach(() => {
  ports.reads = []; ports.readConditions = []; ports.updateResults = []; ports.writes = []; ports.created = [];
  ports.target = null; ports.role = "member"; ports.createFailure = null;
  vi.clearAllMocks();
});

describe("generic producing-run input inheritance", () => {
  it("retains custom and nested root inputs for an arbitrary producer, with the current typed request", async () => {
    const original = { requiredAccount: "account-42", customOptions: { nested: ["value"] }, instructions: "Producer instructions", task: "Own task", lifecycleRepairRequest: { repairId: "old", findings: [{ message: "stale" }] } };
    arrangeProducer(original);
    expect(await dispatchPendingProducerRepairs()).toMatchObject({ dispatched: 1, failed: 0, escalated: 0 });
    expect(inputParams()).toMatchObject({ requiredAccount: original.requiredAccount, customOptions: original.customOptions,
      instructions: original.instructions, task: original.task,
      lifecycleRepairRequest: { repairId: "repair-current", attempt: 2, findings: [currentFinding] } });
    const condition = ports.readConditions[1] as Parameters<PgDialect["sqlToQuery"]>[0];
    const query = new PgDialect().sqlToQuery(condition);
    expect(query.sql).toContain('"org_id"');
    expect(query.params).toEqual(["producer-original", "repair-org"]);
  });

  it("overlays the current CMS task without dropping inherited root inputs or borrowing the old task", async () => {
    arrangeProducer({ instanceId: "site-42", contentId: "content-42", instructions: "Original input", task: "Stale task", lifecycleRepairRequest: { repairId: "old" } });
    ports.target = cmsTarget();
    await dispatchPendingProducerRepairs();
    expect(inputParams()).toMatchObject({ instanceId: "site-42", contentId: "content-42",
      lifecycleRepairRequest: { repairId: "repair-current", findings: [currentFinding] } });
    expect(inputParams().instructions).toContain(currentFinding.message);
    expect(inputParams().instructions).not.toContain("Original input");
    expect(inputParams().task).toBe(inputParams().instructions);
    expect(inputParams().task).toContain(currentFinding.message);
    expect(inputParams().task).not.toContain("Stale task");
  });

  it("does not read inputs or launch a child from a producing run in another organization", async () => {
    arrangeProducer({ privateAccount: "foreign-secret" }, { orgId: "foreign-org" });
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ escalated: 1, dispatched: 0, failed: 0 });
    expect(ports.created).toHaveLength(0);
    expect(ports.queued).not.toHaveBeenCalled();
    expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
    expect(ports.writes[0].values.status).toBe("escalated");
  });
});

describe("input data cannot become repair authorization", () => {
  it("keeps the server's human, organization, authority, producer and OBO ceiling outside inherited input data", async () => {
    const parentCeiling = { marker: "original-parent-ceiling" };
    arrangeProducer({ instructions: "Old", orgId: "forged-org", runBy: "forged-user", authority: "forged-authority", parentRunId: "forged-parent" },
      { oboCeiling: JSON.stringify(parentCeiling) });
    ports.target = cmsTarget();
    await dispatchPendingProducerRepairs();
    const created = ports.created[0];
    expect(created.input).toMatchObject({ orgId: "repair-org", runBy: "human-origin", parentRunId: "producer-original",
      parentOboCeiling: parentCeiling, templateId: "template-producing", idempotencyKey: "lifecycle-repair:repair-current", launchProducer: "lifecycle_repair" });
    const authority = created.authority as { orgId: string; can: (capability: string) => boolean };
    expect(authority.orgId).toBe("repair-org");
    expect(authority.can("run.execute")).toBe(true);
    expect(authority.can("content.write")).toBe(false);
    expect(ports.queued).toHaveBeenCalledOnce();
    const [job, options] = ports.queued.mock.calls[0];
    expect(job.runId).toBe(repairRunId("repair-current"));
    expect(options.jobId).not.toContain(":");
    expect(options.actorContext).toMatchObject({ principalType: "HumanUser", principalId: "human-origin", organizationId: "repair-org" });
    expect(resolveOrgRoleForUser).toHaveBeenCalledWith("repair-org", "human-origin");
  });

  it("refuses a revoked originating human before any run or queue effect", async () => {
    arrangeProducer({ runBy: "forged-user" }); ports.role = undefined;
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ escalated: 1, dispatched: 0 });
    expect(ports.created).toHaveLength(0); expect(ports.queued).not.toHaveBeenCalled();
    expect(ports.writes[0].values.status).toBe("escalated");
  });

  it("refuses missing originating human even if inherited input data names one", async () => {
    arrangeProducer({ runBy: "forged-user" }, { runBy: null });
    const result = await dispatchPendingProducerRepairs();
    expect(result.escalated).toBe(1); expect(ports.created).toHaveLength(0); expect(ports.queued).not.toHaveBeenCalled();
  });

  it("keeps checkpointed delivery on its existing escalation road", async () => {
    ports.reads = [[pendingRepair({ continuationMode: "checkpointed" })]];
    ports.updateResults = [[{ id: "repair-current" }]];
    const result = await dispatchPendingProducerRepairs();
    expect(result.escalated).toBe(1); expect(ports.created).toHaveLength(0); expect(ports.queued).not.toHaveBeenCalled();
  });

  it("does not create a second run when the deterministic repair already exists", async () => {
    arrangeProducer({ custom: "retained" }); ports.reads[3] = [{ id: repairRunId("repair-current") }];
    const result = await dispatchPendingProducerRepairs();
    expect(result.dispatched).toBe(1); expect(ports.created).toHaveLength(0); expect(ports.queued).toHaveBeenCalledOnce();
  });

  it("retains the requested-to-dispatched CAS rather than overwriting a concurrent decision", async () => {
    arrangeProducer({ custom: "retained" }); ports.updateResults = [[]];
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ dispatched: 0, raced: 1 });
    const condition = ports.writes[0].condition as Parameters<PgDialect["sqlToQuery"]>[0];
    expect(new PgDialect().sqlToQuery(condition).params).toEqual(["repair-current", "requested"]);
  });

  it("isolates a failed creation so the next pending repair still dispatches", async () => {
    const first = pendingRepair({ id: "repair-first" });
    const second = pendingRepair({ id: "repair-second" });
    const producer = { templateId: "template-producing", orgId: "repair-org", runBy: "human-origin", oboCeiling: null, inputParams: JSON.stringify({ custom: "retained" }) };
    const template = { id: "template-producing", packageName: "@any-vendor/repair-producer" };
    ports.reads = [[first, second], [producer], [template], [], [producer], [template], []];
    ports.updateResults = [[{ id: "repair-second" }]];
    ports.createFailure = new Error("Isolated external persistence failure");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await dispatchPendingProducerRepairs()).toMatchObject({ failed: 1, dispatched: 1 });
      expect(ports.created).toHaveLength(1);
      expect(ports.created[0].input.id).toBe(repairRunId("repair-second"));
      expect(ports.queued).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledOnce();
    } finally { error.mockRestore(); }
  });

  for (const invalid of ["{malformed", "[]", "null", "42", "\"text\""]) {
    it(`does not inherit authorization or arbitrary fields from unreadable recorded params: ${invalid}`, async () => {
      arrangeProducer(invalid);
      await dispatchPendingProducerRepairs();
      expect(Object.keys(inputParams())).toEqual(["lifecycleRepairRequest"]);
      expect(ports.created[0].input.runBy).toBe("human-origin");
    });
  }
});
