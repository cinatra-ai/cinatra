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
 *  2. The host saves nothing under the tombstone: both blog-pipeline shapers
 *     that saved there (the selected idea and the draft projection) are retired
 *     (cinatra#3035), so no passthrough declaration names a type under it.
 *  3. The host saves nothing under the blog pipeline's own namespace either —
 *     no declaration names a retired shaper or any type under
 *     `@cinatra-ai/blog-pipeline:`; such a type belongs to the pack.
 */
import { describe, expect, it } from "vitest";

import {
  classifyArtifactTypeOwnership,
  type ArtifactTypeOwnershipPorts,
} from "@cinatra-ai/objects/namespace";
import { PASSTHROUGH_SHAPER_DECLARATIONS } from "@/app/api/agents/passthrough/shaper-type-declarations";

/** The ids cinatra#2960 recorded the refusal on. Never a write target again. */
const TOMBSTONED_TYPES = [
  "@dynamic/types:blog-pipeline-selected-idea",
  "@dynamic/types:blog-pipeline-draft-projection",
];

/** Ports over a registry in which EVERY namespaced id resolves — the most
 *  permissive registry a save could ever meet. The tombstone must still hold. */
const everythingInstalled: ArtifactTypeOwnershipPorts = {
  isArtifactWritable: () => true,
  packageHasRegisteredTypes: () => true,
};

describe("cinatra#2960 — the @dynamic/types:* rule on the passthrough save path", () => {
  it("the tombstoned blog-pipeline ids stay unowned with reason dynamic-namespace, whatever is installed", () => {
    for (const typeId of TOMBSTONED_TYPES) {
      const own = classifyArtifactTypeOwnership(typeId, everythingInstalled);
      expect(own.owned).toBe(false);
      if (own.owned) return;
      expect(own.reason).toBe("dynamic-namespace");
      expect(own.suggestedExtension).toBeNull();
    }
  });

  it("no passthrough declaration names a retired blog-pipeline shaper (cinatra#3035)", () => {
    const blog = PASSTHROUGH_SHAPER_DECLARATIONS.filter(
      (d) => d.shaperId.startsWith("blog-pipeline-seam:") || d.module.includes("blog-pipeline-seam"),
    );
    expect(blog).toEqual([]);
  });

  it("no declaration saves under the tombstone or under the blog pipeline's namespace", () => {
    for (const d of PASSTHROUGH_SHAPER_DECLARATIONS) {
      for (const type of d.savesTypes) {
        expect(type.startsWith("@dynamic/types:")).toBe(false);
        expect(type.startsWith("@cinatra-ai/blog-pipeline:")).toBe(false);
      }
    }
  });
});
