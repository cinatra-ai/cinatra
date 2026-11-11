/**
 * ENABLER 0.16 — THE UNOWNED-TYPE REFUSAL, AT BOTH ENDS
 * (`PLAN: Agents Lifecycle (C)` §4.1, cinatra#3028 / epic #3023).
 *
 * THE PLAN'S SENTENCE, VERBATIM: "The unowned-type refusal, at both ends: the
 * save boundary refuses a type that no installed extension and not the host
 * owns, with a named reason; and the compiler flags an agent whose steps save to
 * a type it neither declares nor depends on — the dynamic-type namespace
 * resolves nowhere by design (https://github.com/cinatra-ai/cinatra/issues/2960).
 * The host's passthrough shapers are inside the rule: a shaper declares the
 * types it saves through a contract the compiler reads, exactly as an agent
 * does, and a shaper never persists a transform of a run value — a projection is
 * a deterministic, non-persisting step."
 *
 * WHAT IT FIXES, VERBATIM: "a run fails one frame after its gate with an opaque
 * error because a host shaper saves an intermediate value under a type nothing
 * defines — two such writes exist on the blog pipeline's road, neither visible
 * in the agent's own declarations."
 *
 * THIS IS ACCEPTANCE ITEM 4: "A save to an unowned type is refused with its
 * reason on the surface."
 */
import { describe, expect, it } from "vitest";

import {
  UNOWNED_ARTIFACT_TYPE_REASONS,
  classifyArtifactTypeOwnership,
  definerPackageOfObjectTypeId,
  unownedArtifactTypeMessage,
  type ArtifactTypeOwnershipPorts,
} from "@cinatra-ai/objects/namespace";
import {
  PASSTHROUGH_SHAPER_DECLARATIONS,
  auditPassthroughShaperDeclarations,
} from "@/app/api/agents/passthrough/shaper-type-declarations";

/** Ports over a pretend registry: `writable` names the ids that resolve to an
 *  artifact write target, `data` the ids that resolve to a plain data type. */
function ports(opts: {
  writable?: string[];
  data?: string[];
  installedPackages?: string[];
}): ArtifactTypeOwnershipPorts {
  const writable = new Set(opts.writable ?? []);
  const data = new Set(opts.data ?? []);
  const installed = new Set(opts.installedPackages ?? []);
  return {
    isArtifactWritable: (id) => (writable.has(id) ? true : data.has(id) ? false : null),
    packageHasRegisteredTypes: (pkg) => installed.has(pkg),
  };
}

describe("0.16 — the save boundary's named reason", () => {
  it("names the reserved dynamic namespace as the reason, not a missing install", () => {
    // The exact id cinatra#2960 recorded the opaque refusal on.
    const own = classifyArtifactTypeOwnership(
      "@dynamic/types:blog-pipeline-selected-idea",
      ports({}),
    );
    expect(own.owned).toBe(false);
    if (own.owned) return;
    expect(own.reason).toBe("dynamic-namespace");
    // Never a fabricated install hint for an id that by design resolves nowhere.
    expect(own.suggestedExtension).toBeNull();
    const message = unownedArtifactTypeMessage(
      "@dynamic/types:blog-pipeline-selected-idea",
      own,
    );
    expect(message).toContain("reserved dynamic-type namespace");
    expect(message).not.toContain("install @dynamic/types");
  });

  it("names the legacy dynamic prefix the same way", () => {
    const own = classifyArtifactTypeOwnership("@cinatra-ai/dynamic:brand-audit", ports({}));
    expect(own.owned === false && own.reason).toBe("dynamic-namespace");
  });

  it("names the retired generic host types", () => {
    for (const id of ["@cinatra-ai/objects:object", "@cinatra-ai/artifact:object"]) {
      const own = classifyArtifactTypeOwnership(id, ports({}));
      expect(own.owned === false && own.reason).toBe("retired-generic");
    }
  });

  it("names a non-namespaced id", () => {
    for (const id of ["invoice", "", "@cinatra-ai/blog-post-artifact"]) {
      const own = classifyArtifactTypeOwnership(id, ports({}));
      expect(own.owned === false && own.reason).toBe("not-namespaced");
    }
  });

  it("names a missing definer — and suggests the install only when the package is not installed", () => {
    const absent = classifyArtifactTypeOwnership(
      "@cinatra-ai/blog-post-artifact:post",
      ports({}),
    );
    expect(absent.owned === false && absent.reason).toBe("no-installed-definer");
    expect(absent.owned === false && absent.suggestedExtension).toBe(
      "@cinatra-ai/blog-post-artifact",
    );

    const installedButUndeclared = classifyArtifactTypeOwnership(
      "@cinatra-ai/blog-post-artifact:draft",
      ports({ installedPackages: ["@cinatra-ai/blog-post-artifact"] }),
    );
    expect(installedButUndeclared.owned === false && installedButUndeclared.suggestedExtension)
      .toBeNull();
  });

  it("names a data type that is not an artifact write target", () => {
    const own = classifyArtifactTypeOwnership(
      "@cinatra-ai/campaigns:context",
      ports({ data: ["@cinatra-ai/campaigns:context"] }),
    );
    expect(own.owned === false && own.reason).toBe("not-artifact-writable");
  });

  it("admits an installed artifact type and names its definer", () => {
    const own = classifyArtifactTypeOwnership(
      "@cinatra-ai/blog-post-artifact:post",
      ports({ writable: ["@cinatra-ai/blog-post-artifact:post"] }),
    );
    expect(own).toEqual({ owned: true, definer: "@cinatra-ai/blog-post-artifact" });
  });

  it("every reason token carries a message of its own — the set is closed and total", () => {
    const seen = new Set<string>();
    for (const reason of UNOWNED_ARTIFACT_TYPE_REASONS) {
      const message = unownedArtifactTypeMessage("@scope/pkg:thing", {
        owned: false,
        reason,
        definer: "@scope/pkg",
        suggestedExtension: null,
      });
      expect(message.length).toBeGreaterThan(0);
      seen.add(message);
    }
    // Distinct reasons must READ distinctly — the whole point of naming them.
    expect(seen.size).toBe(UNOWNED_ARTIFACT_TYPE_REASONS.length);
  });

  it("derives the definer package from a namespaced id", () => {
    expect(definerPackageOfObjectTypeId("@cinatra-ai/blog-post-artifact:post")).toBe(
      "@cinatra-ai/blog-post-artifact",
    );
    expect(definerPackageOfObjectTypeId("invoice")).toBeNull();
  });
});

