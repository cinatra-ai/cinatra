/**
 * The passthrough save path's type-resolution rule for the blog-pipeline seam
 * (cinatra#2960).
 *
 * The refusal this pins: with a fielded selection the next frame answered
 * `500 {"error":"no installed artifact extension defines
 * \"@dynamic/types:blog-pipeline-selected-idea\""}`, because the seam minted its
 * type hint under the `@dynamic/types:` namespace — a PERMANENT tombstone
 * (`packages/objects/src/namespace.ts`) that no save may ever land under. The
 * rule this file locks:
 *
 *   1. every type hint the seam emits resolves through the installed set — the
 *      same registry `objects_save` resolves against;
 *   2. no seam hint is under a tombstoned dynamic namespace, and the retired
 *      ids stay unresolvable;
 *   3. a genuinely undefined type is STILL unresolved — the fail-closed write
 *      boundary is untouched;
 *   4. a shaper that emits a tombstoned hint fails immediately, naming what
 *      must define the type.
 *
 *   pnpm exec vitest run src/__tests__/blog-pipeline-passthrough-save-type.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { collectAllPrimitiveHandlers } from "@/lib/primitive-handlers";
import { classifyObject } from "../../packages/objects/src/classifier";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { registerAllObjectTypes } from "@cinatra-ai/objects/register-object-types";
import {
  isTombstonedObjectTypeId,
  TOMBSTONED_OBJECT_TYPE_ID_PREFIXES,
} from "@cinatra-ai/objects/namespace";
import {
  shapeBlogPipelineObjectsSave,
  assertPassthroughSaveTypeHint,
  BLOG_PIPELINE_SELECTED_IDEA_TYPE_ID,
  BLOG_PIPELINE_DRAFT_PROJECTION_TYPE_ID,
} from "../app/api/agents/passthrough/blog-pipeline-seam";

/** The exact ids the refusal named, kept as literals so the retirement holds. */
const RETIRED_SEAM_TYPE_IDS = [
  "@dynamic/types:blog-pipeline-selected-idea",
  "@dynamic/types:blog-pipeline-draft-projection",
];

const IDEA = { title: "B", summary: "sb", outline: ["2"] };

function shapeSelectedIdea() {
  return shapeBlogPipelineObjectsSave(
    {
      _shape: "blog_pipeline_selected_idea",
      selectedIdeaJson: JSON.stringify(IDEA),
      ideas: [IDEA],
      cinatra_agent_run_id: "run-1",
    },
    "run-fallback",
  );
}

function shapeDraftProjection() {
  return shapeBlogPipelineObjectsSave(
    {
      _shape: "blog_pipeline_draft_projection",
      draft: { title: "T", excerpt: "E", content: "C" },
      cinatra_agent_run_id: "run-1",
    },
    "run-fallback",
  );
}

describe("blog-pipeline passthrough save — type resolution", () => {
  beforeAll(() => {
    // The registrar the passthrough dispatch path mounts: it is what makes a
    // type hint resolvable at the `objects_save` write boundary.
    registerAllObjectTypes();
  });

  it("every seam type hint resolves through the installed set", () => {
    for (const shaped of [shapeSelectedIdea(), shapeDraftProjection()]) {
      expect(shaped).not.toBeNull();
      const def = objectTypeRegistry.resolve(shaped!.typeHint);
      expect(def, `unresolved seam type hint ${shaped!.typeHint}`).not.toBeNull();
      expect(def!.type).toBe(shaped!.typeHint);
    }
  });

  it("the selection save carries the picked idea under its resolved type", () => {
    const shaped = shapeSelectedIdea()!;
    expect(shaped.typeHint).toBe(BLOG_PIPELINE_SELECTED_IDEA_TYPE_ID);
    expect(shaped.rawData.idea).toEqual(IDEA);
    // The run-scoped identity the registered type dedups retries on.
    expect(shaped.rawData.cinatra_agent_run_id).toBe("run-1");
    expect(objectTypeRegistry.resolve(shaped.typeHint)!.category).toBe("idea");
  });

  it("the draft projection resolves to its own registered type", () => {
    const shaped = shapeDraftProjection()!;
    expect(shaped.typeHint).toBe(BLOG_PIPELINE_DRAFT_PROJECTION_TYPE_ID);
    expect(objectTypeRegistry.resolve(shaped.typeHint)!.category).toBe("content");
  });

  it("no seam type hint is under a tombstoned dynamic namespace", () => {
    for (const shaped of [shapeSelectedIdea(), shapeDraftProjection()]) {
      expect(isTombstonedObjectTypeId(shaped!.typeHint)).toBe(false);
    }
  });

  it("the retired @dynamic/types ids stay tombstoned and unresolvable", () => {
    for (const id of RETIRED_SEAM_TYPE_IDS) {
      expect(isTombstonedObjectTypeId(id)).toBe(true);
      expect(objectTypeRegistry.resolve(id)).toBeNull();
    }
  });

  it("a genuinely undefined type is STILL unresolved (fail-closed preserved)", () => {
    expect(objectTypeRegistry.resolve("@cinatra-ai/not-installed:thing")).toBeNull();
  });
});

