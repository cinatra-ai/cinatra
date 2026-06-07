// Host objects DI binder — unit tests.
//
// register-objects-provider.ts binds the SDK's requireObjectsProvider() slot to the
// real @cinatra-ai/objects registries + graphiti client + objects_save. These tests
// pin the host-owned behavior that moved off the crm-connector during the decouple:
// the graphiti group-id derivation, the EPISODE-UUID-EMPTY no-uuid rule, source:json,
// the registry delegation, and the objects_save request shape.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { addEpisodeMock, identityHashToUuidMock, registerTypeMock, registerAdapterMock, objectsSaveMock } = vi.hoisted(
  () => ({
    addEpisodeMock: vi.fn(),
    identityHashToUuidMock: vi.fn((id: string, group: string) => `uuid:${id}:${group}`),
    registerTypeMock: vi.fn(),
    registerAdapterMock: vi.fn(),
    objectsSaveMock: vi.fn(),
  }),
);

vi.mock("@cinatra-ai/objects/registry", () => ({ objectTypeRegistry: { register: registerTypeMock } }));
vi.mock("@cinatra-ai/objects/sync-adapters/registry", () => ({
  objectSyncAdapterRegistry: { register: registerAdapterMock },
}));
vi.mock("@cinatra-ai/objects/graphiti-client", () => ({
  addEpisode: addEpisodeMock,
  identityHashToUuid: identityHashToUuidMock,
}));
vi.mock("@cinatra-ai/objects/mcp-handlers", () => ({
  createObjectsPrimitiveHandlers: () => ({ objects_save: objectsSaveMock }),
}));

import {
  requireObjectsProvider,
  getObjectsProviderOrNull,
  setObjectsProvider,
  _resetObjectsProviderForTests,
} from "@cinatra-ai/sdk-extensions";
// Importing the binder calls setObjectsProvider(...) at module load.
import "../register-objects-provider";

const provider = requireObjectsProvider();

describe("getObjectsProviderOrNull (build-time-safe boot-registration accessor)", () => {
  it("resolves the host-bound provider, and returns null when unbound (the next-build no-op path)", () => {
    // The binder import bound it.
    expect(getObjectsProviderOrNull()).toBe(provider);
    // Unbound (e.g. `next build` page-data collection — instrumentation absent) → null,
    // so the crm registerCrmObjectTypes/registerCrmObjectSyncAdapters guards no-op
    // instead of throwing. Restored immediately to avoid cross-test contamination.
    _resetObjectsProviderForTests();
    expect(getObjectsProviderOrNull()).toBeNull();
    setObjectsProvider(provider);
    expect(getObjectsProviderOrNull()).toBe(provider);
  });
});

describe("register-objects-provider (host objects DI binder)", () => {
  beforeEach(() => {
    addEpisodeMock.mockReset();
    addEpisodeMock.mockResolvedValue({});
    identityHashToUuidMock.mockClear();
    registerTypeMock.mockReset();
    registerAdapterMock.mockReset();
    objectsSaveMock.mockReset();
  });

  it("addGraphitiEpisodeForObject derives the org group-id, OMITS uuid (EPISODE-UUID-EMPTY), sets source:json", async () => {
    const { episodeUuid } = await provider.addGraphitiEpisodeForObject({
      objectId: "obj-1",
      orgId: "org-1",
      name: "Alice [oid:obj-1]",
      episodeBody: "{}",
      sourceDescription: "cinatra contact",
      referenceTime: "2026-01-01T00:00:00Z",
    });
    expect(addEpisodeMock).toHaveBeenCalledOnce();
    const call = addEpisodeMock.mock.calls[0]![0] as Record<string, unknown>;
    // Graphiti 0.28.2 mis-handles `uuid` on add_memory — it MUST be absent.
    expect(call).not.toHaveProperty("uuid");
    expect(call.group_id).toBe("cinatra-org-org-1");
    expect(call.source).toBe("json");
    expect(call.source_description).toBe("cinatra contact");
    expect(call.reference_time).toBe("2026-01-01T00:00:00Z");
    // The returned UUID is the deterministic identityHashToUuid(objectId, group).
    expect(episodeUuid).toBe("uuid:obj-1:cinatra-org-org-1");
  });

  it("uses the cinatra-default group when orgId is null + omits reference_time when absent", async () => {
    const { episodeUuid } = await provider.addGraphitiEpisodeForObject({
      objectId: "obj-2",
      orgId: null,
      name: "X",
      episodeBody: "{}",
      sourceDescription: "cinatra account",
    });
    const call = addEpisodeMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.group_id).toBe("cinatra-default");
    expect(call).not.toHaveProperty("reference_time");
    expect(episodeUuid).toBe("uuid:obj-2:cinatra-default");
  });

  it("registerObjectType / registerSyncAdapter delegate to the host registries", () => {
    const def = { type: "x", category: "profile" } as never;
    provider.registerObjectType(def);
    expect(registerTypeMock).toHaveBeenCalledWith(def);
    const adapter = { id: "a", targetSystem: "graphiti" } as never;
    provider.registerSyncAdapter(adapter);
    expect(registerAdapterMock).toHaveBeenCalledWith(adapter);
  });

  it("saveObject wraps the real objects_save with the {primitiveName,input,actor,mode} shape", async () => {
    objectsSaveMock.mockResolvedValueOnce({
      objectId: "o1",
      type: "t",
      isNew: true,
      wasMerged: false,
      confidence: 1,
      changeSetId: "cs",
    });
    const actor = { orgId: "org-1", roles: ["member"] };
    const res = await provider.saveObject({ typeHint: "T", rawData: { a: 1 }, actor, mode: "agentic" });
    expect(objectsSaveMock).toHaveBeenCalledOnce();
    expect(objectsSaveMock.mock.calls[0]![0]).toMatchObject({
      primitiveName: "objects_save",
      input: { typeHint: "T", rawData: { a: 1 } },
      actor,
      mode: "agentic",
    });
    expect(res.objectId).toBe("o1");
  });
});
