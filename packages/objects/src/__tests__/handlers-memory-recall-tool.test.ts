// `memory_recall` — the shared-memory recall primitive (cinatra#1380, epic #1373).
//
// FAIL-FIRST. Every assertion below was captured RED before the handler existed
// (the primitive was absent from `createObjectsPrimitiveHandlers()`), and the
// guard assertions were re-captured RED individually against a handler with the
// guard removed. See the PR body for the recorded runs.
//
// What this file proves, with test doubles only (the live-ranking half of AC1
// needs a running dev stack and is called out honestly in the PR):
//
//   AC1  the recall is pinned to `@cinatra-ai/memory:concept`, searches the
//        caller's SERVER-DERIVED entitled lanes (cinatra#1379), and respects
//        `limit`;
//   AC2  BOTH degradation paths — semantic index unavailable, and a response
//        that yields no row ids — are labelled `degraded-recent` and are never
//        presented as query-ranked;
//   plus the security posture: strict parse (a forged `group_ids` is a
//        rejection, not an ignored key), every author-controlled input capped,
//        `limit` ceilinged, `kind` unable to move the type or reach SQL, and a
//        capped body excerpt.
//
// AC3 (registry discoverability) lives in registry-memory-recall.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/objects-store", () => ({
  upsertObjectAndEnqueue: vi.fn(),
  getObjectById: vi.fn(),
  listObjectsByFilter: vi.fn(() => []),
  resolveObjectIdsByAnchorNodeUuids: vi.fn(() => new Map<string, string[]>()),
  softDeleteObject: vi.fn(),
}));

vi.mock("../classifier", () => ({ classifyObject: vi.fn() }));

vi.mock("../graphiti-client", () => ({
  searchNodes: vi.fn(async () => ({ nodes: [] })),
  addEpisode: vi.fn(),
  deleteEpisode: vi.fn(),
  getEpisodes: vi.fn(async () => ({ episodes: [] })),
  identityHashToUuid: (h: string) => h,
}));

vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => [] as Array<{ id: string; name: string }>),
}));

// The kernel, DENYING by default (round 1, item 6). Without this the
// package-wide alias stub answers allow-by-default, every row the per-row
// `object.read` probe sees is admitted, and the drop assertions below assert
// nothing. `enforceResourceAccess` short-circuits a user-owned row for its OWN
// owner before it consults the kernel, so a denying `can` still lets the caller
// read its own rows — which is exactly the asymmetry these tests need. A test
// that wants a NON-owned row admitted opts in explicitly with
// `mockCan.mockReturnValue(true)`.
vi.mock("@/lib/authz", () => ({
  can: vi.fn(() => false),
  canDo: vi.fn(() => false),
  buildActorContext: vi.fn(() => ({})),
  AuthzError: class AuthzError extends Error {
    statusCode: number;
    reason: string;
    constructor(opts: { statusCode: number; reason: string; message?: string }) {
      super(opts.message ?? opts.reason);
      this.name = "AuthzError";
      this.statusCode = opts.statusCode;
      this.reason = opts.reason;
    }
  },
  EFFECTIVE_GRANTS: {},
  POLICY_VERSION: "test",
  logAuditEvent: vi.fn(),
}));

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import { searchNodes } from "../graphiti-client";
import {
  listObjectsByFilter,
  resolveObjectIdsByAnchorNodeUuids,
} from "@/lib/objects-store";
import { readTeamsForUser } from "@/lib/better-auth-db";
import { can } from "@/lib/authz";
import { deriveProjectionGroupId } from "../graphiti-projection-policy";
import {
  MEMORY_RECALL_CANDIDATE_FETCH_MAX,
  MEMORY_RECALL_CONCEPT_PATH_MAX_BYTES,
  MEMORY_RECALL_EXCERPT_MAX_BYTES,
  MEMORY_RECALL_ITEM_KIND_MAX_BYTES,
  MEMORY_RECALL_RESPONSE_MAX_BYTES,
  MEMORY_RECALL_TITLE_MAX_BYTES,
  onInternalReadAuthzDrop,
} from "../mcp/handlers";
import {
  MEMORY_RECALL_KIND_MAX_BYTES,
  MEMORY_RECALL_MAX_LIMIT,
  MEMORY_RECALL_QUERY_MAX_BYTES,
  PROJECT_ID_MAX_BYTES,
  memoryRecallResponseSchema,
  memoryRecallSchema,
  objectsListSchema,
  objectsSaveSchema,
  objectsUpdateSchema,
} from "../mcp/schemas";

const MEMORY_CONCEPT_TYPE_ID = "@cinatra-ai/memory:concept";
const ORG = "org-1";
const OTHER_ORG = "org-2";
const BASE = deriveProjectionGroupId(ORG);

const mockSearch = searchNodes as unknown as ReturnType<typeof vi.fn>;
const mockList = listObjectsByFilter as unknown as ReturnType<typeof vi.fn>;
const mockAnchors = resolveObjectIdsByAnchorNodeUuids as unknown as ReturnType<typeof vi.fn>;
const mockTeams = readTeamsForUser as unknown as ReturnType<typeof vi.fn>;
const mockCan = can as unknown as ReturnType<typeof vi.fn>;

const ACTOR = {
  actorType: "model",
  source: "agent",
  userId: "user-1",
  ...({ orgId: ORG, agentId: "a1", runId: "r1" } as unknown as Record<string, unknown>),
} as never;

/** The same actor, holding a read grant on `proj-1` (the sealed-room axis the
 *  registry stamps for the request frame's identity pair). */
const ACTOR_WITH_PROJECT = {
  ...(ACTOR as unknown as Record<string, unknown>),
  projectGrants: [{ projectId: "proj-1", role: "read" }],
  projectIds: ["proj-1"],
} as never;

/** A canonical memory row as `listObjectsByFilter` returns it. */
function memoryRow(
  id: string,
  over: Partial<{
    conceptId: string;
    okfType: string;
    title: string;
    body: string;
    ownerLevel: string;
    ownerId: string;
    visibility: string;
    projectId: string | null;
    orgId: string;
  }> = {},
) {
  return {
    id,
    orgId: over.orgId ?? ORG,
    type: MEMORY_CONCEPT_TYPE_ID,
    data: {
      conceptId: over.conceptId ?? `notes/${id}`,
      bundleId: "11111111-1111-4111-8111-111111111111",
      externalId: "a".repeat(64),
      okfType: over.okfType ?? "note",
      frontmatter: { type: over.okfType ?? "note", title: over.title ?? `Title ${id}` },
      bodyMarkdown: over.body ?? `body of ${id}`,
      links: [],
      okfVersion: "0.1",
    },
    ownerLevel: over.ownerLevel ?? "user",
    ownerId: over.ownerId ?? "user-1",
    visibility: over.visibility ?? "private",
    projectId: over.projectId ?? null,
    parentId: null,
    parentType: null,
    agentId: "a1",
    packageVersion: null,
    agentSpecVersion: null,
    runId: "r1",
    source: "agent",
    createdBy: "user-1",
    deletedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    version: 1,
  };
}

function recall(input: unknown, actor: unknown = ACTOR) {
  const handlers = createObjectsPrimitiveHandlers();
  return (handlers as Record<string, (r: unknown) => Promise<unknown>>).memory_recall({
    primitiveName: "memory_recall",
    input,
    actor,
    mode: "deterministic",
  });
}

