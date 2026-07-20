// cinatra#1392 OBJECT-TYPE SERVE — the CONSUME side wired into the two object-
// type consumers (objects_save POINT resolve, objects_types_list per-package
// substitution). The serve machinery is published by the host lib
// `extension-edge-bound-serving.ts` on a globalThis singleton (via `Symbol.for`);
// these leaf handlers read it OFF globalThis (no import edge — route-graph safe)
// and fall back to the DEFAULT behavior when it is absent. This suite drives a
// STUB port off the same Symbol so it isolates the handler wiring from the DB /
// ALS-dependent serve internals (those are covered by the edge-bound-serving
// suite).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/objects-store", () => ({
  upsertObjectAndEnqueue: vi.fn(),
  getObjectById: vi.fn(),
  listObjectsByFilter: vi.fn(),
  softDeleteObject: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  readObjectsClassificationModelFromDatabase: vi.fn(() => "openai:gpt-4o-mini"),
}));

// The classifier resolves a NAMESPACED extension type owned by @x/target.
vi.mock("../classifier", () => ({
  classifyObject: vi.fn(async () => ({
    type: "@x/target:event",
    normalizedData: { name: "Test" },
    confidence: 0.9,
    isNewType: false,
    inferredTypeName: null,
    inferredCategory: null,
    canonicalKeys: null,
  })),
}));

vi.mock("../graphiti-client", () => ({
  addEpisode: vi.fn(async () => ({ uuid: "ep-1", episode_id: "ep-1" })),
  deleteEpisode: vi.fn(async () => ({ ok: true })),
  searchNodes: vi.fn(async () => ({ nodes: [] })),
  getEpisodes: vi.fn(async () => ({ episodes: [] })),
  identityHashToUuid: (h: string, _g: string) => `uuid-${h}`,
}));

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import { upsertObjectAndEnqueue } from "@/lib/objects-store";
import { objectTypeRegistry } from "../registry";

const mockUpsert = upsertObjectAndEnqueue as unknown as ReturnType<typeof vi.fn>;

const ACTOR = {
  actorType: "model",
  source: "agent",
  ...({ orgId: "org-1", agentId: "a1", runId: "r1" } as unknown as Record<string, unknown>),
} as never;

// The globalThis serve-port key — MUST match the publisher + the handler reader.
const OBJECT_TYPE_SERVE_KEY = Symbol.for("@cinatra-ai/host:extension-object-type-serve/v1");
type Holder = { [k: symbol]: unknown };
function setServePort(port: unknown) {
  (globalThis as unknown as Holder)[OBJECT_TYPE_SERVE_KEY] = port;
}
function clearServePort() {
  delete (globalThis as unknown as Holder)[OBJECT_TYPE_SERVE_KEY];
}

function record(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "obj-1",
    type: "@x/target:event",
    version: 1,
    changeSetId: "cs-1",
    ...overrides,
  } as const;
}

const save = (handlers: ReturnType<typeof createObjectsPrimitiveHandlers>) =>
  handlers.objects_save({
    primitiveName: "objects_save",
    input: { rawData: { name: "Test" }, typeHint: undefined },
    actor: ACTOR,
    mode: "agentic",
  } as never);

