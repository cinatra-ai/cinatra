/**
 * cinatra#2592 — the classifier prompt/catalog now agree with the write
 * path's fail-closed contract (owner ruling 2026-07-18, epic #1785: "types
 * exist only by installation" — there is no generic or low-confidence
 * fallback save any more, #1787 reversed). This file pins that agreement at
 * three seams so the two sides can never silently diverge again:
 *
 *  1. Catalog exclusion — the retired generic `@cinatra-ai/objects:object`
 *     id stays REGISTERED (READ back-compat, register-types.ts) but is never
 *     shown to the classifier as a candidate.
 *  2. Vocabulary drift (grep/regression) — the prompt's static Rules text
 *     never re-promises a generic/low-confidence save, and the literal it
 *     instructs the model to emit for an unmatched result is the SAME
 *     sentinel the schema (and, transitively, the write path) accepts.
 *  3. End-to-end fixture outcomes — an un-hinted `objects_save` running the
 *     REAL classifier + REAL write-path handler against a scripted LLM
 *     either lands on a registered type or produces the typed
 *     `OBJECTS_TYPE_NOT_REGISTERED` refusal — never a silent generic save.
 */
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

vi.mock("@/lib/objects/draftable-lock-gate", () => ({
  assertDraftableWriteAllowed: async () => {},
}));

vi.mock("../graphiti-client", () => ({
  addEpisode: vi.fn(async () => ({ uuid: "ep-1", episode_id: "ep-1" })),
  deleteEpisode: vi.fn(async () => ({ ok: true })),
  searchNodes: vi.fn(async () => ({ nodes: [] })),
  getEpisodes: vi.fn(async () => ({ episodes: [] })),
  identityHashToUuid: (hash: string, _g: string) => `uuid-${hash}`,
}));

const h = vi.hoisted(() => {
  const state = {
    /** The next scripted LLM response body — set per test before saving. */
    nextResponse: null as Record<string, unknown> | null,
    /** Every `system` prompt string the classifier handed to the LLM. */
    capturedSystemPrompts: [] as string[],
  };
  return { state };
});

// Thin double for @cinatra-ai/llm — same shape as classifier-no-model-override
// .test.ts's double. `parseStructuredJson` is the REAL implementation.
vi.mock("@cinatra-ai/llm", async () => {
  const { parseStructuredJson } = await import("../../../llm/src/structured-json");
  return {
    resolveConfiguredLlmRuntime: vi.fn(async () => ({ provider: "anthropic" })),
    runResolvedDeterministicLlmTask: vi.fn(async (input: { system: string }) => {
      h.state.capturedSystemPrompts.push(input.system);
      if (!h.state.nextResponse) {
        throw new Error("test bug: h.state.nextResponse not set before calling save()");
      }
      return { text: JSON.stringify(h.state.nextResponse) };
    }),
    parseStructuredJson,
  };
});

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import { upsertObjectAndEnqueue } from "@/lib/objects-store";
import { objectTypeRegistry } from "../registry";
import { GENERIC_OBJECT_TYPE_ID } from "../namespace";
import { buildClassifierSystemPrompt } from "../classifier/prompt";
import { CLASSIFIER_UNMATCHED_TYPE_ID } from "../classifier/schema";

const mockUpsert = upsertObjectAndEnqueue as unknown as ReturnType<typeof vi.fn>;

const DOMAIN_TYPE = "@cinatra-ai/entity-contacts:contact";

const ACTOR = {
  actorType: "model",
  source: "agent",
  ...({ orgId: "org-1", agentId: "a1", runId: "run-1" } as unknown as Record<string, unknown>),
} as never;

function makeRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "obj-1",
    type: DOMAIN_TYPE,
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
    changeSetId: "cs-1",
    ...overrides,
  };
}

/** An UN-HINTED save: no typeHint, so the classifier's static fast-path is
 *  skipped and the LLM path runs — the seam this file targets. */
async function unhintedSave() {
  const handlers = createObjectsPrimitiveHandlers();
  return handlers.objects_save({
    primitiveName: "objects_save",
    input: { rawData: { name: "Acme" } },
    actor: ACTOR,
    mode: "agentic",
  } as never) as Promise<Record<string, unknown>>;
}

async function saveExpectingRefusal() {
  try {
    await unhintedSave();
  } catch (err) {
    return err as PrimitiveInvocationError;
  }
  throw new Error("expected objects_save to REFUSE, but it resolved");
}

beforeEach(() => {
  mockUpsert.mockReset();
  mockUpsert.mockReturnValue(makeRecord());
  h.state.nextResponse = null;
  h.state.capturedSystemPrompts.length = 0;
  objectTypeRegistry._clearForTests();
  // Registered like production: the domain type by an installed extension,
  // PLUS the retired generic type (READ back-compat, register-types.ts) —
  // exactly the shape the classifier catalog must filter (cinatra#2592: the
  // issue's grounding note that the generic id "is still registered, so it
  // still enters the classifier catalog today").
  objectTypeRegistry.register(
    { type: DOMAIN_TYPE, category: "record", description: "Contact" } as never,
    "@cinatra-ai/entity-contacts",
  );
  objectTypeRegistry.register({ type: GENERIC_OBJECT_TYPE_ID, category: "report" } as never);
});

