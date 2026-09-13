/**
 * THE SET-REPRESENTING ARTIFACT IS NEVER PINNED — ON THE PATH A PRODUCTION
 * ACTUALLY TAKES (cinatra#3458).
 *
 * "The JSON is not supposed to be presented in the review, because it represents
 * a list of artifacts, not the artifact itself."
 *
 * The rule landed first on the DECLARED review's server half, where a caller
 * names its own targets. A run that writes several artifacts at once never goes
 * that way: it reaches a review through the PRODUCED batch path, which sealed and
 * pinned whatever it fired. Measured on a real production — five blog ideas plus
 * the structured list payload written ABOUT them — the gate pinned six targets and
 * the review drew the list beside its own members.
 *
 * THE FIXTURE IS THE REAL PRODUCTION, copied row for row out of the database
 * it was measured in: the six pending outbox rows of run
 * 4f551a6b-aefc-405b-9d09-37514f7f79c2, the six `objects` rows they name (five
 * `@cinatra-ai/blog-idea-artifact:blog-idea`, one
 * `@cinatra-ai/json-artifact:artifact` titled "Blog Idea Generator Agent —
 * ideas"), the run's EMPTY `package_version`, and the producing template's own
 * `artifact_bindings` declaration — which names the blog-idea type as the one
 * thing this production produces and never names the JSON payload's type at all.
 *
 * Driven through `sweepReviewOrchestration`, the shipped entry, with the database
 * stubbed per TABLE the way the sibling produced-path suite stubs it: the reads
 * this decision makes (the production keys, its pending membership, the producing
 * run, its template, each artifact's type) are each answered by the fixture that
 * names them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ORG = "c7809afa-d534-4a8d-9b23-2635738a5ec1";
const RUN = "4f551a6b-aefc-405b-9d09-37514f7f79c2";
const TEMPLATE = "f4aeadd0-567a-471c-a4ad-c35ec3ca0039";

/** The producing template's EXECUTED artifact-binding declaration, verbatim from
 *  `agent_templates.artifact_bindings` (template f4aeadd0, package version
 *  0.2.0): ONE produced type, and it is not the payload's. */
const ARTIFACT_BINDINGS = JSON.stringify({
  v: 1,
  bindings: [
    {
      nodeId: "end",
      outputId: "ideas",
      binding: {
        extension: "@cinatra-ai/blog-idea-artifact",
        objectTypeId: "@cinatra-ai/blog-idea-artifact:blog-idea",
        contentFrom: "ideas",
        declaredMime: "text/plain",
        fanOut: { mode: "member", titleFrom: "first-line", titlePrefix: "Title:" },
      },
    },
  ],
  producesRefs: [
    {
      extension: "@cinatra-ai/blog-idea-artifact",
      objectTypeId: "@cinatra-ai/blog-idea-artifact:blog-idea",
    },
  ],
});

const BLOG_IDEA = "@cinatra-ai/blog-idea-artifact:blog-idea";
const JSON_ARTIFACT = "@cinatra-ai/json-artifact:artifact";

/** The production, member for member, as the database holds it. */
const PRODUCTION = [
  {
    eventId: "bc177c5aef08f4644a4d0994c2504e9f24e9c4bf2f10278c88d2a8f8f51db3e4",
    artifactId: "2382c88c-e565-48c5-8e77-e2706c493ab6",
    representationRevisionId: "657a4ebd-cc05-40b3-b391-d24bd8a85055",
    objectType: BLOG_IDEA,
  },
  {
    eventId: "bc9fcbb16faea0e130a19a88ed3608271887ba9464c1e35288f1b385d2f4a595",
    artifactId: "74f2947e-0306-4bfd-8549-3b4b01ecb672",
    representationRevisionId: "c15fdeba-b9a3-4f45-b2af-7ed8f7c1f327",
    objectType: BLOG_IDEA,
  },
  {
    eventId: "aaa1dbb69370454517992fefff4bfd3186392720ba032afda4e1844cf98c5d7f",
    artifactId: "f628bbd3-037b-4b4d-abcd-28b2afe160b2",
    representationRevisionId: "3545e4d0-dd7c-4219-b7f1-8b0900216356",
    objectType: BLOG_IDEA,
  },
  {
    eventId: "e51b3ab77a4b64289f7e51f8cc7866c6ce023b453d737f1fd472b074a0d574f0",
    artifactId: "6653e07c-6e62-4e05-a7f9-4a1d564798cc",
    representationRevisionId: "4b1c9b18-219f-4a16-ac97-2430b0843d84",
    objectType: BLOG_IDEA,
  },
  {
    eventId: "544216eb87b67a94d447961ea74735d0f9c6c05e8b62f45d68f8239ba19af2c1",
    artifactId: "2d7bd258-f906-4ddf-81ec-1984cfb5b28f",
    representationRevisionId: "f7d34c69-fd42-4e8d-b779-381ab45be04a",
    objectType: BLOG_IDEA,
  },
  {
    // The set's own payload: the production's structured list of the five above.
    eventId: "ea39c895d15762ad556a11befb3aac572d401d53dbda0c2ca364f8e948a23fe7",
    artifactId: "b23bfb4d-8469-43b2-b094-7323ee71390a",
    representationRevisionId: "49217bfc-97da-41f5-af5e-13af753731d2",
    objectType: JSON_ARTIFACT,
  },
] as const;

