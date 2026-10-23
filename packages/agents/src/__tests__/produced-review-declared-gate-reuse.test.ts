import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { producedEventId } from "@/lib/lifecycle/lifecycle-produced-event";
import { autoReviewTaskId, isAutoReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";

// cinatra#4225 — the produced path must not open an automatic review gate over a
// revision a template-declared (`wayflow-*`) gate of the same run already pins.
// The defect: a declared `wayflow-…` gate and an automatic `lifecycle-review:…` gate
// pinned one revision; after the declared gate's Approve the run parked on the automatic one.

type Target = { artifactId: string; representationRevisionId: string };
type Event = Target & {
  eventId: string;
  orgId: string;
  emitter: string;
  producerRunId: string | null;
  producerAgentId: string | null;
  originKind: string;
  destinationClass: "none" | "external_publish";
  continuationMode: string;
  continuationAddress: string | null;
  status: string;
};
type Gate = {
  runId: string;
  orgId: string;
  reviewTaskId: string;
  targets: Target[];
  gateId: string;
  status?: "pending" | "resolved";
  disposition?: "approve" | "reject" | "changes_requested" | null;
};
type GateInput = { runId: string; orgId: string; reviewTaskId: string; targets: Target[] };

const state = vi.hoisted(() => ({
  events: [] as Event[],
  gates: new Map<string, Gate>(),
  epoch: null as { id: string; membership: Target[] } | null,
  phase: [] as string[],
}));

function params(where: SQL | undefined): unknown[] {
  return where ? new PgDialect().sqlToQuery(where).params : [];
}

const dbFake = {
  select(columns: Record<string, unknown>) {
    let where: SQL | undefined;
    const rows = (): unknown[] => {
      const keys = Object.keys(columns);
      const values = params(where);
      const gates = [...state.gates.values()];
      // The sweep's production keys (orgId, producerRunId), grouped.
      if (keys.length === 2 && keys.includes("orgId") && keys.includes("producerRunId")) {
        const seen = new Map<string, { orgId: string; producerRunId: string | null }>();
        for (const e of state.events) {
          if (e.status === "pending" && e.producerRunId) seen.set(`${e.orgId}/${e.producerRunId}`, { orgId: e.orgId, producerRunId: e.producerRunId });
        }
        return [...seen.values()];
      }
      // The run's gates, read by the declared-gate match (run + org).
      if (keys.includes("reviewTaskId") && keys.includes("pinnedTargets")) {
        return gates
          .filter(g => values.includes(g.runId) && values.includes(g.orgId))
          .map(g => ({ id: g.gateId, orgId: g.orgId, reviewTaskId: g.reviewTaskId, status: g.status ?? "pending", pinnedTargets: g.targets }));
      }
      // cinatra#4245: the event's own row, read under its lock before a gate is emitted.
      if (keys.includes("continuationAddress") && keys.includes("representationRevisionId") && !keys.includes("eventId")) {
        return state.events.filter(e => values.includes(e.eventId));
      }
      if (keys.includes("emitter")) return state.events.filter(e => e.status === "pending" && (e.producerRunId === null || values.includes(e.producerRunId)));
      if (keys.includes("destinationClass")) return state.events.filter(e => values.includes(e.eventId));
      if (keys.includes("eventId")) return state.events.filter(e => (values.includes("pending") ? e.status === "pending" : true) && values.includes(e.orgId) && values.includes(e.producerRunId));
      if (keys.includes("gateId") && keys.includes("status")) return gates.filter(g => values.includes(g.gateId) && values.includes(g.orgId)).map(g => ({ gateId: g.gateId, status: g.status ?? "pending", disposition: g.disposition ?? null }));
      if (keys.includes("gateId")) return state.events.filter(e => e.continuationAddress !== null && values.includes(e.orgId) && values.includes(e.producerRunId)).map(e => ({ gateId: e.continuationAddress }));
      if (keys.includes("id") && keys.includes("runId")) return gates.filter(g => values.includes(g.gateId)).map(g => ({ id: g.gateId, runId: g.runId, status: g.status ?? "pending", disposition: g.disposition ?? null }));
      // isArtifactEffectHeld's gate read (status + disposition by id).
      if (keys.length === 2 && keys.includes("status") && keys.includes("disposition")) return gates.filter(g => values.includes(g.gateId)).map(g => ({ status: g.status ?? "pending", disposition: g.disposition ?? null }));
      if (keys.includes("pending")) return [{ pending: state.events.filter(e => e.status === "pending" && values.includes(e.eventId)).length }];
      if (keys.includes("templateId")) return [{ templateId: "template", packageVersion: "1.0.0" }];
      if (keys.includes("hasArtifactBindings")) return [{ lifecycleConfig: null, hasArtifactBindings: true, packageVersion: "1.0.0" }];
      if (keys.includes("path")) return [{ path: "end_node_binding" }];
      if (keys.includes("type")) return keys.includes("id")
        ? state.events.map(e => ({ id: e.artifactId, type: "artifact-blog-post-body" }))
        : [{ type: "artifact-blog-post-body", deletedAt: null }];
      return [];
    };
    const chain = {
      from: () => chain,
      where(condition: SQL) { where = condition; return chain; },
      orderBy: () => chain,
      for: () => chain,
      groupBy: () => chain,
      async limit(cap: number) { return rows().slice(0, cap); },
      then(resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) {
        return Promise.resolve(rows()).then(resolve, reject);
      },
    };
    return chain;
  },
  update() {
    return {
      set(update: { continuationAddress: string }) {
        return {
          async where(condition: SQL) {
            state.phase.push(`link:${update.continuationAddress}`);
            const ids = params(condition);
            for (const e of state.events) {
              if (ids.includes(e.eventId) && e.continuationAddress === null) e.continuationAddress = update.continuationAddress;
            }
          },
        };
      },
    };
  },
};

vi.mock("../db", () => ({
  db: {
    select: (columns: Record<string, unknown>) => dbFake.select(columns),
    update: () => dbFake.update(),
    // cinatra#4245: the link decision runs in a transaction on the event row.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      select: (columns: Record<string, unknown>) => dbFake.select(columns),
      update: () => dbFake.update(),
    }),
  },
  agentBuilderPool: {
    connect: async () => ({
      query: async () => ({ rows: [{ locked: true }] }),
      release: () => undefined,
    }),
  },
}));

