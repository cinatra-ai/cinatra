import { describe, it, expect } from "vitest";
import { resolveExtensionRole, requireExtensionRole } from "@/lib/extension-roles";

// Optional-surface role resolution pins (cinatra#151 Stage 6). The committed
// generated bindings are the FULL-universe emission, so the present-case pins
// hold wherever this suite runs; absence is pinned through a role name no
// extension claims.
describe("extension-roles — optional-surface role resolution", () => {
  it("resolves each Stage-6 role to its single manifest claimant (committed full-universe bindings)", () => {
    expect(resolveExtensionRole("artifact-blog-post-body")).toBe("@cinatra-ai/blog-post-artifact");
    expect(resolveExtensionRole("artifact-blog-idea-summary")).toBe("@cinatra-ai/blog-idea-artifact");
    expect(resolveExtensionRole("artifact-blog-image")).toBe("@cinatra-ai/blog-image-artifact");
  });

  it("returns undefined for an unclaimed role (the NORMAL reduced-universe state)", () => {
    // `blog-operator-dashboard` is host-neutral vocabulary whose optional
    // claimant was retired with the archived workflow dev-extensions — a
    // well-typed role with no present claimant, so it resolves like any
    // reduced-universe absence.
    expect(resolveExtensionRole("blog-operator-dashboard")).toBeUndefined();
    expect(
      resolveExtensionRole("artifact-fixture-unclaimed" as Parameters<typeof resolveExtensionRole>[0]),
    ).toBeUndefined();
  });

  it("requireExtensionRole fails LOUD and descriptive on absence", () => {
    expect(() =>
      requireExtensionRole("artifact-fixture-unclaimed" as Parameters<typeof requireExtensionRole>[0]),
    ).toThrowError(/no present extension claims the role "artifact-fixture-unclaimed"/);
    expect(() =>
      requireExtensionRole("artifact-fixture-unclaimed" as Parameters<typeof requireExtensionRole>[0]),
    ).toThrowError(/generate-extension-manifest\.mjs/);
  });
});
