// Lossless generic fallback for unclassifiable saves — classifier stops minting
// dynamic type ids (cinatra#1787, epic #1785 slice C).
//
// Covers the six acceptance criteria on the objects_save write path:
//   1. an unmatched save persists the FULL original payload under the generic
//      type (field-drop regression: fields the classifier trims survive
//      byte-for-byte in `data`);
//   2. two unmatched saves in one run produce two distinct objects; a pair
//      sharing an explicit external identity still deduplicates;
//   3. classifier-unavailable (thrown) behaves identically to unmatched;
//   4. no save path mints or persists a dynamic type id;
//   5. the tool result carries a versioned structured warning;
//   6. zero approval/queue steps — ensureDynamicObjectType is never called.

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

// Classifier is controlled per test.
vi.mock("../classifier", () => ({ classifyObject: vi.fn() }));

vi.mock("../auto-registrar", () => ({
  ensureDynamicObjectType: vi.fn(),
  readAllDynamicObjectTypes: vi.fn(async () => []),
}));

vi.mock("../graphiti-client", () => ({
  addEpisode: vi.fn(async () => ({ uuid: "ep-1", episode_id: "ep-1" })),
  deleteEpisode: vi.fn(async () => ({ ok: true })),
  searchNodes: vi.fn(async () => ({ nodes: [] })),
  getEpisodes: vi.fn(async () => ({ episodes: [] })),
  // Deterministic so identical identity hashes map to identical object ids.
  identityHashToUuid: (h: string, _g: string) => `uuid-${h}`,
}));

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import type { ObjectsSaveWarning } from "../mcp/handlers";
import { upsertObjectAndEnqueue } from "@/lib/objects-store";
import { ensureDynamicObjectType } from "../auto-registrar";
import { classifyObject } from "../classifier";

const mockUpsert = upsertObjectAndEnqueue as unknown as ReturnType<typeof vi.fn>;
const mockEnsureDynamic = ensureDynamicObjectType as unknown as ReturnType<typeof vi.fn>;
const mockClassify = classifyObject as unknown as ReturnType<typeof vi.fn>;

const GENERIC = "@cinatra-ai/objects:object";

const ACTOR = {
  actorType: "model",
  source: "agent",
  ...({ orgId: "org-1", agentId: "a1", runId: "run-1" } as unknown as Record<string, unknown>),
} as never;

// The canonical writer echoes back the persisted type + a monotonically new id
// so `isNew` / response `type` reflect what was written.
let seq = 0;
function recordFor(call: { upsertInput: { id: string; type: string } }) {
  seq += 1;
  return {
    id: call.upsertInput.id,
    type: call.upsertInput.type,
    parentId: null,
    parentType: null,
    data: {},
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdBy: null,
    orgId: "org-1",
    source: "agent",
    runId: "run-1",
    agentId: "a1",
    packageVersion: null,
    agentSpecVersion: null,
    version: 1,
    deletedAt: null,
    changeSetId: `cs-${seq}`,
  };
}

/** A classifier result that MATCHES a real installed type (no fallback). */
function matched(extra: Record<string, unknown> = {}) {
  return {
    type: "@cinatra-ai/entity-contacts:contact",
    normalizedData: { name: "Test" },
    confidence: 0.9,
    isNewType: false,
    inferredTypeName: null,
    inferredCategory: null,
    canonicalKeys: null,
    ...extra,
  };
}

/** A classifier result that does NOT match — comes back as the generic id. */
function unmatched(extra: Record<string, unknown> = {}) {
  return {
    type: GENERIC,
    // The classifier trims to `{ name }`; the fallback must ignore this and
    // persist the ORIGINAL payload instead.
    normalizedData: { name: "Test" },
    confidence: 0.9,
    isNewType: true,
    inferredTypeName: "Brand Audit",
    inferredCategory: "report",
    canonicalKeys: null,
    ...extra,
  };
}