const emit = vi.fn(async (input: GateInput) => {
  state.phase.push(`emit:${input.reviewTaskId}`);
  const key = `${input.runId}/${input.reviewTaskId}`;
  const old = state.gates.get(key);
  if (old) return { gateId: old.gateId, idempotent: true };
  const gateId = `auto-${state.gates.size + 1}`;
  state.gates.set(key, { ...input, gateId });
  return { gateId, idempotent: false };
});
vi.mock("../artifact-review-gate-store", () => ({
  emitArtifactReviewGate: (input: GateInput) => emit(input),
  readReviewGate: vi.fn(async (runId: string, reviewTaskId: string) => {
    const gate = state.gates.get(`${runId}/${reviewTaskId}`);
    return gate ? { ...gate, id: gate.gateId, status: gate.status ?? "pending", pinnedTargets: gate.targets } : null;
  }),
  ArtifactReviewGateError: class extends Error {},
}));
vi.mock("../lifecycle-produced-outbox-store", () => ({
  markProducedEventProcessed: vi.fn(async (eventId: string) => {
    state.phase.push(`mark:${eventId}`);
    const e = state.events.find(x => x.eventId === eventId);
    if (e) e.status = "processed";
  }),
}));
vi.mock("../lifecycle-policy-store", () => ({ resolveOrgPolicyRule: vi.fn(async () => ({ bound: "silent" })) }));
const park = vi.fn(async (_plan: unknown, bind: { eventId: string; policyDecisionId: string }) => {
  state.phase.push(`park:${bind.policyDecisionId}:${bind.eventId}`);
});
vi.mock("../lifecycle-continuation-park-store", () => ({
  maybeParkCheckpoint: (plan: unknown, bind: { eventId: string; policyDecisionId: string }) => park(plan, bind),
  sweepParks: vi.fn(),
}));
const notify = vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined);
// Partial: the executor's import graph reads the notifier leaf's real exports at
// module initialization (RECOMMENDATION_HOLD_CHECKPOINT, setRunWaitNotifier).
vi.mock("../run-wait-notifier", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  dispatchAutoGateOpen: (input: unknown) => notify(input),
  dispatchAutoGateResolved: vi.fn(),
}));
const suggest = vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined);
vi.mock("../lifecycle-suggestion-producer-lane", () => ({ produceSuggestionsForGateTargets: (input: unknown) => suggest(input) }));
const seal = vi.fn(async (input: { candidateMembers: Target[] }) => {
  const reused = state.epoch !== null;
  state.epoch ??= { id: "epoch", membership: input.candidateMembers };
  state.phase.push("seal");
  return { epoch: state.epoch, reused };
});
vi.mock("../lifecycle-repair-store", () => ({
  readRepair: vi.fn(async () => null),
  resolveOpenBatchEpoch: vi.fn(async () => state.epoch),
  sealBatchEpoch: (input: { candidateMembers: Target[] }) => seal(input),
  closeBatchEpoch: vi.fn(async () => { state.epoch = null; }),
  listOpenBatchEpochs: vi.fn(async () => []),
}));
vi.mock("../lifecycle-repair-dispatch-store", () => ({ repairIdFromRunId: () => null, dispatchPendingProducerRepairs: vi.fn() }));
const transition = vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined);
vi.mock("../run-transition", () => ({
  transitionRunStatus: (...args: unknown[]) => transition(...args),
  updateAgentRunStatus: vi.fn(),
  updateAgentRunStatusConditional: vi.fn(),
}));
// The executor's terminal announcement and its autosave sidecar (item 5 reads the
// terminal write the executor itself makes once nothing holds the run).
const publish = vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined);
vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  publishAgUiEvent: (...args: unknown[]) => publish(...args),
}));
vi.mock("../skill-autosave", () => ({ runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined) }));

