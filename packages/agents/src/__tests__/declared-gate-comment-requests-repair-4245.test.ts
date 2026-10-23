import { beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#4245 — a typed comment on a review step a flow declares in its own
// template (a `wayflow-` gate) files a change request when every condition
// holds, and the repair drain stops the paused run before a repair run starts.
// Only the persistence, queue and identity ports are replaced; the real
// changes-requested composer and the real repair drain run.
const ports = vi.hoisted(() => ({
  gates: [] as Array<{ id: string; runId: string; orgId: string; reviewTaskId: string; status: string;
    pinnedTargets?: unknown[]; createdAt?: Date }>,
  run: null as null | { id: string; orgId: string; templateId: string; runBy: string | null; status: string;
    a2aTaskId?: string | null },
  repairs: [] as Array<Record<string, unknown>>,
  repairCapable: true,
  event: null as null | Record<string, unknown>,
  gate: null as null | Record<string, unknown>,
  recorded: [] as unknown[],
  transitions: [] as unknown[][],
  transitionFailure: null as Error | null,
  launched: [] as unknown[],
  releases: [] as unknown[],
  escalations: [] as Record<string, unknown>[],
  dispatched: [] as string[],
  cleared: [] as unknown[][],
}));

vi.mock("server-only", () => ({}));
vi.mock("../db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const paramsOf = (condition: unknown): unknown[] =>
    condition ? new PgDialect().sqlToQuery(condition as Parameters<InstanceType<typeof PgDialect>["sqlToQuery"]>[0]).params : [];
  const rowsFor = (table: unknown, params: unknown[]): unknown[] => {
    const name = getTableName(table as Parameters<typeof getTableName>[0]);
    if (name === "lifecycle_repair") return ports.repairs.filter((r) => r.status === "requested");
    if (name === "artifact_review_gates") {
      if (params.includes("pending")) {
        return ports.gates.filter((g) => g.status === "pending" && params.includes(g.runId) && params.includes(g.orgId));
      }
      const byId = ports.gates.filter((g) => params.includes(g.id) && params.includes(g.orgId));
      if (byId.length > 0) return byId;
      // A read of every gate of one run (the declared-gate lookup, the pause witness).
      return ports.gates.filter((g) => params.includes(g.runId) && params.includes(g.orgId));
    }
    if (name === "agent_runs") {
      if (!ports.run || !params.includes(ports.run.id)) return [];
      return [{ ...ports.run, oboCeiling: null, inputParams: "{}" }];
    }
    if (name === "agent_templates") {
      return [{ id: "template-producing", packageName: "@any-vendor/producer",
        lifecycleConfig: JSON.stringify({ repairCapable: ports.repairCapable }) }];
    }
    return [];
  };
  return {
    db: {
      select: () => {
        let table: unknown;
        let condition: unknown;
        const query = {
          from: (t: unknown) => { table = t; return query; },
          where: (c: unknown) => { condition = c; return query; },
          orderBy: () => query,
          limit: async () => rowsFor(table, paramsOf(condition)),
          then: (ok: (v: unknown[]) => unknown, ko?: (e: unknown) => unknown) =>
            Promise.resolve(rowsFor(table, paramsOf(condition))).then(ok, ko),
        };
        return query;
      },
      update: () => {
        let values: Record<string, unknown> = {};
        let condition: unknown;
        const query = {
          set: (v: Record<string, unknown>) => { values = v; return query; },
          where: (c: unknown) => { condition = c; return query; },
          returning: async () => {
            const params = paramsOf(condition);
            const row = ports.repairs.find((r) => params.includes(r.id) && r.status === "requested");
            if (!row) return [];
            Object.assign(row, { status: values.status });
            ports.escalations.push({ id: row.id, ...values });
            return [{ id: row.id }];
          },
        };
        return query;
      },
    },
  };
});
vi.mock("../artifact-review-gate-store", () => ({
  readReviewGate: async () => ports.gate,
}));
vi.mock("../lifecycle-produced-outbox-store", () => ({
  readProducedEvent: async () => ports.event,
}));
vi.mock("../lifecycle-repair-producer-registry", () => ({
  coreRepairsObjectType: () => false,
}));
vi.mock("../lifecycle-repair-store", () => ({
  recordChangesRequested: async (input: unknown) => {
    ports.recorded.push(input);
    return { ok: true, repairId: "repair-1", route: { kind: "producer_repair", continuationMode: "async_effects_gated" },
      attempt: 1, status: "requested", idempotent: false };
  },
  readRepair: async () => null,
  readRepairBySuccessorGateId: async () => null,
  markRepairDispatched: async (id: string) => {
    const row = ports.repairs.find((r) => r.id === id && r.status === "requested");
    if (!row) return false;
    row.status = "dispatched";
    ports.dispatched.push(id);
    return true;
  },
}));
vi.mock("../store", () => ({
  transitionRunStatus: async (...args: unknown[]) => {
    ports.transitions.push(args);
    if (ports.transitionFailure) {
      const failure = ports.transitionFailure;
      ports.transitionFailure = null;
      throw failure;
    }
    if (ports.run && ports.run.status === args[1]) ports.run.status = args[2] as string;
  },
}));
vi.mock("../lifecycle-coordinator", async () => {
  // The stop goes through the coordinator's release entry; this stand-in hands
  // the release to the store's compare-and-set exactly as the entry does.
  const store = await import("../store");
  return {
    launchAgentRun: async (args: unknown) => { ports.launched.push(args); },
    clearRunLifecycleMoment: async (...args: unknown[]) => { ports.cleared.push(args); },
    advanceAgentRun: async (input: {
      run: { id: string };
      release: { from: string; to: string; dispatch: { kind: string } };
      authority: unknown;
    }) => {
      ports.releases.push(input.release);
      await (store.transitionRunStatus as (...a: unknown[]) => Promise<void>)(
        input.run.id, input.release.from, input.release.to, undefined, input.authority);
    },
  };
});
vi.mock("../lifecycle-repair-cms-production-bridge", () => ({
  projectCmsRepairInputParams: async () => ({}),
}));
vi.mock("@/lib/org-write/agent-run-authority-mint", () => ({
  mintLifecycleRepairDispatchAuthority: (orgId: string) => ({ orgId, purpose: "agent-run-dispatch" }),
}));
vi.mock("@/lib/auth-session", () => ({ resolveOrgRoleForUser: async () => "member" }));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({ buildActorContextFromRun: async () => ({}) }));
vi.mock("@/lib/agent-run-enqueue", () => ({ enqueueAgentRun: async () => undefined }));

