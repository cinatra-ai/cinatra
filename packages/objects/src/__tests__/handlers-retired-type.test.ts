// A RETIRED host type keeps its stored rows read-only (cinatra#4366).
//
// The Drupal pack moved its pointer type into its own namespace, so the host's
// former id `@cinatra-ai/drupal:node` has no definer any more. Its stored rows
// stay registered as a host tombstone (projection none), and neither content
// write path may reach them: `objects_save` refuses the retired type exactly as
// it refuses an unregistered one, and `objects_update` refuses any change to a
// row of it before anything is written.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/objects-store", () => ({
  upsertObjectAndEnqueue: vi.fn(),
  getObjectById: vi.fn(),
  listObjectsByFilter: vi.fn(),
  softDeleteObject: vi.fn(),
}));

// The REAL classifier runs; an exact static typeHint never reaches the LLM.
vi.mock("@cinatra-ai/llm", () => ({
  resolveConfiguredLlmRuntime: vi.fn(async () => {
    throw new Error("classifier LLM must not be called in this suite");
  }),
  runResolvedDeterministicLlmTask: vi.fn(),
  parseStructuredJson: vi.fn(),
}));

vi.mock("../graphiti-client", () => ({
  addEpisode: vi.fn(async () => ({ uuid: "ep-1", episode_id: "ep-1" })),
  deleteEpisode: vi.fn(async () => ({ ok: true })),
  searchNodes: vi.fn(async () => ({ nodes: [] })),
  getEpisodes: vi.fn(async () => ({ episodes: [] })),
  identityHashToUuid: (h: string, _g: string) => `uuid-${h}`,
}));

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import { upsertObjectAndEnqueue, getObjectById } from "@/lib/objects-store";
import { objectTypeRegistry } from "../registry";
import { registerAllObjectTypes } from "../integration/register-types";

const RETIRED = "@cinatra-ai/drupal:node";

const mockUpsert = upsertObjectAndEnqueue as unknown as ReturnType<typeof vi.fn>;
const mockGet = getObjectById as unknown as ReturnType<typeof vi.fn>;

const ACTOR = {
  actorType: "model",
  source: "agent",
  ...({ orgId: "org-1", agentId: "a1", runId: "r1" } as unknown as Record<string, unknown>),
} as never;

const POINTER = {
  artifactType: "connector-ref",
  originKind: "external_link",
  mime: "text/html",
  title: "Node 42",
  connectorRef: {
    url: "https://cms.example.test/node/42",
    connectorId: "drupal-1",
    externalId: "42",
    state: "linked",
  },
};

function retiredRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "obj-retired-1",
    type: RETIRED,
    parentId: null,
    parentType: null,
    data: POINTER,
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

beforeEach(() => {
  mockUpsert.mockReset();
  mockGet.mockReset();
  mockUpsert.mockReturnValue(retiredRow({ version: 2 }));
  objectTypeRegistry._clearForTests();
  registerAllObjectTypes();
});

describe("a retired host type is read-only (cinatra#4366)", () => {
  it("objects_save refuses the retired type and writes nothing", async () => {
    const handlers = createObjectsPrimitiveHandlers();
    await expect(
      handlers.objects_save({
        primitiveName: "objects_save",
        input: { rawData: POINTER, typeHint: RETIRED },
        actor: ACTOR,
        mode: "agentic",
      }),
    ).rejects.toMatchObject({ code: "OBJECTS_TYPE_NOT_REGISTERED" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("objects_update refuses a content change to a stored row of the retired type", async () => {
    mockGet.mockReturnValue(retiredRow());
    const handlers = createObjectsPrimitiveHandlers();
    await expect(
      handlers.objects_update({
        primitiveName: "objects_update",
        input: { objectId: "obj-retired-1", data: { title: "changed" } },
        actor: ACTOR,
        mode: "agentic",
      }),
    ).rejects.toMatchObject({
      code: "OBJECTS_TYPE_RETIRED",
      retryable: false,
      details: { type: RETIRED },
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("objects_update refuses a project move of a stored row of the retired type", async () => {
    mockGet.mockReturnValue(retiredRow());
    const handlers = createObjectsPrimitiveHandlers();
    await expect(
      handlers.objects_update({
        primitiveName: "objects_update",
        input: { objectId: "obj-retired-1", projectId: "project-2" },
        actor: ACTOR,
        mode: "agentic",
      }),
    ).rejects.toMatchObject({ code: "OBJECTS_TYPE_RETIRED" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("objects_types_list does not advertise the retired type", async () => {
    const handlers = createObjectsPrimitiveHandlers();
    const res = (await handlers.objects_types_list({
      primitiveName: "objects_types_list",
      input: {},
      actor: ACTOR,
      mode: "agentic",
    })) as { types: Array<{ type: string }> };
    expect(res.types.length).toBeGreaterThan(0);
    expect(res.types.map((t) => t.type)).not.toContain(RETIRED);
  });

  it("objects_update still reports a missing row as not found (no existence leak through the refusal)", async () => {
    mockGet.mockReturnValue(null);
    const handlers = createObjectsPrimitiveHandlers();
    await expect(
      handlers.objects_update({
        primitiveName: "objects_update",
        input: { objectId: "obj-missing", data: { title: "changed" } },
        actor: ACTOR,
        mode: "agentic",
      }),
    ).rejects.toThrow(/Object not found|not found|denied/i);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
