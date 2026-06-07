// objects_list { runId } filter
//
// When objects_list is called with a runId input field, the handler passes it
// through to listObjectsByFilter so results are scoped to that run. A caller
// without runId must NOT receive objects from another run.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/objects-store", () => ({
  upsertObjectAndEnqueue: vi.fn(),
  getObjectById: vi.fn(),
  listObjectsByFilter: vi.fn(() => []),
  softDeleteObject: vi.fn(),
}));

vi.mock("@/lib/objects-dual-write", () => ({
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
import { listObjectsByFilter } from "@/lib/objects-store";

const mockList = listObjectsByFilter as unknown as ReturnType<typeof vi.fn>;

const ACTOR = {
  actorType: "model" as const,
  source: "agent" as const,
  ...({ orgId: "org-1" } as unknown as Record<string, unknown>),
} as never;

describe("objects_list runId filter", () => {
  beforeEach(() => {
    mockList.mockReset();
    mockList.mockReturnValue([]);
  });

  it("passes runId to listObjectsByFilter when provided in input", async () => {
    const handlers = createObjectsPrimitiveHandlers();

    await handlers.objects_list({
      primitiveName: "objects_list",
      input: { runId: "run-target-123" },
      actor: ACTOR,
      mode: "agentic",
    });

    // listObjectsByFilter must have been called with runId = "run-target-123"
    expect(mockList).toHaveBeenCalled();
    const callArg = mockList.mock.calls[0][0] as { runId?: string };
    expect(callArg.runId).toBe("run-target-123");
  });

  it("passes runId=undefined to listObjectsByFilter when not in input (no implicit bleed)", async () => {
    const handlers = createObjectsPrimitiveHandlers();

    await handlers.objects_list({
      primitiveName: "objects_list",
      input: {},
      actor: ACTOR,
      mode: "agentic",
    });

    expect(mockList).toHaveBeenCalled();
    const callArg = mockList.mock.calls[0][0] as { runId?: string };
    // runId must NOT be set because objects from one run must not bleed into another
    expect(callArg.runId).toBeUndefined();
  });

  it("combines runId filter with type filter", async () => {
    const handlers = createObjectsPrimitiveHandlers();

    await handlers.objects_list({
      primitiveName: "objects_list",
      input: {
        runId: "run-abc",
        type: "@cinatra-ai/entity-contacts:contact",
      },
      actor: ACTOR,
      mode: "agentic",
    });

    expect(mockList).toHaveBeenCalled();
    const callArg = mockList.mock.calls[0][0] as {
      runId?: string;
      type?: string;
    };
    expect(callArg.runId).toBe("run-abc");
    expect(callArg.type).toBe("@cinatra-ai/entity-contacts:contact");
  });
});
