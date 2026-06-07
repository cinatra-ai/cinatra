// Handler-level contract tests for objects_save.
// These tests assert the handler enforces actor.orgId before saving objects.
// registry-orgid.test.ts covers the registry-level wiring so external MCP
// callers reach these paths with real orgIds.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mockCallTool = vi.fn();
const mockConnect = vi.fn();
const mockClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: function (this: unknown) {
    return {
      connect: mockConnect,
      callTool: mockCallTool,
      close: mockClose,
    };
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: function (this: unknown) {
    return {};
  },
}));

vi.mock("@/lib/objects-dual-write", () => ({
  shadowUpsertObject: vi.fn(),
}));

// handlers.ts calls upsertObjectAndEnqueue / getObjectById /
// softDeleteObject from @/lib/objects-store, the Postgres-primary write path.
// Stub the module so the orgId-guard tests don't try to reach a real Postgres
// instance via runPostgresQueriesSync.
vi.mock("@/lib/objects-store", () => ({
  upsertObjectAndEnqueue: vi.fn(() => ({
    id: "obj-1",
    type: "@cinatra-ai/entity-contacts:contact",
    parentId: null,
    parentType: null,
    data: { name: "Test campaign" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdBy: null,
    orgId: "org-1",
    source: "agent",
    runId: null,
    agentId: null,
    packageVersion: null,
    agentSpecVersion: null,
    version: 1,
    deletedAt: null,
  })),
  getObjectById: vi.fn(),
  listObjectsByFilter: vi.fn(() => []),
  softDeleteObject: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  readObjectsClassificationModelFromDatabase: vi.fn(() => "openai:gpt-4o-mini"),
}));

vi.mock("../classifier", () => ({
  classifyObject: vi.fn(async () => ({
    type: "@cinatra-ai/entity-contacts:contact",
    normalizedData: { name: "Test campaign" },
    confidence: 0.9,
    isNewType: false,
    inferredTypeName: null,
    inferredCategory: null,
  })),
}));

vi.mock("../auto-registrar", () => ({
  ensureDynamicObjectType: vi.fn(),
  readActiveDynamicObjectTypes: vi.fn(async () => []),
  readAllDynamicObjectTypes: vi.fn(async () => []),
  readDynamicObjectTypeByType: vi.fn(async () => null),
}));

function mcpText(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

describe("objects_save handler (orgId required)", () => {
  beforeEach(() => {
    mockCallTool.mockReset();
    mockConnect.mockReset().mockResolvedValue(undefined);
    mockClose.mockReset().mockResolvedValue(undefined);
  });

  it("throws when actor.orgId is null", async () => {
    const { createObjectsPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createObjectsPrimitiveHandlers();
    await expect(
      handlers.objects_save({
        primitiveName: "objects_save",
        input: { rawData: { name: "x" }, typeHint: "@cinatra-ai/entity-contacts:contact" },
        actor: { actorType: "model", source: "agent" },
        mode: "agentic",
      }),
    ).rejects.toThrow(/actor\.orgId is null/);
  });

  it("succeeds when actor.orgId is set", async () => {
    // First getEpisodes call (findEpisodeByObjectId): return no matching episode.
    // Second add_memory call: return success.
    mockCallTool.mockImplementation(async (args: { name: string }) => {
      if (args.name === "get_episodes") return mcpText({ episodes: [] });
      if (args.name === "add_memory") return mcpText({ message: "Episode added", episode_id: "ep-1" });
      if (args.name === "delete_episode") return mcpText({ ok: true });
      return mcpText({});
    });
    const { createObjectsPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createObjectsPrimitiveHandlers();
    const result = await handlers.objects_save({
      primitiveName: "objects_save",
      input: { rawData: { name: "Test" }, typeHint: "@cinatra-ai/entity-contacts:contact" },
      actor: { actorType: "model", source: "agent", ...{ orgId: "org-1" } as unknown as Record<string, unknown> },
      mode: "agentic",
    });
    expect(result).toHaveProperty("objectId");
    expect(result).toHaveProperty("type", "@cinatra-ai/entity-contacts:contact");
  });
});
