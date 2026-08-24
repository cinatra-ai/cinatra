/**
 * A REVIEW EXISTS ONLY FOR ARTIFACT-BOUND WORK (cinatra#2929, epic #2926 W2b).
 *
 * The acceptance's first two fixtures, on the produced side, driven through the
 * real orchestration entry rather than through the predicate alone:
 *
 *   · an agent that declares NO artifact-bound output produces no review card on
 *     any of the four hosts — no gate is emitted, the event is settled, and the
 *     run states no review moment for a host to mount a card from;
 *   · an artifact-bound output opens a review PER THE POLICY — the gate is
 *     emitted when the lattice fires, and not when the organization forbids it.
 *
 * WHAT WAS TRUE BEFORE. The produced path asked only whether an artifact write
 * had been RECORDED. That is one half of the binding: any write on any run
 * reached the policy, and the policy's own default fires for durable
 * agent-produced work — so an agent whose outputs are bound to no artifact
 * opened a review card all the same.
 *
 * The database is stubbed per TABLE rather than per call, so the three reads the
 * decision makes (the producing run, its template, the artifact's type) are each
 * answered by the fixture that names them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  LIFECYCLE_CARD_HOSTS,
  LIFECYCLE_MOMENT_CARD_KIND,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

const ORG = "org-2929";
const RUN = "run-2929";
const TEMPLATE = "tmpl-2929";
const EVENT = "evt-2929";

type Rows = {
  agentRuns: Record<string, unknown>[];
  agentTemplates: Record<string, unknown>[];
  objects: Record<string, unknown>[];
};

const rows: Rows = { agentRuns: [], agentTemplates: [], objects: [] };
const updates: unknown[] = [];

const { dbMock } = vi.hoisted(() => {
  const state = { rows: null as unknown as Rows, updates: null as unknown as unknown[] };
  const dbMock = {
    __bind(r: Rows, u: unknown[]) {
      state.rows = r;
      state.updates = u;
    },
    // Dispatched on the SELECTION, not the table handle: a drizzle table object
    // carries its name behind a symbol, and reading a private shape would make
    // this stub answer to the driver rather than to the query. The three reads
    // this decision makes each name distinct columns, so the projection is a
    // stable and readable discriminator.
    select(cols: Record<string, unknown>) {
      const keys = Object.keys(cols ?? {});
      const picked: unknown[] = keys.includes("templateId")
        ? state.rows.agentRuns
        : keys.includes("hasArtifactBindings") || keys.includes("lifecycleConfig")
          ? state.rows.agentTemplates
          : keys.includes("type")
            ? state.rows.objects
            : [];
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(picked),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(picked).then(res, rej),
      };
      return chain;
    },
    update() {
      const chain: Record<string, unknown> = {
        set(v: unknown) {
          state.updates.push(v);
          return chain;
        },
        where: () => Promise.resolve(undefined),
        then: (res: (v: unknown) => unknown) => Promise.resolve(undefined).then(res),
      };
      return chain;
    },
  };
  return { dbMock };
});

vi.mock("../db", () => ({ db: dbMock, agentBuilderPool: {} }));

const emitArtifactReviewGate = vi.fn<
  (input: Record<string, unknown>) => Promise<{ gateId: string; idempotent: boolean }>
>(async () => ({ gateId: "gate-2929", idempotent: false }));
const markProducedEventProcessed = vi.fn(async () => undefined);
const resolveOrgPolicyRule = vi.fn<
  (...a: unknown[]) => Promise<{ bound: "silent" | "required" | "forbidden" }>
>(async () => ({ bound: "silent" }));
const maybeParkCheckpoint = vi.fn(async () => undefined);

vi.mock("../artifact-review-gate-store", () => ({
  emitArtifactReviewGate: (input: Record<string, unknown>) => emitArtifactReviewGate(input),
  ArtifactReviewGateError: class ArtifactReviewGateError extends Error {
    code = "pin-conflict";
  },
}));
vi.mock("../lifecycle-produced-outbox-store", () => ({
  markProducedEventProcessed: (...a: unknown[]) => markProducedEventProcessed(...(a as [])),
}));
vi.mock("../lifecycle-policy-store", () => ({
  resolveOrgPolicyRule: (...a: unknown[]) => resolveOrgPolicyRule(...(a as [])),
}));
vi.mock("../lifecycle-continuation-park-store", () => ({
  maybeParkCheckpoint: (...a: unknown[]) => maybeParkCheckpoint(...(a as [])),
  sweepParks: vi.fn(async () => ({ released: 0 })),
}));
vi.mock("../run-wait-notifier", () => ({
  dispatchAutoGateOpen: vi.fn(async () => undefined),
  dispatchAutoGateResolved: vi.fn(async () => undefined),
}));
vi.mock("../lifecycle-repair-store", () => ({
  readRepair: vi.fn(async () => null),
  sealBatchEpoch: vi.fn(async () => ({ epoch: { membership: [] }, reused: false })),
  closeBatchEpoch: vi.fn(async () => undefined),
  resolveOpenBatchEpoch: vi.fn(async () => null),
  listOpenBatchEpochs: vi.fn(async () => []),
}));
vi.mock("../lifecycle-repair-dispatch-store", () => ({
  repairIdFromRunId: vi.fn(() => null),
  dispatchPendingProducerRepairs: vi.fn(async () => undefined),
}));
vi.mock("../lifecycle-suggestion-producer-lane", () => ({
  produceSuggestionsForNewGate: vi.fn(async () => undefined),
}));
vi.mock("@/lib/lifecycle/lifecycle-activation", () => ({
  isLifecycleReviewOrchestrationActive: () => true,
}));

// The coordinator's produced entry is the ONLY writer of the run's moment, so
// the four-host claim is read through it. Its two store dependencies are the
// guarded writer and the read-back.
const recordRunLifecycleMoment = vi.fn(async () => undefined);
const readAgentRunById = vi.fn<(id: string) => Promise<Record<string, unknown> | null>>(
  async () => null,
);
vi.mock("../store", () => ({
  recordRunLifecycleMoment: (...a: unknown[]) => recordRunLifecycleMoment(...(a as [])),
  readAgentRunById: (id: string) => readAgentRunById(id),
  createAgentRun: vi.fn(),
  createAgentRunPendingInput: vi.fn(),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {
    code = "stale_from_status";
  },
}));
vi.mock("@/lib/org-write/run-creation-authority", () => ({
  resolveRunCreationAuthority: vi.fn(async () => ({ kind: "system" })),
}));
vi.mock("@/lib/agent-run-enqueue", () => ({ enqueueAgentRun: vi.fn(async () => undefined) }));
vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false })),
}));

import { orchestrateProducedEvent } from "../lifecycle-review-orchestration-store";
import { onArtifactProduced } from "../lifecycle-coordinator";

function producedRow(overrides: Record<string, unknown> = {}) {
  return {
    eventId: EVENT,
    orgId: ORG,
    artifactId: "art-2929",
    representationRevisionId: "rev-2929",
    emitter: "run-completion-materializer",
    producerRunId: RUN,
    producerAgentId: TEMPLATE,
    originKind: "agent_produced",
    destinationClass: "none",
    continuationMode: "async_effects_gated",
    continuationAddress: null,
    status: "pending",
    ...overrides,
  };
}

/** The producing agent, and whether it declares an artifact-bound output. */
function agentDeclares(hasArtifactBindings: boolean | null) {
  // The run and the template agree on the version, so the flag really is THIS
  // run's answer. The two cases where they do not are their own fixtures below.
  rows.agentRuns = [{ templateId: TEMPLATE, packageVersion: "1.0.0" }];
  rows.agentTemplates = [
    { lifecycleConfig: null, hasArtifactBindings, packageVersion: "1.0.0" },
  ];
  rows.objects = [{ type: "artifact-blog-post-body", deletedAt: null }];
}

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  dbMock.__bind(rows, updates);
  emitArtifactReviewGate.mockResolvedValue({ gateId: "gate-2929", idempotent: false });
  resolveOrgPolicyRule.mockResolvedValue({ bound: "silent" });
});