describe("objects_save — edge-bound object-type serve consumption", () => {
  beforeEach(() => {
    mockUpsert.mockReset();
    mockUpsert.mockReturnValue(record());
    // Fail-closed writes (owner ruling 2026-07-18; epic cinatra#1785): the save persists ONLY under a type
    // an installed extension registered. These tests classify to `@x/target:event`
    // (see the classifier mock), so register it as an installed type.
    objectTypeRegistry.register(
      { type: "@x/target:event", category: "data", description: "Event" } as never,
      "@x/target",
    );
  });
  afterEach(() => {
    clearServePort();
    // Drop the fail-closed registration so it does not leak into the later
    // objects_types_list describe (which asserts this type is absent).
    objectTypeRegistry.removeByPackage("@x/target");
  });

  it("absent serve port → default behavior, response shape byte-identical (no served-version field)", async () => {
    clearServePort();
    const res = (await save(createObjectsPrimitiveHandlers())) as Record<string, unknown>;
    expect(res.objectId).toBe("obj-1");
    expect("objectTypeServedVersion" in res).toBe(false);
  });

  it("port resolves NONE / DEFAULT → no served-version field (default type governs)", async () => {
    setServePort({
      resolveObjectType: async () => ({ kind: "default" }),
      planListing: async () => ({ substitutions: [], notes: [] }),
    });
    const res = (await save(createObjectsPrimitiveHandlers())) as Record<string, unknown>;
    expect("objectTypeServedVersion" in res).toBe(false);
  });

  it("port resolves VERSIONED → surfaces objectTypeServedVersion (positive serve)", async () => {
    const calls: string[] = [];
    setServePort({
      resolveObjectType: async (typeId: string) => {
        calls.push(typeId);
        return { kind: "versioned", version: "0.1.4", descriptor: { typeId } };
      },
      planListing: async () => ({ substitutions: [], notes: [] }),
    });
    const res = (await save(createObjectsPrimitiveHandlers())) as Record<string, unknown>;
    expect(res.objectTypeServedVersion).toBe("0.1.4");
    // The classified type is what gets resolved edge-bound.
    expect(calls).toEqual(["@x/target:event"]);
  });

  it("port REFUSES (torn edge-bound retention) → the save THROWS, never persists against the default", async () => {
    setServePort({
      resolveObjectType: async () => ({
        kind: "refuse",
        code: "NO_SUCH_HANDLER",
        message: "@x/target@0.1.4 registered no object type \"@x/target:event\"",
      }),
      planListing: async () => ({ substitutions: [], notes: [] }),
    });
    await expect(save(createObjectsPrimitiveHandlers())).rejects.toThrow(/edge-bound object-type serving/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("objects_types_list — edge-bound object-type discovery substitution", () => {
  const DEFAULT_TYPE = "@x/target:legacy-event";
  const RETAINED_TYPE = "@x/target:event";

  beforeEach(() => {
    // A DEFAULT-registered type owned by @x/target (with provenance), plus an
    // unrelated first-party type that must always remain listed.
    objectTypeRegistry.register(
      { type: DEFAULT_TYPE, category: "data" } as never,
      "@x/target",
    );
    objectTypeRegistry.register({ type: "@cinatra-ai/core:note", category: "content" } as never);
  });

  afterEach(() => {
    clearServePort();
    objectTypeRegistry.removeByPackage("@x/target");
    // The host-provenance type has no package; drop it via a direct re-list guard.
    const host = objectTypeRegistry.resolve("@cinatra-ai/core:note");
    if (host) {
      // no removeById on the registry — re-register nothing; leave for next test's
      // idempotent replace-by-id (harmless singleton carryover across cases).
    }
  });

  const list = () =>
    createObjectsPrimitiveHandlers().objects_types_list({
      primitiveName: "objects_types_list",
      input: {},
      actor: ACTOR,
      mode: "agentic",
    } as never) as Promise<{ types: Array<{ type: string; description?: string }> }>;

  it("absent serve port → default listing (the package's default type is listed)", async () => {
    clearServePort();
    const { types } = await list();
    const ids = types.map((t) => t.type);
    expect(ids).toContain(DEFAULT_TYPE);
    expect(ids).not.toContain(RETAINED_TYPE);
  });

  it("versioned substitution → the package's DEFAULT type is suppressed, the retained type is served", async () => {
    setServePort({
      resolveObjectType: async () => ({ kind: "none" }),
      planListing: async () => ({
        substitutions: [
          {
            packageName: "@x/target",
            version: "0.1.4",
            retainedTypes: [{ typeId: RETAINED_TYPE, category: "data" }],
          },
        ],
        notes: [],
      }),
    });
    const { types } = await list();
    const ids = types.map((t) => t.type);
    // The default type of the pinned package is REPLACED by the pinned version's type.
    expect(ids).not.toContain(DEFAULT_TYPE);
    expect(ids).toContain(RETAINED_TYPE);
    // Unrelated types stay listed.
    expect(ids).toContain("@cinatra-ai/core:note");
    // The served type is labelled with its edge-bound provenance.
    const served = types.find((t) => t.type === RETAINED_TYPE);
    expect(served?.description).toMatch(/Edge-bound served from @x\/target@0\.1\.4/);
  });

  it("empty substitutions → byte-identical default listing", async () => {
    setServePort({
      resolveObjectType: async () => ({ kind: "none" }),
      planListing: async () => ({ substitutions: [], notes: [] }),
    });
    const { types } = await list();
    expect(types.map((t) => t.type)).toContain(DEFAULT_TYPE);
  });
});