type RecallResponse = {
  items: Array<{
    id: string;
    conceptPath: string | null;
    title: string | null;
    kind: string | null;
    scope: {
      ownerLevel: string;
      ownerId: string | null;
      visibility: string;
      projectId: string | null;
    };
    excerpt: string;
    excerptTruncated: boolean;
  }>;
  mode: "semantic" | "degraded-recent";
  ordering: "semantic-rank" | "lexical-fallback";
  meta?: { semanticSearch?: string; fallback?: string; responseCeiling?: string };
};

/** Wire `searchNodes` so `resolveObjectIds` deterministically yields `ids`. */
function semanticHit(ids: string[]) {
  const nodes = ids.map((id, i) => ({ uuid: `anchor-${i}`, name: `n${i}` }));
  mockSearch.mockResolvedValue({ nodes });
  mockAnchors.mockReturnValue(
    new Map(nodes.map((n, i) => [n.uuid, [ids[i]!]])),
  );
}

beforeEach(() => {
  mockSearch.mockReset();
  mockSearch.mockResolvedValue({ nodes: [] });
  mockAnchors.mockReset();
  mockAnchors.mockReturnValue(new Map());
  mockList.mockReset();
  mockList.mockReturnValue([]);
  mockTeams.mockReset();
  mockTeams.mockResolvedValue([]);
  mockCan.mockReset();
  mockCan.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// AC1 — scoped lanes, memory-pinned type, limit
// ---------------------------------------------------------------------------

describe("memory_recall — scoped lanes and limit (AC1, doubles)", () => {
  it("searches the SERVER-DERIVED entitled lane set (user + teams + org)", async () => {
    mockTeams.mockResolvedValue([{ id: "team-a", name: "A" }]);
    await recall({ query: "how do we export" });

    expect(mockTeams).toHaveBeenCalledWith("user-1", ORG);
    const call = mockSearch.mock.calls[0]![0] as { group_ids: string[]; query: string };
    expect(new Set(call.group_ids)).toEqual(
      new Set([BASE, `${BASE}-user-user-1`, `${BASE}-team-team-a`]),
    );
    expect(call.query).toBe("how do we export");
  });

  it("project recall searches the project lanes AND the ambient lanes", async () => {
    mockTeams.mockResolvedValue([]);
    await recall({ query: "q", projectId: "proj-1" }, ACTOR_WITH_PROJECT);

    const call = mockSearch.mock.calls[0]![0] as { group_ids: string[] };
    expect(new Set(call.group_ids)).toEqual(
      new Set([
        BASE,
        `${BASE}-user-user-1`,
        `${BASE}-proj-proj-1`,
        `${BASE}-user-user-1-proj-proj-1`,
      ]),
    );
  });

  // Codex convergence round 2. The lane set for a project recall includes the
  // AMBIENT lanes (cinatra#1379's derivation, shared with objects_list), but the
  // canonical read is SEALED to the project by `AND project_id = $projectId` in
  // the store. Both facts are true and they do not compose into "project recall
  // returns ambient memory". Asserted here so the contract is proven rather than
  // assumed, and so a later change to either half fails loudly.
  it("SEALS a project recall to the project: the ambient lanes inform ranking, not the result", async () => {
    semanticHit(["ambient-1", "proj-1-row"]);
    // The store applies the seal; it returns only the project row.
    mockList.mockReturnValue([memoryRow("proj-1-row", { projectId: "proj-1" })]);
    const res = (await recall(
      { query: "q", projectId: "proj-1" },
      ACTOR_WITH_PROJECT,
    )) as RecallResponse;

    // The ambient lane WAS searched...
    expect(
      (mockSearch.mock.calls[0]![0] as { group_ids: string[] }).group_ids,
    ).toContain(BASE);
    // ...and the canonical read still carries the seal, so the ambient row is gone.
    expect((mockList.mock.calls[0]![0] as Record<string, unknown>).projectId).toBe("proj-1");
    expect(res.items.map((i) => i.id)).toEqual(["proj-1-row"]);
  });

  // Crowding-out (codex convergence round 2, secondary; widened in round 2 of
  // review). THREE filters narrow AFTER the ranked fetch: the per-row
  // `object.read` probe on every call, plus `kind` and the project seal when
  // asked for. So asking the index for exactly `limit` nodes lets dropped
  // candidates eat the caller's whole budget and turn a real hit into a
  // spurious `degraded-recent`. Over-fetch, bounded.
  it("over-fetches ranked candidates because filters narrow them AFTER ranking", async () => {
    await recall({ query: "q", limit: 10, kind: "decision" });
    expect((mockSearch.mock.calls[0]![0] as { max_nodes: number }).max_nodes).toBe(50);

    mockSearch.mockClear();
    await recall({ query: "q", limit: 10, projectId: "proj-1" }, ACTOR_WITH_PROJECT);
    expect((mockSearch.mock.calls[0]![0] as { max_nodes: number }).max_nodes).toBe(50);

    // Bounded: the factor never lifts the fetch past the hard ceiling.
    mockSearch.mockClear();
    await recall({ query: "q", limit: 50, kind: "decision" });
    expect((mockSearch.mock.calls[0]![0] as { max_nodes: number }).max_nodes).toBe(
      MEMORY_RECALL_CANDIDATE_FETCH_MAX,
    );
  });

  it("pins the Postgres read to the memory concept type and to the ACTOR's org", async () => {
    semanticHit(["row-1"]);
    mockList.mockReturnValue([memoryRow("row-1")]);
    await recall({ query: "q" });

    const filter = mockList.mock.calls[0]![0] as Record<string, unknown>;
    expect(filter.type).toBe(MEMORY_CONCEPT_TYPE_ID);
    expect(filter.orgId).toBe(ORG);
  });

  it("caps the returned item count at `limit`, and asks the index for the widened budget", async () => {
    // `max_nodes` is the CANDIDATE budget, not the answer size: the post-ranking
    // filters run on every call, so it is `limit * 5`. What the caller is
    // handed is still exactly `limit`.
    semanticHit(["r1", "r2", "r3"]);
    mockList.mockReturnValue([memoryRow("r1"), memoryRow("r2"), memoryRow("r3")]);
    const res = (await recall({ query: "q", limit: 2 })) as RecallResponse;

    expect((mockSearch.mock.calls[0]![0] as { max_nodes: number }).max_nodes).toBe(10);
    expect(res.items).toHaveLength(2);
  });

  it("defaults `limit` to 10 when the caller does not ask", async () => {
    semanticHit(Array.from({ length: 20 }, (_, i) => `r${i}`));
    mockList.mockReturnValue(Array.from({ length: 20 }, (_, i) => memoryRow(`r${i}`)));
    const res = (await recall({ query: "q" })) as RecallResponse;

    expect(res.items).toHaveLength(10);
    // The candidate budget widens off the same default.
    expect((mockSearch.mock.calls[0]![0] as { max_nodes: number }).max_nodes).toBe(50);
  });

  it("preserves the semantic rank order of the returned rows", async () => {
    semanticHit(["r3", "r1", "r2"]);
    // Postgres returns them in its own order; the handler must re-impose rank.
    mockList.mockReturnValue([memoryRow("r1"), memoryRow("r2"), memoryRow("r3")]);
    const res = (await recall({ query: "q" })) as RecallResponse;
    expect(res.items.map((i) => i.id)).toEqual(["r3", "r1", "r2"]);
  });

  it("projects the capped recall row, not the whole envelope", async () => {
    // A TEAM-owned row: the owner short-circuit does not apply, so the denying
    // kernel double has to be told to admit it.
    mockCan.mockReturnValue(true);
    semanticHit(["r1"]);
    mockList.mockReturnValue([
      memoryRow("r1", {
        conceptId: "decisions/no-backcompat",
        okfType: "decision",
        title: "No backward compat",
        body: "x".repeat(MEMORY_RECALL_EXCERPT_MAX_BYTES + 500),
        visibility: "team",
        ownerLevel: "team",
        ownerId: "team-a",
        projectId: "proj-9",
      }),
    ]);
    const res = (await recall({ query: "q" })) as RecallResponse;
    const item = res.items[0]!;

    expect(item).toEqual({
      id: "r1",
      conceptPath: "decisions/no-backcompat",
      title: "No backward compat",
      kind: "decision",
      scope: {
        ownerLevel: "team",
        ownerId: "team-a",
        visibility: "team",
        projectId: "proj-9",
      },
      excerpt: expect.any(String),
      excerptTruncated: true,
    });
    expect(new TextEncoder().encode(item.excerpt).length).toBeLessThanOrEqual(
      MEMORY_RECALL_EXCERPT_MAX_BYTES,
    );
    // No envelope passthrough: the full body, links and frontmatter must not ride out.
    expect(Object.keys(item)).not.toContain("data");
    expect(JSON.stringify(item)).not.toContain("bundleId");
  });

  it("filters by `kind` against the row's okfType WITHOUT moving the type filter", async () => {
    semanticHit(["r1", "r2"]);
    mockList.mockReturnValue([
      memoryRow("r1", { okfType: "note" }),
      memoryRow("r2", { okfType: "decision" }),
    ]);
    const res = (await recall({ query: "q", kind: "decision" })) as RecallResponse;

    expect(res.items.map((i) => i.id)).toEqual(["r2"]);
    // Kind smuggling: it never becomes the SQL `type`, and never reaches SQL at all.
    const filter = mockList.mock.calls[0]![0] as Record<string, unknown>;
    expect(filter.type).toBe(MEMORY_CONCEPT_TYPE_ID);
    expect(JSON.stringify(filter)).not.toContain("decision");
  });
});

// ---------------------------------------------------------------------------
// Security posture — strict parse + caps
// ---------------------------------------------------------------------------

describe("memory_recall — refusals (security posture)", () => {
  it("REFUSES a client-supplied lane set (strict parse; lanes are server-derived only)", async () => {
    await expect(
      recall({ query: "q", group_ids: [deriveProjectionGroupId(OTHER_ORG)] }),
    ).rejects.toThrow();
    await expect(recall({ query: "q", groupIds: ["x"] })).rejects.toThrow();
    await expect(recall({ query: "q", lanes: ["x"] })).rejects.toThrow();
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("REFUSES a client-supplied orgId", async () => {
    await expect(recall({ query: "q", orgId: OTHER_ORG })).rejects.toThrow();
  });

  it("REFUSES an oversized query", async () => {
    await expect(
      recall({ query: "x".repeat(MEMORY_RECALL_QUERY_MAX_BYTES + 1) }),
    ).rejects.toThrow();
  });

  it("REFUSES a blank query rather than degrading into a recent-rows listing", async () => {
    await expect(recall({ query: "   " })).rejects.toThrow();
    await expect(recall({})).rejects.toThrow();
  });

  it("REFUSES limit above the ceiling and below 1", async () => {
    await expect(recall({ query: "q", limit: MEMORY_RECALL_MAX_LIMIT + 1 })).rejects.toThrow();
    await expect(recall({ query: "q", limit: 0 })).rejects.toThrow();
    await expect(recall({ query: "q", limit: 2.5 })).rejects.toThrow();
  });

  it("REFUSES an oversized or blank kind", async () => {
    await expect(
      recall({ query: "q", kind: "k".repeat(MEMORY_RECALL_KIND_MAX_BYTES + 1) }),
    ).rejects.toThrow();
    await expect(recall({ query: "q", kind: "  " })).rejects.toThrow();
  });

  it("404-hides a projectId the caller has no read grant on (sealed room)", async () => {
    // The lane set is derived AFTER this gate, so an unentitled project never
    // reaches searchNodes at all.
    await expect(recall({ query: "q", projectId: "proj-nope" })).rejects.toThrow(
      /not found/i,
    );
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("REFUSES an orgless actor", async () => {
    await expect(
      recall({ query: "q" }, { actorType: "model", source: "agent", userId: "u" }),
    ).rejects.toThrow(/org context/i);
  });

  // Codex convergence round 1, finding 1. `objects_list` relaxes BOTH its org
  // guard and its actor-scoped ownership SQL filter under `A2A_DEV_BYPASS`.
  // Memory recall does not inherit that relaxation: memory is org-scoped by
  // construction (an orgless lane set is `cinatra-default`, which names nothing),
  // and an unfiltered read of the memory type with a permissive kernel is a
  // cross-tenant, cross-user leak of exactly the rows that must not leak.
  it("REFUSES an orgless actor EVEN under A2A_DEV_BYPASS", async () => {
    const prev = process.env.A2A_DEV_BYPASS;
    process.env.A2A_DEV_BYPASS = "true";
    try {
      await expect(
        recall({ query: "q" }, { actorType: "model", source: "agent" }),
      ).rejects.toThrow(/org context/i);
      expect(mockSearch).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.A2A_DEV_BYPASS;
      else process.env.A2A_DEV_BYPASS = prev;
    }
  });

  it("ALWAYS passes an actor-scoped ownership filter to the store, dev-bypass or not", async () => {
    const prev = process.env.A2A_DEV_BYPASS;
    process.env.A2A_DEV_BYPASS = "true";
    try {
      semanticHit(["r1"]);
      mockList.mockReturnValue([memoryRow("r1")]);
      // A sessionless model caller WITH an org — the shape `readScopeActor`
      // would hand an UNDEFINED scope actor (no ownership WHERE clause at all).
      await recall({ query: "q" }, {
        actorType: "model",
        source: "agent",
        ...({ orgId: ORG } as unknown as Record<string, unknown>),
      });
      expect(mockList.mock.calls[0]![1]).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.A2A_DEV_BYPASS;
      else process.env.A2A_DEV_BYPASS = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — honest degradation
// ---------------------------------------------------------------------------

describe("memory_recall — honest degradation (AC2, doubles)", () => {
  it("labels a semantic-index FAILURE as degraded-recent, never as search", async () => {
    mockSearch.mockRejectedValue(new Error("graphiti down"));
    mockList.mockReturnValue([memoryRow("r1"), memoryRow("r2")]);
    const res = (await recall({ query: "how do we export" })) as RecallResponse;

    expect(res.mode).toBe("degraded-recent");
    expect(res.meta).toEqual({
      semanticSearch: "unavailable",
      fallback: "postgres_filter",
    });
    expect(res.items.length).toBeGreaterThan(0);
    // The fallback read is a RECENT-rows listing: no ids were supplied to it.
    const filter = mockList.mock.calls[0]![0] as Record<string, unknown>;
    expect(filter.ids).toBeUndefined();
  });

  it("labels `no_ids_extracted` as degradation, NOT as an empty search result", async () => {
    // Graphiti answered, but none of its ranked nodes named a row we hold.
    mockSearch.mockResolvedValue({ nodes: [{ uuid: "n-1", name: "some entity" }] });
    mockAnchors.mockReturnValue(new Map());
    mockList.mockReturnValue([memoryRow("r1")]);
    const res = (await recall({ query: "how do we export" })) as RecallResponse;

    expect(res.mode).toBe("degraded-recent");
    expect(res.meta).toEqual({
      semanticSearch: "no_ids_extracted",
      fallback: "postgres_filter",
    });
    expect(res.items).toHaveLength(1);
  });

  it("an EMPTY degraded set is still degraded-recent, not a clean semantic miss", async () => {
    mockSearch.mockRejectedValue(new Error("down"));
    mockList.mockReturnValue([]);
    const res = (await recall({ query: "q" })) as RecallResponse;
    expect(res.mode).toBe("degraded-recent");
    expect(res.items).toEqual([]);
  });

  it("labels a real ranked hit as semantic, with no degradation metadata", async () => {
    semanticHit(["r1"]);
    mockList.mockReturnValue([memoryRow("r1")]);
    const res = (await recall({ query: "q" })) as RecallResponse;

    expect(res.mode).toBe("semantic");
    expect(res.ordering).toBe("semantic-rank");
    expect(res.meta).toBeUndefined();
  });

  it("names the degraded ORDERING as lexical fallback, never as semantic rank", async () => {
    mockSearch.mockRejectedValue(new Error("down"));
    mockList.mockReturnValue([
      memoryRow("r1", { title: "unrelated", body: "nothing here" }),
      memoryRow("r2", { title: "export pipeline", body: "how we export" }),
    ]);
    const res = (await recall({ query: "export" })) as RecallResponse;

    expect(res.mode).toBe("degraded-recent");
    expect(res.ordering).toBe("lexical-fallback");
    // The lexical pass reorders the RECENT candidate set; it does not relabel it.
    expect(res.items[0]!.id).toBe("r2");
  });

  // Codex convergence round 1, finding 2. `resolveObjectIds` still runs the
  // DEMOTED incidental probes, which can lift a syntactically valid UUID off a
  // node that names no row we hold. A non-empty id list that recovers NO row is
  // the same fact `no_ids_extracted` states — the ranked hits were other nodes —
  // so it must degrade, not answer "semantic search found nothing".
  it("degrades when ranked ids recover NO row (not a clean semantic miss)", async () => {
    semanticHit(["ghost-1", "ghost-2"]);
    mockList
      .mockReturnValueOnce([]) // the ranked-id fetch recovers nothing
      .mockReturnValueOnce([memoryRow("r1")]); // the degraded recent listing
    const res = (await recall({ query: "q" })) as RecallResponse;

    expect(res.mode).toBe("degraded-recent");
    expect(res.meta).toEqual({
      semanticSearch: "no_ids_extracted",
      fallback: "postgres_filter",
    });
    expect(res.items.map((i) => i.id)).toEqual(["r1"]);
    // The second read is the recent-rows listing: no ids, and it is a REAL read
    // rather than a silent empty answer.
    expect(mockList).toHaveBeenCalledTimes(2);
    expect((mockList.mock.calls[1]![0] as Record<string, unknown>).ids).toBeUndefined();
  });

  it("keeps mode `semantic` when rows WERE recovered and a filter emptied them", async () => {
    // The search worked and named rows we hold; `kind` then removed them. That
    // is an honest empty SEARCH result, and calling it degradation would be the
    // same dishonesty pointing the other way.
    semanticHit(["r1"]);
    mockList.mockReturnValue([memoryRow("r1", { okfType: "note" })]);
    const res = (await recall({ query: "q", kind: "decision" })) as RecallResponse;

    expect(res.mode).toBe("semantic");
    expect(res.meta).toBeUndefined();
    expect(res.items).toEqual([]);
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it("still respects `limit` on the degraded path", async () => {
    mockSearch.mockRejectedValue(new Error("down"));
    mockList.mockReturnValue([memoryRow("r1"), memoryRow("r2"), memoryRow("r3")]);
    const res = (await recall({ query: "q", limit: 2 })) as RecallResponse;
    expect(res.items).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Round 1, item 1 — the ranked read must not be truncated by the database.
//
// `listObjectsByFilter` suppresses `ORDER BY` whenever `ids` is set and applies
// `LIMIT 100` when the caller passes no limit. The double below reproduces both
// facts, so a ranked read that hands over more than 100 candidates without a
// limit loses rows in an order it did not choose — and the response still says
// `semantic` / `semantic-rank`. Captured RED against the handler before the
// `limit: candidateIds.length` argument existed: the top-ranked row was absent
// and the answer was ranks 50-59.
// ---------------------------------------------------------------------------

type StoreFilter = { ids?: string[]; limit?: number };

/** The store, behaving the way the SQL does on an id read. */
function storeBehavesLikeSql(rows: Array<ReturnType<typeof memoryRow>>) {
  mockList.mockImplementation((filter: StoreFilter) => {
    const pool = filter.ids ? rows.filter((r) => filter.ids!.includes(r.id)) : rows;
    // With no ORDER BY the database is free to return any order. Reversed is a
    // legal one, and it is the one that puts the top rank at the far end.
    const arbitrary = [...pool].reverse();
    return arbitrary.slice(0, filter.limit ?? 100);
  });
}

describe("memory_recall — the ranked read is bounded, not truncated (item 1)", () => {
  it("keeps the TOP rank on a 150-candidate read (the measured regression)", async () => {
    // Round 1's measurement, reproduced: 150 ranked ids at the default limit.
    // Unfixed, all 150 went to the store with no limit, the SQL kept an
    // arbitrary 100 of them and the answer was ranks 50-59 labelled `semantic`.
    const ids = Array.from({ length: 150 }, (_, i) => `r${i}`);
    semanticHit(ids);
    storeBehavesLikeSql(ids.map((id) => memoryRow(id)));

    const res = (await recall({ query: "q", kind: "note" })) as RecallResponse;

    // `kind` widens the budget to 5 x 10; the id list is cut to it BEFORE the
    // read, and the read asks for exactly that many.
    const call = mockList.mock.calls[0]![0] as StoreFilter;
    expect(call.ids).toHaveLength(50);
    expect(call.limit).toBe(50);
    expect(call.ids![0]).toBe("r0");
    expect(res.items.map((i) => i.id)).toEqual(ids.slice(0, 10));
    expect(res.mode).toBe("semantic");
    expect(res.ordering).toBe("semantic-rank");
  });

  it("asks for EVERY candidate when the budget exceeds the SQL default of 100", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `r${i}`);
    semanticHit(ids);
    storeBehavesLikeSql(ids.map((id) => memoryRow(id)));

    // limit 50 + `kind` puts candidateLimit at the 250 ceiling, so all 150 ids
    // are legitimate candidates and none may be lost to the default LIMIT 100.
    const res = (await recall({
      query: "q",
      kind: "note",
      limit: MEMORY_RECALL_MAX_LIMIT,
    })) as RecallResponse;

    const call = mockList.mock.calls[0]![0] as StoreFilter;
    expect(call.ids).toHaveLength(150);
    expect(call.limit).toBe(150);
    expect(res.items.map((i) => i.id)).toEqual(ids.slice(0, MEMORY_RECALL_MAX_LIMIT));
  });

  it("caps the candidate set at candidateLimit and drops the LOWEST ranks only", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `r${i}`);
    semanticHit(ids);
    storeBehavesLikeSql(ids.map((id) => memoryRow(id)));

    const res = (await recall({
      query: "q",
      kind: "note",
      limit: MEMORY_RECALL_MAX_LIMIT,
    })) as RecallResponse;

    const call = mockList.mock.calls[0]![0] as StoreFilter;
    expect(call.ids).toHaveLength(MEMORY_RECALL_CANDIDATE_FETCH_MAX);
    expect(call.limit).toBe(MEMORY_RECALL_CANDIDATE_FETCH_MAX);
    expect(call.ids![0]).toBe("r0");
    expect(call.ids![MEMORY_RECALL_CANDIDATE_FETCH_MAX - 1]).toBe(
      `r${MEMORY_RECALL_CANDIDATE_FETCH_MAX - 1}`,
    );
    expect(res.items.map((i) => i.id)).toEqual(ids.slice(0, MEMORY_RECALL_MAX_LIMIT));
  });

  it("stays bounded when one merged anchor names MORE rows than max_nodes asked for", async () => {
    // `resolveObjectIds` takes every row a merged anchor names, so the id list
    // is NOT already bounded by `max_nodes`. Without the slice the read would
    // ask for 121 ids on a 50-candidate budget.
    const many = Array.from({ length: 120 }, (_, i) => `m${i}`);
    mockSearch.mockResolvedValue({
      nodes: [
        { uuid: "anchor-0", name: "n0" },
        { uuid: "anchor-1", name: "n1" },
      ],
    });
    mockAnchors.mockReturnValue(
      new Map([
        ["anchor-0", many],
        ["anchor-1", ["m-last"]],
      ]),
    );
    storeBehavesLikeSql([...many, "m-last"].map((id) => memoryRow(id)));

    const res = (await recall({ query: "q", limit: 10 })) as RecallResponse;

    const call = mockList.mock.calls[0]![0] as StoreFilter;
    // The candidate budget is the widened one (`limit * 5`, round 2 item 2) and
    // the slice holds it: 50 ids reach the read, not 121, and the read asks for
    // exactly the ids that survived. The ANSWER is still `limit`.
    expect(call.ids).toHaveLength(50);
    expect(call.limit).toBe(50);
    expect(res.items.map((i) => i.id)).toEqual(many.slice(0, 10));
  });
});

// ---------------------------------------------------------------------------
// Round 1, item 2 — `mode` is required by something.
// ---------------------------------------------------------------------------

describe("memory_recall — the response shape is enforced (item 2)", () => {
  it("the response schema REFUSES a response with no `mode`", () => {
    const noMode = memoryRecallResponseSchema.safeParse({
      items: [],
      ordering: "semantic-rank",
    });
    expect(noMode.success).toBe(false);
  });

  it("the response schema refuses an unknown `mode`, `ordering` or extra key", () => {
    expect(
      memoryRecallResponseSchema.safeParse({
        items: [],
        mode: "ranked",
        ordering: "semantic-rank",
      }).success,
    ).toBe(false);
    expect(
      memoryRecallResponseSchema.safeParse({
        items: [],
        mode: "semantic",
        ordering: "recency",
      }).success,
    ).toBe(false);
    expect(
      memoryRecallResponseSchema.safeParse({
        items: [],
        mode: "semantic",
        ordering: "semantic-rank",
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  // Not "the two paths that exist": every path a caller can reach is bound to
  // the SAME parse the handler returns through, so a third one inherits it.
  it("EVERY reachable path returns a response that satisfies the schema", async () => {
    const paths: Array<() => Promise<unknown>> = [
      // a real ranked hit
      async () => {
        semanticHit(["r1"]);
        mockList.mockReturnValue([memoryRow("r1")]);
        return recall({ query: "q" });
      },
      // the index threw
      async () => {
        mockSearch.mockRejectedValue(new Error("down"));
        mockList.mockReturnValue([memoryRow("r1")]);
        return recall({ query: "q" });
      },
      // ranked ids recovered no row
      async () => {
        semanticHit(["ghost"]);
        mockList.mockReturnValueOnce([]).mockReturnValueOnce([memoryRow("r1")]);
        return recall({ query: "q" });
      },
      // an empty corpus
      async () => {
        mockSearch.mockResolvedValue({ nodes: [] });
        mockList.mockReturnValue([]);
        return recall({ query: "q" });
      },
      // a ranked hit that `kind` then empties
      async () => {
        semanticHit(["r1"]);
        mockList.mockReturnValue([memoryRow("r1", { okfType: "note" })]);
        return recall({ query: "q", kind: "decision" });
      },
    ];

    for (const path of paths) {
      mockSearch.mockReset();
      mockAnchors.mockReset();
      mockAnchors.mockReturnValue(new Map());
      mockList.mockReset();
      const res = await path();
      const parsed = memoryRecallResponseSchema.safeParse(res);
      expect(parsed.success).toBe(true);
      expect((res as RecallResponse).mode).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Round 1, item 3 — every projected field is capped, and so is the total.
// ---------------------------------------------------------------------------

const utf8 = (v: string) => new TextEncoder().encode(v).length;

describe("memory_recall — the projection caps EVERY field (item 3)", () => {
  it("caps `title`, `kind` and `conceptPath`, not only the excerpt", async () => {
    semanticHit(["r1"]);
    mockList.mockReturnValue([
      memoryRow("r1", {
        title: "T".repeat(30 * 1024),
        okfType: "K".repeat(4096),
        conceptId: "C".repeat(8192),
        body: "b".repeat(4096),
      }),
    ]);
    const item = ((await recall({ query: "q" })) as RecallResponse).items[0]!;

    expect(utf8(item.title!)).toBeLessThanOrEqual(MEMORY_RECALL_TITLE_MAX_BYTES);
    expect(utf8(item.kind!)).toBeLessThanOrEqual(MEMORY_RECALL_ITEM_KIND_MAX_BYTES);
    expect(utf8(item.conceptPath!)).toBeLessThanOrEqual(MEMORY_RECALL_CONCEPT_PATH_MAX_BYTES);
    expect(utf8(item.excerpt)).toBeLessThanOrEqual(MEMORY_RECALL_EXCERPT_MAX_BYTES);
  });

  it("caps on BYTES, not code units, and never splits a code point", async () => {
    semanticHit(["r1"]);
    mockList.mockReturnValue([
      memoryRow("r1", { title: "ä".repeat(MEMORY_RECALL_TITLE_MAX_BYTES) }),
    ]);
    const item = ((await recall({ query: "q" })) as RecallResponse).items[0]!;
    expect(utf8(item.title!)).toBeLessThanOrEqual(MEMORY_RECALL_TITLE_MAX_BYTES);
    expect(item.title).not.toContain("�");
  });

  it("bounds the WHOLE response and says so when it drops rows", async () => {
    const rows = Array.from({ length: MEMORY_RECALL_MAX_LIMIT }, (_, i) =>
      memoryRow(`r${i}`, {
        title: "T".repeat(4096),
        okfType: "K".repeat(4096),
        conceptId: "C".repeat(8192),
        body: "b".repeat(8192),
      }),
    );
    semanticHit(rows.map((r) => r.id));
    mockList.mockReturnValue(rows);

    const res = (await recall({
      query: "q",
      limit: MEMORY_RECALL_MAX_LIMIT,
    })) as RecallResponse;

    // The WHOLE serialized response, not the sum of the rows: the accounting
    // charges the envelope, the brackets and every separator.
    expect(utf8(JSON.stringify(res))).toBeLessThanOrEqual(
      MEMORY_RECALL_RESPONSE_MAX_BYTES,
    );
    expect(res.items.length).toBeLessThan(MEMORY_RECALL_MAX_LIMIT);
    expect(res.items.length).toBeGreaterThan(0);
    // Reported, not silent — and reported on the SEMANTIC path too.
    expect(res.mode).toBe("semantic");
    expect(res.meta?.responseCeiling).toBe("applied");
  });

  it("holds the bound with NO exception when a single row cannot fit", async () => {
    // `id` and the `scope` fields are canonical columns, not capped
    // projections, so one row can exceed the ceiling on its own. The bound has
    // no "keep the first row anyway" escape, and the empty answer says why.
    const giant = "i".repeat(MEMORY_RECALL_RESPONSE_MAX_BYTES + 1);
    semanticHit([giant]);
    mockList.mockReturnValue([memoryRow(giant)]);
    const res = (await recall({ query: "q" })) as RecallResponse;

    expect(utf8(JSON.stringify(res))).toBeLessThanOrEqual(
      MEMORY_RECALL_RESPONSE_MAX_BYTES,
    );
    expect(res.items).toEqual([]);
    expect(res.meta?.responseCeiling).toBe("applied");
  });

  it("charges the envelope it EMITS, not a reservation", async () => {
    // Round 2, item 1. Nothing here asserts a constant: each path's answer is
    // serialized with its rows removed, and that IS what the ceiling charges.
    // The two envelopes differ, which is why one flat number could not be right
    // for both.
    semanticHit(["r1"]);
    mockList.mockReturnValue([memoryRow("r1")]);
    const ranked = (await recall({ query: "q" })) as RecallResponse;
    const rankedEnvelope = utf8(JSON.stringify({ ...ranked, items: [] }));

    mockSearch.mockRejectedValue(new Error("down"));
    mockList.mockReturnValue([memoryRow("r1")]);
    const degraded = (await recall({ query: "q" })) as RecallResponse;
    const degradedEnvelope = utf8(JSON.stringify({ ...degraded, items: [] }));

    expect(rankedEnvelope).toBeLessThan(degradedEnvelope);
    // Both are far under the 256-byte reservation this replaced; the ranked one
    // by the 201 bytes that cost a caller a row.
    expect(degradedEnvelope).toBeLessThan(256);
  });

  it("leaves `meta` absent on a ranked answer that fits", async () => {
    semanticHit(["r1"]);
    mockList.mockReturnValue([memoryRow("r1")]);
    const res = (await recall({ query: "q" })) as RecallResponse;
    expect(res.meta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Round 1, items 4 + 5 — a blank projectId must REFUSE, not silently unseal,
// and an oversized one must not reach the lanes.
// ---------------------------------------------------------------------------

describe("memory_recall — projectId is non-blank and capped (items 4, 5)", () => {
  // `.min(1)` alone admits every one of these except "". The last two are the
  // unicode spaces `String.prototype.trim` also removes, which is why the
  // refinement uses trim rather than a hand-rolled character class.
  const BLANK = ["", " ", "   ", "\t", "\n", "\r\n", "\u00a0", "\u2003"];

  it.each(BLANK)("REFUSES a blank projectId (%j) instead of unsealing", async (blank) => {
    await expect(recall({ query: "q", projectId: blank })).rejects.toThrow();
    // The refusal is at the door: no lane was derived and no read was issued.
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it("still ACCEPTS omitted and explicit null — the ambient states are correct", async () => {
    mockList.mockReturnValue([memoryRow("r1")]);
    semanticHit(["r1"]);
    const omitted = (await recall({ query: "q" })) as RecallResponse;
    expect(omitted.items.map((i) => i.id)).toEqual(["r1"]);

    semanticHit(["r1"]);
    const explicitNull = (await recall({ query: "q", projectId: null })) as RecallResponse;
    expect(explicitNull.items.map((i) => i.id)).toEqual(["r1"]);
    // Ambient: no project filter reached the store on either call.
    for (const call of mockList.mock.calls) {
      expect((call[0] as { projectId?: string | null }).projectId).toBeNull();
    }
  });

  it("refuses a projectId over the BYTE cap before it can reach a lane", async () => {
    await expect(
      recall({ query: "q", projectId: "p".repeat(PROJECT_ID_MAX_BYTES + 1) }),
    ).rejects.toThrow();
    // Multibyte: 100 three-byte code points are 300 bytes, not 100 units.
    await expect(
      recall({ query: "q", projectId: "中".repeat(100) }),
    ).rejects.toThrow();
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("accepts a projectId AT the cap (the ceiling is not off by one)", () => {
    expect(
      memoryRecallSchema.safeParse({
        query: "q",
        projectId: "p".repeat(PROJECT_ID_MAX_BYTES),
      }).success,
    ).toBe(true);
  });

  // The same gap is inherited by the two neighbouring read/write surfaces that
  // normalize projectId the same way. Fixed in the same edit, pinned here.
  it("closes the same blank/oversize gap on objects_list and objects_save", () => {
    for (const blank of BLANK) {
      expect(objectsListSchema.safeParse({ projectId: blank }).success).toBe(false);
      expect(objectsSaveSchema.safeParse({ projectId: blank }).success).toBe(false);
    }
    const huge = "p".repeat(PROJECT_ID_MAX_BYTES + 1);
    expect(objectsListSchema.safeParse({ projectId: huge }).success).toBe(false);
    expect(objectsSaveSchema.safeParse({ projectId: huge }).success).toBe(false);
    // Ambient stays legal on both.
    expect(objectsListSchema.safeParse({ projectId: null }).success).toBe(true);
    expect(objectsListSchema.safeParse({}).success).toBe(true);
    expect(objectsSaveSchema.safeParse({ projectId: null }).success).toBe(true);
    expect(objectsSaveSchema.safeParse({}).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round 1, item 6 — the per-row `object.read` probe actually drops rows.
//
// Every assertion here is vacuous without the denying kernel double installed
// at the top of this file: under the package-wide allow-by-default alias all of
// them pass with the probe removed.
// ---------------------------------------------------------------------------

/** A row the caller does NOT own — the owner short-circuit cannot admit it. */
function foreignRow(id: string) {
  return memoryRow(id, { ownerId: "user-2" });
}

describe("memory_recall — the per-row authz probe drops rows (item 6)", () => {
  it("returns the caller's own row and DROPS the row it may not read", async () => {
    semanticHit(["mine", "theirs"]);
    mockList.mockReturnValue([memoryRow("mine"), foreignRow("theirs")]);
    const res = (await recall({ query: "q" })) as RecallResponse;
    expect(res.items.map((i) => i.id)).toEqual(["mine"]);
  });

  it("answers 0 items and KEEPS mode `semantic` when every ranked row is denied", async () => {
    semanticHit(["a", "b", "c"]);
    mockList.mockReturnValue([foreignRow("a"), foreignRow("b"), foreignRow("c")]);
    const res = (await recall({ query: "q" })) as RecallResponse;
    // Rows WERE recovered for this query; a filter removed them. That is an
    // honest empty search result, not degradation.
    expect(res.items).toEqual([]);
    expect(res.mode).toBe("semantic");
    expect(res.meta).toBeUndefined();
  });

  it("drops denied rows on the DEGRADED path too", async () => {
    mockSearch.mockRejectedValue(new Error("down"));
    mockList.mockReturnValue([
      ...Array.from({ length: 5 }, (_, i) => memoryRow(`mine-${i}`)),
      ...Array.from({ length: 15 }, (_, i) => foreignRow(`theirs-${i}`)),
    ]);
    const res = (await recall({ query: "q", limit: 10 })) as RecallResponse;
    expect(res.items).toHaveLength(5);
    expect(res.items.every((i) => i.id.startsWith("mine-"))).toBe(true);
  });

  it("emits the loud internal-read drop diagnostic for a system actor", async () => {
    const events: Array<{ primitive: string; droppedCount: number; totalCount: number }> = [];
    const off = onInternalReadAuthzDrop((e) => events.push(e));
    try {
      const SYSTEM_ACTOR = {
        actorType: "system",
        source: "worker",
        ...({ orgId: ORG } as unknown as Record<string, unknown>),
      } as never;
      semanticHit(["a", "b"]);
      mockList.mockReturnValue([foreignRow("a"), foreignRow("b")]);
      const res = (await recall({ query: "q" }, SYSTEM_ACTOR)) as RecallResponse;
      expect(res.items).toEqual([]);
    } finally {
      off();
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      primitive: "memory_recall",
      droppedCount: 2,
      totalCount: 2,
    });
  });

  it("stays silent for an INTERACTIVE caller's ordinary drop", async () => {
    const events: unknown[] = [];
    const off = onInternalReadAuthzDrop((e) => events.push(e));
    try {
      semanticHit(["a"]);
      mockList.mockReturnValue([foreignRow("a")]);
      await recall({ query: "q" });
    } finally {
      off();
    }
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Round 2, item 1: the ceiling charges the envelope it EMITS.
//
// FAIL-FIRST: every assertion below was captured RED against the flat
// 256+2-byte reservation. The ranked no-meta envelope is 57 bytes, so the
// reservation charged 201 bytes that were never in the response and dropped a
// row out of the last 201 bytes under the ceiling. See the PR body for the runs.
// ---------------------------------------------------------------------------

/**
 * A row whose projection is wide and whose cost is TUNABLE: `id` is a canonical
 * column with no cap, so padding it moves the serialized item by exactly the
 * pad length. Every other field sits at its cap.
 */
function sizedRow(id: string) {
  return memoryRow(id, {
    title: "T".repeat(300),
    conceptId: "c".repeat(1200),
    body: "b".repeat(600),
  });
}

/** Serialize one recall of `ids` and report the byte size of the whole answer. */
async function recallBytes(
  ids: string[],
  opts: { degraded?: boolean } = {},
): Promise<{ res: RecallResponse; bytes: number }> {
  const rows = ids.map(sizedRow);
  if (opts.degraded) mockSearch.mockRejectedValue(new Error("down"));
  else semanticHit(ids);
  mockList.mockReturnValue(rows);
  const res = (await recall({
    query: "q",
    limit: MEMORY_RECALL_MAX_LIMIT,
  })) as RecallResponse;
  return { res, bytes: utf8(JSON.stringify(res)) };
}

/**
 * A FIXED-WIDTH row id. Every other projected field sits at its cap, so a
 * constant id width is what makes the per-item cost constant. `r9` and `r10`
 * would differ by a byte and quietly move the arithmetic below.
 */
const sizedId = (i: number) => `r${String(i).padStart(3, "0")}`;

/**
 * Measure the envelope and the per-item cost of THIS path by construction: a
 * one-row answer is `envelope + item`, a two-row answer is
 * `envelope + 2*item + 1` (the joining `,`). Nothing here assumes a constant.
 */
async function measurePath(opts: { degraded?: boolean } = {}) {
  const one = (await recallBytes([sizedId(0)], opts)).bytes;
  const two = (await recallBytes([sizedId(0), sizedId(1)], opts)).bytes;
  const itemBytes = two - one - 1;
  return { itemBytes, envelopeBytes: one - itemBytes };
}

/**
 * Ids for an answer that serializes to EXACTLY `target` bytes on a path whose
 * envelope and item cost were measured above. The last id absorbs the
 * remainder, one ASCII byte per character.
 */
function idsSizedTo(target: number, m: { itemBytes: number; envelopeBytes: number }) {
  const budget = target - m.envelopeBytes;
  const count = Math.floor((budget + 1) / (m.itemBytes + 1));
  const pad = budget - (count * m.itemBytes + (count - 1));
  return Array.from({ length: count }, (_, i) =>
    i === count - 1 ? `${sizedId(i)}${"p".repeat(pad)}` : sizedId(i),
  );
}

describe("memory_recall: the ceiling charges the emitted envelope (round 2, item 1)", () => {
  it("keeps every row of a response sitting in the last 201 bytes under the ceiling", async () => {
    // The exact window the 258-byte reservation charged away. 8 bytes of
    // headroom is the reviewer's own measurement.
    const m = await measurePath();
    const ids = idsSizedTo(MEMORY_RECALL_RESPONSE_MAX_BYTES - 8, m);

    const { res, bytes } = await recallBytes(ids);

    expect(bytes).toBe(MEMORY_RECALL_RESPONSE_MAX_BYTES - 8);
    expect(MEMORY_RECALL_RESPONSE_MAX_BYTES - bytes).toBeLessThanOrEqual(201);
    expect(res.items).toHaveLength(ids.length);
    // Nothing was dropped, so nothing is reported.
    expect(res.meta).toBeUndefined();
  });

  it("keeps every row of a response that lands EXACTLY on the ceiling", async () => {
    const m = await measurePath();
    const ids = idsSizedTo(MEMORY_RECALL_RESPONSE_MAX_BYTES, m);

    const { res, bytes } = await recallBytes(ids);

    expect(bytes).toBe(MEMORY_RECALL_RESPONSE_MAX_BYTES);
    expect(res.items).toHaveLength(ids.length);
    expect(res.meta).toBeUndefined();
  });

  it("drops at ONE byte over, and the answer it emits still fits", async () => {
    const m = await measurePath();
    // One byte past the ceiling: the last row cannot ride out.
    const ids = idsSizedTo(MEMORY_RECALL_RESPONSE_MAX_BYTES + 1, m);

    const { res, bytes } = await recallBytes(ids);

    expect(res.items).toHaveLength(ids.length - 1);
    expect(res.meta?.responseCeiling).toBe("applied");
    // The re-charge is the point: `meta.responseCeiling` is 30 more bytes than
    // the envelope the fit was measured against, and the EMITTED answer is what
    // has to be under the ceiling.
    expect(bytes).toBeLessThanOrEqual(MEMORY_RECALL_RESPONSE_MAX_BYTES);
  });

  it("charges the DEGRADED envelope on the degraded path, not the ranked one", async () => {
    // The degraded envelope carries `meta.semanticSearch` + `meta.fallback` and
    // is the widest one the schema admits. A single flat reservation is either
    // too small for this path or too large for the ranked one; measured per
    // path, both are exact.
    const ranked = await measurePath();
    const degraded = await measurePath({ degraded: true });
    expect(degraded.envelopeBytes).toBeGreaterThan(ranked.envelopeBytes);

    const ids = idsSizedTo(MEMORY_RECALL_RESPONSE_MAX_BYTES, degraded);
    const { res, bytes } = await recallBytes(ids, { degraded: true });

    expect(res.mode).toBe("degraded-recent");
    expect(bytes).toBe(MEMORY_RECALL_RESPONSE_MAX_BYTES);
    expect(res.items).toHaveLength(ids.length);
    expect(res.meta?.responseCeiling).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Round 2, item 2: the over-fetch widens for the per-row authz probe too.
//
// FAIL-FIRST: captured RED against `candidateLimit = limit` on an ambient
// recall. `filterByAuthz` runs AFTER the read on BOTH paths, so every denied
// row cost the caller a row of its budget: 25 ranked ids, 15 unreadable,
// `limit: 10` answered 5.
// ---------------------------------------------------------------------------

describe("memory_recall: the authz probe is a post-ranking filter too (round 2, item 2)", () => {
  it("fills `limit` on an AMBIENT recall when the probe denies rows", async () => {
    // No `kind`, no `projectId`: the case the round-1 condition left narrow.
    // 25 ranked ids, a denied row at every other rank, 10 readable in the corpus.
    const ids = Array.from({ length: 25 }, (_, i) => `r${i}`);
    const rows = ids.map((id, i) => (i % 2 === 1 ? foreignRow(id) : memoryRow(id)));
    semanticHit(ids);
    mockList.mockImplementation((filter: StoreFilter) => {
      const pool = filter.ids ? rows.filter((r) => filter.ids!.includes(r.id)) : rows;
      return pool.slice(0, filter.limit ?? 100);
    });

    const res = (await recall({ query: "q", limit: 10 })) as RecallResponse;

    expect((mockSearch.mock.calls[0]![0] as { max_nodes: number }).max_nodes).toBe(50);
    expect(res.items).toHaveLength(10);
    expect(res.mode).toBe("semantic");
    expect(res.items.every((i) => !i.id.startsWith("theirs"))).toBe(true);
  });

  it("widens the budget on EVERY call, with or without a narrowing filter", async () => {
    // The probe runs on every call, so the widening is unconditional. Same
    // number on all four shapes.
    for (const input of [
      { query: "q", limit: 10 },
      { query: "q", limit: 10, kind: "decision" },
    ]) {
      mockSearch.mockClear();
      await recall(input);
      expect((mockSearch.mock.calls[0]![0] as { max_nodes: number }).max_nodes).toBe(50);
    }
    mockSearch.mockClear();
    await recall({ query: "q", limit: 10, projectId: "proj-1" }, ACTOR_WITH_PROJECT);
    expect((mockSearch.mock.calls[0]![0] as { max_nodes: number }).max_nodes).toBe(50);
  });

  it("fills `limit` on the DEGRADED path when the probe denies rows", async () => {
    mockSearch.mockRejectedValue(new Error("down"));
    const rows = Array.from({ length: 50 }, (_, i) =>
      i % 2 === 1 ? foreignRow(`r${i}`) : memoryRow(`r${i}`),
    );
    mockList.mockImplementation((filter: StoreFilter) => rows.slice(0, filter.limit ?? 100));

    const res = (await recall({ query: "q", limit: 10 })) as RecallResponse;

    expect((mockList.mock.calls[0]![0] as StoreFilter).limit).toBe(50);
    expect(res.items).toHaveLength(10);
  });

  it("stays bounded by the hard candidate ceiling", async () => {
    await recall({ query: "q", limit: MEMORY_RECALL_MAX_LIMIT });
    expect((mockSearch.mock.calls[0]![0] as { max_nodes: number }).max_nodes).toBe(
      MEMORY_RECALL_CANDIDATE_FETCH_MAX,
    );
  });
});

// ---------------------------------------------------------------------------
// Round 2, item 4: the response schema binds `mode` to `ordering` and to the
// `meta` vocabulary.
//
// FAIL-FIRST: captured RED against the two independent enums, which accepted
// `semantic` / `lexical-fallback`, `degraded-recent` / `semantic-rank` and a
// `semantic` answer carrying `meta.semanticSearch`.
// ---------------------------------------------------------------------------

describe("memory_recall: mode, ordering and meta agree (round 2, item 4)", () => {
  const items: never[] = [];

  it("REFUSES a semantic answer ordered by the lexical fallback", () => {
    expect(
      memoryRecallResponseSchema.safeParse({
        items,
        mode: "semantic",
        ordering: "lexical-fallback",
      }).success,
    ).toBe(false);
  });

  it("REFUSES a degraded answer claiming semantic rank", () => {
    expect(
      memoryRecallResponseSchema.safeParse({
        items,
        mode: "degraded-recent",
        ordering: "semantic-rank",
        meta: { semanticSearch: "unavailable", fallback: "postgres_filter" },
      }).success,
    ).toBe(false);
  });

  it("REFUSES a semantic answer carrying the degradation metadata", () => {
    expect(
      memoryRecallResponseSchema.safeParse({
        items,
        mode: "semantic",
        ordering: "semantic-rank",
        meta: { semanticSearch: "unavailable" },
      }).success,
    ).toBe(false);
    expect(
      memoryRecallResponseSchema.safeParse({
        items,
        mode: "semantic",
        ordering: "semantic-rank",
        meta: { fallback: "postgres_filter" },
      }).success,
    ).toBe(false);
  });

  it("REFUSES a degraded answer that does not say WHY it degraded", () => {
    expect(
      memoryRecallResponseSchema.safeParse({
        items,
        mode: "degraded-recent",
        ordering: "lexical-fallback",
      }).success,
    ).toBe(false);
    expect(
      memoryRecallResponseSchema.safeParse({
        items,
        mode: "degraded-recent",
        ordering: "lexical-fallback",
        meta: { fallback: "postgres_filter" },
      }).success,
    ).toBe(false);
  });

  it("keeps `meta.responseCeiling` legal on BOTH paths; it is orthogonal to degradation", () => {
    expect(
      memoryRecallResponseSchema.safeParse({
        items,
        mode: "semantic",
        ordering: "semantic-rank",
        meta: { responseCeiling: "applied" },
      }).success,
    ).toBe(true);
    expect(
      memoryRecallResponseSchema.safeParse({
        items,
        mode: "degraded-recent",
        ordering: "lexical-fallback",
        meta: {
          semanticSearch: "no_ids_extracted",
          fallback: "postgres_filter",
          responseCeiling: "applied",
        },
      }).success,
    ).toBe(true);
  });

  it("REFUSES an EMPTY meta on the ranked path", () => {
    // Codex convergence round 2 on this change: `meta: {}` said nothing, and
    // the handler never emits it. The ranked arm has exactly two shapes.
    expect(
      memoryRecallResponseSchema.safeParse({
        items,
        mode: "semantic",
        ordering: "semantic-rank",
        meta: {},
      }).success,
    ).toBe(false);
  });

  it("accepts the two answers the handler actually produces, and no third", () => {
    expect(
      memoryRecallResponseSchema.safeParse({
        items,
        mode: "semantic",
        ordering: "semantic-rank",
      }).success,
    ).toBe(true);
    expect(
      memoryRecallResponseSchema.safeParse({
        items,
        mode: "degraded-recent",
        ordering: "lexical-fallback",
        meta: { semanticSearch: "unavailable", fallback: "postgres_filter" },
      }).success,
    ).toBe(true);
    // `.strict()` survives the union: an extra key is still a rejection.
    expect(
      memoryRecallResponseSchema.safeParse({
        items,
        mode: "semantic",
        ordering: "semantic-rank",
        cursor: "c",
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round 2, item 5: `objects_update` is the fourth `projectId` surface.
//
// FAIL-FIRST: captured RED against `z.string().nullable().optional()`, which
// accepted every blank form and a 1 MiB value.
// ---------------------------------------------------------------------------

describe("objects_update: projectId is non-blank and capped (round 2, item 5)", () => {
  it("REFUSES a blank or whitespace-only projectId on the project MOVE field", () => {
    for (const blank of ["", " ", "   ", "\t", "\n", " ", "　"]) {
      expect(
        objectsUpdateSchema.safeParse({ objectId: "o1", projectId: blank }).success,
      ).toBe(false);
    }
  });

  it("REFUSES a projectId over the BYTE cap", () => {
    expect(
      objectsUpdateSchema.safeParse({
        objectId: "o1",
        projectId: "p".repeat(PROJECT_ID_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
    // Bytes, not code units.
    expect(
      objectsUpdateSchema.safeParse({
        objectId: "o1",
        projectId: "é".repeat(PROJECT_ID_MAX_BYTES),
      }).success,
    ).toBe(false);
    expect(
      objectsUpdateSchema.safeParse({
        objectId: "o1",
        projectId: "p".repeat(PROJECT_ID_MAX_BYTES),
      }).success,
    ).toBe(true);
  });

  it("still accepts null and omission; the UNSET move and the no-op are unchanged", () => {
    // `null` is the move-to-ambient instruction and omission means "do not
    // move". Neither is narrowed, and neither is what the refinement is about.
    expect(
      objectsUpdateSchema.safeParse({ objectId: "o1", projectId: null }).success,
    ).toBe(true);
    expect(objectsUpdateSchema.safeParse({ objectId: "o1" }).success).toBe(true);
  });
});