import * as crStore from "../lifecycle-review-changes-requested-store";
import { dispatchPendingProducerRepairs } from "../lifecycle-repair-dispatch-store";

const ORG = "org-4245";
const RUN = "run-paused-4245";
const TASK = "wayflow-review-step";
const GATE = "gate-declared-1";
const TARGET = { artifactId: "artifact-post", representationRevisionId: "revision-1" };

function arrangeEligible(): void {
  ports.gate = { id: GATE, runId: RUN, orgId: ORG, reviewTaskId: TASK, status: "pending", pinnedTargets: [TARGET] };
  ports.gates = [{ id: GATE, runId: RUN, orgId: ORG, reviewTaskId: TASK, status: "pending" }];
  ports.event = { eventId: "event-1", orgId: ORG, artifactId: TARGET.artifactId, representationRevisionId: TARGET.representationRevisionId,
    producerRunId: RUN, producerAgentId: null, continuationMode: "async_effects_gated", continuationAddress: GATE };
  // The run waits at the declared step's pause: its paused task is the gate's task.
  ports.run = { id: RUN, orgId: ORG, templateId: "template-producing", runBy: "human-member", status: "pending_approval",
    a2aTaskId: TASK.slice("wayflow-".length) };
  ports.repairCapable = true;
}

function comment(feedback = "  Shorten the second paragraph.  ", reviewTaskId = TASK) {
  return crStore.recordReviewSurfaceChangesRequested({
    runId: RUN,
    reviewTaskId,
    baseTarget: TARGET,
    currentBaseRevisionId: TARGET.representationRevisionId,
    feedback,
  });
}

function requestedRepair(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "repair-1", orgId: ORG, gateId: GATE, lineageId: GATE, attempt: 1, baseArtifactId: TARGET.artifactId,
    baseRepresentationRevisionId: TARGET.representationRevisionId, expectedBaseRevisionId: TARGET.representationRevisionId,
    producerRunId: RUN, route: "producer_repair", status: "requested", continuationMode: "async_effects_gated",
    continuationAddress: GATE, findings: [{ id: "prompt-window", message: "Shorten the second paragraph." }], ...over,
  };
}

beforeEach(() => {
  ports.gates = []; ports.run = null; ports.repairs = []; ports.event = null; ports.gate = null;
  ports.recorded = []; ports.transitions = []; ports.transitionFailure = null; ports.launched = []; ports.releases = [];
  ports.escalations = []; ports.dispatched = []; ports.repairCapable = true; ports.cleared = [];
});

