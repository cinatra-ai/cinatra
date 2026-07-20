// Fail-closed writes — an objects_save whose content cannot be placed under a
// type an installed artifact extension DEFINES is REFUSED at the write boundary,
// never persisted under any fallback name (owner ruling 2026-07-18;
// epic cinatra#1785). This reverses the #1787 "lossless generic fallback".
//
// Covers:
//   1. an unmatched save is REJECTED with the structured OBJECTS_TYPE_NOT_REGISTERED
//      error and NOTHING is persisted (upsert never called);
//   2. a save that matches an installed, REGISTERED type persists unchanged and
//      carries no warning field (matched response shape unchanged);
//   3. the error shape — stable code, ratified message, retryable:false,
//      details.attemptedType, and the install hint only when a definer is known;
//   4. classifier-unavailable, dynamic/tombstoned id, new-type, generic-id, and
//      low-confidence outcomes ALL refuse — no warning-store / queue / dead-letter.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrimitiveInvocationError } from "@cinatra-ai/mcp-client";

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

vi.mock("../graphiti-client", () => ({
  addEpisode: vi.fn(async () => ({ uuid: "ep-1", episode_id: "ep-1" })),
  deleteEpisode: vi.fn(async () => ({ ok: true })),
  searchNodes: vi.fn(async () => ({ nodes: [] })),
  getEpisodes: vi.fn(async () => ({ episodes: [] })),
  identityHashToUuid: (h: string, _g: string) => `uuid-${h}`,
}));

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import { upsertObjectAndEnqueue } from "@/lib/objects-store";
import { classifyObject } from "../classifier";
import { objectTypeRegistry } from "../registry";

const mockUpsert = upsertObjectAndEnqueue as unknown as ReturnType<typeof vi.fn>;
const mockClassify = classifyObject as unknown as ReturnType<typeof vi.fn>;

const GENERIC = "@cinatra-ai/objects:object";
const INSTALLED_TYPE = "@cinatra-ai/entity-contacts:contact";

const ACTOR = {
  actorType: "model",
  source: "agent",
  ...({ orgId: "org-1", agentId: "a1", runId: "run-1" } as unknown as Record<string, unknown>),
} as never;

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