import {
  drainProducedProductionForRun,
  isArtifactEffectHeld,
  orchestrateProducedEvent,
  resolveArtifactEffectDisposition,
  sweepReviewOrchestration,
} from "../lifecycle-review-orchestration-store";
import { holdRunForProducedReview } from "../run-produced-review-hold";
import { recoverProducedReviewHold } from "../execution";

function event(artifactId: string, revision = "r1", destinationClass: Event["destinationClass"] = "none"): Event {
  return {
    artifactId,
    representationRevisionId: revision,
    eventId: producedEventId(artifactId, revision, "artifact_produced"),
    orgId: "org",
    emitter: "agent",
    producerRunId: "run",
    producerAgentId: "template",
    originKind: "agent_produced",
    destinationClass,
    continuationMode: "checkpointed",
    continuationAddress: null,
    status: "pending",
  };
}
const pair = (e: Event): Target => ({ artifactId: e.artifactId, representationRevisionId: e.representationRevisionId });

/** Seed a template-declared gate the way execution.ts mints one (`wayflow-<taskId>`). */
function declare(targets: Target[], opts: Partial<Gate> = {}): Gate {
  const reviewTaskId = opts.reviewTaskId ?? "wayflow-task-1";
  const gate: Gate = {
    runId: "run", orgId: "org", reviewTaskId, targets,
    gateId: opts.gateId ?? `declared-${state.gates.size + 1}`,
    status: "pending", disposition: null, ...opts,
  };
  state.gates.set(`${gate.runId}/${reviewTaskId}`, gate);
  return gate;
}
const autoGates = () => [...state.gates.values()].filter(g => isAutoReviewTaskId(g.reviewTaskId));

beforeEach(() => {
  vi.clearAllMocks();
  state.events = []; state.gates.clear(); state.epoch = null; state.phase = [];
});

describe("a declared gate that pins the revision is reused (cinatra#4225)", () => {
  it.each([
    { status: "pending" as const, disposition: null },
    { status: "resolved" as const, disposition: "approve" as const },
  ])("a $status declared gate: the event links to it, is processed and returns gate-reused", async ({ status, disposition }) => {
    const e = event("post"); state.events = [e];
    const declared = declare([pair(e)], { status, disposition });
    expect(await orchestrateProducedEvent(e)).toBe("gate-reused");
    expect(e.continuationAddress).toBe(declared.gateId);
    expect(e.status).toBe("processed");
    expect(emit).not.toHaveBeenCalled();
    expect(autoGates()).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    expect(suggest).not.toHaveBeenCalled();
    // The automatic road's order, on the declared gate: park -> link -> mark.
    const p = state.phase;
    expect(p.indexOf(`park:${declared.gateId}:${e.eventId}`)).toBeGreaterThanOrEqual(0);
    expect(p.indexOf(`park:${declared.gateId}:${e.eventId}`)).toBeLessThan(p.indexOf(`link:${declared.gateId}`));
    expect(p.indexOf(`link:${declared.gateId}`)).toBeLessThan(p.indexOf(`mark:${e.eventId}`));
  });

  it("a per-artifact leg (`wayflow-<id>#N`) that pins the revision among others is reused", async () => {
    const e = event("post"); state.events = [e];
    const declared = declare([{ artifactId: "other", representationRevisionId: "r9" }, pair(e)], { reviewTaskId: "wayflow-task-1#2" });
    expect(await orchestrateProducedEvent(e)).toBe("gate-reused");
    expect(e.continuationAddress).toBe(declared.gateId);
    expect(e.status).toBe("processed");
    expect(emit).not.toHaveBeenCalled();
    expect(autoGates()).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    expect(suggest).not.toHaveBeenCalled();
    // The automatic road's order, on the per-artifact leg: park -> link -> mark.
    const p = state.phase;
    expect(p.indexOf(`park:${declared.gateId}:${e.eventId}`)).toBeGreaterThanOrEqual(0);
    expect(p.indexOf(`park:${declared.gateId}:${e.eventId}`)).toBeLessThan(p.indexOf(`link:${declared.gateId}`));
    expect(p.indexOf(`link:${declared.gateId}`)).toBeLessThan(p.indexOf(`mark:${e.eventId}`));
  });
});