const PAYLOAD = PRODUCTION[5];
const MEMBER_IDS = PRODUCTION.filter((m) => m.objectType === BLOG_IDEA).map(
  (m) => m.artifactId,
);

type Fixture = {
  /** `agent_runs`: the producing run. Its `package_version` is EMPTY on the real
   *  row — the run is UNPINNED, which is what makes the template's declaration
   *  speak for it (a template PROVABLY on another version is the only one that
   *  does not). */
  run: Record<string, unknown>[];
  /** `agent_templates`: the producing template. */
  template: Record<string, unknown>[];
  /** `objects`: one row per produced artifact, keyed by id. */
  objects: Record<string, Record<string, unknown>>;
};

const fixture: Fixture = { run: [], template: [], objects: {} };
const linked: unknown[] = [];

/** Every string reachable in a drizzle `where` expression — the artifact id a
 *  per-artifact read names is one of them, which is how the stub answers the row
 *  that read asked for instead of the first row it holds. */
function stringsIn(value: unknown, depth = 0, seen = new Set<unknown>()): string[] {
  if (depth > 12 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const out: string[] = [];
  for (const inner of Object.values(value as Record<string, unknown>)) {
    out.push(...stringsIn(inner, depth + 1, seen));
  }
  return out;
}

const { dbMock, poolMock } = vi.hoisted(() => {
  const state = {
    fixture: null as unknown as Fixture,
    linked: null as unknown as unknown[],
    production: null as unknown as ReadonlyArray<Record<string, unknown>>,
    org: "",
    run: "",
    stringsIn: null as unknown as (v: unknown) => string[],
    /** The template read is made ONCE PER MEMBER. From this read on (1-based) it
     *  answers with no declaration at all — a read that failed, or a template
     *  updated mid-drain. Null: every read answers the same. */
    templateSilentFromRead: null as number | null,
    templateReads: 0,
  };
  /** A select answers with the COLUMNS IT SELECTED and no others — a stub that
   *  hands back the whole fixture row would let the production code drop a column
   *  from its projection and still read it. */
  const project = (row: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
    Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]]));
  const dbMock = {
    __bind(bound: Partial<{
      fixture: Fixture;
      linked: unknown[];
      production: ReadonlyArray<Record<string, unknown>>;
      org: string;
      run: string;
      stringsIn: (v: unknown) => string[];
      templateSilentFromRead: number | null;
      templateReads: number;
    }>) {
      Object.assign(state, bound);
    },
    // Dispatched on the SELECTION (and, where one read is per-artifact, on the
    // strings its `where` carries): a drizzle table object hides its name behind
    // a symbol, and reading a private shape would make this stub answer to the
    // driver rather than to the query.
    select(cols: Record<string, unknown>) {
      const keys = Object.keys(cols ?? {});
      let where: unknown = null;
      const rows = (): unknown[] => {
        const named = state.stringsIn(where);
        // The pending membership of ONE production. The run-LESS orphan pass runs
        // the same projection and names no run, and this production has none.
        if (keys.includes("eventId")) {
          return named.includes(state.run) ? [...state.production] : [];
        }
        // The production keys the sweep groups by.
        if (keys.includes("producerRunId") && keys.includes("orgId")) {
          return [{ orgId: state.org, producerRunId: state.run }];
        }
        if (keys.includes("templateId")) return state.fixture.run;
        if (keys.includes("hasArtifactBindings") || keys.includes("lifecycleConfig")) {
          state.templateReads += 1;
          const silent =
            state.templateSilentFromRead !== null &&
            state.templateReads >= state.templateSilentFromRead;
          return state.fixture.template.map((row) =>
            silent ? { ...row, artifactBindings: null } : row,
          );
        }
        // ONE artifact's type (the review context), or the whole set's (the
        // suggestion lane's kind read).
        if (keys.includes("type")) {
          if (keys.includes("deletedAt")) {
            const id = named.find((s) => s in state.fixture.objects);
            if (!id) throw new Error(`no artifact id in the type read's where clause`);
            return [state.fixture.objects[id]];
          }
          return Object.values(state.fixture.objects);
        }
        return [];
      };
      const projected = (): unknown[] =>
        rows().map((row) => project(row as Record<string, unknown>, keys));
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: (clause: unknown) => {
          where = clause;
          return chain;
        },
        groupBy: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(projected()),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(projected()).then(res, rej),
      };
      return chain;
    },
    update() {
      let set: unknown = null;
      const chain: Record<string, unknown> = {
        set(v: unknown) {
          set = v;
          return chain;
        },
        // The link names its members in the WHERE, so the stub records both
        // halves: which gate they were linked onto, and WHICH events were.
        where: (clause: unknown) => {
          state.linked.push({ set, events: state.stringsIn(clause) });
          return Promise.resolve(undefined);
        },
        then: (res: (v: unknown) => unknown) => Promise.resolve(undefined).then(res),
      };
      return chain;
    },
  };
  // The production lock is a pure mutex on a dedicated client; the drain's own
  // reads and writes go through the pool above.
  const agentBuilderPool = {
    connect: async () => ({
      query: async () => ({ rows: [{ locked: true }] }),
      release: () => undefined,
    }),
  };
  return { dbMock, poolMock: agentBuilderPool };
});

