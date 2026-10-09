import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PgDialect } from "drizzle-orm/pg-core";

// Only external persistence, queue and identity-reading ports are replaced.
// The real dispatcher, coordinator, system authority mint, ActorContext
// builder and CMS instruction projection execute. No run or queue job exists.
const ports = vi.hoisted(() => ({
  reads: [] as unknown[][],
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
        from: () => query, where: () => query, orderBy: () => query,
        limit: async () => result,
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
import { projectCmsRepairInputParams } from "../lifecycle-repair-cms-production-bridge";
import { resolveOrgRoleForUser } from "@/lib/auth-session";

// Source-contract fixtures from the adopted producers' actual root Flow
// descriptors. A missing default makes the ROOT input required, independently
// of StartNode setup metadata. These are small schema fixtures, not run proof.
const producerContracts = [
  {
    "label": "Drupal",
    "packageName": "@cinatra-ai/drupal-agent",
    "rootInputs": [
      {
        "title": "instanceId",
        "type": "string"
      },
      {
        "title": "nodeId",
        "type": "string"
      },
      {
        "title": "nodeBundle",
        "type": "string"
      },
      {
        "title": "nodeStatus",
        "type": "string"
      },
      {
        "title": "instructions",
        "type": "string"
      },
      {
        "title": "cinatra_run_id",
        "type": "string",
        "default": ""
      }
    ],
    "originalInputs": {
      "instanceId": "cms-site",
      "nodeId": "content-42",
      "nodeBundle": "article",
      "nodeStatus": "draft",
      "instructions": "Old producing instructions"
    },
    "resourceType": "node"
  },
  {
    "label": "WordPress",
    "packageName": "@cinatra-ai/wordpress-agent",
    "rootInputs": [
      {
        "title": "instanceId",
        "type": "string"
      },
      {
        "title": "postId",
        "type": "string"
      },
      {
        "title": "postType",
        "type": "string"
      },
      {
        "title": "postStatus",
        "type": "string"
      },
      {
        "title": "instructions",
        "type": "string"
      },
      {
        "title": "cinatra_run_id",
        "type": "string",
        "default": ""
      }
    ],
    "originalInputs": {
      "instanceId": "cms-site",
      "postId": "content-42",
      "postType": "page",
      "postStatus": "draft",
      "instructions": "Old producing instructions"
    },
    "resourceType": "page"
  }
] as const;

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
  ports.reads = [[row], [{ templateId: "template-producing", runBy: "human-origin", oboCeiling: null,
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
function schemaForRoot(contract: typeof producerContracts[number]) {
  const properties = Object.fromEntries(contract.rootInputs.map((input) => [input.title, { type: input.type }]));
  const required = contract.rootInputs.filter((input) => !("default" in input)).map((input) => input.title);
  return z.fromJSONSchema({ type: "object", properties, required, additionalProperties: true });
}

beforeEach(() => {
  ports.reads = []; ports.updateResults = []; ports.writes = []; ports.created = [];
  ports.target = null; ports.role = "member"; ports.createFailure = null;
  vi.clearAllMocks();
});

describe("repair start inputs satisfy the actual producing root contracts", () => {
  for (const contract of producerContracts) {
    it(`${contract.label}: retains every required start input and passes standard root-schema validation`, async () => {
      const original = { ...contract.originalInputs, customProducerOption: { untouched: ["value"] } };
      arrangeProducer(original); ports.target = cmsTarget(contract.resourceType);
      const result = await dispatchPendingProducerRepairs();
      expect(result).toMatchObject({ dispatched: 1, failed: 0, escalated: 0 });
      const parsed = schemaForRoot(contract).safeParse(inputParams());
      expect(parsed.success).toBe(true);
      expect(inputParams()).toMatchObject({ ...original, instructions: expect.any(String) });
      expect(inputParams().customProducerOption).toEqual(original.customProducerOption);
    });

    it(`${contract.label}: the consumed instructions use fresh findings instead of inherited old instructions`, async () => {
      arrangeProducer({ ...contract.originalInputs, lifecycleRepairRequest: { repairId: "previous-repair", findings: [{ message: "Stale previous finding" }] } });
      ports.target = cmsTarget(contract.resourceType);
      await dispatchPendingProducerRepairs();
      const delivered = inputParams();
      expect(delivered.instructions).toContain(currentFinding.message);
      expect(delivered.instructions).toContain("field: title");
      expect(delivered.instructions).not.toContain("Old producing instructions");
      expect(delivered.instructions).not.toContain("Stale previous finding");
      expect(delivered.task).toBe(delivered.instructions);
      expect(delivered.lifecycleRepairRequest).toMatchObject({ repairId: "repair-current", attempt: 2, findings: [currentFinding] });
    });

    it(`${contract.label}: fresh CMS instructions also satisfy the root when the producer recorded none`, async () => {
      const original = { ...contract.originalInputs } as Record<string, unknown>;
      delete original.instructions;
      arrangeProducer(original); ports.target = cmsTarget(contract.resourceType);
      await dispatchPendingProducerRepairs();
      expect(schemaForRoot(contract).safeParse(inputParams()).success).toBe(true);
      expect(inputParams().instructions).toContain(currentFinding.message);
    });

    it(`${contract.label}: root requirements reject a missing field or wrong type and allow the defaulted run id to be omitted`, () => {
      const schema = schemaForRoot(contract);
      expect(schema.safeParse(contract.originalInputs).success).toBe(true);
      const missing = { ...contract.originalInputs } as Record<string, unknown>;
      delete missing.instanceId;
      expect(schema.safeParse(missing).success).toBe(false);
      expect(schema.safeParse({ ...contract.originalInputs, instructions: 123 }).success).toBe(false);
    });
  }

  it("keeps a non-CMS producer's custom input contract unchanged, with the newest typed request", async () => {
    const original = { bespokeValue: { nested: true }, instructions: "Non-CMS producer instructions", task: "Own task", lifecycleRepairRequest: { repairId: "old" } };
    arrangeProducer(original);
    await dispatchPendingProducerRepairs();
    expect(inputParams()).toMatchObject({ bespokeValue: original.bespokeValue, instructions: original.instructions, task: original.task,
      lifecycleRepairRequest: { repairId: "repair-current", findings: [currentFinding] } });
  });

  it("returns no CMS additions for a non-CMS target", async () => {
    const request = { kind: "lifecycle_repair_request" as const, repairId: "repair-current", gateId: "gate-current", lineageId: "lineage-current",
      attempt: 2, baseTarget: { artifactId: "artifact-base", representationRevisionId: "revision-base" }, expectedBaseRevisionId: "revision-base",
      findings: [], continuationMode: "async_effects_gated", continuationAddress: null, originatingRunBy: "human-origin" };
    expect(await projectCmsRepairInputParams(request)).toEqual({});
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
    const producer = { templateId: "template-producing", runBy: "human-origin", oboCeiling: null, inputParams: JSON.stringify({ custom: "retained" }) };
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

  for (const invalid of ["{malformed", "[]"]) {
    it(`does not inherit authorization or arbitrary fields from unreadable recorded params: ${invalid}`, async () => {
      arrangeProducer(invalid);
      await dispatchPendingProducerRepairs();
      expect(Object.keys(inputParams())).toEqual(["lifecycleRepairRequest"]);
      expect(ports.created[0].input.runBy).toBe("human-origin");
    });
  }
});
