// Read-path handler tests.
//
// These tests assert the Postgres-primary read contract:
//   - objects_get reads via getObjectById; never calls Graphiti.
//   - objects_list (no query) reads via listObjectsByFilter; never calls Graphiti.
//   - objects_list (with query) calls searchNodes for ranked IDs, then
//     listObjectsByFilter({ ids }) for canonical rows. Ranking is preserved
//     via Map<string, ObjectRecord>.
//   - When searchNodes throws, response carries
//     meta.semanticSearch="unavailable" + meta.fallback="postgres_filter"
//     and the body comes from a Postgres-only listObjectsByFilter call
//     so semantic search outages do not block canonical reads.
//   - Orphan ids (Graphiti returns ids with no matching Postgres row) are
//     filtered out — no nulls in the response.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/objects-store", () => ({
  upsertObjectAndEnqueue: vi.fn(),
  getObjectById: vi.fn(),
  listObjectsByFilter: vi.fn(),
  softDeleteObject: vi.fn(),
}));

vi.mock("@/lib/objects-dual-write", () => ({
  shadowUpsertObject: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  readObjectsClassificationModelFromDatabase: vi.fn(() => "openai:gpt-4o-mini"),
}));

vi.mock("../classifier", () => ({
  classifyObject: vi.fn(),
}));

vi.mock("../auto-registrar", () => ({
  ensureDynamicObjectType: vi.fn(),
  readActiveDynamicObjectTypes: vi.fn(async () => []),
  readAllDynamicObjectTypes: vi.fn(async () => []),
  readDynamicObjectTypeByType: vi.fn(async () => null),
}));

vi.mock("../graphiti-client", () => ({
  searchNodes: vi.fn(async () => ({ nodes: [] })),
  addEpisode: vi.fn(),
  deleteEpisode: vi.fn(),
  getEpisodes: vi.fn(async () => ({ episodes: [] })),
  identityHashToUuid: (h: string) => h,
}));

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import { getObjectById, listObjectsByFilter } from "@/lib/objects-store";
import { searchNodes, getEpisodes } from "../graphiti-client";

const mockGet = getObjectById as unknown as ReturnType<typeof vi.fn>;
const mockList = listObjectsByFilter as unknown as ReturnType<typeof vi.fn>;
const mockSearch = searchNodes as unknown as ReturnType<typeof vi.fn>;
const mockGetEpisodes = getEpisodes as unknown as ReturnType<typeof vi.fn>;

const ACTOR = {
  actorType: "model",
  source: "agent",
  ...({ orgId: "org-1", agentId: "a1", runId: "r1" } as unknown as Record<string, unknown>),
} as never;

function fakeRow(id: string) {
  return {
    id,
    type: "test",
    parentId: null,
    parentType: null,
    data: { name: id },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdBy: null,
    orgId: "org-1",
    source: null,
    runId: null,
    agentId: null,
    packageVersion: null,
    agentSpecVersion: null,
    version: 1,
    deletedAt: null,
  };
}

describe("objects_get — Postgres-primary read", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSearch.mockReset();
    mockGetEpisodes.mockReset();
    mockGetEpisodes.mockResolvedValue({ episodes: [] });
  });

  it("Test 1: calls getObjectById, never calls searchNodes or getEpisodes", async () => {
    mockGet.mockReturnValue(fakeRow("obj-1"));
    const handlers = createObjectsPrimitiveHandlers();
    await handlers.objects_get({
      primitiveName: "objects_get",
      input: { objectId: "obj-1" },
      actor: ACTOR,
      mode: "deterministic",
    });
    expect(mockGet).toHaveBeenCalledWith("obj-1", { orgId: "org-1" });
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockGetEpisodes).not.toHaveBeenCalled();
  });

  it("Test 2: returns { object: null } when getObjectById returns null", async () => {
    mockGet.mockReturnValue(null);
    const handlers = createObjectsPrimitiveHandlers();
    const res = await handlers.objects_get({
      primitiveName: "objects_get",
      input: { objectId: "missing" },
      actor: ACTOR,
      mode: "deterministic",
    });
    expect((res as { object: unknown }).object).toBeNull();
  });
});

describe("objects_list without query — Postgres-only", () => {
  beforeEach(() => {
    mockList.mockReset();
    mockSearch.mockReset();
    mockGetEpisodes.mockReset();
    mockGetEpisodes.mockResolvedValue({ episodes: [] });
  });

  it("Test 3: calls listObjectsByFilter, never searchNodes or getEpisodes", async () => {
    mockList.mockReturnValue([fakeRow("a"), fakeRow("b")]);
    const handlers = createObjectsPrimitiveHandlers();
    await handlers.objects_list({
      primitiveName: "objects_list",
      input: { type: "test" },
      actor: ACTOR,
      mode: "deterministic",
    });
    expect(mockList).toHaveBeenCalled();
    const filter = mockList.mock.calls[0][0];
    expect(filter.orgId).toBe("org-1");
    expect(filter.type).toBe("test");
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockGetEpisodes).not.toHaveBeenCalled();
  });
});