vi.mock("../db", () => ({ db: dbMock, agentBuilderPool: poolMock }));

const emitArtifactReviewGate = vi.fn<
  (input: Record<string, unknown>) => Promise<{ gateId: string; idempotent: boolean }>
>(async () => ({ gateId: "gate-3458", idempotent: false }));
const markProducedEventProcessed = vi.fn(async () => undefined);
const resolveOrgPolicyRule = vi.fn<
  (...a: unknown[]) => Promise<{ bound: "silent" | "required" | "forbidden" }>
>(async () => ({ bound: "silent" }));
const sealBatchEpoch = vi.fn(
  async (input: { candidateMembers: ReadonlyArray<Record<string, unknown>> }) => ({
    epoch: { id: "epoch-3458", membership: [...input.candidateMembers] },
    reused: false,
  }),
);
/** The OPEN batch epoch this production would reuse. Null: none — the fresh
 *  production of the measured run. A case that seals one before the rule existed
 *  makes it answer with its frozen membership. */
const resolveOpenBatchEpoch = vi.fn<
  () => Promise<{
    id: string;
    membership: Array<{ artifactId: string; representationRevisionId: string }>;
  } | null>
>(async () => null);
const produceSuggestionsForGateTargets = vi.fn<
  (input: { targets: Array<{ target: { artifactId: string } }> }) => Promise<void>
>(async () => undefined);

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
  maybeParkCheckpoint: vi.fn(async () => undefined),
  sweepParks: vi.fn(async () => ({ released: 0 })),
}));
vi.mock("../run-wait-notifier", () => ({
  dispatchAutoGateOpen: vi.fn(async () => undefined),
  dispatchAutoGateResolved: vi.fn(async () => undefined),
}));
vi.mock("../lifecycle-repair-store", () => ({
  readRepair: vi.fn(async () => null),
  sealBatchEpoch: (input: { candidateMembers: ReadonlyArray<Record<string, unknown>> }) =>
    sealBatchEpoch(input),
  closeBatchEpoch: vi.fn(async () => undefined),
  resolveOpenBatchEpoch: () => resolveOpenBatchEpoch(),
  listOpenBatchEpochs: vi.fn(async () => []),
}));
vi.mock("../lifecycle-repair-dispatch-store", () => ({
  repairIdFromRunId: vi.fn(() => null),
  dispatchPendingProducerRepairs: vi.fn(async () => undefined),
}));
vi.mock("../lifecycle-suggestion-producer-lane", () => ({
  produceSuggestionsForGateTargets: (input: {
    targets: Array<{ target: { artifactId: string } }>;
  }) => produceSuggestionsForGateTargets(input),
  produceSuggestionsForNewGate: vi.fn(async () => undefined),
}));
vi.mock("@/lib/lifecycle/lifecycle-activation", () => ({
  isLifecycleReviewOrchestrationActive: () => true,
}));

