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

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import { searchNodes } from "../graphiti-client";
import {
  listObjectsByFilter,
  resolveObjectIdsByAnchorNodeUuids,
} from "@/lib/objects-store";
import { readTeamsForUser } from "@/lib/better-auth-db";
import { deriveProjectionGroupId } from "../graphiti-projection-policy";
import {
  MEMORY_RECALL_CANDIDATE_FETCH_MAX,
  MEMORY_RECALL_EXCERPT_MAX_BYTES,
} from "../mcp/handlers";
import {
  MEMORY_RECALL_KIND_MAX_BYTES,
  MEMORY_RECALL_MAX_LIMIT,
  MEMORY_RECALL_QUERY_MAX_BYTES,
} from "../mcp/schemas";

const MEMORY_CONCEPT_TYPE_ID = "@cinatra-ai/memory:concept";
const ORG = "org-1";
const OTHER_ORG = "org-2";
const BASE = deriveProjectionGroupId(ORG);

const mockSearch = searchNodes as unknown as ReturnType<typeof vi.fn>;
const mockList = listObjectsByFilter as unknown as ReturnType<typeof vi.fn>;
const mockAnchors = resolveObjectIdsByAnchorNodeUuids as unknown as ReturnType<typeof vi.fn>;
const mockTeams = readTeamsForUser as unknown as ReturnType<typeof vi.fn>;

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
  meta?: { semanticSearch?: string; fallback?: string };
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

  // Crowding-out (codex convergence round 2, secondary). A project recall and a
  // `kind` recall both narrow AFTER the ranked fetch, so asking the index for
  // exactly `limit` nodes lets dropped candidates eat the caller's whole budget
  // and turn a real hit into a spurious `degraded-recent`. Over-fetch, bounded.
  it("over-fetches ranked candidates when a filter will narrow them AFTER ranking", async () => {
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

  it("caps `max_nodes` and the returned item count at `limit`", async () => {
    semanticHit(["r1", "r2", "r3"]);
    mockList.mockReturnValue([memoryRow("r1"), memoryRow("r2"), memoryRow("r3")]);
    const res = (await recall({ query: "q", limit: 2 })) as RecallResponse;

    expect((mockSearch.mock.calls[0]![0] as { max_nodes: number }).max_nodes).toBe(2);
    expect(res.items).toHaveLength(2);
  });

  it("defaults `limit` to 10 when the caller does not ask", async () => {
    await recall({ query: "q" });
    expect((mockSearch.mock.calls[0]![0] as { max_nodes: number }).max_nodes).toBe(10);
  });

  it("preserves the semantic rank order of the returned rows", async () => {
    semanticHit(["r3", "r1", "r2"]);
    // Postgres returns them in its own order; the handler must re-impose rank.
    mockList.mockReturnValue([memoryRow("r1"), memoryRow("r2"), memoryRow("r3")]);
    const res = (await recall({ query: "q" })) as RecallResponse;
    expect(res.items.map((i) => i.id)).toEqual(["r3", "r1", "r2"]);
  });

  it("projects the capped recall row, not the whole envelope", async () => {
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
