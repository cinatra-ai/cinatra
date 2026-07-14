// Write-path tests for `@cinatra-ai/memory:concept` (cinatra#1376):
//
// - AC1: `objects_save` with the exact static `typeHint` performs NO
//   classifier LLM call — asserted via a test double on `@cinatra-ai/llm`
//   (the REAL classifier module runs; its static fast-path must short-circuit
//   before ever resolving an LLM runtime).
// - AC2: envelope rejection paths (externalId mismatch, okfType/frontmatter
//   mismatch, body over the 64 KiB cap) reject BEFORE any commit.
// - Fail-closed: a memory-typed write whose static registration is missing is
//   refused on BOTH write paths — objects_save via the pre-classification
//   guard on the declared typeHint (the classifier can never return an
//   unregistered static id, so the envelope gate alone cannot cover saves),
//   and objects_update via the envelope gate on the existing row's type.
import { describe, it, expect, vi, beforeEach } from "vitest";

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

// AC1 test double: the REAL `../classifier` module is loaded (NOT mocked); the
// LLM runtime resolver underneath it is the double. If the static fast-path
// ever falls through to a classifier LLM call, the resolver both records the
// call and rejects loudly.
vi.mock("@cinatra-ai/llm", () => ({
  resolveConfiguredLlmRuntime: vi.fn(async () => {
    throw new Error("classifier LLM must not be called for an exact static typeHint");
  }),
  runResolvedDeterministicLlmTask: vi.fn(),
  parseStructuredJson: vi.fn(),
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
import { upsertObjectAndEnqueue, getObjectById } from "@/lib/objects-store";
import { resolveConfiguredLlmRuntime } from "@cinatra-ai/llm";
import { ensureDynamicObjectType } from "../auto-registrar";
import { objectTypeRegistry } from "../registry";
import {
  registerAllObjectTypes,
  MEMORY_CONCEPT_TYPE_ID,
  MEMORY_CONCEPT_BODY_MAX_BYTES,
  computeMemoryConceptExternalId,
} from "../integration/register-types";

const mockUpsert = upsertObjectAndEnqueue as unknown as ReturnType<typeof vi.fn>;
const mockGet = getObjectById as unknown as ReturnType<typeof vi.fn>;
const mockLlmResolve = resolveConfiguredLlmRuntime as unknown as ReturnType<typeof vi.fn>;
const mockEnsureDynamic = ensureDynamicObjectType as unknown as ReturnType<typeof vi.fn>;

const ACTOR = {
  actorType: "model",
  source: "agent",
  ...({ orgId: "org-1", agentId: "a1", runId: "r1" } as unknown as Record<string, unknown>),
} as never;

const BUNDLE_ID = "9f4d9e0a-1b2c-4d3e-8f5a-6b7c8d9e0f1a";
const CONCEPT_ID = "conventions/typescript/no-default-exports";

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    conceptId: CONCEPT_ID,
    bundleId: BUNDLE_ID,
    externalId: computeMemoryConceptExternalId(BUNDLE_ID, CONCEPT_ID),
    okfType: "convention",
    frontmatter: { type: "convention", title: "No default exports" },
    bodyMarkdown: "Use named exports everywhere.",
    links: [],
    okfVersion: "0.1",
    ...overrides,
  };
}

function makeMemoryRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "obj-mem-1",
    type: MEMORY_CONCEPT_TYPE_ID,
    parentId: null,
    parentType: null,
    data: makeEnvelope(),
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
    ownerLevel: "user",
    ownerId: "user-1",
    visibility: "private",
    projectId: null,
    changeSetId: "cs-1",
    ...overrides,
  };
}

beforeEach(() => {
  mockUpsert.mockReset();
  mockGet.mockReset();
  mockLlmResolve.mockClear();
  mockEnsureDynamic.mockReset();
  mockUpsert.mockReturnValue(makeMemoryRecord());
  objectTypeRegistry._clearForTests();
  registerAllObjectTypes();
});

function save(rawData: unknown) {
  const handlers = createObjectsPrimitiveHandlers();
  return handlers.objects_save({
    primitiveName: "objects_save",
    input: { rawData, typeHint: MEMORY_CONCEPT_TYPE_ID },
    actor: ACTOR,
    mode: "agentic",
  } as never);
}

describe("objects_save — memory concept static path (AC1)", () => {
  it("saves a valid envelope with NO classifier LLM call and no dynamic-type mint", async () => {
    const res = await save(makeEnvelope());
    expect(mockLlmResolve).not.toHaveBeenCalled();
    expect(mockEnsureDynamic).not.toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalledOnce();
    const upsertInput = mockUpsert.mock.calls[0][0].upsertInput;
    expect(upsertInput.type).toBe(MEMORY_CONCEPT_TYPE_ID);
    expect((res as { confidence: number }).confidence).toBe(1.0);
  });

  it("tolerates the system-injected cinatraAgentRunId in the validated/stored shape", async () => {
    await save(makeEnvelope());
    const stored = mockUpsert.mock.calls[0][0].upsertInput.data as Record<string, unknown>;
    // The run id was injected by the handler (actor runId r1) and the
    // envelope still validated — what is validated is what persists.
    expect(stored.cinatraAgentRunId).toBe("r1");
    expect(stored.externalId).toBe(computeMemoryConceptExternalId(BUNDLE_ID, CONCEPT_ID));
  });

  it("materializes the okfVersion default into the STORED payload when omitted", async () => {
    const { okfVersion: _drop, ...withoutVersion } = makeEnvelope();
    await save(withoutVersion);
    const stored = mockUpsert.mock.calls[0][0].upsertInput.data as Record<string, unknown>;
    expect(stored.okfVersion).toBe("0.1");
    // ...and never clobbers an explicit value.
    await save(makeEnvelope({ okfVersion: "0.1-custom" }));
    const stored2 = mockUpsert.mock.calls[1][0].upsertInput.data as Record<string, unknown>;
    expect(stored2.okfVersion).toBe("0.1-custom");
  });

  it("derives identity from the envelope's externalId (stable id across re-syncs)", async () => {
    await save(makeEnvelope());
    const first = mockUpsert.mock.calls[0][0].upsertInput.id;
    await save(makeEnvelope());
    const second = mockUpsert.mock.calls[1][0].upsertInput.id;
    expect(first).toBe(second);
  });
});