describe("assertPassthroughSaveTypeHint — the declared resolution rule", () => {
  it("rejects every tombstoned dynamic namespace and names what must define the type", () => {
    for (const prefix of TOMBSTONED_OBJECT_TYPE_ID_PREFIXES) {
      expect(() => assertPassthroughSaveTypeHint(`${prefix}blog-pipeline-selected-idea`))
        .toThrow(/permanently retired dynamic namespace/);
      expect(() => assertPassthroughSaveTypeHint(`${prefix}blog-pipeline-selected-idea`))
        .toThrow(/installed artifact extension declares/);
    }
  });

  it("accepts the seam's own hints", () => {
    for (const id of [
      BLOG_PIPELINE_SELECTED_IDEA_TYPE_ID,
      BLOG_PIPELINE_DRAFT_PROJECTION_TYPE_ID,
      "@cinatra-ai/campaigns:context",
    ]) {
      expect(() => assertPassthroughSaveTypeHint(id)).not.toThrow();
    }
  });

  it("does NOT widen to an uninstalled definer — the write boundary still owns that refusal", () => {
    expect(() => assertPassthroughSaveTypeHint("@cinatra-ai/not-installed:thing")).not.toThrow();
  });
});

describe("the passthrough dispatch path resolves the seam save from a COLD registry", () => {
  // The reported 500 is a COLD-START class as much as a naming class: the
  // in-process primitive registry that /api/agents/passthrough dispatches
  // through does not load the MCP module whose `createObjectsModule()` used to
  // be the only thing that registered these types. So the proof starts from an
  // EMPTY registry and goes through the real handler collection.
  it("collecting the handlers boots the registrar and the selection save resolves", async () => {
    objectTypeRegistry._clearForTests();
    const handlers = (await collectAllPrimitiveHandlers()) as Record<string, unknown>;
    expect(typeof handlers.objects_save).toBe("function");

    const shaped = shapeSelectedIdea()!;
    // Step 1 of objects_save — classification. An exactly-registered type hint
    // takes the static fast path, so no LLM is consulted: this is the path the
    // credential-free development runtime actually takes.
    const classification = await classifyObject(shaped.rawData, shaped.typeHint);
    expect(classification.isNewType).toBe(false);
    expect(classification.type).toBe(shaped.typeHint);
    expect(classification.confidence).toBe(1);

    // Step 2 — the fail-closed write-boundary decision the 500 came from
    // (packages/objects/src/mcp/handlers.ts): a save is refused when the
    // classification is a new type, a dynamic/tombstoned id, below 0.4
    // confidence, or resolves to nothing in the live registry. None holds now.
    expect(isTombstonedObjectTypeId(classification.type)).toBe(false);
    expect(classification.confidence).toBeGreaterThanOrEqual(0.4);
    expect(objectTypeRegistry.resolve(classification.type)).not.toBeNull();
  });

  it("the retired hint and an undefined type are STILL refused from the same warm registry", () => {
    for (const id of [...RETIRED_SEAM_TYPE_IDS, "@cinatra-ai/not-installed:thing"]) {
      // No live registration → the write boundary's registry check refuses.
      expect(objectTypeRegistry.resolve(id)).toBeNull();
    }
    // ...and a tombstoned id is refused even if something ever registered it.
    for (const id of RETIRED_SEAM_TYPE_IDS) {
      expect(isTombstonedObjectTypeId(id)).toBe(true);
    }
  });
});