describe("an effect linked through a reused declared gate is held exactly like one through an automatic gate", () => {
  it("held while the gate is pending, released once it resolves", async () => {
    const viaDeclared = event("declared-post", "r1", "external_publish");
    const viaAuto = event("auto-post", "r1", "external_publish");
    state.events = [viaDeclared, viaAuto];
    const declared = declare([pair(viaDeclared)]);
    expect(await orchestrateProducedEvent(viaDeclared)).toBe("gate-reused");
    expect(await orchestrateProducedEvent(viaAuto)).toBe("gate-created");
    const auto = state.gates.get(`run/${autoReviewTaskId(viaAuto.eventId)}`)!;
    expect(viaDeclared.continuationAddress).toBe(declared.gateId);
    expect(viaAuto.continuationAddress).toBe(auto.gateId);

    const pendingDeclared = await isArtifactEffectHeld(viaDeclared);
    expect(pendingDeclared.held).toBe(true);
    expect(pendingDeclared).toEqual(await isArtifactEffectHeld(viaAuto));
    expect(await resolveArtifactEffectDisposition(viaDeclared)).toMatchObject({ disposition: "held", gate: { gateId: declared.gateId } });
    expect(await resolveArtifactEffectDisposition(viaAuto)).toMatchObject({ disposition: "held", gate: { gateId: auto.gateId } });

    for (const g of [declared, auto]) { g.status = "resolved"; g.disposition = "approve"; }
    const resolvedDeclared = await isArtifactEffectHeld(viaDeclared);
    expect(resolvedDeclared.held).toBe(false);
    expect(resolvedDeclared).toEqual(await isArtifactEffectHeld(viaAuto));
    expect(await resolveArtifactEffectDisposition(viaDeclared)).toMatchObject({ disposition: "approved", gate: { gateId: declared.gateId } });
    expect(await resolveArtifactEffectDisposition(viaAuto)).toMatchObject({ disposition: "approved", gate: { gateId: auto.gateId } });
  });
});

describe("a revision no declared gate pins opens the automatic gate exactly as today", () => {
  it.each([
    { name: "no declared gate at all", seed: () => undefined },
    { name: "a declared gate on another revision of the same artifact", seed: (e: Event) => { declare([{ ...pair(e), representationRevisionId: "r0" }]); } },
    { name: "a declared gate on another artifact", seed: () => { declare([{ artifactId: "other", representationRevisionId: "r1" }]); } },
    { name: "a same-run gate of another organization", seed: (e: Event) => { declare([pair(e)], { orgId: "other-org" }); } },
    { name: "a same-run gate whose task is not a declared one", seed: (e: Event) => { declare([pair(e)], { reviewTaskId: "manual-task-1" }); } },
  ])("$name -> gate-created", async ({ seed }) => {
    const e = event("post"); state.events = [e];
    seed(e);
    expect(await orchestrateProducedEvent(e)).toBe("gate-created");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run", orgId: "org", reviewTaskId: autoReviewTaskId(e.eventId), targets: [pair(e)],
    }));
    const auto = state.gates.get(`run/${autoReviewTaskId(e.eventId)}`)!;
    expect(e.continuationAddress).toBe(auto.gateId);
    expect(e.status).toBe("processed");
    expect(notify).toHaveBeenCalledWith({ runId: "run", reviewTaskId: autoReviewTaskId(e.eventId) });
  });
});