describe("classifier catalog excludes the retired generic type (cinatra#2592)", () => {
  it("the system prompt shown to the model never offers the generic id as a candidate", async () => {
    h.state.nextResponse = {
      objectTypeId: DOMAIN_TYPE,
      confidence: 0.95,
      normalizedData: JSON.stringify({ name: "Acme" }),
      isNewType: false,
      inferredTypeName: "contact",
      inferredCategory: "profile",
      canonicalKeys: null,
    };
    const res = await unhintedSave();
    expect(res.type).toBe(DOMAIN_TYPE);
    expect(h.state.capturedSystemPrompts).toHaveLength(1);
    const prompt = h.state.capturedSystemPrompts[0];
    expect(prompt).not.toContain(GENERIC_OBJECT_TYPE_ID);
    expect(prompt).toContain(DOMAIN_TYPE);
  });
});

describe("prompt vocabulary never re-promises a retired outcome (grep/regression, cinatra#2592)", () => {
  // Isolate the STATIC rules text from catalog content by rendering with an
  // empty catalog — any of these phrases appearing here is prompt drift, not
  // an artifact of what happens to be registered.
  const staticPrompt = buildClassifierSystemPrompt([]);

  it("never claims an unmatched or low-confidence payload persists", () => {
    expect(staticPrompt).not.toMatch(/saved losslessly/i);
    expect(staticPrompt).not.toMatch(/generic object/i);
    expect(staticPrompt).not.toMatch(/also saved/i);
  });

  it("never names the retired generic type id as an outcome", () => {
    expect(staticPrompt).not.toContain(GENERIC_OBJECT_TYPE_ID);
  });

  it("the unmatched-branch literal it instructs the model to emit is byte-equal to the schema's accepted sentinel", () => {
    // Structural guarantee (prompt.ts imports the same constant from
    // schema.ts) — pinned at the rendered TEXT level so a future hardcoded
    // literal can't drift silently past a review.
    expect(staticPrompt).toContain(`"${CLASSIFIER_UNMATCHED_TYPE_ID}"`);
  });
});

describe("un-hinted saves: registered-type classification or the typed refusal — nothing else (cinatra#2592 AC)", () => {
  it("an unmatched classification (the schema-valid sentinel) is REFUSED, never persisted as generic", async () => {
    h.state.nextResponse = {
      objectTypeId: CLASSIFIER_UNMATCHED_TYPE_ID,
      confidence: 0.9,
      normalizedData: JSON.stringify({ name: "Acme" }),
      isNewType: true,
      inferredTypeName: "Something",
      inferredCategory: "report",
      canonicalKeys: null,
    };
    const err = await saveExpectingRefusal();
    expect(err).toBeInstanceOf(PrimitiveInvocationError);
    expect(err.code).toBe("OBJECTS_TYPE_NOT_REGISTERED");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("a low-confidence classification is REFUSED even for a registered type — no low-confidence fallback save", async () => {
    h.state.nextResponse = {
      objectTypeId: DOMAIN_TYPE,
      confidence: 0.2,
      normalizedData: JSON.stringify({ name: "Acme" }),
      isNewType: false,
      inferredTypeName: null,
      inferredCategory: null,
      canonicalKeys: null,
    };
    const err = await saveExpectingRefusal();
    expect(err.code).toBe("OBJECTS_TYPE_NOT_REGISTERED");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("a model that still proposes the retired generic id as a MATCHED type fails schema validation and is refused (not silently accepted)", async () => {
    h.state.nextResponse = {
      objectTypeId: GENERIC_OBJECT_TYPE_ID,
      confidence: 0.95,
      normalizedData: JSON.stringify({ name: "Acme" }),
      isNewType: false,
      inferredTypeName: null,
      inferredCategory: null,
      canonicalKeys: null,
    };
    const err = await saveExpectingRefusal();
    expect(err.code).toBe("OBJECTS_TYPE_NOT_REGISTERED");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("a confident, matched registered type still persists (the happy path is untouched)", async () => {
    h.state.nextResponse = {
      objectTypeId: DOMAIN_TYPE,
      confidence: 0.95,
      normalizedData: JSON.stringify({ name: "Acme" }),
      isNewType: false,
      inferredTypeName: "contact",
      inferredCategory: "profile",
      canonicalKeys: null,
    };
    const res = await unhintedSave();
    expect(res.type).toBe(DOMAIN_TYPE);
    expect(mockUpsert).toHaveBeenCalledOnce();
  });
});
