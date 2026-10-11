import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { producedEventId } from "@/lib/lifecycle/lifecycle-produced-event";
import { autoReviewTaskId, batchPartitionReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";

type Target = { artifactId: string; representationRevisionId: string };
type Event = Target & {
  eventId: string; orgId: string; producerRunId: string;
  continuationAddress: string | null; status: string; destinationClass: "none" | "external_publish";
};
type GateInput = { runId: string; orgId: string; reviewTaskId: string; targets: Target[] };

const state = vi.hoisted(() => ({
  events: [] as Event[],
  gates: new Map<string, GateInput & { gateId: string; status?: "pending" | "resolved"; disposition?: "approve" | "reject" | "changes_requested" | null }>(),
  epoch: null as { id: string; membership: Target[] } | null,
  failLinkOnce: false,
  phase: [] as string[],
  policy: "silent" as "silent" | "forbidden",
}));

function params(where: SQL | undefined): unknown[] {
  return where ? new PgDialect().sqlToQuery(where).params : [];
}

const dbFake = {
  select(columns: Record<string, unknown>) {
    let where: SQL | undefined;
    const rows = () => {
      const keys = Object.keys(columns);
      const values = params(where);
      if (keys.includes("emitter")) return state.events.filter(e => e.status === "pending");
      if (keys.includes("destinationClass")) return state.events.filter(e => values.includes(e.eventId));
      if (keys.includes("eventId")) return state.events.filter(e => e.status === "pending" && values.includes(e.orgId) && values.includes(e.producerRunId));
      if (keys.includes("gateId") && keys.includes("status")) return [...state.gates.values()].filter(g => values.includes(g.gateId) && values.includes(g.orgId)).map(g => ({ gateId: g.gateId, status: g.status ?? "pending", disposition: g.disposition ?? null }));
      if (keys.includes("gateId")) return state.events.filter(e => e.continuationAddress !== null && values.includes(e.orgId) && values.includes(e.producerRunId)).map(e => ({ gateId: e.continuationAddress }));
      if (keys.includes("id") && keys.includes("runId")) return [...state.gates.values()].filter(g => values.includes(g.gateId)).map(g => ({ id: g.gateId, runId: g.runId, status: g.status ?? "pending", disposition: g.disposition ?? null }));
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
            if (state.failLinkOnce) { state.failLinkOnce = false; throw new Error("interrupted before link"); }
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

vi.mock("../db", () => ({ db: {
  select: (columns: Record<string, unknown>) => dbFake.select(columns),
  update: () => dbFake.update(),
}, agentBuilderPool: {} }));

const emit = vi.fn(async (input: GateInput) => {
  state.phase.push(`emit:${input.reviewTaskId}`);
  const key = `${input.runId}/${input.reviewTaskId}`;
  const old = state.gates.get(key);
  if (old) return { gateId: old.gateId, idempotent: true };
  const gateId = `gate-${state.gates.size + 1}`;
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
    const e = state.events.find(e => e.eventId === eventId);
    if (e) e.status = "processed";
  }),
}));
vi.mock("../lifecycle-policy-store", () => ({ resolveOrgPolicyRule: vi.fn(async () => ({ bound: state.policy })) }));
const park = vi.fn(async (_plan: unknown, bind: { eventId: string; policyDecisionId: string }) => {
  state.phase.push(`park:${bind.policyDecisionId}:${bind.eventId}`);
});
vi.mock("../lifecycle-continuation-park-store", () => ({
  maybeParkCheckpoint: (plan: unknown, bind: { eventId: string; policyDecisionId: string }) => park(plan, bind),
  sweepParks: vi.fn(),
}));
const notify = vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined);
vi.mock("../run-wait-notifier", () => ({ dispatchAutoGateOpen: (input: unknown) => notify(input), dispatchAutoGateResolved: vi.fn() }));
const suggest = vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined);
vi.mock("../lifecycle-suggestion-producer-lane", () => ({ produceSuggestionsForGateTargets: (input: unknown) => suggest(input) }));
const closeEpoch = vi.fn(async () => { state.phase.push("close"); state.epoch = null; });
vi.mock("../lifecycle-repair-store", () => ({
  readRepair: vi.fn(async () => null),
  resolveOpenBatchEpoch: vi.fn(async () => state.epoch),
  sealBatchEpoch: vi.fn(async (input: { candidateMembers: Target[] }) => {
    const reused = state.epoch !== null;
    state.epoch ??= { id: "epoch", membership: input.candidateMembers };
    state.phase.push("seal");
    return { epoch: state.epoch, reused };
  }),
  closeBatchEpoch: () => closeEpoch(),
  listOpenBatchEpochs: vi.fn(async () => []),
}));
vi.mock("../lifecycle-repair-dispatch-store", () => ({ repairIdFromRunId: () => null, dispatchPendingProducerRepairs: vi.fn() }));