describe("an agent with NO artifact-bound output", () => {
  it("opens no review gate, whatever it writes", async () => {
    agentDeclares(false);
    const outcome = await orchestrateProducedEvent(producedRow());

    expect(outcome).toBe("no-gate");
    expect(emitArtifactReviewGate).not.toHaveBeenCalled();
    // Settled, not left pending: the answer is final, not a deferral.
    expect(markProducedEventProcessed).toHaveBeenCalledWith(EVENT);
  });

  it("never asks the policy at all — there is nothing for a rule to decide", async () => {
    // The binding is proved FIRST, so an organization does not have to write a
    // rule to keep unbound work out of a review.
    agentDeclares(false);
    await orchestrateProducedEvent(producedRow());
    expect(resolveOrgPolicyRule).not.toHaveBeenCalled();
  });

  it("produces no review card on ANY of the four hosts", async () => {
    // Every host mounts the review card from the run's own MOMENT and card
    // reference, which the coordinator's produced entry is the only writer of.
    // So the absence is read off that entry, driven for real, rather than off a
    // row this test wrote itself: orchestration opens no gate, the coordinator
    // is told so, and it states nothing for any host to mount.
    agentDeclares(false);
    const outcome = await orchestrateProducedEvent(producedRow());
    expect(outcome).toBe("no-gate");
    expect(emitArtifactReviewGate).not.toHaveBeenCalled();

    readAgentRunById.mockResolvedValue({
      id: RUN,
      orgId: ORG,
      status: "running",
      lifecycleMoment: null,
      lifecycleCardRef: null,
    });
    const answered = await onArtifactProduced({
      run: { id: RUN, orgId: ORG, status: "running" },
      reviewOpened: emitArtifactReviewGate.mock.calls.length > 0,
      authority: undefined,
    });

    // NOTHING WAS STATED. The moment column is the one thing a host reads, and
    // the guarded writer was never called — so there is no card reference on the
    // run for any host to resolve, and none to take off it either.
    expect(recordRunLifecycleMoment).not.toHaveBeenCalled();
    expect(answered.moment).toBeNull();
    expect(LIFECYCLE_CARD_HOSTS.length).toBe(4);
    for (const host of LIFECYCLE_CARD_HOSTS) {
      expect(
        answered.moment,
        `${host} would mount ${LIFECYCLE_MOMENT_CARD_KIND.review} only from a stated review moment`,
      ).toBeNull();
    }
  });

  it("a pinned run keeps its review when the template has MOVED ON to an unbound version", async () => {
    // `agent_templates` is a mutable row a reinstall overwrites in place, while
    // a run is pinned to the version it started against. Reading the current
    // flag as this run's would settle a v1 write with no review at all — and
    // irreversibly, because the event is marked processed. A moved-on template
    // is UNKNOWN, so the review stands.
    rows.agentRuns = [{ templateId: TEMPLATE, packageVersion: "1.0.0" }];
    rows.agentTemplates = [
      { lifecycleConfig: null, hasArtifactBindings: false, packageVersion: "2.0.0" },
    ];
    rows.objects = [{ type: "artifact-blog-post-body", deletedAt: null }];

    const outcome = await orchestrateProducedEvent(producedRow());
    expect(outcome).toBe("gate-created");
    expect(emitArtifactReviewGate).toHaveBeenCalledTimes(1);
  });

  it("a moved-on template cannot take the review away with a skip it declared LATER either", async () => {
    // The other half of the same race. The binding flag is not the only
    // declaration on that mutable row: a `requestedSkips: ["review"]` the
    // template picked up after this run started would remove the review just as
    // effectively, so a template provably on another version supplies neither.
    rows.agentRuns = [{ templateId: TEMPLATE, packageVersion: "1.0.0" }];
    rows.agentTemplates = [
      {
        lifecycleConfig: JSON.stringify({ requestedSkips: ["review"] }),
        hasArtifactBindings: true,
        packageVersion: "2.0.0",
      },
    ];
    rows.objects = [{ type: "artifact-blog-post-body", deletedAt: null }];

    expect(await orchestrateProducedEvent(producedRow())).toBe("gate-created");
    expect(emitArtifactReviewGate).toHaveBeenCalledTimes(1);
  });

  it("an UNPINNED run keeps the agent's declared skip — that is not this race", async () => {
    // The asymmetry, stated as a case. An unpinned run's flag is unknown (a
    // floating tag can move under it), but its MANIFEST still applies: dropping
    // it would stop honouring an agent's declared skip for every run without a
    // pin, which is a change to when the policy applies and no part of this work.
    rows.agentRuns = [{ templateId: TEMPLATE, packageVersion: null }];
    rows.agentTemplates = [
      {
        lifecycleConfig: JSON.stringify({ requestedSkips: ["review"] }),
        hasArtifactBindings: true,
        packageVersion: "2.0.0",
      },
    ];
    rows.objects = [{ type: "artifact-blog-post-body", deletedAt: null }];

    expect(await orchestrateProducedEvent(producedRow())).toBe("no-gate");
    expect(emitArtifactReviewGate).not.toHaveBeenCalled();
  });

  it("an UNPINNED run reads the flag as unknown too — a floating tag can move under it", async () => {
    rows.agentRuns = [{ templateId: TEMPLATE, packageVersion: null }];
    rows.agentTemplates = [
      { lifecycleConfig: null, hasArtifactBindings: false, packageVersion: "2.0.0" },
    ];
    rows.objects = [{ type: "artifact-blog-post-body", deletedAt: null }];

    expect(await orchestrateProducedEvent(producedRow())).toBe("gate-created");
  });

  it("an agent that was never compiled for the question keeps its review", async () => {
    // `null` is nobody having looked, and it must not read as `false` — that
    // would silently stop reviewing every agent installed before the column.
    agentDeclares(null);
    const outcome = await orchestrateProducedEvent(producedRow());
    expect(outcome).toBe("gate-created");
    expect(emitArtifactReviewGate).toHaveBeenCalledTimes(1);
  });
});

