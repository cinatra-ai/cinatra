// Guard against reintroducing "project" as an ownership TIER.
// Project is a scope refinement, carried by `visibility='project:<id>'`
// (objects/derived) or the typed `ProjectRefinementTarget`
// (agent install / skill assignment), never an `OwnerLevel`.
import { describe, it, expect } from "vitest";
import {
  normalizeOwnerLevel,
  isOwnerLevelValue,
  type OwnerLevel,
  type ProjectRefinementTarget,
} from "@/lib/authz/resource-ref";

describe("OwnerLevel is exactly 4 tiers (no project)", () => {
  it("isOwnerLevelValue accepts the 4 tiers and rejects project/garbage", () => {
    for (const t of ["user", "team", "organization", "workspace"]) {
      expect(isOwnerLevelValue(t)).toBe(true);
    }
    expect(isOwnerLevelValue("project")).toBe(false);
    expect(isOwnerLevelValue("")).toBe(false);
    expect(isOwnerLevelValue(null)).toBe(false);
    expect(isOwnerLevelValue(undefined)).toBe(false);
  });

  it("normalizeOwnerLevel coerces legacy/unknown 'project' to 'organization' (behavior-preserving, non-leaking)", () => {
    expect(normalizeOwnerLevel("project")).toBe("organization");
    expect(normalizeOwnerLevel("garbage")).toBe("organization");
    expect(normalizeOwnerLevel(null)).toBe("organization");
    for (const t of ["user", "team", "organization", "workspace"]) {
      expect(normalizeOwnerLevel(t)).toBe(t);
    }
  });

  it("the type system separates the tier from the refinement target", () => {
    // Compile-time proof: OwnerLevel excludes 'project'; ProjectRefinementTarget includes it.
    const tier: OwnerLevel = "workspace";
    const refinement: ProjectRefinementTarget = "project";
    expect(tier).toBe("workspace");
    expect(refinement).toBe("project");
    // @ts-expect-error - 'project' must NOT be assignable to OwnerLevel.
    const bad: OwnerLevel = "project";
    expect(bad).toBe("project"); // runtime value still a string; the @ts-expect-error is the guard
  });
});