describe("cinatra#4245 — a comment on a declared review gate files a change request", () => {
  it("the eligible case records exactly one change request on the gate, with the trimmed comment", async () => {
    arrangeEligible();
    const result = await comment();
    expect(result.ok).toBe(true);
    expect(ports.recorded).toHaveLength(1);
    expect(ports.recorded[0]).toMatchObject({
      runId: RUN, reviewTaskId: TASK, orgId: ORG, repairCapable: true, producerRunId: RUN,
      request: { gateId: GATE, continuationMode: "async_effects_gated", continuationAddress: GATE,
        findings: [{ id: "prompt-window", message: "Shorten the second paragraph." }] },
    });
  });

  it("names the declared prefix and the not-eligible refusal the review action reads", () => {
    expect(crStore.DECLARED_REVIEW_TASK_PREFIX).toBe("wayflow-");
    expect(crStore.DECLARED_GATE_NOT_ELIGIBLE).toBe("declared-gate-not-eligible");
  });

  it("an ineligible declared gate returns the not-eligible refusal", async () => {
    arrangeEligible();
    ports.event = { ...ports.event, continuationAddress: "another-gate" };
    const result = await comment();
    expect(result).toMatchObject({ ok: false, code: "declared-gate-not-eligible" });
  });

  describe("each ineligible case writes nothing", () => {
    it("an empty comment", async () => {
      arrangeEligible();
      expect((await comment("   ")).ok).toBe(false);
      expect(ports.recorded).toHaveLength(0);
    });
    it("a gate that pins two targets", async () => {
      arrangeEligible();
      ports.gate = { ...ports.gate, pinnedTargets: [TARGET, { artifactId: "artifact-page", representationRevisionId: "revision-2" }] };
      expect((await comment()).ok).toBe(false);
      expect(ports.recorded).toHaveLength(0);
    });
    it("a produced event not yet linked but already processed, or one the link would give another gate", async () => {
      arrangeEligible();
      ports.gates[0].pinnedTargets = [TARGET];
      ports.event = { ...ports.event, continuationAddress: null, status: "processed" };
      expect((await comment()).ok).toBe(false);
      ports.gates.unshift({ id: "gate-declared-older", runId: RUN, orgId: ORG, reviewTaskId: "wayflow-older-step",
        status: "resolved", pinnedTargets: [TARGET] });
      ports.event = { ...ports.event, status: "pending" };
      expect((await comment()).ok).toBe(false);
      expect(ports.recorded).toHaveLength(0);
    });
    it("no produced event names the gate", async () => {
      arrangeEligible();
      ports.event = { ...ports.event, continuationAddress: null };
      expect((await comment()).ok).toBe(false);
      expect(ports.recorded).toHaveLength(0);
    });
    it("the produced event names another producing run or organization", async () => {
      arrangeEligible();
      ports.event = { ...ports.event, producerRunId: "run-other" };
      expect((await comment()).ok).toBe(false);
      ports.event = { ...ports.event, producerRunId: RUN, orgId: "org-other" };
      expect((await comment()).ok).toBe(false);
      expect(ports.recorded).toHaveLength(0);
    });
    it("a checkpointed continuation, or a producer that cannot repair", async () => {
      arrangeEligible();
      ports.event = { ...ports.event, continuationMode: "checkpointed" };
      expect((await comment()).ok).toBe(false);
      arrangeEligible();
      ports.repairCapable = false;
      expect((await comment()).ok).toBe(false);
      expect(ports.recorded).toHaveLength(0);
    });
  });
});

describe("cinatra#4245 — review fold: race, families", () => {
  it("a comment before the produced event is linked files the change request on the gate the link will name", async () => {
    arrangeEligible();
    ports.gates[0].pinnedTargets = [TARGET];
    ports.event = { ...ports.event, continuationAddress: null, status: "pending" };
    const result = await comment();
    expect(result.ok).toBe(true);
    expect(ports.recorded).toHaveLength(1);
    expect(ports.recorded[0]).toMatchObject({ request: { gateId: GATE, continuationAddress: GATE } });
  });

  it("each gate of a per-artifact review step takes its own change request while a sibling gate is pending", async () => {
    arrangeEligible();
    ports.gates.push({ id: "gate-declared-2", runId: RUN, orgId: ORG, reviewTaskId: `${TASK}#2`, status: "pending" });
    const result = await comment();
    expect(result.ok).toBe(true);
    expect(ports.recorded).toHaveLength(1);
    expect(ports.recorded[0]).toMatchObject({ request: { gateId: GATE, continuationAddress: GATE } });
  });
});