describe("objects_list with query — semantic", () => {
  beforeEach(() => {
    mockList.mockReset();
    mockSearch.mockReset();
    mockGetEpisodes.mockReset();
    mockGetEpisodes.mockResolvedValue({ episodes: [] });
  });

  it("Test 4: calls searchNodes then listObjectsByFilter with ids[]", async () => {
    mockSearch.mockResolvedValue({
      nodes: [
        {
          uuid: "n1",
          name: "A",
          summary: "",
          labels: [],
          group_id: "g",
          attributes: { cinatra_object_id: "a" },
        },
        {
          uuid: "n2",
          name: "B",
          summary: "",
          labels: [],
          group_id: "g",
          attributes: { cinatra_object_id: "b" },
        },
      ],
    });
    mockList.mockReturnValue([fakeRow("a"), fakeRow("b")]);
    const handlers = createObjectsPrimitiveHandlers();
    await handlers.objects_list({
      primitiveName: "objects_list",
      input: { query: "test query", type: "test" },
      actor: ACTOR,
      mode: "deterministic",
    });
    expect(mockSearch).toHaveBeenCalledOnce();
    const lastListCall = mockList.mock.calls[mockList.mock.calls.length - 1][0];
    expect(lastListCall.ids).toEqual(["a", "b"]);
    expect(lastListCall.orgId).toBe("org-1");
  });

  it("Test 5: ranking preserved (Graphiti order survives Postgres fetch)", async () => {
    mockSearch.mockResolvedValue({
      nodes: [
        {
          uuid: "n1",
          name: "B",
          summary: "",
          labels: [],
          group_id: "g",
          attributes: { cinatra_object_id: "b" },
        },
        {
          uuid: "n2",
          name: "A",
          summary: "",
          labels: [],
          group_id: "g",
          attributes: { cinatra_object_id: "a" },
        },
        {
          uuid: "n3",
          name: "C",
          summary: "",
          labels: [],
          group_id: "g",
          attributes: { cinatra_object_id: "c" },
        },
      ],
    });
    // Postgres returns rows in insertion / created_at order — NOT the Graphiti
    // rank order. The handler must preserve the Graphiti rank via Map lookup.
    mockList.mockReturnValue([fakeRow("a"), fakeRow("b"), fakeRow("c")]);
    const handlers = createObjectsPrimitiveHandlers();
    const res = await handlers.objects_list({
      primitiveName: "objects_list",
      input: { query: "x" },
      actor: ACTOR,
      mode: "deterministic",
    });
    const ids = (res as { items: { id: string }[] }).items.map((i) => i.id);
    expect(ids).toEqual(["b", "a", "c"]);
  });

  it("Test 6: Graphiti unavailable → meta + Postgres fallback", async () => {
    mockSearch.mockRejectedValue(new Error("graphiti down"));
    mockList.mockReturnValue([fakeRow("a"), fakeRow("b")]);
    const handlers = createObjectsPrimitiveHandlers();
    const res = await handlers.objects_list({
      primitiveName: "objects_list",
      input: { query: "x", type: "test" },
      actor: ACTOR,
      mode: "deterministic",
    });
    const meta = (res as { meta?: { semanticSearch?: string; fallback?: string } }).meta;
    expect(meta?.semanticSearch).toBe("unavailable");
    expect(meta?.fallback).toBe("postgres_filter");
    expect(mockList).toHaveBeenCalled();
    // Fallback list call must NOT include `ids` filter.
    const fallbackCall = mockList.mock.calls[mockList.mock.calls.length - 1][0];
    expect(fallbackCall.ids).toBeUndefined();
  });

  it("Test 7: orphan ids (no matching PG row) are filtered out", async () => {
    mockSearch.mockResolvedValue({
      nodes: [
        {
          uuid: "n1",
          name: "A",
          summary: "",
          labels: [],
          group_id: "g",
          attributes: { cinatra_object_id: "a" },
        },
        {
          uuid: "n2",
          name: "Orphan",
          summary: "",
          labels: [],
          group_id: "g",
          attributes: { cinatra_object_id: "orphan-id" },
        },
      ],
    });
    // Postgres only knows about "a" — the orphan id should be skipped.
    mockList.mockReturnValue([fakeRow("a")]);
    const handlers = createObjectsPrimitiveHandlers();
    const res = await handlers.objects_list({
      primitiveName: "objects_list",
      input: { query: "x" },
      actor: ACTOR,
      mode: "deterministic",
    });
    const ids = (res as { items: { id: string }[] }).items.map((i) => i.id);
    expect(ids).toEqual(["a"]);
  });
});