vi.mock("../run-transition", () => ({ transitionRunStatus: vi.fn() }));

import { drainProducedProductionForRun, resolveArtifactEffectDisposition } from "../lifecycle-review-orchestration-store";
import { resolveProducedReviewHold, resolveProducedReviewDecision } from "../run-produced-review-hold";

function event(artifactId: string, revision = "r1"): Event {
  return {
    artifactId, representationRevisionId: revision,
    eventId: producedEventId(artifactId, revision, "artifact_produced"),
    orgId: "org", producerRunId: "run", continuationAddress: null, status: "pending",
    ...{ eventKind: "artifact_produced", emitter: "agent", producerAgentId: "template", originKind: "agent_produced", destinationClass: "none", continuationMode: "checkpointed", createdAt: new Date("2026-01-01"), processedAt: null },
  };
}
const drain = () => drainProducedProductionForRun({ orgId: "org", runId: "run" });

beforeEach(() => {
  vi.clearAllMocks(); state.events = []; state.gates.clear(); state.epoch = null;
  state.failLinkOnce = false; state.phase = []; state.policy = "silent";
});

describe("a sealed production opens one gate per artifact revision", () => {
  it.each([2, 55])("%i artifacts open individual pinned gates, never a combined gate", async count => {
    state.events = Array.from({ length: count }, (_, i) => event(`artifact-${i}`));
    const result = await drain();
    expect(result.gatesCreated).toBe(count);
    expect(state.gates.size).toBe(count);
    for (const e of state.events) {
      const gate = state.gates.get(`run/${autoReviewTaskId(e.eventId)}`);
      expect(gate?.targets).toEqual([{ artifactId: e.artifactId, representationRevisionId: e.representationRevisionId }]);
      expect(e.continuationAddress).toBe(gate?.gateId);
      expect(e.status).toBe("processed");
      const phases = state.phase;
      expect(phases.indexOf(`park:${gate!.gateId}:${e.eventId}`)).toBeGreaterThanOrEqual(0);
      expect(phases.indexOf(`park:${gate!.gateId}:${e.eventId}`)).toBeLessThan(phases.indexOf(`link:${gate!.gateId}`));
      expect(phases.indexOf(`link:${gate!.gateId}`)).toBeLessThan(phases.indexOf(`mark:${e.eventId}`));
      expect(notify).toHaveBeenCalledWith({ runId: "run", reviewTaskId: autoReviewTaskId(e.eventId) });
      expect(suggest).toHaveBeenCalledWith({
        gateId: gate!.gateId, orgId: "org",
        targets: [{ target: gate!.targets[0], kind: "artifact-blog-post-body" }],
      });
    }
    expect(notify).toHaveBeenCalledTimes(count);
    expect(suggest).toHaveBeenCalledTimes(count);
    expect(closeEpoch).toHaveBeenCalledTimes(1);
  });

  it("separates revisions of the same artifact rather than selecting one", async () => {
    state.events = [event("post", "r1"), event("post", "r2")];
    await drain();
    expect([...state.gates.values()].map(g => g.targets)).toEqual(expect.arrayContaining([
      [{ artifactId: "post", representationRevisionId: "r1" }],
      [{ artifactId: "post", representationRevisionId: "r2" }],
    ]));
  });

  it("a create-to-link interruption plus a new sibling retries the same individual gate", async () => {
    const first = event("a"); state.events = [first]; state.failLinkOnce = true;
    await expect(drain()).rejects.toThrow("interrupted before link");
    expect(first.status).toBe("pending");
    state.events.push(event("b"));
    await drain();
    expect(state.gates.size).toBe(2);
    expect(new Set(state.events.map(e => e.continuationAddress)).size).toBe(2);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(suggest).toHaveBeenCalledTimes(2);
  });

  it("a frozen epoch resumes its remaining member and leaves a newly arrived revision for a successor", async () => {
    const a = event("a"), b = event("b");
    state.events = [a, b]; state.failLinkOnce = true;
    await expect(drain()).rejects.toThrow("interrupted before link");
    const c = event("c"); state.events.push(c);
    await drain();
    expect(state.gates.size).toBe(2);
    expect(c.status).toBe("pending");
    await drain();
    expect(state.gates.size).toBe(3);
    expect(c.status).toBe("processed");
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("a forbidden production creates no gates and settles every event", async () => {
    state.policy = "forbidden"; state.events = [event("a"), event("b")];
    const result = await drain();
    expect(result.noGate).toBe(2);
    expect(emit).not.toHaveBeenCalled(); expect(park).not.toHaveBeenCalled();
    expect(state.events.every(e => e.status === "processed")).toBe(true);
  });

  it("a singleton approval releases only its own effect; the producing run still waits for its sibling", async () => {
    const a = event("a"), b = event("b");
    a.destinationClass = b.destinationClass = "external_publish";
    state.events = [a, b]; await drain();
    const gateA = [...state.gates.values()].find(g => g.gateId === a.continuationAddress)!;
    const gateB = [...state.gates.values()].find(g => g.gateId === b.continuationAddress)!;
    expect(gateA.gateId).not.toBe(gateB.gateId);
    expect(await resolveArtifactEffectDisposition(a)).toMatchObject({ disposition: "held", gate: { gateId: gateA.gateId } });
    expect(await resolveArtifactEffectDisposition(b)).toMatchObject({ disposition: "held", gate: { gateId: gateB.gateId } });
    gateA.status = "resolved"; gateA.disposition = "approve";
    expect(await resolveArtifactEffectDisposition(a)).toMatchObject({ disposition: "approved", gate: { gateId: gateA.gateId } });
    expect(await resolveArtifactEffectDisposition(b)).toMatchObject({ disposition: "held", gate: { gateId: gateB.gateId } });
    expect(await resolveProducedReviewHold("org", "run")).toEqual({ held: true, reason: "gate-undecided", gateIds: [gateB.gateId] });
    gateB.status = "resolved"; gateB.disposition = "reject";
    expect(await resolveArtifactEffectDisposition(b)).toMatchObject({ disposition: "rejected", gate: { gateId: gateB.gateId } });
    expect(await resolveArtifactEffectDisposition(a)).toMatchObject({ disposition: "approved", gate: { gateId: gateA.gateId } });
    expect(await resolveProducedReviewDecision("org", "run")).toEqual({ decided: true, rejected: true });
  });

  it("a changes-requested sibling retains its own held effect without changing the approved sibling", async () => {
    const a = event("a"), b = event("b");
    a.destinationClass = b.destinationClass = "external_publish";
    state.events = [a, b]; await drain();
    const gateA = [...state.gates.values()].find(g => g.gateId === a.continuationAddress)!;
    const gateB = [...state.gates.values()].find(g => g.gateId === b.continuationAddress)!;
    gateA.status = "resolved"; gateA.disposition = "approve";
    gateB.status = "resolved"; gateB.disposition = "changes_requested";
    expect(await resolveArtifactEffectDisposition(a)).toMatchObject({ disposition: "approved", gate: { gateId: gateA.gateId } });
    expect(await resolveArtifactEffectDisposition(b)).toMatchObject({ disposition: "held", gate: { gateId: gateB.gateId } });
    expect(gateA.targets).toEqual([{ artifactId: a.artifactId, representationRevisionId: a.representationRevisionId }]);
  });

  it.each([
    { status: "pending" as const, partlyLinked: false },
    { status: "pending" as const, partlyLinked: true },
    { status: "resolved" as const, partlyLinked: false },
    { status: "resolved" as const, partlyLinked: true },
  ])("drains a grandfathered $status combined gate as minted (partly linked: $partlyLinked)", async ({ status, partlyLinked }) => {
    const a = event("a"), b = event("b");
    const membership = [a, b].map(({ artifactId, representationRevisionId }) => ({ artifactId, representationRevisionId }));
    const reviewTaskId = batchPartitionReviewTaskId(membership);
    state.events = [a, b]; state.epoch = { id: "old-epoch", membership };
    const historical = { runId: "run", orgId: "org", reviewTaskId, targets: membership, gateId: "old-combined", status };
    state.gates.set(`run/${reviewTaskId}`, historical);
    if (partlyLinked) a.continuationAddress = "old-combined";
    const result = await drain();
    expect(result.failed).toBe(0); expect(result.gatesCreated).toBe(0);
    expect(emit).not.toHaveBeenCalled(); expect(state.gates.size).toBe(1);
    expect(state.gates.get(`run/${reviewTaskId}`)).toBe(historical);
    expect(state.events.every(e => e.status === "processed" && e.continuationAddress === "old-combined")).toBe(true);
    expect(park).toHaveBeenCalledTimes(2);
    expect(notify).not.toHaveBeenCalled(); expect(suggest).not.toHaveBeenCalled();
    expect(closeEpoch).toHaveBeenCalledTimes(1);
  });

  it("recovers an old batch-of-one slot instead of creating a second singleton gate", async () => {
    const a = event("a"), membership = [{ artifactId: a.artifactId, representationRevisionId: a.representationRevisionId }];
    const reviewTaskId = batchPartitionReviewTaskId(membership);
    state.events = [a]; state.epoch = { id: "old-epoch", membership };
    state.gates.set(`run/${reviewTaskId}`, { runId: "run", orgId: "org", reviewTaskId, targets: membership, gateId: "old-singleton" });
    await drain(); expect(emit).not.toHaveBeenCalled();
    expect(a.continuationAddress).toBe("old-singleton"); expect(a.status).toBe("processed");
    expect(state.gates.size).toBe(1);
  });

  it("drains existing partitions and creates singleton reviews only for an unminted partition", async () => {
    state.events = Array.from({ length: 52 }, (_, i) => event(`artifact-${i}`));
    const membership = state.events.map(({ artifactId, representationRevisionId }) => ({ artifactId, representationRevisionId }));
    state.epoch = { id: "old-epoch", membership };
    const first = membership.slice(0, 50), reviewTaskId = batchPartitionReviewTaskId(first);
    state.gates.set(`run/${reviewTaskId}`, { runId: "run", orgId: "org", reviewTaskId, targets: first, gateId: "old-combined" });
    const result = await drain(); expect(result.failed).toBe(0); expect(result.gatesCreated).toBe(2);
    expect(state.gates.size).toBe(3);
    expect(state.events.slice(0, 50).every(e => e.continuationAddress === "old-combined")).toBe(true);
    expect(state.events.slice(50).every(e => e.continuationAddress !== "old-combined")).toBe(true);
    expect(emit).toHaveBeenCalledTimes(2); expect(notify).toHaveBeenCalledTimes(2);
    expect(state.events.every(e => e.status === "processed")).toBe(true);
  });

  it.each(["foreign", "repinned"] as const)("does not adopt a %s historical partition slot", async corruption => {
    const a = event("a"), b = event("b");
    const membership = [a, b].map(({ artifactId, representationRevisionId }) => ({ artifactId, representationRevisionId }));
    const reviewTaskId = batchPartitionReviewTaskId(membership);
    state.events = [a, b]; state.epoch = { id: "old-epoch", membership };
    state.gates.set(`run/${reviewTaskId}`, { runId: "run", orgId: corruption === "foreign" ? "other" : "org", reviewTaskId,
      targets: corruption === "repinned" ? [membership[0], { ...membership[1], representationRevisionId: "different" }] : membership,
      gateId: "invalid-history" });
    const result = await drain(); expect(result.failed).toBe(1); expect(emit).not.toHaveBeenCalled();
    expect(state.events.every(e => e.status === "pending" && e.continuationAddress === null)).toBe(true);
    expect(closeEpoch).not.toHaveBeenCalled();
  });
});