describe("cinatra#4245 — review fold: the stop is bound to the pause, and the moment is cleared", () => {
  it("a run that went on and waits at a later declared review step is not stopped there", async () => {
    arrangeEligible();
    ports.gates = [
      { id: GATE, runId: RUN, orgId: ORG, reviewTaskId: TASK, status: "resolved", createdAt: new Date("2026-10-21T06:00:00Z") },
      { id: "gate-later", runId: RUN, orgId: ORG, reviewTaskId: "wayflow-later-step", status: "pending",
        createdAt: new Date("2026-10-21T06:05:00Z") },
    ];
    ports.repairs = [requestedRepair()];
    const summary = await dispatchPendingProducerRepairs();
    expect(ports.transitions).toHaveLength(0);
    expect(ports.run!.status).toBe("pending_approval");
    expect(summary).toMatchObject({ escalated: 1, dispatched: 0 });
    expect(ports.launched).toHaveLength(0);
  });

  it("the stopped run's lifecycle moment is cleared through the coordinator, on the stop and on a converging drain", async () => {
    arrangeEligible();
    ports.repairs = [requestedRepair()];
    await dispatchPendingProducerRepairs();
    expect(ports.cleared).toEqual([[RUN, { orgId: ORG, purpose: "agent-run-dispatch" }]]);

    ports.cleared = [];
    ports.repairs = [requestedRepair({ id: "repair-2" })];
    await dispatchPendingProducerRepairs();
    expect(ports.run!.status).toBe("stopped");
    expect(ports.cleared).toEqual([[RUN, { orgId: ORG, purpose: "agent-run-dispatch" }]]);
  });
});

describe("cinatra#4245 — the repair drain stops the paused run before the repair run", () => {
  it("moves the paused run from pending_approval to stopped, then starts the repair run", async () => {
    arrangeEligible();
    ports.repairs = [requestedRepair()];
    const summary = await dispatchPendingProducerRepairs();
    expect(ports.transitions).toEqual([[RUN, "pending_approval", "stopped", undefined, { orgId: ORG, purpose: "agent-run-dispatch" }]]);
    expect(ports.releases).toEqual([{ reason: "changes_requested", from: "pending_approval", to: "stopped",
      dispatch: expect.objectContaining({ kind: "caller_dispatches" }), onLostRace: "throw" }]);
    expect(ports.run!.status).toBe("stopped");
    expect(summary).toMatchObject({ dispatched: 1, failed: 0, escalated: 0 });
    expect(ports.launched).toHaveLength(1);
  });

  it("a failure between the gate's commit and the status change still ends stopped on the next drain, with one repair run", async () => {
    arrangeEligible();
    ports.repairs = [requestedRepair()];
    ports.transitionFailure = new Error("connection lost");
    const first = await dispatchPendingProducerRepairs();
    expect(first).toMatchObject({ failed: 1, dispatched: 0 });
    expect(ports.launched).toHaveLength(0);
    expect(ports.run!.status).toBe("pending_approval");

    const second = await dispatchPendingProducerRepairs();
    expect(second).toMatchObject({ failed: 0, dispatched: 1 });
    expect(ports.run!.status).toBe("stopped");
    expect(ports.launched).toHaveLength(1);
    expect(ports.transitions).toHaveLength(2);
  });

  it("a second drain after the stop changes the status no more (idempotent)", async () => {
    arrangeEligible();
    ports.run!.status = "stopped";
    ports.repairs = [requestedRepair()];
    const summary = await dispatchPendingProducerRepairs();
    expect(ports.transitions).toHaveLength(0);
    expect(summary).toMatchObject({ dispatched: 1 });
    expect(await dispatchPendingProducerRepairs()).toMatchObject({ scanned: 0, dispatched: 0 });
  });

  it("a run that left its review step is escalated, never repaired", async () => {
    arrangeEligible();
    ports.run!.status = "running";
    ports.run!.a2aTaskId = "a-later-task";
    ports.repairs = [requestedRepair()];
    const summary = await dispatchPendingProducerRepairs();
    expect(summary).toMatchObject({ escalated: 1, dispatched: 0 });
    expect(ports.launched).toHaveLength(0);
    expect(ports.transitions).toHaveLength(0);
  });

  it("a run that reads running AT its review step is a claim being given back: the repair waits, nothing escalates", async () => {
    arrangeEligible();
    ports.run!.status = "running";
    ports.repairs = [requestedRepair()];
    const summary = await dispatchPendingProducerRepairs();
    expect(summary).toMatchObject({ raced: 1, escalated: 0, dispatched: 0 });
    expect(ports.launched).toHaveLength(0);
    expect(ports.transitions).toHaveLength(0);
  });

  it("a repair on a lifecycle review gate keeps its road: no stop", async () => {
    arrangeEligible();
    ports.gates = [{ id: GATE, runId: RUN, orgId: ORG, reviewTaskId: "lifecycle-review:event-1", status: "resolved" }];
    ports.repairs = [requestedRepair()];
    const summary = await dispatchPendingProducerRepairs();
    expect(ports.transitions).toHaveLength(0);
    expect(ports.run!.status).toBe("pending_approval");
    expect(summary).toMatchObject({ dispatched: 1 });
  });
});