describe("0.16 — the passthrough shapers are inside the rule", () => {
  it("every shaper on the passthrough declares the types it saves", () => {
    const ids = PASSTHROUGH_SHAPER_DECLARATIONS.map((d) => d.shaperId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("route:campaigns_context_setup");
    for (const d of PASSTHROUGH_SHAPER_DECLARATIONS) {
      expect(d.savesTypes.length).toBeGreaterThan(0);
    }
  });

  it("the two blog-pipeline writes are retired: no shaper declares them (cinatra#3035)", () => {
    // The plan gave "the removal of the selected-idea save and the persisted
    // draft projection" to the pipeline's own wave, W11 (cinatra#3035). Both
    // shapers are gone, so neither is declared any more.
    const ids = PASSTHROUGH_SHAPER_DECLARATIONS.map((d) => d.shaperId);
    expect(ids).not.toContain("blog-pipeline-seam:blog_pipeline_selected_idea");
    expect(ids).not.toContain("blog-pipeline-seam:blog_pipeline_draft_projection");
    expect(ids.filter((id) => id.startsWith("blog-pipeline-seam:"))).toEqual([]);
    // No declared write still counts down to the wave that retired them.
    expect(PASSTHROUGH_SHAPER_DECLARATIONS.filter((d) => d.retiredBy === "cinatra#3035")).toEqual([]);
  });

  it("the audit names no unowned shaper save once the blog-pipeline writes are retired", () => {
    // The campaigns context type IS owned by an installed extension, and the
    // two writes the plan named on the blog pipeline's road are retired.
    const findings = auditPassthroughShaperDeclarations(
      ports({ writable: ["@cinatra-ai/campaigns:context"] }),
    );
    expect(findings.filter((f) => f.kind === "unowned-type")).toEqual([]);
  });

  it("no declared shaper persists a transform of a run value", () => {
    // The plan: "a shaper never persists a transform of a run value — a
    // projection is a deterministic, non-persisting step". The two that did
    // were the blog pipeline's, now retired.
    const findings = auditPassthroughShaperDeclarations(
      ports({ writable: ["@cinatra-ai/campaigns:context"] }),
    );
    expect(findings.filter((f) => f.kind === "persists-run-value-transform")).toEqual([]);
    expect(PASSTHROUGH_SHAPER_DECLARATIONS.some((d) => d.persistsRunValueTransform)).toBe(false);
  });

  it("the audit still names an unowned, persisting write with its reason and its countdown", () => {
    // The audit itself stays: a declaration that saves under the reserved
    // dynamic namespace and persists a transform is named on both counts, and
    // carries its countdown onto every finding.
    const findings = auditPassthroughShaperDeclarations(
      ports({ writable: ["@cinatra-ai/campaigns:context"] }),
      [
        {
          shaperId: "fixture:dynamic_projection",
          module: "fixture.ts",
          savesTypes: ["@dynamic/types:fixture-projection"],
          persistsRunValueTransform: true,
          retiredBy: "fixture#1",
        },
      ],
    );
    expect(findings.map((f) => f.kind).sort()).toEqual([
      "persists-run-value-transform",
      "unowned-type",
    ]);
    const unowned = findings.find((f) => f.kind === "unowned-type");
    expect(unowned?.reason).toBe("dynamic-namespace");
    for (const f of findings) expect(f.retiredBy).toBe("fixture#1");
  });

  it("a shaper whose type an installed extension owns raises nothing", () => {
    const findings = auditPassthroughShaperDeclarations(
      ports({ writable: ["@cinatra-ai/campaigns:context"] }),
    );
    expect(findings.some((f) => f.shaperId === "route:campaigns_context_setup")).toBe(false);
  });
});
