import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { AgentRunStatus } from "../run-status";

// Only external persistence, queue and identity-reading ports are replaced.
// The real dispatcher, coordinator, system authority mint, ActorContext
// builder and the declared findings projection (cinatra#4424) execute. The
// CMS snapshot read-back counts its reads: the drain must never read it. No
// run or queue job exists.
const ports = vi.hoisted(() => ({
  reads: [] as unknown[][],
  readConditions: [] as unknown[],
  updateResults: [] as unknown[][],
  writes: [] as { values: Record<string, unknown>; condition?: unknown }[],
  created: [] as { input: Record<string, unknown>; authority: unknown }[],
  role: "member" as "member" | undefined,
  createFailure: null as Error | null,
  queued: vi.fn(),
  // The one repair run's status, moved only by the transition fake (a
  // compare-and-set on `from`); null when no case expects a transition.
  run: null as { status: string } | null,
  transitions: [] as { runId: string; from: string; to: string; authority: unknown }[],
  transitionFailure: null as Error | null,
  raceTo: null as string | null,
  clears: [] as string[],
  events: [] as string[],
  // cinatra#4264 B1b: the repair claims (advisory lock keys) another drain
  // holds, what the claim fake did, the pooled clients it released, the rows
  // the last pending read selected, and what a claimed re-read of a repair
  // finds now (by id; absent = the selected row unchanged).
  claims: new Set<string>(),
  claimEvents: [] as string[],
  clientsReleased: 0,
  selected: [] as { id: string }[],
  repairNow: new Map<string, unknown[]>(),
}));
vi.mock("server-only", () => ({}));
// cinatra#4312 — an escalation CASes the repair and, in ONE transaction, carries a
// declared review's latest decision; the transaction runs on this same fake, and the
// carrier (proven against a real database in
// lifecycle-c-w11-picture-regenerate-parks-run-3035.integration.test.ts) is inert.
vi.mock("../lifecycle-repair-store", async (orig) => ({
  ...(await orig<typeof import("../lifecycle-repair-store")>()),
  carryDeclaredReviewDecision: async () => null,
}));
vi.mock("../db", () => ({
  // The claim of a Regenerate repair: a pooled client's advisory lock. A key in
  // `ports.claims` is held by another drain.
  agentBuilderPool: {
    connect: async () => ({
      query: async (text: string, params: unknown[]) => {
        const key = String(params[0]);
        if (text === "SELECT pg_try_advisory_lock(hashtext($1)) AS locked") {
          const locked = !ports.claims.has(key);
          if (locked) ports.claims.add(key);
          ports.claimEvents.push(locked ? `claim ${key}` : `held elsewhere ${key}`);
          return { rows: [{ locked }] };
        }
        if (text === "SELECT pg_advisory_unlock(hashtext($1))") {
          ports.claims.delete(key);
          ports.claimEvents.push(`release ${key}`);
          return { rows: [{}] };
        }
        throw new Error(`Unexpected pooled query: ${text}`);
      },
      release: () => { ports.clientsReleased += 1; },
    }),
  },
  db: {
    async transaction(this: unknown, fn: (tx: unknown) => Promise<unknown>) { return fn(this); },
    select: () => {
      let table: unknown = null;
      let ordered = false;
      const query = {
        from: (t: unknown) => { table = t; return query; },
        where: (condition: unknown) => { ports.readConditions.push(condition); return query; },
        orderBy: () => { ordered = true; return query; },
        limit: async () => {
          const condition = ports.readConditions.at(-1) as Parameters<PgDialect["sqlToQuery"]>[0];
          const params = new PgDialect().sqlToQuery(condition).params;
          // The claimed re-read of ONE repair (lifecycle_repair, no order): the
          // selected row, or what `ports.repairNow` says it is now.
          if (!ordered && (table as Record<symbol, unknown> | null)?.[Symbol.for("drizzle:Name")] === "lifecycle_repair") {
            const id = ports.selected.map((r) => r.id).find((candidate) => params.includes(candidate));
            if (!id) throw new Error("Unexpected repair read");
            return ports.repairNow.get(id) ?? ports.selected.filter((r) => r.id === id);
          }
          const result = ports.reads.shift();
          if (!result) throw new Error("Unexpected database read");
          if (ordered) ports.selected = result as { id: string }[];
          const row = result[0] as { orgId?: string } | undefined;
          return row?.orgId && params.includes("repair-org") && row.orgId !== "repair-org" ? [] : result;
        },
      };
      return query;
    },
    update: () => {
      const query = {
        set: (values: Record<string, unknown>) => {
          ports.writes.push({ values });
          ports.events.push(`write ${String(values.status)}`);
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
  // Read only by the strict moment clear after a stop: the repair run states no moment.
  readAgentRunById: async (id: string) => {
    if (!ports.run) throw new Error("Unexpected run read-back");
    ports.clears.push(id);
    return { id, orgId: "repair-org", lifecycleMoment: null };
  },
  recordRunLifecycleMoment: () => { throw new Error("Unexpected moment write"); },
  transitionRunStatus: async (runId: string, from: string, to: string, _meta: unknown, authority: unknown) => {
    if (!ports.run) throw new Error("Unexpected transition");
    ports.transitions.push({ runId, from, to, authority });
    ports.events.push(`transition ${from}->${to}`);
    if (ports.transitionFailure) throw ports.transitionFailure;
    if (ports.raceTo) { ports.run.status = ports.raceTo; ports.raceTo = null; }
    if (ports.run.status !== from) {
      const { RunTransitionError } = await import("../run-status");
      throw new RunTransitionError({ code: "stale_from_status", runId, from: from as AgentRunStatus, to: to as AgentRunStatus });
    }
    ports.run.status = to;
  },
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
// cinatra#4264 B1b on cinatra#3080: the step road's switch, and the segment
// plan as a spy. The spy runs the REAL plan unless a case sets its answer (the
// real plan reads the provenance ledger and the installed flow, which are
// external ports here).
const stepRoad = vi.hoisted(() => ({ dispatches: true }));
vi.mock("../regenerate-step-road", () => ({
  regenerateStepRoadDispatches: () => stepRoad.dispatches,
}));
const segmentPlan = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  answer: null as null | { kind: "segment"; parentRunId: string; inputParams: Record<string, unknown> } | { kind: "refused"; reason: string },
}));
vi.mock("../regenerate-segment", async (orig) => {
  const actual = await orig<typeof import("../regenerate-segment")>();
  return {
    ...actual,
    planSegmentDispatch: async (...args: Parameters<typeof actual.planSegmentDispatch>) => {
      segmentPlan.calls.push(args[0] as unknown as Record<string, unknown>);
      return segmentPlan.answer ?? actual.planSegmentDispatch(...args);
    },
  };
});

// cinatra#4264 (the reader and dispatch slice): the real plan's two external
// reads. The provenance ledger answers the filing node a case names; the
// installed flow document is a file this suite writes, in which one start
// output (`draftNote`) feeds the declared input (`draft_flow`, `note`).
const segmentPorts = vi.hoisted(() => ({
  provenance: null as null | { runId: string; nodeId: string },
  oasPath: null as string | null,
}));
vi.mock("@/lib/artifacts/regenerate-provenance", () => ({
  readVerifiedFilingNode: async () => segmentPorts.provenance,
}));
vi.mock("../installed-oas-path", () => ({
  resolveInstalledOasPathForRead: () => segmentPorts.oasPath,
}));

import { dispatchPendingProducerRepairs, repairRunId } from "../lifecycle-repair-dispatch-store";
import * as dispatchStore from "../lifecycle-repair-dispatch-store";
import { REPAIR_FINDINGS_TEXT_LEAD } from "@/lib/lifecycle/lifecycle-policy";
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
function arrangeProducer(input: unknown, overrides: Record<string, unknown> = {}, lifecycleConfig?: string | null) {
  const row = pendingRepair();
  const template: Record<string, unknown> = { id: "template-producing", packageName: "@any-vendor/repair-producer" };
  if (lifecycleConfig !== undefined) template.lifecycleConfig = lifecycleConfig;
  ports.reads = [[row], [{ templateId: "template-producing", orgId: "repair-org", runBy: "human-origin", oboCeiling: null,
    inputParams: typeof input === "string" ? input : JSON.stringify(input), ...overrides }],
    [template], []];
  ports.updateResults = [[{ id: row.id }]];
  return row;
}
function inputParams() {
  return ports.created[0].input.inputParams as Record<string, unknown>;
}
beforeEach(() => {
  ports.reads = []; ports.readConditions = []; ports.updateResults = []; ports.writes = []; ports.created = [];
  ports.role = "member"; ports.createFailure = null;
  ports.run = null; ports.transitions = []; ports.transitionFailure = null; ports.raceTo = null; ports.clears = []; ports.events = [];
  ports.claims = new Set(); ports.claimEvents = []; ports.clientsReleased = 0; ports.selected = []; ports.repairNow = new Map();
  stepRoad.dispatches = true; segmentPlan.calls = []; segmentPlan.answer = null;
  segmentPorts.provenance = null; segmentPorts.oasPath = null;
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

  it("overlays the current findings on the declared input without dropping inherited root inputs, for a CMS producer", async () => {
    arrangeProducer({ instanceId: "site-42", contentId: "content-42", instructions: "Original input", task: "Own task", lifecycleRepairRequest: { repairId: "old" } },
      {}, JSON.stringify({ repairCapable: true, repairFindingsInput: { input: "instructions" } }));
    await dispatchPendingProducerRepairs();
    expect(inputParams()).toMatchObject({ instanceId: "site-42", contentId: "content-42", task: "Own task",
      lifecycleRepairRequest: { repairId: "repair-current", findings: [currentFinding] } });
    expect(inputParams().instructions).toContain(currentFinding.message);
    expect(inputParams().instructions).not.toContain("Original input");
  });

  it("adds no CMS task or instructions for a producer that declares nothing", async () => {
    const original = { instanceId: "site-42", contentId: "content-42", instructions: "Original input" };
    arrangeProducer(original, {}, JSON.stringify({ repairCapable: true }));
    await dispatchPendingProducerRepairs();
    expect(inputParams()).toEqual({ ...original,
      lifecycleRepairRequest: expect.objectContaining({ repairId: "repair-current", findings: [currentFinding] }) });
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

  // cinatra#3080 on cinatra#4264 B1b: a Regenerate (a repair naming
  // `regenerate_node_id`) is never run as an ordinary repair through the root
  // findings input, and never left `requested` with nothing to take it. With
  // the step road on, it reaches the segment plan: a planned segment is
  // dispatched on the provenance run with the segment's inputs only; a refused
  // plan is escalated with the plan's reason. A blank node id is still a
  // Regenerate intent (the real plan refuses it).
  const REGENERATE_CONFIG = JSON.stringify({
    repairFindingsInput: { input: "instructions" },
    regenerate: [{ artifactNode: "write_draft", step: "draft_flow", noteInput: "brief" }],
  });

  it("a requested Regenerate (regenerate_node_id \"write_draft\") reaches the segment plan and is dispatched on the provenance run with the segment's inputs only", async () => {
    arrangeProducer({ custom: "not-inherited" }, {}, REGENERATE_CONFIG);
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    const segmentInputs = { draftNote: "the note", lifecycleRepairRequest: { repairId: "repair-current" } };
    segmentPlan.answer = { kind: "segment", parentRunId: "provenance-run", inputParams: segmentInputs };
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ scanned: 1, dispatched: 1, escalated: 0, failed: 0 });
    expect(segmentPlan.calls).toHaveLength(1);
    expect(segmentPlan.calls[0]).toMatchObject({
      repair: { id: "repair-current", orgId: "repair-org", regenerateNodeId: "write_draft",
        baseArtifactId: "artifact-base", baseRepresentationRevisionId: "revision-base" },
      templateId: "template-producing", packageName: "@any-vendor/repair-producer", lifecycleConfig: REGENERATE_CONFIG,
      request: { repairId: "repair-current", findings: [currentFinding] },
    });
    // The plan is handed the recorded findings and routes them by the step
    // itself; the drain builds no findings text and picks no field.
    expect(segmentPlan.calls[0].findings).toEqual([currentFinding]);
    expect(segmentPlan.calls[0]).not.toHaveProperty("note");
    expect(ports.created).toHaveLength(1);
    expect(ports.created[0].input).toMatchObject({ parentRunId: "provenance-run", runBy: "human-origin", orgId: "repair-org" });
    expect(inputParams()).toEqual(segmentInputs);
    expect(ports.queued).toHaveBeenCalledOnce();
    expect(ports.writes).toHaveLength(1);
    expect(ports.writes[0].values.status).toBe("dispatched");
  });

  it("a requested Regenerate, through the real plan, puts the Note field's words into the declared input only: no findings text, no findings in the request", async () => {
    const note = "Open with the harbour, not the market";
    const findings = [{ id: "prompt-window", message: note }];
    const dir = mkdtempSync(path.join(tmpdir(), "regen-4264-"));
    segmentPorts.oasPath = path.join(dir, "agent.oas.json");
    writeFileSync(segmentPorts.oasPath, JSON.stringify({
      component_type: "Flow",
      start_node: { $component_ref: "start" },
      data_flow_connections: [
        { source_node: { $component_ref: "start" }, source_output: "draftNote",
          destination_node: { $component_ref: "draft_flow" }, destination_input: "note" },
      ],
    }));
    segmentPorts.provenance = { runId: "provenance-run", nodeId: "write_draft" };
    arrangeProducer({ custom: "not-inherited", instructions: "Original input" }, {}, JSON.stringify({
      repairFindingsInput: { input: "instructions" },
      regenerate: [{ artifactNode: "write_draft", step: "draft_flow", noteInput: "note" }],
    }));
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft", findings })];
    try {
      const result = await dispatchPendingProducerRepairs();
      expect(result).toMatchObject({ scanned: 1, dispatched: 1, escalated: 0, failed: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(ports.created[0].input).toMatchObject({ parentRunId: "provenance-run" });
    const params = inputParams();
    expect(Object.keys(params).sort()).toEqual(["draftNote", "lifecycleRepairRequest"]);
    expect(params.draftNote).toBe(note);
    expect(params.lifecycleRepairRequest).toMatchObject({ kind: "lifecycle_repair_request", repairId: "repair-current", findings: [] });
    expect(JSON.stringify(params).split(note)).toHaveLength(2);
  });

  it("a Regenerate whose segment plan refuses is escalated with the plan's reason: no run, no job", async () => {
    arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG);
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    segmentPlan.answer = { kind: "refused", reason: "Regenerate refused: the agent declares no Regenerate entry for that step" };
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ scanned: 1, escalated: 1, dispatched: 0, failed: 0 });
    expect(segmentPlan.calls).toHaveLength(1);
    expect(ports.created).toHaveLength(0); expect(ports.queued).not.toHaveBeenCalled();
    // The existing-run read is made BEFORE the plan, and it finds no run.
    expect(ports.reads).toHaveLength(0);
    expect(ports.writes).toHaveLength(1);
    expect(ports.writes[0].values.status).toBe("escalated");
    expect(String(ports.writes[0].values.changeSummary)).toContain("declares no Regenerate entry for that step");
  });

  it("a blank regenerate_node_id is a Regenerate intent: the real plan refuses it and the repair is escalated, never dispatched as an ordinary repair", async () => {
    arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG);
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "" })];
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ scanned: 1, escalated: 1, dispatched: 0, failed: 0 });
    expect(segmentPlan.calls).toHaveLength(1);
    expect(ports.created).toHaveLength(0); expect(ports.queued).not.toHaveBeenCalled();
    expect(ports.reads).toHaveLength(0);
    expect(ports.writes[0].values.status).toBe("escalated");
    expect(String(ports.writes[0].values.changeSummary)).toContain("the Regenerate intent names no node");
  });

  // A "write_draft" dispatch created and enqueued its segment run, then
  // stopped before the repair was marked dispatched. This first pass uses a
  // stub plan, so its run carries no record of its dispatch: a retry stops
  // and escalates it (a completed one is escalated only).
  const PLANNED = { kind: "segment" as const, parentRunId: "provenance-run",
    inputParams: { draftNote: "the note", lifecycleRepairRequest: { repairId: "repair-current", findings: [] } } };
  async function firstPassCreatesAndEnqueuesTheRun() {
    arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG);
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    segmentPlan.answer = PLANNED;
    ports.updateResults = []; // the pass stops before the dispatched mark
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await dispatchPendingProducerRepairs()).toMatchObject({ dispatched: 0, escalated: 0, failed: 1 });
    } finally { error.mockRestore(); }
    expect(ports.created).toHaveLength(1);
    expect(ports.queued).toHaveBeenCalledOnce();
    return ports.created[0].input;
  }

  // A retry judges a run that already exists by its own stored record only
  // (`recordedRegenerateInput`, as the completer does), never by a plan
  // rebuilt from the current template and flow: those can be reinstalled in
  // place after the run was made. The first pass here runs the REAL plan, so
  // the run carries the record its dispatch wrote; the retry then reads a
  // template whose Regenerate entry is gone and no installed flow, so a
  // rebuilt plan would refuse.
  const RECORDED_NOTE = "Open with the harbour, not the market";
  const RECORDED_FINDINGS = [{ id: "prompt-window", message: RECORDED_NOTE }];
  const RECORDED_CONFIG = JSON.stringify({ regenerate: [{ artifactNode: "write_draft", step: "draft_flow", noteInput: "note" }] });
  const REINSTALLED_CONFIG = JSON.stringify({ repairFindingsInput: { input: "instructions" } });
  async function firstPassCreatesARecordedRun() {
    const dir = mkdtempSync(path.join(tmpdir(), "regen-4264-"));
    segmentPorts.oasPath = path.join(dir, "agent.oas.json");
    writeFileSync(segmentPorts.oasPath, JSON.stringify({
      component_type: "Flow",
      start_node: { $component_ref: "start" },
      data_flow_connections: [
        { source_node: { $component_ref: "start" }, source_output: "draftNote",
          destination_node: { $component_ref: "draft_flow" }, destination_input: "note" },
      ],
    }));
    segmentPorts.provenance = { runId: "provenance-run", nodeId: "write_draft" };
    arrangeProducer({ custom: "retained" }, {}, RECORDED_CONFIG);
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft", findings: RECORDED_FINDINGS })];
    ports.updateResults = []; // the pass stops before the dispatched mark
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await dispatchPendingProducerRepairs()).toMatchObject({ dispatched: 0, escalated: 0, failed: 1 });
    } finally {
      error.mockRestore();
      rmSync(dir, { recursive: true, force: true });
      segmentPorts.oasPath = null; segmentPorts.provenance = null;
    }
    expect(ports.created).toHaveLength(1);
    expect(ports.queued).toHaveBeenCalledOnce();
    ports.writes = []; // the first pass's failed mark
    return ports.created[0].input;
  }
  function retryReads(created: Record<string, unknown>, status: string, config: string) {
    arrangeProducer({ custom: "retained" }, {}, config);
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft", findings: RECORDED_FINDINGS })];
    ports.reads[3] = [{ id: repairRunId("repair-current"), status,
      inputParams: JSON.stringify(created.inputParams), parentRunId: created.parentRunId }];
  }

  it("a Regenerate retry whose run already exists with its record is carried to dispatched: no second create, no second plan and the same job id", async () => {
    const created = await firstPassCreatesARecordedRun();
    const firstJobId = ports.queued.mock.calls[0][1].jobId;

    retryReads(created, "queued", RECORDED_CONFIG);
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ scanned: 1, dispatched: 1, escalated: 0, failed: 0 });
    expect(segmentPlan.calls).toHaveLength(1); // the first pass's plan only
    expect(ports.created).toHaveLength(1);
    expect(ports.queued).toHaveBeenCalledTimes(2);
    expect(ports.queued.mock.calls[1][0].runId).toBe(repairRunId("repair-current"));
    expect(ports.queued.mock.calls[1][1].jobId).toBe(firstJobId);
    expect(ports.writes.map((w) => w.values.status)).toEqual(["dispatched"]);
  });

  // The worker validated and started the run; the template was then
  // reinstalled in place before the retry. The run is judged by its record,
  // so it is carried to the mark, never stopped.
  // red-first-expect: expected { scanned: 1, dispatched: +0, …(3) } to match object { scanned: 1, dispatched: 1, …(2) }
  it("a Regenerate retry whose running run was made before its template changed is marked dispatched, not stopped", async () => {
    const created = await firstPassCreatesARecordedRun();
    const firstJobId = ports.queued.mock.calls[0][1].jobId;
    ports.run = { status: "running" }; ports.events = [];

    retryReads(created, "running", REINSTALLED_CONFIG);
    ports.reads.push([{ status: "running" }]); // read only by a stop
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ scanned: 1, dispatched: 1, escalated: 0, failed: 0 });
    expect(ports.run).toEqual({ status: "running" });
    expect(ports.transitions).toHaveLength(0);
    expect(segmentPlan.calls).toHaveLength(1); // the first pass's plan only
    expect(ports.created).toHaveLength(1);
    expect(ports.queued.mock.calls.at(-1)![1].jobId).toBe(firstJobId);
    expect(ports.writes.map((w) => w.values.status)).toEqual(["dispatched"]);
  });

  // The worker can finish the run before the pass that enqueued it marks the
  // repair dispatched, and the template can be reinstalled after that. A
  // retry that finds the run completed with its record marks the repair
  // dispatched with no second create and no second job, so the completer
  // takes the run's output. A completed run with no valid record is
  // escalated; there is nothing to stop.
  // red-first-expect: expected { scanned: 1, dispatched: +0, …(3) } to match object { scanned: 1, dispatched: 1, …(2) }
  it("a Regenerate retry whose completed run was made before its template changed is marked dispatched: no second create and no second job", async () => {
    const created = await firstPassCreatesARecordedRun();

    retryReads(created, "completed", REINSTALLED_CONFIG);
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ scanned: 1, dispatched: 1, escalated: 0, failed: 0 });
    expect(segmentPlan.calls).toHaveLength(1); // the first pass's plan only
    expect(ports.created).toHaveLength(1);
    expect(ports.queued).toHaveBeenCalledOnce(); // the first pass's call only
    expect(ports.transitions).toHaveLength(0);
    expect(ports.writes.map((w) => w.values.status)).toEqual(["dispatched"]);
    const condition = ports.writes[0].condition as Parameters<PgDialect["sqlToQuery"]>[0];
    expect(new PgDialect().sqlToQuery(condition).params).toEqual(["repair-current", "requested"]);
    expect(ports.reads).toHaveLength(0);
  });

  // A run with no record is escalated even when a rebuilt plan would match
  // it byte for byte: the plan never decides for an existing run.
  // red-first-expect: expected { scanned: 1, dispatched: 1, …(3) } to match object { scanned: 1, dispatched: +0, …(2) }
  it("a Regenerate retry whose existing run carries no record is stopped and escalated, even when the rebuilt plan matches it", async () => {
    const created = await firstPassCreatesAndEnqueuesTheRun();
    ports.writes = []; // the first pass's failed mark
    ports.run = { status: "queued" }; ports.events = [];

    arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG);
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    ports.reads[3] = [{ id: repairRunId("repair-current"), status: "queued",
      inputParams: JSON.stringify(created.inputParams), parentRunId: created.parentRunId }];
    ports.reads.push([{ status: "queued" }]); // the stop's own read of the run
    ports.updateResults = [[{ lineageId: "lineage-current" }]];
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ scanned: 1, dispatched: 0, escalated: 1, failed: 0 });
    expect(ports.run).toEqual({ status: "stopped" });
    expect(ports.events).toEqual(["transition queued->stopped", "write escalated"]);
    expect(ports.created).toHaveLength(1);
    expect(ports.queued).toHaveBeenCalledOnce(); // the first pass's call only
    expect(String(ports.writes.at(-1)!.values.changeSummary)).toContain("stopped and not sent");
  });

  it("a Regenerate retry whose run already completed with no valid record is escalated, never marked dispatched", async () => {
    const created = await firstPassCreatesAndEnqueuesTheRun();
    ports.writes = []; // the first pass's failed mark

    arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG);
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    ports.reads[3] = [{ id: repairRunId("repair-current"), status: "completed",
      inputParams: JSON.stringify({ ...created.inputParams as Record<string, unknown>, draftNote: "another note" }),
      parentRunId: created.parentRunId }];
    ports.updateResults = [[{ lineageId: "lineage-current" }]];
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ scanned: 1, dispatched: 0, escalated: 1, failed: 0 });
    expect(ports.queued).toHaveBeenCalledOnce(); // the first pass's call only
    expect(ports.transitions).toHaveLength(0);
    expect(ports.writes.map((w) => w.values.status)).toEqual(["escalated"]);
    expect(String(ports.writes[0].values.changeSummary)).toContain(dispatchStore.REGENERATE_RUN_NOT_DECLARED_FORM);
    expect(ports.reads).toHaveLength(0);
  });

  // A run made in the earlier form (the generic findings text in the note's
  // start output and the request with all its findings, as an older build
  // writes it) that a pass created before a crash, or during a rolling
  // deployment, is never sent in that form: the retry stops it and escalates.
  // red-first-expect: expected { scanned: 1, dispatched: 1, …(3) } to match object { scanned: 1, dispatched: +0, …(2) }
  it("a Regenerate retry whose existing run holds the earlier findings form is stopped and escalated, never enqueued in that form", async () => {
    const note = "Open with the harbour, not the market";
    const findings = [{ id: "prompt-window", message: note }];
    const dir = mkdtempSync(path.join(tmpdir(), "regen-4264-"));
    segmentPorts.oasPath = path.join(dir, "agent.oas.json");
    writeFileSync(segmentPorts.oasPath, JSON.stringify({
      component_type: "Flow",
      start_node: { $component_ref: "start" },
      data_flow_connections: [
        { source_node: { $component_ref: "start" }, source_output: "draftNote",
          destination_node: { $component_ref: "draft_flow" }, destination_input: "note" },
      ],
    }));
    segmentPorts.provenance = { runId: "provenance-run", nodeId: "write_draft" };
    const config = JSON.stringify({ regenerate: [{ artifactNode: "write_draft", step: "draft_flow", noteInput: "note" }] });
    arrangeProducer({ custom: "retained" }, {}, config);
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft", findings })];
    const earlierForm = {
      draftNote: `${REPAIR_FINDINGS_TEXT_LEAD}\n\n1. ${note}`,
      lifecycleRepairRequest: { kind: "lifecycle_repair_request", repairId: "repair-current", findings },
    };
    ports.reads[3] = [{ id: repairRunId("repair-current"), status: "queued",
      inputParams: JSON.stringify(earlierForm), parentRunId: "provenance-run" }];
    ports.reads.push([{ status: "queued" }]); // the stop's own read of the run
    ports.run = { status: "queued" };
    let result: unknown;
    try {
      result = await dispatchPendingProducerRepairs();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(result).toMatchObject({ scanned: 1, dispatched: 0, escalated: 1, failed: 0 });
    expect(ports.queued).not.toHaveBeenCalled();
    expect(ports.created).toHaveLength(0);
    expect(ports.run).toEqual({ status: "stopped" });
    expect(ports.writes.map((w) => w.values.status)).toEqual(["escalated"]);
    expect(String(ports.writes[0].values.changeSummary)).toContain("stopped and not sent");
  });

  // A picture's Regenerate carries two review fields: the Note and the
  // picture's prompt. Each fills only the input declared for it. The picture
  // step declares its prompt, so the prompt's words (not the note's) reach
  // that input, once; the draft step declares its note, so the Note's words
  // reach that input, once. Neither text appears anywhere else in the run.
  // red-first-expect: expected 'A reviewer requested changes to the w…' to be 'A lighthouse at dusk, wide angle' // Object.is equality
  it("a note and a picture prompt with different words each reach only their own declared input, once", async () => {
    const note = "Make the sky brighter";
    const prompt = "A lighthouse at dusk, wide angle";
    const dir = mkdtempSync(path.join(tmpdir(), "regen-4264-"));
    segmentPorts.oasPath = path.join(dir, "agent.oas.json");
    writeFileSync(segmentPorts.oasPath, JSON.stringify({
      component_type: "Flow",
      start_node: { $component_ref: "start" },
      data_flow_connections: [
        { source_node: { $component_ref: "start" }, source_output: "draftNote",
          destination_node: { $component_ref: "draft_flow" }, destination_input: "note" },
        { source_node: { $component_ref: "start" }, source_output: "imagePrompt",
          destination_node: { $component_ref: "image_flow" }, destination_input: "prompt" },
      ],
    }));
    const config = JSON.stringify({ regenerate: [
      { artifactNode: "file_image", step: "image_flow", noteInput: "prompt" },
      { artifactNode: "write_draft", step: "draft_flow", noteInput: "note" },
    ] });
    try {
      segmentPorts.provenance = { runId: "provenance-run", nodeId: "file_image" };
      arrangeProducer({ custom: "retained" }, {}, config);
      ports.reads[0] = [pendingRepair({ regenerateNodeId: "file_image", findings: [
        { id: "prompt-window", message: note }, { id: "picture-prompt", message: prompt },
      ] })];
      expect(await dispatchPendingProducerRepairs()).toMatchObject({ dispatched: 1, escalated: 0 });
      const picture = inputParams();
      expect(picture.imagePrompt).toBe(prompt);
      expect(Object.keys(picture).sort()).toEqual(["imagePrompt", "lifecycleRepairRequest"]);
      expect(JSON.stringify(picture).split(prompt)).toHaveLength(2);
      expect(JSON.stringify(picture)).not.toContain(note);

      ports.created = [];
      segmentPorts.provenance = { runId: "provenance-run", nodeId: "write_draft" };
      arrangeProducer({ custom: "retained" }, {}, config);
      ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft", findings: [{ id: "prompt-window", message: note }] })];
      expect(await dispatchPendingProducerRepairs()).toMatchObject({ dispatched: 1, escalated: 0 });
      const draft = inputParams();
      expect(draft.draftNote).toBe(note);
      expect(Object.keys(draft).sort()).toEqual(["draftNote", "lifecycleRepairRequest"]);
      expect(JSON.stringify(draft).split(note)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The reviewed work, not the declared input's name, decides which review
  // field fills that input. The review store records a picture's prompt only
  // for a picture with a recorded prompt; a picture step whose prompt input
  // has another name is sent that prompt, and the Note reaches no input.
  // red-first-expect: expected 'A reviewer requested changes to the w…' to be 'A lighthouse at dusk, wide angle' // Object.is equality
  it("a picture step whose declared input is not named prompt is sent the picture's prompt; the Note reaches no input", async () => {
    const note = "Make the sky brighter";
    const prompt = "A lighthouse at dusk, wide angle";
    const dir = mkdtempSync(path.join(tmpdir(), "regen-4264-"));
    segmentPorts.oasPath = path.join(dir, "agent.oas.json");
    writeFileSync(segmentPorts.oasPath, JSON.stringify({
      component_type: "Flow",
      start_node: { $component_ref: "start" },
      data_flow_connections: [
        { source_node: { $component_ref: "start" }, source_output: "pictureWords",
          destination_node: { $component_ref: "picture_flow" }, destination_input: "imagePrompt" },
      ],
    }));
    const config = JSON.stringify({ regenerate: [
      { artifactNode: "file_picture", step: "picture_flow", noteInput: "imagePrompt" },
    ] });
    try {
      segmentPorts.provenance = { runId: "provenance-run", nodeId: "file_picture" };
      arrangeProducer({ custom: "retained" }, {}, config);
      ports.reads[0] = [pendingRepair({ regenerateNodeId: "file_picture", findings: [
        { id: "prompt-window", message: note }, { id: "picture-prompt", message: prompt },
      ] })];
      expect(await dispatchPendingProducerRepairs()).toMatchObject({ dispatched: 1, escalated: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const picture = inputParams();
    expect(picture.pictureWords).toBe(prompt);
    expect(Object.keys(picture).sort()).toEqual(["lifecycleRepairRequest", "pictureWords"]);
    expect(JSON.stringify(picture)).not.toContain(note);
    expect(JSON.stringify(picture).split(prompt)).toHaveLength(2);
  });

  // A text step may name its note input `prompt`. Its review records the Note
  // alone, and the Note is what that input is sent.
  it("a text step whose declared input is named prompt is sent the Note", async () => {
    const note = "Make the sky brighter";
    const dir = mkdtempSync(path.join(tmpdir(), "regen-4264-"));
    segmentPorts.oasPath = path.join(dir, "agent.oas.json");
    writeFileSync(segmentPorts.oasPath, JSON.stringify({
      component_type: "Flow",
      start_node: { $component_ref: "start" },
      data_flow_connections: [
        { source_node: { $component_ref: "start" }, source_output: "draftPrompt",
          destination_node: { $component_ref: "draft_flow" }, destination_input: "prompt" },
      ],
    }));
    const config = JSON.stringify({ regenerate: [
      { artifactNode: "write_draft", step: "draft_flow", noteInput: "prompt" },
    ] });
    try {
      segmentPorts.provenance = { runId: "provenance-run", nodeId: "write_draft" };
      arrangeProducer({ custom: "retained" }, {}, config);
      ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft", findings: [
        { id: "prompt-window", message: note },
      ] })];
      expect(await dispatchPendingProducerRepairs()).toMatchObject({ dispatched: 1, escalated: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const draft = inputParams();
    expect(draft.draftPrompt).toBe(note);
    expect(Object.keys(draft).sort()).toEqual(["draftPrompt", "lifecycleRepairRequest"]);
    expect(JSON.stringify(draft).split(note)).toHaveLength(2);
  });

  it("a Regenerate retry that finds no run and whose new plan refuses is escalated with the plan's reason, as before", async () => {
    arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG);
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    segmentPlan.answer = { kind: "segment", parentRunId: "provenance-run", inputParams: { draftNote: "the note" } };
    ports.createFailure = new Error("The pass stops before the run is created");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await dispatchPendingProducerRepairs()).toMatchObject({ dispatched: 0, escalated: 0, failed: 1 });
    } finally { error.mockRestore(); }
    expect(ports.created).toHaveLength(0); expect(ports.queued).not.toHaveBeenCalled();

    arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG);
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    segmentPlan.answer = { kind: "refused", reason: "Regenerate refused: the agent declares no Regenerate entry for that step" };
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ scanned: 1, escalated: 1, dispatched: 0, failed: 0 });
    expect(segmentPlan.calls).toHaveLength(2);
    expect(ports.reads).toHaveLength(0);
    expect(ports.created).toHaveLength(0); expect(ports.queued).not.toHaveBeenCalled();
    expect(ports.writes.at(-1)!.values.status).toBe("escalated");
    expect(String(ports.writes.at(-1)!.values.changeSummary)).toContain("declares no Regenerate entry for that step");
  });

  // The cases the drain refused for a reason other than the missing step road
  // still escalate a Regenerate before any plan: a checkpointed delivery and a
  // revoked originating human.
  it("a checkpointed Regenerate keeps the checkpointed escalation; the plan is never made", async () => {
    ports.reads = [[pendingRepair({ continuationMode: "checkpointed", regenerateNodeId: "write_draft" })]];
    ports.updateResults = [[{ id: "repair-current" }]];
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ escalated: 1, dispatched: 0 });
    expect(segmentPlan.calls).toHaveLength(0);
    expect(String(ports.writes[0].values.changeSummary)).toContain("checkpointed repair delivery is a resume");
  });

  it("a Regenerate whose originating human is revoked is escalated before any plan, run or job", async () => {
    arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG); ports.role = undefined;
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ escalated: 1, dispatched: 0 });
    expect(segmentPlan.calls).toHaveLength(0);
    expect(ports.created).toHaveLength(0); expect(ports.queued).not.toHaveBeenCalled();
    expect(String(ports.writes[0].values.changeSummary)).toContain("no longer a verified member");
  });

  // R117 root fix (cinatra#4264 B1b): a check that escalates a Regenerate BEFORE
  // the deterministic-run read (ended pause, no producer, no human runBy,
  // revoked member) can meet a retry whose run an earlier pass created. That run
  // is stopped FIRST, then the repair is escalated: never enqueued for a member
  // who no longer qualifies, never left queued with no job.
  const RUN = repairRunId("repair-current");
  async function firstPassCreatesTheRunButNoJob() {
    arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG);
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    segmentPlan.answer = { kind: "segment", parentRunId: "provenance-run", inputParams: { draftNote: "the note" } };
    ports.queued.mockRejectedValueOnce(new Error("The pass stops before the enqueue"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await dispatchPendingProducerRepairs()).toMatchObject({ dispatched: 0, escalated: 0, failed: 1 });
    } finally { error.mockRestore(); }
    expect(ports.created).toHaveLength(1);
    ports.run = { status: "queued" }; ports.events = [];
  }
  function expectStoppedThenEscalated(result: unknown, from: string, reason: string) {
    expect(result).toMatchObject({ scanned: 1, escalated: 1, dispatched: 0, failed: 0 });
    expect(ports.run).toEqual({ status: "stopped" });
    expect(ports.transitions.map((t) => [t.runId, t.from, t.to])).toEqual([[RUN, from, "stopped"]]);
    const authority = ports.transitions[0].authority as { orgId: string; can: (capability: string) => boolean };
    expect(authority.orgId).toBe("repair-org");
    expect(authority.can("run.complete")).toBe(true);
    expect(ports.clears).toEqual([RUN]);
    expect(ports.events).toEqual([`transition ${from}->stopped`, "write escalated"]);
    expect(ports.created).toHaveLength(1);
    expect(String(ports.writes.at(-1)!.values.changeSummary)).toContain(reason);
  }

  it("a Regenerate retry after a crash before the enqueue and a revoked originating member stops the queued run, then escalates: no job, no second create", async () => {
    await firstPassCreatesTheRunButNoJob();
    arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG); ports.role = undefined;
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    ports.reads[3] = [{ status: "queued" }];
    const result = await dispatchPendingProducerRepairs();
    expectStoppedThenEscalated(result, "queued", "no longer a verified member");
    expect(ports.queued).toHaveBeenCalledOnce(); // the first pass's failed call only
    expect(segmentPlan.calls).toHaveLength(1);
  });

  it("a Regenerate retry whose ended pause is no longer held stops the existing run, then escalates", async () => {
    await firstPassCreatesTheRunButNoJob();
    ports.reads = [[pendingRepair({ regenerateNodeId: "write_draft", pausedRunGeneration: 3 })], [], [{ status: "queued" }]];
    ports.updateResults = [[{ id: "repair-current" }]];
    const result = await dispatchPendingProducerRepairs();
    expectStoppedThenEscalated(result, "queued", "no longer at that pause");
  });

  it("a Regenerate retry whose producing run is gone stops the existing run, then escalates", async () => {
    await firstPassCreatesTheRunButNoJob();
    ports.reads = [[pendingRepair({ regenerateNodeId: "write_draft" })], [], [{ status: "queued" }]];
    ports.updateResults = [[{ id: "repair-current" }]];
    const result = await dispatchPendingProducerRepairs();
    expectStoppedThenEscalated(result, "queued", "no resolvable producing run");
  });

  it("a Regenerate retry whose producing run carries no human runBy stops the existing run, then escalates", async () => {
    await firstPassCreatesTheRunButNoJob();
    arrangeProducer({ custom: "retained" }, { runBy: null }, REGENERATE_CONFIG);
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    ports.reads[3] = [{ status: "queued" }];
    const result = await dispatchPendingProducerRepairs();
    expectStoppedThenEscalated(result, "queued", "carries no human runBy");
  });

  it("a stop that loses its compare-and-set reads the run again and stops it from its live status", async () => {
    await firstPassCreatesTheRunButNoJob();
    arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG); ports.role = undefined;
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    ports.reads[3] = [{ status: "queued" }]; ports.reads.push([{ status: "running" }]); ports.raceTo = "running";
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ escalated: 1, failed: 0 });
    expect(ports.transitions.map((t) => `${t.from}->${t.to}`)).toEqual(["queued->stopped", "running->stopped"]);
    expect(ports.run).toEqual({ status: "stopped" });
    expect(ports.reads).toHaveLength(0);
  });

  it("a stop that fails keeps the Regenerate requested for the next pass: no escalation is written", async () => {
    await firstPassCreatesTheRunButNoJob();
    arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG); ports.role = undefined;
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    ports.reads[3] = [{ status: "queued" }]; ports.transitionFailure = new Error("The status write failed");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await dispatchPendingProducerRepairs()).toMatchObject({ escalated: 0, failed: 1 });
    } finally { error.mockRestore(); }
    expect(ports.writes.map((w) => w.values.status)).not.toContain("escalated");
  });

  it("a Regenerate retry whose run already failed moves nothing and escalates", async () => {
    await firstPassCreatesTheRunButNoJob(); ports.run = { status: "failed" };
    arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG); ports.role = undefined;
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    ports.reads[3] = [{ status: "failed" }];
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ escalated: 1, failed: 0 });
    expect(ports.reads).toHaveLength(0); // the run was read
    expect(ports.transitions).toHaveLength(0); expect(ports.clears).toHaveLength(0);
  });

  // R117 root fix of the class (cinatra#4264 B1b): every decision on a
  // Regenerate repair is taken under ONE claim of that repair, so a drain never
  // stops, escalates or marks a Regenerate another drain is delivering.
  const CLAIM = "lifecycle-repair-dispatch::repair-current";

  it("two drains on one Regenerate: a drain that meets the other drain's claim stops nothing, escalates nothing and marks nothing", async () => {
    // Drain A holds the claim: it created and enqueued the run and has not
    // marked the repair dispatched yet. Drain B's check would escalate now
    // (the originating member was revoked in between).
    await firstPassCreatesTheRunButNoJob();
    ports.claims.add(CLAIM); ports.claimEvents = []; ports.clientsReleased = 0;
    arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG); ports.role = undefined;
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    ports.reads[3] = [{ status: "queued" }]; // what a drain acting without the claim would read and stop
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ scanned: 1, raced: 1, escalated: 0, dispatched: 0, failed: 0 });
    expect(ports.transitions).toHaveLength(0);
    expect(ports.run).toEqual({ status: "queued" });
    expect(ports.writes).toHaveLength(0);
    expect(ports.created).toHaveLength(1); expect(ports.queued).toHaveBeenCalledOnce();
    expect(ports.reads).toHaveLength(3); // only the pending read was made
    expect(ports.claimEvents).toEqual([`held elsewhere ${CLAIM}`]);
    expect(ports.claims.has(CLAIM)).toBe(true); // still drain A's
    expect(ports.clientsReleased).toBe(1);
  });

  it("two drains on one Regenerate: a drain that selected the repair before the other drain marked it dispatched reads it again under the claim and leaves it alone", async () => {
    await firstPassCreatesTheRunButNoJob();
    ports.claimEvents = []; // the first pass's own claim and release
    arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG); ports.role = undefined;
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    ports.reads[3] = [{ status: "queued" }]; // what a drain acting without the claim would read and stop
    ports.repairNow.set("repair-current", []); // no longer requested: the other drain marked it
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ scanned: 1, raced: 1, escalated: 0, dispatched: 0, failed: 0 });
    expect(ports.transitions).toHaveLength(0);
    expect(ports.run).toEqual({ status: "queued" });
    expect(ports.writes).toHaveLength(0);
    expect(ports.reads).toHaveLength(3); // the producer was never read
    expect(ports.claimEvents).toEqual([`claim ${CLAIM}`, `release ${CLAIM}`]);
  });

  it("a crash after the stop and before the escalation, then the check passes again: the stopped run is never enqueued or marked; the repair is escalated", async () => {
    await firstPassCreatesTheRunButNoJob();
    // Pass 2: the member is revoked; the run is stopped, then the pass dies
    // before the escalation write.
    arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG); ports.role = undefined;
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    ports.reads[3] = [{ status: "queued" }];
    ports.updateResults = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await dispatchPendingProducerRepairs()).toMatchObject({ escalated: 0, failed: 1 });
    } finally { error.mockRestore(); }
    expect(ports.run).toEqual({ status: "stopped" });
    // Pass 3: the member is restored, so every check before the run read passes.
    ports.role = "member";
    arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG);
    ports.reads[0] = [pendingRepair({ regenerateNodeId: "write_draft" })];
    ports.reads[3] = [{ id: RUN, status: "stopped" }];
    const result = await dispatchPendingProducerRepairs();
    expect(result).toMatchObject({ scanned: 1, escalated: 1, dispatched: 0, failed: 0 });
    expect(ports.queued).toHaveBeenCalledOnce(); // the first pass's failed call only
    expect(ports.writes.map((w) => w.values.status)).not.toContain("dispatched");
    expect(ports.writes.at(-1)!.values.status).toBe("escalated");
    expect(String(ports.writes.at(-1)!.values.changeSummary)).toContain("already stopped");
    expect(segmentPlan.calls).toHaveLength(1);
  });

  it("the claim is released on every road, a Regenerate failure included; an ordinary repair takes no claim", async () => {
    await firstPassCreatesTheRunButNoJob();
    expect(ports.claimEvents).toEqual([`claim ${CLAIM}`, `release ${CLAIM}`]);
    expect(ports.claims.size).toBe(0); expect(ports.clientsReleased).toBe(1);
    ports.claimEvents = []; ports.clientsReleased = 0;
    arrangeProducer({ custom: "retained" });
    expect(await dispatchPendingProducerRepairs()).toMatchObject({ dispatched: 1 });
    expect(ports.claimEvents).toEqual([]); expect(ports.clientsReleased).toBe(0);
  });

  // With the step road OFF (`regenerateStepRoadDispatches` false), the drain
  // escalates every Regenerate intent before the producer reads, as before.
  for (const regenerateNodeId of ["write_draft", ""]) {
    it(`with the step road off, escalates a Regenerate repair (regenerate_node_id ${JSON.stringify(regenerateNodeId)}) instead of dispatching it or leaving it requested`, async () => {
      stepRoad.dispatches = false;
      arrangeProducer({ custom: "retained" }, {}, REGENERATE_CONFIG);
      ports.reads[0] = [pendingRepair({ regenerateNodeId })];
      const result = await dispatchPendingProducerRepairs();
      expect(result).toMatchObject({ scanned: 1, escalated: 1, dispatched: 0, failed: 0 });
      expect(segmentPlan.calls).toHaveLength(0);
      expect(ports.created).toHaveLength(0); expect(ports.queued).not.toHaveBeenCalled();
      // The producer, its template and the existing-run reads are never made.
      expect(ports.reads).toHaveLength(3);
      expect(ports.writes).toHaveLength(1);
      expect(ports.writes[0].values.status).toBe("escalated");
      expect(String(ports.writes[0].values.changeSummary)).toContain("a Regenerate reruns one declared step");
    });
  }

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