/** A classifier result that MATCHES the installed, registered type. */
function matched(extra: Record<string, unknown> = {}) {
  return {
    type: INSTALLED_TYPE,
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

/** Capture the rejection so its structured fields can be asserted. */
async function saveExpectingRefusal(input: Record<string, unknown>) {
  try {
    await save(input);
  } catch (err) {
    return err as PrimitiveInvocationError;
  }
  throw new Error("expected objects_save to REFUSE, but it resolved");
}

beforeEach(() => {
  seq = 0;
  mockUpsert.mockReset();
  mockUpsert.mockImplementation((call: { upsertInput: { id: string; type: string } }) =>
    recordFor(call),
  );
  mockClassify.mockReset();
  // Only the installed type is defined by an installed extension; the generic /
  // dynamic ids are not.
  objectTypeRegistry._clearForTests();
  objectTypeRegistry.register(
    {
      type: INSTALLED_TYPE,
      category: "record",
      description: "Contact",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    "@cinatra-ai/entity-contacts",
  );
});

// ---------------------------------------------------------------------------
// 1. Unknown type → refused, nothing persisted.
// ---------------------------------------------------------------------------
describe("unknown type → refused at the write boundary", () => {
  it("an unmatched (new-type) save is REJECTED and NOTHING is persisted", async () => {
    mockClassify.mockResolvedValue(unmatched());
    const err = await saveExpectingRefusal({ rawData: { name: "Test", keep: 1 } });
    expect(err).toBeInstanceOf(PrimitiveInvocationError);
    expect(err.code).toBe("OBJECTS_TYPE_NOT_REGISTERED");
    // The refused payload never reaches the store.
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("the error message states no installed extension defines the type", async () => {
    mockClassify.mockResolvedValue(unmatched());
    const err = await saveExpectingRefusal({ rawData: { name: "Test" } });
    expect(err.message).toContain("no installed artifact extension defines");
  });
});

// ---------------------------------------------------------------------------
// 2. Known, registered type → unchanged.
// ---------------------------------------------------------------------------
describe("known type → persisted unchanged", () => {
  it("a match to an installed, registered type persists and carries no warning", async () => {
    mockClassify.mockResolvedValue(matched());
    const res = await save({ rawData: { name: "Test" } });
    expect(res.type).toBe(INSTALLED_TYPE);
    expect(res.isNew).toBe(true);
    expect(res.wasMerged).toBe(false);
    // The reversed fallback shape is gone — no warning field on any save.
    expect(res.warning).toBeUndefined();
    expect(mockUpsert).toHaveBeenCalledOnce();
    expect(mockUpsert.mock.calls[0][0].upsertInput.type).toBe(INSTALLED_TYPE);
  });

  it("a confident classifier match to an UNREGISTERED type is still refused (fail-closed registry check)", async () => {
    // The LLM returns a well-formed, confident, non-dynamic id — but no
    // installed extension registered it, so there is no defining extension.
    mockClassify.mockResolvedValue(
      matched({ type: "@cinatra-ai/blog-post-artifact:post" }),
    );
    const err = await saveExpectingRefusal({ rawData: { name: "Test" } });
    expect(err.code).toBe("OBJECTS_TYPE_NOT_REGISTERED");
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Error shape.
// ---------------------------------------------------------------------------
describe("structured error shape", () => {
  it("names the attempted type and is non-retryable", async () => {
    mockClassify.mockResolvedValue(
      matched({ type: "@cinatra-ai/blog-post-artifact:post" }),
    );
    const err = await saveExpectingRefusal({ rawData: { name: "Test" } });
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('"@cinatra-ai/blog-post-artifact:post"');
    expect(err.details?.attemptedType).toBe("@cinatra-ai/blog-post-artifact:post");
  });

  it("suggests installing the defining extension when it is known-but-not-installed", async () => {
    // A namespaced type whose defining package registered no types → known
    // definer, not installed → install hint.
    mockClassify.mockResolvedValue(
      matched({ type: "@cinatra-ai/blog-post-artifact:post" }),
    );
    const err = await saveExpectingRefusal({ rawData: { name: "Test" } });
    expect(err.message).toContain("install @cinatra-ai/blog-post-artifact");
    expect(err.details?.suggestedExtension).toBe("@cinatra-ai/blog-post-artifact");
  });

  it("omits an install hint for an unclassifiable save with no concrete type", async () => {
    mockClassify.mockResolvedValue(unmatched()); // generic id + isNewType
    const err = await saveExpectingRefusal({ rawData: { name: "Test" } });
    expect(err.message).not.toContain("install ");
    expect(err.details?.suggestedExtension).toBeUndefined();
  });

  it("never suggests installing a tombstoned dynamic namespace", async () => {
    mockClassify.mockResolvedValue(
      matched({ type: "@dynamic/types:brand-audit", isNewType: false }),
    );
    const err = await saveExpectingRefusal({ rawData: { name: "Test" } });
    expect(err.message).not.toContain("install ");
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Every non-matching outcome refuses.
// ---------------------------------------------------------------------------
describe("all non-matching outcomes refuse", () => {
  it("classifier-unavailable (thrown) refuses — nothing persisted", async () => {
    mockClassify.mockRejectedValue(new Error("No LLM provider configured."));
    const err = await saveExpectingRefusal({ rawData: { name: "Test" } });
    expect(err.code).toBe("OBJECTS_TYPE_NOT_REGISTERED");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("a dynamic-id classification refuses (never persisted, no mint)", async () => {
    mockClassify.mockResolvedValue(
      matched({ type: "@dynamic/types:brand-audit", isNewType: false }),
    );
    await saveExpectingRefusal({ rawData: { name: "Test" } });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("a legacy dynamic-id classification refuses", async () => {
    mockClassify.mockResolvedValue(
      matched({ type: "@cinatra-ai/dynamic:existing-row", isNewType: false }),
    );
    await saveExpectingRefusal({ rawData: { name: "Test" } });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("the retired generic id refuses even at high confidence", async () => {
    mockClassify.mockResolvedValue(matched({ type: GENERIC, isNewType: false }));
    await saveExpectingRefusal({ rawData: { name: "Test" } });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("low confidence refuses even against a registered type", async () => {
    mockClassify.mockResolvedValue(matched({ confidence: 0.2 }));
    await saveExpectingRefusal({ rawData: { name: "Test" } });
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