import { sweepReviewOrchestration } from "../lifecycle-review-orchestration-store";

/** The production's pending outbox rows, exactly as the drain reads them. */
function pendingRows(payloadDestination: string = "none"): Record<string, unknown>[] {
  return PRODUCTION.map((member) => ({
    eventId: member.eventId,
    orgId: ORG,
    artifactId: member.artifactId,
    representationRevisionId: member.representationRevisionId,
    emitter: "createSemanticArtifact",
    producerRunId: RUN,
    producerAgentId: TEMPLATE,
    originKind: "agent_produced",
    destinationClass: member.artifactId === PAYLOAD.artifactId ? payloadDestination : "none",
    continuationMode: "async_effects_gated",
    continuationAddress: null,
    status: "pending",
  }));
}

/** The producing run and its template, as the database holds them. The
 *  template's declaration is the one fact under test; `declares` lets a case ask
 *  what happens when a production declares nothing at all. */
function seed(declares: string | null = ARTIFACT_BINDINGS) {
  fixture.run = [{ templateId: TEMPLATE, packageVersion: null }];
  fixture.template = [
    {
      lifecycleConfig: null,
      hasArtifactBindings: true,
      artifactBindings: declares,
      packageVersion: "0.2.0",
    },
  ];
  fixture.objects = Object.fromEntries(
    PRODUCTION.map((member) => [
      member.artifactId,
      { id: member.artifactId, type: member.objectType, deletedAt: null },
    ]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  linked.length = 0;
  seed();
  dbMock.__bind({
    fixture,
    linked,
    production: pendingRows(),
    org: ORG,
    run: RUN,
    stringsIn: (v: unknown) => stringsIn(v),
    templateSilentFromRead: null,
    templateReads: 0,
  });
  emitArtifactReviewGate.mockResolvedValue({ gateId: "gate-3458", idempotent: false });
  resolveOrgPolicyRule.mockResolvedValue({ bound: "silent" });
  resolveOpenBatchEpoch.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

/** The targets the one emitted gate pinned. */
function pinnedTargets(): Array<{ artifactId: string; representationRevisionId: string }> {
  expect(emitArtifactReviewGate).toHaveBeenCalledTimes(1);
  const emitted = emitArtifactReviewGate.mock.calls[0]![0];
  return emitted.targets as Array<{ artifactId: string; representationRevisionId: string }>;
}

describe("cinatra#3458 — the production's own list payload is never pinned", () => {
  it("pins the FIVE members of the real production, never its six", async () => {
    const summary = await sweepReviewOrchestration();

    expect(summary.failed).toBe(0);
    const targets = pinnedTargets();
    expect(targets).toHaveLength(5);
    expect(targets.map((t) => t.artifactId).sort()).toEqual([...MEMBER_IDS].sort());
  });

  it("the JSON payload of that production is not among them", async () => {
    await sweepReviewOrchestration();
    const targets = pinnedTargets();
    expect(
      targets.some((t) => t.artifactId === PAYLOAD.artifactId),
      "the artifact that represents the set is not a piece of the work",
    ).toBe(false);
    expect(targets.some((t) => t.representationRevisionId === PAYLOAD.representationRevisionId)).toBe(
      false,
    );
  });

  it("settles the excluded payload rather than leaving it pending — and never links it", async () => {
    // A left-pending member would be re-swept forever, and an external effect of
    // it would stay held on a gate that will never name it. So the payload is
    // SETTLED — but it is never linked onto the gate, because the gate does not
    // pin it: a linked event would hold its effect on a review nobody can take
    // for it.
    await sweepReviewOrchestration();
    expect(markProducedEventProcessed).toHaveBeenCalledWith(PAYLOAD.eventId);
    expect(linked).toHaveLength(1);
    const link = linked[0] as { set: unknown; events: string[] };
    expect(link.set).toEqual({ continuationAddress: "gate-3458" });
    expect(link.events).toContain(PRODUCTION[0].eventId);
    expect(
      link.events,
      "the set's own payload is not linked onto the members' gate",
    ).not.toContain(PAYLOAD.eventId);
  });

  it("seals the five into the epoch — the exclusion happens BEFORE the seal", async () => {
    // The pinned targets are derived from the FROZEN membership, so an exclusion
    // that ran after the seal would pin the payload and then argue with itself.
    await sweepReviewOrchestration();
    expect(sealBatchEpoch).toHaveBeenCalledTimes(1);
    const sealed = sealBatchEpoch.mock.calls[0]![0].candidateMembers as Array<{
      artifactId: string;
    }>;
    expect(sealed.map((m) => m.artifactId).sort()).toEqual([...MEMBER_IDS].sort());
  });

  it("offers the five to the suggestion lane too — the payload is not work to suggest on", async () => {
    await sweepReviewOrchestration();
    expect(produceSuggestionsForGateTargets).toHaveBeenCalledTimes(1);
    const offered = produceSuggestionsForGateTargets.mock.calls[0]![0];
    expect(offered.targets.map((t) => t.target.artifactId).sort()).toEqual([...MEMBER_IDS].sort());
  });

  it("a payload that carries an EXTERNAL EFFECT is kept, never dropped", async () => {
    // An excluded member is settled with no continuation address, and an
    // orchestrated external event with no linked gate reads as `ungated` — the
    // effect flows with no review at all. So the exclusion refuses to touch a
    // member that carries one: better one block too many in the review than a
    // publish that escapes it. (The real payload's destination is `none`.)
    dbMock.__bind({ production: pendingRows("external_publish") });

    await sweepReviewOrchestration();

    const targets = pinnedTargets();
    expect(targets).toHaveLength(6);
    expect(targets.some((t) => t.artifactId === PAYLOAD.artifactId)).toBe(true);
    // Kept means GATED, not merely drawn: the event is LINKED onto the gate, so
    // its effect is held until that review resolves.
    const link = linked[0] as { events: string[] };
    expect(link.events).toContain(PAYLOAD.eventId);
  });

  it("a membership FROZEN before the rule existed is gated as it was frozen", async () => {
    // `sealBatchEpoch` reuses an open epoch's frozen membership whatever the
    // candidates are, and the partition gate ids hash that frozen set: dropping a
    // member the epoch already froze would settle it here and pin it there.
    resolveOpenBatchEpoch.mockResolvedValue({
      id: "epoch-pre-fix",
      membership: PRODUCTION.map((m) => ({
        artifactId: m.artifactId,
        representationRevisionId: m.representationRevisionId,
      })),
    });

    await sweepReviewOrchestration();

    const sealed = sealBatchEpoch.mock.calls[0]![0].candidateMembers as Array<{
      artifactId: string;
    }>;
    expect(sealed).toHaveLength(6);
    expect(pinnedTargets()).toHaveLength(6);
    // Gated with its siblings — linked, never settled behind the gate's back.
    const link = linked[0] as { events: string[] };
    expect(link.events).toContain(PAYLOAD.eventId);
  });

  it("one member's empty answer never restores the payload — the declarations are the UNION", async () => {
    // The declaration is read PER MEMBER. A read that failed, or one that caught
    // the template mid-update, answers with none; taking the last answer would
    // hand the whole batch that emptiness and pin the payload again.
    dbMock.__bind({ templateSilentFromRead: 6, templateReads: 0 });

    await sweepReviewOrchestration();

    const targets = pinnedTargets();
    expect(targets).toHaveLength(5);
    expect(targets.some((t) => t.artifactId === PAYLOAD.artifactId)).toBe(false);
  });

  it("a production that declares NOTHING keeps every target — the rule never fires on a guess", async () => {
    // The first of the three guards: a production that declares no produced type
    // says nothing about its own members, so nothing is left out.
    seed(null);
    await sweepReviewOrchestration();
    expect(pinnedTargets()).toHaveLength(6);
  });
});