describe("the escalation of a Regenerate repair whose run is not in the declared-input form", () => {
  // The run start and the completer escalate by this one rule. During a
  // rolling deployment the repair can already be `dispatched` (an older
  // dispatcher marked it), so the compare-and-set takes a `requested` or a
  // `dispatched` Regenerate repair, and only one that names a Regenerate node.
  // A second escalation of the same repair matches no row and writes nothing.
  // red-first-expect: to have property "escalateRegenerateRepairOfUndeclaredRun"
  it("moves a dispatched Regenerate repair to escalated with the reason, once", async () => {
    expect(dispatchStore).toHaveProperty("escalateRegenerateRepairOfUndeclaredRun");
    ports.updateResults = [[{ lineageId: "lineage-current" }], []];
    // The escalation lives in `../regenerate-segment` (route-graph ratchet),
    // which this suite loads through its original module, so the carrier it
    // calls is the real one: a lineage with no root gate (the empty read)
    // carries nothing.
    ports.reads = [[]];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await dispatchStore.escalateRegenerateRepairOfUndeclaredRun("repair-current")).toBe(true);
      expect(await dispatchStore.escalateRegenerateRepairOfUndeclaredRun("repair-current")).toBe(false);
    } finally { warn.mockRestore(); }
    expect(ports.reads).toHaveLength(0);
    expect(ports.writes.map((w) => w.values.status)).toEqual(["escalated", "escalated"]);
    expect(String(ports.writes[0].values.changeSummary)).toBe(
      `${dispatchStore.DISPATCH_ESCALATION_PREFIX}${dispatchStore.REGENERATE_RUN_NOT_DECLARED_FORM}`,
    );
    const query = new PgDialect().sqlToQuery(ports.writes[0].condition as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(query.params).toEqual(["repair-current", "requested", "dispatched"]);
    expect(query.sql).toContain('"regenerate_node_id" is not null');
  });
});