describe("the batch path (sweepReviewOrchestration) keeps a declared pair out of the epoch", () => {
  it("one declared pair and two unmatched pairs: the declared pair links to its gate, two singleton auto gates pin the rest", async () => {
    const d = event("declared"), u1 = event("u1"), u2 = event("u2");
    state.events = [d, u1, u2];
    const declared = declare([pair(d)]);
    const summary = await sweepReviewOrchestration();
    expect(summary.failed).toBe(0);
    expect(d.continuationAddress).toBe(declared.gateId);
    expect(d.status).toBe("processed");
    expect(seal).toHaveBeenCalledTimes(1);
    const candidates = seal.mock.calls[0][0].candidateMembers;
    expect(candidates).toEqual([pair(u1), pair(u2)]);
    expect(candidates).not.toContainEqual(pair(d));
    const autos = autoGates();
    expect(autos).toHaveLength(2);
    expect(autos.map(g => g.targets)).toEqual(expect.arrayContaining([[pair(u1)], [pair(u2)]]));
    expect(summary.gatesCreated).toBe(2);
    for (const u of [u1, u2]) {
      expect(u.continuationAddress).toBe(state.gates.get(`run/${autoReviewTaskId(u.eventId)}`)!.gateId);
      expect(u.status).toBe("processed");
    }

    // An epoch sealed by an earlier pass (a crash before its close) whose frozen
    // membership holds a pair a declared gate now pins. Mixed membership: the
    // declared member has no fired plan, so its partition opens no gate; the
    // other member still gets its own automatic gate and the epoch closes.
    vi.clearAllMocks();
    state.gates.clear(); state.phase = [];
    const d2 = event("declared-2"), u3 = event("u3");
    state.events = [d2, u3];
    const declared2 = declare([pair(d2)]);
    state.epoch = { id: "epoch-earlier", membership: [pair(d2), pair(u3)] };
    const recovered = await sweepReviewOrchestration();
    expect(recovered.failed).toBe(0);
    expect(seal).toHaveBeenCalledTimes(1);
    await expect(seal.mock.results[0].value).resolves.toMatchObject({ reused: true, epoch: { id: "epoch-earlier" } });
    expect(d2.continuationAddress).toBe(declared2.gateId);
    expect(d2.status).toBe("processed");
    expect(autoGates().map(g => g.targets)).toEqual([[pair(u3)]]);
    expect(u3.continuationAddress).toBe(state.gates.get(`run/${autoReviewTaskId(u3.eventId)}`)!.gateId);
    expect(u3.status).toBe("processed");
    expect(state.epoch).toBeNull();

    // The same earlier epoch holding only the declared pair: nothing fires, no
    // seal and no emit; the event links to the declared gate and the epoch closes.
    vi.clearAllMocks();
    state.gates.clear(); state.phase = [];
    const d3 = event("declared-3");
    state.events = [d3];
    const declared3 = declare([pair(d3)]);
    state.epoch = { id: "epoch-earlier-2", membership: [pair(d3)] };
    const drained = await sweepReviewOrchestration();
    expect(drained.failed).toBe(0);
    expect(seal).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(autoGates()).toHaveLength(0);
    expect(d3.continuationAddress).toBe(declared3.gateId);
    expect(d3.status).toBe("processed");
    expect(state.epoch).toBeNull();
  });
});

describe("a run whose declared gate is approved finishes with no automatic gate", () => {
  it("the terminal hold reads no review and the run is not parked", async () => {
    const e = event("post"); state.events = [e];
    declare([pair(e)], { status: "resolved", disposition: "approve" });
    const outcome = await holdRunForProducedReview({
      runId: "run",
      orgId: "org",
      fromStatus: "running",
      stepResults: [{ type: "wayflow_response" }],
      withheld: { status: "completed" },
      drain: async (i) => { await drainProducedProductionForRun(i); },
    }, undefined);
    // Not held: the executor writes its terminal status unchanged (the NOT-HELD
    // edge is execution-review-precedes-terminal.test.ts).
    expect(outcome).toEqual({ held: false, reason: "no-review" });
    expect(autoGates()).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();

    // The terminal status itself: the executor asks the same hold again and, as
    // nothing holds the run, makes the withheld `completed` write (execution.ts,
    // recoverProducedReviewHold). Still no `lifecycle-review:` gate after it.
    await recoverProducedReviewHold({
      runId: "run",
      run: { orgId: "org", status: "running" },
      recovery: { withheld: { status: "completed" }, stepResults: [{ type: "wayflow_response" }] },
      authority: undefined,
    });
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition.mock.calls[0].slice(0, 3)).toEqual(["run", "running", "completed"]);
    expect(publish).toHaveBeenCalledWith("run", expect.objectContaining({ type: "RUN_FINISHED", status: "completed" }));
    expect(autoGates()).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });
});
