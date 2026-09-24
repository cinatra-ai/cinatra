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
 *  2. Therefore the passthrough's selected-idea save may not NAME a tombstoned
 *     id. It names a host-owned, statically registered type instead.
 *  3. The shaper and its enabler-0.16 declaration name the SAME type — the
 *     declaration is what the audit reads, so a shaper that drifts from its
 *     declaration would put the refusal back without any test noticing.
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

/** The host-owned static type the selected-idea save names instead. */
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

  it("the selected-idea shaper no longer names a tombstoned type", () => {
    const out = shapeSelectedIdea();
    expect(out).not.toBeNull();
    expect(out!.typeHint).not.toBe(TOMBSTONED_SELECTED_IDEA_TYPE);
    expect(out!.typeHint.startsWith("@dynamic/types:")).toBe(false);
    expect(out!.typeHint.startsWith("@cinatra-ai/dynamic:")).toBe(false);
  });

  it("the selected-idea shaper names the host-owned static type, which classifies owned", () => {
    const out = shapeSelectedIdea();
    expect(out!.typeHint).toBe(OWNED_SELECTED_IDEA_TYPE);
    const own = classifyArtifactTypeOwnership(out!.typeHint, {
      isArtifactWritable: (id) => (id === OWNED_SELECTED_IDEA_TYPE ? true : null),
      packageHasRegisteredTypes: () => true,
    });
    expect(own).toEqual({ owned: true, definer: "@cinatra-ai/blog-pipeline" });
  });

  it("the shaper and its enabler-0.16 declaration name the SAME type", () => {
    const declaration = PASSTHROUGH_SHAPER_DECLARATIONS.find(
      (d) => d.shaperId === "blog-pipeline-seam:blog_pipeline_selected_idea",
    );
    expect(declaration).toBeDefined();
    expect(declaration!.savesTypes).toEqual([OWNED_SELECTED_IDEA_TYPE]);
    expect(declaration!.savesTypes).toContain(shapeSelectedIdea()!.typeHint);
  });
});