describe("objects_save — memory envelope rejection paths (AC2, fail-closed)", () => {
  it("rejects an externalId mismatch BEFORE any commit", async () => {
    const bad = makeEnvelope({
      externalId: computeMemoryConceptExternalId(BUNDLE_ID, "some/other/concept"),
    });
    await expect(save(bad)).rejects.toThrow(/invalid memory concept envelope.*externalId/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects an okfType / frontmatter.type mismatch", async () => {
    const bad = makeEnvelope({ okfType: "command" });
    await expect(save(bad)).rejects.toThrow(/invalid memory concept envelope.*okfType/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects a body over the 64 KiB byte cap", async () => {
    const bad = makeEnvelope({
      bodyMarkdown: "x".repeat(MEMORY_CONCEPT_BODY_MAX_BYTES + 1),
    });
    await expect(save(bad)).rejects.toThrow(/invalid memory concept envelope.*bodyMarkdown/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects an empty payload (no envelope fields at all)", async () => {
    await expect(save({})).rejects.toThrow(/invalid memory concept envelope/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: refuses a memory-declared save when the static registration is missing — before classification, no LLM fall-through, no dynamic mint", async () => {
    objectTypeRegistry._clearForTests(); // simulate a boot path that never registered the type
    await expect(save(makeEnvelope())).rejects.toThrow(/static type is not registered/);
    expect(mockUpsert).not.toHaveBeenCalled();
    // The guard fires BEFORE classifyObject: without it the classifier would
    // fall through to the LLM path (its output enum cannot return an
    // unregistered static id) and the payload could be misclassified or
    // minted as a dynamic type and persisted with no envelope validation.
    expect(mockLlmResolve).not.toHaveBeenCalled();
    expect(mockEnsureDynamic).not.toHaveBeenCalled();
  });

  it("does NOT gate other static types (memory-scoped enforcement)", async () => {
    mockUpsert.mockReturnValue(
      makeMemoryRecord({ type: "@cinatra-ai/campaigns:context", data: { anything: true } }),
    );
    const handlers = createObjectsPrimitiveHandlers();
    await expect(
      handlers.objects_save({
        primitiveName: "objects_save",
        input: { rawData: { anything: true }, typeHint: "@cinatra-ai/campaigns:context" },
        actor: ACTOR,
        mode: "agentic",
      } as never),
    ).resolves.toBeTruthy();
    expect(mockUpsert).toHaveBeenCalledOnce();
  });
});

describe("objects_update — memory envelope enforcement on the merged payload", () => {
  it("accepts a patch whose MERGED envelope is valid", async () => {
    mockGet.mockReturnValue(makeMemoryRecord());
    const handlers = createObjectsPrimitiveHandlers();
    const res = await handlers.objects_update({
      primitiveName: "objects_update",
      input: { objectId: "obj-mem-1", data: { bodyMarkdown: "Updated body." } },
      actor: ACTOR,
      mode: "agentic",
    } as never);
    expect((res as { ok: boolean }).ok).toBe(true);
    expect(mockUpsert).toHaveBeenCalledOnce();
    const merged = mockUpsert.mock.calls[0][0].upsertInput.data as Record<string, unknown>;
    expect(merged.bodyMarkdown).toBe("Updated body.");
  });

  it("rejects a patch whose MERGED envelope is invalid, before any commit", async () => {
    mockGet.mockReturnValue(makeMemoryRecord());
    const handlers = createObjectsPrimitiveHandlers();
    await expect(
      handlers.objects_update({
        primitiveName: "objects_update",
        input: {
          objectId: "obj-mem-1",
          data: { conceptId: "hijacked/elsewhere" }, // externalId no longer matches
        },
        actor: ACTOR,
        mode: "agentic",
      } as never),
    ).rejects.toThrow(/invalid memory concept envelope.*externalId/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: refuses a memory-typed UPDATE when the static registration is missing (existing-row type path)", async () => {
    objectTypeRegistry._clearForTests(); // simulate a boot path that never registered the type
    mockGet.mockReturnValue(makeMemoryRecord());
    const handlers = createObjectsPrimitiveHandlers();
    await expect(
      handlers.objects_update({
        primitiveName: "objects_update",
        input: { objectId: "obj-mem-1", data: { bodyMarkdown: "x" } },
        actor: ACTOR,
        mode: "agentic",
      } as never),
    ).rejects.toThrow(/static type is not registered/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
