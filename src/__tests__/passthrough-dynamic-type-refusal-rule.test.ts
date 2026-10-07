/**
 * cinatra#2960 — the resolution rule for `@dynamic/types:*` on the passthrough
 * SAVE PATH, pinned so the refusal class cannot silently return.
 *
 * ACCEPTANCE ITEM 2, VERBATIM: "A test pins the resolution rule for
 * `@dynamic/types:*` on the passthrough save path so the refusal class cannot
 * silently return."
 *
 * THE RULE, IN THREE PARTS:
 *  1. `@dynamic/types:*` is a PERMANENT tombstone. It classifies `owned:false`
 *     with reason `dynamic-namespace` unconditionally, whatever is installed —
 *     the classifier is correct and must never be relaxed to make a save pass.
 *  2. The host saves nothing under the tombstone: the passthrough's selected-idea
 *     save is retired (cinatra#3035), so the seam returns null for its shape.
 *  3. The host saves nothing under the blog pipeline's own namespace either — no
 *     enabler-0.16 declaration names the retired shaper, the tombstoned id or any
 *     type under `@cinatra-ai/blog-pipeline:`; that type belongs to the pack.
 */
import { describe, expect, it } from "vitest";

import {
  classifyArtifactTypeOwnership,
  type ArtifactTypeOwnershipPorts,
} from "@cinatra-ai/objects/namespace";
import { shapeBlogPipelineObjectsSave } from "@/app/api/agents/passthrough/blog-pipeline-seam";
import { PASSTHROUGH_SHAPER_DECLARATIONS } from "@/app/api/agents/passthrough/shaper-type-declarations";

/** The id cinatra#2960 recorded the refusal on. Never a write target again. */
const TOMBSTONED_SELECTED_IDEA_TYPE = "@dynamic/types:blog-pipeline-selected-idea";

/** The type the retired selected-idea save named; the host saves nothing under it now. */
const OWNED_SELECTED_IDEA_TYPE = "@cinatra-ai/blog-pipeline:selected-idea";

/** Ports over a registry in which EVERY namespaced id resolves — the most
 *  permissive registry a save could ever meet. The tombstone must still hold. */
const everythingInstalled: ArtifactTypeOwnershipPorts = {
  isArtifactWritable: () => true,
  packageHasRegisteredTypes: () => true,
};

function shapeSelectedIdea() {
  return shapeBlogPipelineObjectsSave(
    {
      _shape: "blog_pipeline_selected_idea",
      selectedIdeaJson: JSON.stringify({ title: "A", summary: "s", outline: ["1"] }),
      ideas: [{ title: "A", summary: "s", outline: ["1"] }],
      cinatra_agent_run_id: "run-2960",
    },
    "run-fallback",
  );
}

describe("cinatra#2960 — the @dynamic/types:* rule on the passthrough save path", () => {
  it("the tombstoned selected-idea id stays unowned with reason dynamic-namespace, whatever is installed", () => {
    const own = classifyArtifactTypeOwnership(
      TOMBSTONED_SELECTED_IDEA_TYPE,
      everythingInstalled,
    );
    expect(own.owned).toBe(false);
    if (own.owned) return;
    expect(own.reason).toBe("dynamic-namespace");
    expect(own.suggestedExtension).toBeNull();
  });

  it("the retired selected-idea shape is shaped no more: the seam returns null", () => {
    expect(shapeSelectedIdea()).toBeNull();
  });

  it("no enabler-0.16 declaration names the retired selected-idea shaper", () => {
    const declaration = PASSTHROUGH_SHAPER_DECLARATIONS.find(
      (d) => d.shaperId === "blog-pipeline-seam:blog_pipeline_selected_idea",
    );
    expect(declaration).toBeUndefined();
  });

  it("no declaration saves the tombstoned id or any type under the blog pipeline's namespace", () => {
    for (const d of PASSTHROUGH_SHAPER_DECLARATIONS) {
      expect(d.savesTypes).not.toContain(TOMBSTONED_SELECTED_IDEA_TYPE);
      expect(d.savesTypes).not.toContain(OWNED_SELECTED_IDEA_TYPE);
      for (const type of d.savesTypes) {
        expect(type.startsWith("@cinatra-ai/blog-pipeline:")).toBe(false);
      }
    }
  });
});
