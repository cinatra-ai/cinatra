// The declared dependency-edge ROLE survives a persistence round-trip
// (cinatra#2090 S3, epic #2086).
//
// The edge-role vocabulary is what lets an artifact extension declare BOTH its
// classifier's rules and its chat authoring methodology and have the host know
// which is which. Edges live in `extension_dependency_edge` rows, so a `role`
// added to the canonical type but not to the row mapping would be silently
// dropped on every write and read back as a ROLE-LESS edge — which resolves
// nothing and classifies nothing. This suite pins both halves of the mapping
// against each other so the two can never drift apart again.
import { describe, expect, it } from "vitest";

import type { ResolvedDependencyEdge } from "../canonical-types";
import { __test } from "../canonical-store";

const { resolvedEdgeToRowValues, edgeRowToResolved } = __test;

function edge(over: Partial<ResolvedDependencyEdge> = {}): ResolvedDependencyEdge {
  return {
    packageName: "@cinatra-ai/blog-idea-matcher-skill",
    kind: "skill",
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "*" },
    requirement: "required",
    resolvedInstallId: "install-1",
    resolutionReason: "scoped:org",
    ...over,
  };
}

/** Persist → read back, through the two pure mappers the store uses. */
function roundTrip(e: ResolvedDependencyEdge): ResolvedDependencyEdge {
  const values = resolvedEdgeToRowValues("edge-1", "dependent-1", e, 0);
  return edgeRowToResolved({
    ...values,
    versionConstraint: values.versionConstraint as never,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);
}

describe("dependency-edge role round-trip", () => {
  it("a matcher edge reads back as a matcher edge", () => {
    expect(roundTrip(edge({ role: "matcher" }))).toEqual(edge({ role: "matcher" }));
  });

  it("an authoring edge reads back as an authoring edge", () => {
    expect(roundTrip(edge({ role: "authoring" }))).toEqual(edge({ role: "authoring" }));
  });

  it("a ROLE-LESS edge stays role-less (no key materializes)", () => {
    const out = roundTrip(edge());
    expect(out).toEqual(edge());
    expect("role" in out).toBe(false);
  });

  it("the write half persists the role in the row column", () => {
    expect(resolvedEdgeToRowValues("e", "d", edge({ role: "matcher" }), 0).declaredRole).toBe(
      "matcher",
    );
    expect(resolvedEdgeToRowValues("e", "d", edge(), 0).declaredRole).toBeNull();
  });

  it("EVERY field of the canonical edge survives the round-trip", () => {
    // The generic guard: if a future field is added to `ExtensionDependency`
    // and to only ONE mapper, this fails without anyone having to remember to
    // add a case for it.
    const full = edge({ role: "authoring", requirement: "optional", edgeType: "install-time" });
    expect(Object.keys(roundTrip(full)).sort()).toEqual(Object.keys(full).sort());
  });
});