describe("an artifact-bound output", () => {
  it("opens a review per the policy", async () => {
    agentDeclares(true);
    const outcome = await orchestrateProducedEvent(producedRow());

    expect(outcome).toBe("gate-created");
    expect(emitArtifactReviewGate).toHaveBeenCalledTimes(1);
    const emitted = emitArtifactReviewGate.mock.calls[0]![0];
    expect(emitted.runId).toBe(RUN);
    expect(emitted.orgId).toBe(ORG);
    expect(emitted.targets).toEqual([
      { artifactId: "art-2929", representationRevisionId: "rev-2929" },
    ]);
    // The gate is linked onto the event, which is what makes the effect held.
    expect(updates).toContainEqual({ continuationAddress: "gate-2929" });
  });

  it("…PER THE POLICY: an organization that forbids this review opens none", async () => {
    agentDeclares(true);
    resolveOrgPolicyRule.mockResolvedValue({ bound: "forbidden" });
    const outcome = await orchestrateProducedEvent(producedRow());

    expect(outcome).toBe("no-gate");
    expect(emitArtifactReviewGate).not.toHaveBeenCalled();
    expect(markProducedEventProcessed).toHaveBeenCalledWith(EVENT);
  });

  it("…and an agent that declares the review checkpoint skipped opens none either", async () => {
    rows.agentRuns = [{ templateId: TEMPLATE, packageVersion: "1.0.0" }];
    rows.agentTemplates = [
      {
        lifecycleConfig: JSON.stringify({ requestedSkips: ["review"] }),
        hasArtifactBindings: true,
        packageVersion: "1.0.0",
      },
    ];
    rows.objects = [{ type: "artifact-blog-post-body", deletedAt: null }];

    const outcome = await orchestrateProducedEvent(producedRow());
    expect(outcome).toBe("no-gate");
    expect(emitArtifactReviewGate).not.toHaveBeenCalled();
  });
});
