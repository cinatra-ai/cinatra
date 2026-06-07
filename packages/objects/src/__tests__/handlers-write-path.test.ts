// Write-path handler tests assert Postgres-primary behaviour: the three
// write-path handlers must not call addEpisode/deleteEpisode/shadowUpsertObject
// directly. These flows use atomic upsertObjectAndEnqueue / softDeleteObject
// calls, with Graphiti projection handled async by graphiti-projector.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/objects-store", () => ({
  upsertObjectAndEnqueue: vi.fn(),
  getObjectById: vi.fn(),
  listObjectsByFilter: vi.fn(),
  softDeleteObject: vi.fn(),
}));

vi.mock("@/lib/objects-dual-write", () => ({
  // Write-path handlers should not call this directly.
  shadowUpsertObject: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  readObjectsClassificationModelFromDatabase: vi.fn(() => "openai:gpt-4o-mini"),
}));

vi.mock("../classifier", () => ({
  classifyObject: vi.fn(async () => ({
    type: "@cinatra-ai/entity-contacts:contact",
    normalizedData: { name: "Test" },
    confidence: 0.9,
    isNewType: false,
    inferredTypeName: null,
    inferredCategory: null,
    canonicalKeys: null,
  })),
}));

vi.mock("../auto-registrar", () => ({
  ensureDynamicObjectType: vi.fn(),
  readActiveDynamicObjectTypes: vi.fn(async () => []),
  readAllDynamicObjectTypes: vi.fn(async () => []),
  readDynamicObjectTypeByType: vi.fn(async () => null),
}));

vi.mock("../graphiti-client", () => ({
  addEpisode: vi.fn(async () => ({ uuid: "ep-1", episode_id: "ep-1" })),
  deleteEpisode: vi.fn(async () => ({ ok: true })),
  searchNodes: vi.fn(async () => ({ nodes: [] })),
  getEpisodes: vi.fn(async () => ({ episodes: [] })),
  identityHashToUuid: (h: string, _g: string) => `uuid-${h}`,
}));

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import {
  upsertObjectAndEnqueue,
  getObjectById,
  softDeleteObject,
} from "@/lib/objects-store";
import { shadowUpsertObject } from "@/lib/objects-dual-write";
import { addEpisode, deleteEpisode } from "../graphiti-client";

const mockUpsert = upsertObjectAndEnqueue as unknown as ReturnType<typeof vi.fn>;
const mockGet = getObjectById as unknown as ReturnType<typeof vi.fn>;
const mockSoftDelete = softDeleteObject as unknown as ReturnType<typeof vi.fn>;
const mockShadow = shadowUpsertObject as unknown as ReturnType<typeof vi.fn>;
const mockAdd = addEpisode as unknown as ReturnType<typeof vi.fn>;
const mockDel = deleteEpisode as unknown as ReturnType<typeof vi.fn>;

const ACTOR = {
  actorType: "model",
  source: "agent",
  // orgId is not on the base PrimitiveActorContext type — handlers cast through
  // getActorExt(); spread an extension to satisfy that path while keeping the
  // base shape valid.
  ...({ orgId: "org-1", agentId: "a1", runId: "r1" } as unknown as Record<string, unknown>),
} as never;

function makeRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "obj-1",
    type: "@cinatra-ai/entity-contacts:contact",
    parentId: null,
    parentType: null,
    data: { name: "Test" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdBy: null,
    orgId: "org-1",
    source: "agent",
    runId: "r1",
    agentId: "a1",
    packageVersion: null,
    agentSpecVersion: null,
    version: 1,
    deletedAt: null,
    ...overrides,
  } as const;
}

describe("objects_save handler — Postgres-primary", () => {
  beforeEach(() => {
    mockUpsert.mockReset();
    mockGet.mockReset();
    mockSoftDelete.mockReset();
    mockShadow.mockReset();
    mockAdd.mockReset();
    mockDel.mockReset();
    mockUpsert.mockReturnValue(makeRecord());
  });

  it("Test 1: calls upsertObjectAndEnqueue once with operation='upsert' and never calls Graphiti", async () => {
    const handlers = createObjectsPrimitiveHandlers();
    await handlers.objects_save({
      primitiveName: "objects_save",
      input: {
        rawData: { name: "Test" },
        typeHint: "@cinatra-ai/entity-contacts:contact",
      },
      actor: ACTOR,
      mode: "agentic",
    });
    expect(mockUpsert).toHaveBeenCalledOnce();
    expect(mockUpsert.mock.calls[0][0].operation).toBe("upsert");
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockDel).not.toHaveBeenCalled();
    expect(mockShadow).not.toHaveBeenCalled();
  });

  it("Test 4: response includes objectId returned by upsertObjectAndEnqueue", async () => {
    mockUpsert.mockReturnValueOnce(makeRecord({ id: "obj-from-upsert" }));
    const handlers = createObjectsPrimitiveHandlers();
    const res = await handlers.objects_save({
      primitiveName: "objects_save",
      input: {
        rawData: { name: "Test" },
        typeHint: "@cinatra-ai/entity-contacts:contact",
      },
      actor: ACTOR,
      mode: "agentic",
    });
    expect((res as { objectId: string }).objectId).toBe("obj-from-upsert");
  });
});

describe("objects_update handler — Postgres-primary", () => {
  beforeEach(() => {
    mockUpsert.mockReset();
    mockGet.mockReset();
    mockShadow.mockReset();
    mockAdd.mockReset();
    mockDel.mockReset();
    mockGet.mockReturnValue(makeRecord({ data: { name: "old" } }));
    mockUpsert.mockReturnValue(makeRecord({ data: { name: "new" }, version: 2 }));
  });

  it("Test 2: reads via getObjectById, calls upsertObjectAndEnqueue with merged data, no Graphiti", async () => {
    const handlers = createObjectsPrimitiveHandlers();
    await handlers.objects_update({
      primitiveName: "objects_update",
      input: { objectId: "obj-1", data: { name: "new" } },
      actor: ACTOR,
      mode: "agentic",
    });
    expect(mockGet).toHaveBeenCalledWith("obj-1", { orgId: "org-1" });
    expect(mockUpsert).toHaveBeenCalledOnce();
    // The merged data must include the new value.
    const call = mockUpsert.mock.calls[0][0];
    expect(call.upsertInput.data).toMatchObject({ name: "new" });
    expect(call.operation).toBe("upsert");
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockDel).not.toHaveBeenCalled();
    expect(mockShadow).not.toHaveBeenCalled();
  });
});

describe("objects_delete handler — Postgres-primary", () => {
  beforeEach(() => {
    mockSoftDelete.mockReset();
    mockShadow.mockReset();
    mockAdd.mockReset();
    mockDel.mockReset();
  });

  it("Test 3: calls softDeleteObject and never calls deleteEpisode/shadowUpsertObject from the handler", async () => {
    const handlers = createObjectsPrimitiveHandlers();
    await handlers.objects_delete({
      primitiveName: "objects_delete",
      input: { objectId: "obj-1" },
      actor: ACTOR,
      mode: "agentic",
    });
    expect(mockSoftDelete).toHaveBeenCalledWith("obj-1", { orgId: "org-1" });
    expect(mockDel).not.toHaveBeenCalled();
    expect(mockShadow).not.toHaveBeenCalled();
  });
});