async function save(input: Record<string, unknown>) {
  const handlers = createObjectsPrimitiveHandlers();
  return handlers.objects_save({
    primitiveName: "objects_save",
    input,
    actor: ACTOR,
    mode: "agentic",
  }) as Promise<Record<string, unknown>>;
}

function lastUpsert() {
  return mockUpsert.mock.calls[mockUpsert.mock.calls.length - 1][0] as {
    upsertInput: { id: string; type: string; data: Record<string, unknown> };
    payloadHash?: string;
  };
}

beforeEach(() => {
  seq = 0;
  mockUpsert.mockReset();
  mockUpsert.mockImplementation((call: { upsertInput: { id: string; type: string } }) =>
    recordFor(call),
  );
  mockEnsureDynamic.mockReset();
  mockClassify.mockReset();
});

// ---------------------------------------------------------------------------
// Criterion 1 — lossless persistence under the generic type.
// ---------------------------------------------------------------------------
describe("unmatched save → lossless generic object", () => {
  it("persists the FULL original payload under the generic type (field-drop regression)", async () => {
    mockClassify.mockResolvedValue(unmatched());
    const rawData = {
      name: "Test",
      // Fields the classifier's normalizedData drops — must survive byte-for-byte.
      weirdField: "must survive",
      count: 42,
      nested: { a: [1, 2, 3], b: null },
    };

    await save({ rawData });

    const { upsertInput } = lastUpsert();
    expect(upsertInput.type).toBe(GENERIC);
    // Byte-for-byte: no fields dropped, and NO cinatraAgentRunId injected.
    expect(upsertInput.data).toEqual(rawData);
    expect(upsertInput.data).not.toHaveProperty("cinatraAgentRunId");
  });

  it("response reports the generic type and is not merged on first write", async () => {
    mockClassify.mockResolvedValue(unmatched());
    const res = await save({ rawData: { name: "Test" } });
    expect(res.type).toBe(GENERIC);
    expect(res.isNew).toBe(true);
    expect(res.wasMerged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 — identity: distinct per save; explicit external id dedups.
// ---------------------------------------------------------------------------
describe("unmatched save → identity", () => {
  it("two unmatched saves in one run produce two DISTINCT objects", async () => {
    mockClassify.mockResolvedValue(unmatched());
    await save({ rawData: { name: "A" } });
    await save({ rawData: { name: "B" } });

    const id0 = mockUpsert.mock.calls[0][0].upsertInput.id as string;
    const id1 = mockUpsert.mock.calls[1][0].upsertInput.id as string;
    expect(id0).not.toBe(id1);
    // No run-scoped identity hash — a fresh random UUID per save.
    expect(mockUpsert.mock.calls[0][0].payloadHash).toBeUndefined();
    expect(mockUpsert.mock.calls[1][0].payloadHash).toBeUndefined();
  });

  it("two unmatched saves sharing an explicit external_id DEDUPLICATE", async () => {
    mockClassify.mockResolvedValue(unmatched());
    await save({ rawData: { name: "A", external_id: "ext-42" } });
    await save({ rawData: { name: "B", external_id: "ext-42" } });

    const id0 = mockUpsert.mock.calls[0][0].upsertInput.id as string;
    const id1 = mockUpsert.mock.calls[1][0].upsertInput.id as string;
    // Same external id → same identity hash → same object id.
    expect(id0).toBe(id1);
    expect(mockUpsert.mock.calls[0][0].payloadHash).toBeDefined();
    expect(mockUpsert.mock.calls[0][0].payloadHash).toBe(
      mockUpsert.mock.calls[1][0].payloadHash,
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 — classifier-unavailable behaves identically to unmatched.
// ---------------------------------------------------------------------------
describe("classifier unavailable → same lossless fallback", () => {
  it("a thrown classifier still saves losslessly under the generic type", async () => {
    mockClassify.mockRejectedValue(new Error("No LLM provider configured."));
    const rawData = { name: "Test", keepMe: true };

    const res = await save({ rawData });

    const { upsertInput } = lastUpsert();
    expect(upsertInput.type).toBe(GENERIC);
    expect(upsertInput.data).toEqual(rawData);
    expect((res.warning as ObjectsSaveWarning).reason).toBe("classifier_unavailable");
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 — no dynamic type is ever minted or persisted.
// ---------------------------------------------------------------------------
describe("no dynamic-type minting on the save path", () => {
  it("a classifier that (defensively) returns a dynamic id persists under the generic type, never the dynamic id", async () => {
    mockClassify.mockResolvedValue(
      unmatched({ type: "@dynamic/types:brand-audit", isNewType: false }),
    );
    await save({ rawData: { name: "Test" } });
    const { upsertInput } = lastUpsert();
    expect(upsertInput.type).toBe(GENERIC);
    expect(upsertInput.type).not.toContain("@dynamic/types");
    expect(mockEnsureDynamic).not.toHaveBeenCalled();
  });

  it("an existing dynamic id also routes to the generic type (no new mint)", async () => {
    mockClassify.mockResolvedValue(
      unmatched({ type: "@cinatra-ai/dynamic:existing-row", isNewType: false }),
    );
    await save({ rawData: { name: "Test" } });
    expect(lastUpsert().upsertInput.type).toBe(GENERIC);
    expect(mockEnsureDynamic).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Criterion 5 — versioned structured warning in the tool result.
// ---------------------------------------------------------------------------
describe("structured warning", () => {
  it("unmatched save carries a versioned warning naming the category + remediation", async () => {
    mockClassify.mockResolvedValue(unmatched());
    const res = await save({ rawData: { name: "Test" } });
    const warning = res.warning as ObjectsSaveWarning;
    expect(warning).toMatchObject({
      version: 1,
      code: "unclassified_generic_fallback",
      reason: "unmatched",
      persistedType: GENERIC,
      inferredCategory: "report",
      inferredTypeName: "Brand Audit",
    });
    expect(warning.message).toContain(GENERIC);
    expect(warning.message).toContain('kind:"artifact"');
  });

  it("low-confidence save reports reason=low_confidence", async () => {
    mockClassify.mockResolvedValue(
      matched({ confidence: 0.2 }), // a real type, but the model is unsure
    );
    const res = await save({ rawData: { name: "Test" } });
    expect(lastUpsert().upsertInput.type).toBe(GENERIC);
    expect((res.warning as ObjectsSaveWarning).reason).toBe("low_confidence");
  });

  it("classifier-unavailable warning has null inferred fields", async () => {
    mockClassify.mockRejectedValue(new Error("boom"));
    const res = await save({ rawData: { name: "Test" } });
    const warning = res.warning as ObjectsSaveWarning;
    expect(warning.inferredCategory).toBeNull();
    expect(warning.inferredTypeName).toBeNull();
  });

  it("a MATCHED save carries NO warning (response shape unchanged)", async () => {
    mockClassify.mockResolvedValue(matched());
    const res = await save({ rawData: { name: "Test" } });
    expect(res.warning).toBeUndefined();
    expect(res.type).toBe("@cinatra-ai/entity-contacts:contact");
  });
});

// ---------------------------------------------------------------------------
// Criterion 6 — zero approval/queue/human steps in the write path.
// ---------------------------------------------------------------------------
describe("no approval/queue writes", () => {
  it("a fallback save writes nothing to the dynamic-type registry", async () => {
    mockClassify.mockResolvedValue(unmatched());
    await save({ rawData: { name: "Test" } });
    // ensureDynamicObjectType is the only writer to the (approval-bearing)
    // dynamic_object_types table from this handler — it must not be called.
    expect(mockEnsureDynamic).not.toHaveBeenCalled();
    // The write still completed.
    expect(mockUpsert).toHaveBeenCalledOnce();
  });
});
