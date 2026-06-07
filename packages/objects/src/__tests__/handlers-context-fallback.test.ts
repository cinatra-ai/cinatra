// Behavioral tests for run-context fallback and normalized-data runId injection.
//
// getActorExt resolves runId from AsyncLocalStorage when the actor object does
// not carry it explicitly. This proves the fallback chain:
// actor.runId -> ctx.runId -> null.
//
// cinatraAgentRunId is auto-injected into the data passed to
// upsertObjectAndEnqueue when actorExt.runId is set and the field is absent
// from the normalized data. It must not overwrite an existing value.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Stub the modules that handlers.ts imports from the host app.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Import the stub storage before handlers so the alias is resolved first.
// @cinatra-ai/mcp-server is aliased to __stubs__/mcp-server.ts in vitest.config.ts.
// ---------------------------------------------------------------------------
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import { upsertObjectAndEnqueue } from "@/lib/objects-store";

const mockUpsert = upsertObjectAndEnqueue as unknown as ReturnType<typeof vi.fn>;

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
    orgId: "org-ctx",
    source: "agent",
    runId: "run-ctx",
    agentId: "agent-ctx",
    packageVersion: null,
    agentSpecVersion: null,
    version: 1,
    deletedAt: null,
    ownerLevel: "user",
    ownerId: "user-1",
    visibility: "private",
    ...overrides,
  };
}

beforeEach(() => {
  mockUpsert.mockReset();
  mockUpsert.mockReturnValue(makeRecord());
});

// ---------------------------------------------------------------------------
// Context fallback: actor carries no runId; AsyncLocalStorage does.
// ---------------------------------------------------------------------------
describe("getActorExt context fallback from AsyncLocalStorage", () => {
  it("actor without runId uses runId from ALS context store", async () => {
    // Arrange: ALS store has runId, actor does not.
    const store = { orgId: "org-ctx", runId: "run-from-als", agentId: "agt-1" };
    await mcpRequestContextStorage.run(store, async () => {
      const handlers = createObjectsPrimitiveHandlers();

      // Actor explicitly has no runId, matching an MCP caller whose actor was
      // assembled before the transport handler ran.
      const actor = {
        actorType: "model" as const,
        source: "agent" as const,
        ...({ orgId: "org-ctx" } as unknown as Record<string, unknown>),
      } as never;

      // Act
      await handlers.objects_save({
        primitiveName: "objects_save",
        input: { rawData: { name: "Test" }, typeHint: "@cinatra-ai/entity-contacts:contact" },
        actor,
        mode: "agentic",
      });

      // Assert: upsertObjectAndEnqueue was called with the runId from ALS.
      expect(mockUpsert).toHaveBeenCalledOnce();
      const callArg = mockUpsert.mock.calls[0][0] as {
        upsertInput: Record<string, unknown>;
      };
      expect(callArg.upsertInput.runId).toBe("run-from-als");
    });
  });

  it("actor-supplied runId wins over ALS context runId", async () => {
    // Arrange: both actor and ALS have runId; actor must win.
    const store = { orgId: "org-ctx", runId: "run-from-als", agentId: "agt-1" };
    await mcpRequestContextStorage.run(store, async () => {
      const handlers = createObjectsPrimitiveHandlers();

      const actor = {
        actorType: "model" as const,
        source: "agent" as const,
        ...({
          orgId: "org-ctx",
          runId: "run-from-actor",
        } as unknown as Record<string, unknown>),
      } as never;

      await handlers.objects_save({
        primitiveName: "objects_save",
        input: { rawData: { name: "Test" }, typeHint: "@cinatra-ai/entity-contacts:contact" },
        actor,
        mode: "agentic",
      });

      const callArg = mockUpsert.mock.calls[0][0] as {
        upsertInput: Record<string, unknown>;
      };
      // Actor-supplied value must win.
      expect(callArg.upsertInput.runId).toBe("run-from-actor");
    });
  });

  it("runId is null when neither actor nor ALS context carry it", async () => {
    // No ALS context at all.
    const handlers = createObjectsPrimitiveHandlers();

    const actor = {
      actorType: "model" as const,
      source: "agent" as const,
      ...({ orgId: "org-ctx" } as unknown as Record<string, unknown>),
    } as never;

    await handlers.objects_save({
      primitiveName: "objects_save",
      input: { rawData: { name: "Test" }, typeHint: "@cinatra-ai/entity-contacts:contact" },
      actor,
      mode: "agentic",
    });

    const callArg = mockUpsert.mock.calls[0][0] as {
      upsertInput: Record<string, unknown>;
    };
    expect(callArg.upsertInput.runId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cinatraAgentRunId injection.
// ---------------------------------------------------------------------------
describe("cinatraAgentRunId auto-injection into normalized data", () => {
  it("injects cinatraAgentRunId when actorExt.runId is set and field is absent", async () => {
    // Arrange: ALS context carries runId; rawData does not have cinatraAgentRunId.
    const store = { orgId: "org-ctx", runId: "run-inject", agentId: "agt-1" };
    await mcpRequestContextStorage.run(store, async () => {
      const handlers = createObjectsPrimitiveHandlers();

      const actor = {
        actorType: "model" as const,
        source: "agent" as const,
        ...({ orgId: "org-ctx" } as unknown as Record<string, unknown>),
      } as never;

      await handlers.objects_save({
        primitiveName: "objects_save",
        input: {
          rawData: { name: "Test" },  // no cinatraAgentRunId
          typeHint: "@cinatra-ai/entity-contacts:contact",
        },
        actor,
        mode: "agentic",
      });

      const callArg = mockUpsert.mock.calls[0][0] as {
        upsertInput: { data: Record<string, unknown> };
      };
      // The data written must contain cinatraAgentRunId = run context runId.
      expect(callArg.upsertInput.data).toHaveProperty("cinatraAgentRunId", "run-inject");
    });
  });

  it("does not overwrite cinatraAgentRunId already present in data", async () => {
    // Arrange: ALS context carries runId; rawData already has cinatraAgentRunId.
    const store = { orgId: "org-ctx", runId: "run-from-als", agentId: "agt-1" };

    // The classifier returns the field as-is in normalizedData.
    const { classifyObject } = await import("../classifier");
    (classifyObject as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: "@cinatra-ai/entity-contacts:contact",
      normalizedData: { name: "Test", cinatraAgentRunId: "run-explicit" },
      confidence: 0.9,
      isNewType: false,
      inferredTypeName: null,
      inferredCategory: null,
      canonicalKeys: null,
    });

    await mcpRequestContextStorage.run(store, async () => {
      const handlers = createObjectsPrimitiveHandlers();

      const actor = {
        actorType: "model" as const,
        source: "agent" as const,
        ...({ orgId: "org-ctx" } as unknown as Record<string, unknown>),
      } as never;

      await handlers.objects_save({
        primitiveName: "objects_save",
        input: {
          rawData: { name: "Test", cinatraAgentRunId: "run-explicit" },
          typeHint: "@cinatra-ai/entity-contacts:contact",
        },
        actor,
        mode: "agentic",
      });

      const callArg = mockUpsert.mock.calls[0][0] as {
        upsertInput: { data: Record<string, unknown> };
      };
      // The explicit value must not be overwritten by the ALS value.
      expect(callArg.upsertInput.data.cinatraAgentRunId).toBe("run-explicit");
    });
  });
});
