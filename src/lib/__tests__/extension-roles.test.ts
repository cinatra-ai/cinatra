import { describe, it, expect } from "vitest";
import { resolveExtensionRole, requireExtensionRole } from "@/lib/extension-roles";
import { GENERATED_AGENT_ROLE_BINDINGS } from "@/lib/generated/agent-bindings";

// Optional-surface role resolution pins (cinatra#151 Stage 6). The committed
// generated bindings are the FULL-universe emission, so the present-case pins
// hold wherever this suite runs; absence is pinned through a role name no
// extension claims.
describe("extension-roles — optional-surface role resolution", () => {
  it("resolves each Stage-6 role to its single manifest claimant (committed full-universe bindings)", () => {
    expect(resolveExtensionRole("artifact-blog-post-body")).toBe("@cinatra-ai/blog-post-artifact");
    expect(resolveExtensionRole("artifact-blog-idea-summary")).toBe("@cinatra-ai/blog-idea-artifact");
    expect(resolveExtensionRole("artifact-blog-image")).toBe("@cinatra-ai/blog-image-artifact");
    expect(resolveExtensionRole("blog-operator-dashboard")).toBe("@cinatra-ai/blog-content-workflow");
  });

  it("returns undefined for an unclaimed role (the NORMAL reduced-universe state)", () => {
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

  it("the semantic-floor role is claimed by a systemExtension (generation guard holds on the committed map)", () => {
    // The generator fail-closes on this; the pin here catches a hand-edited
    // or stale committed map before the gate does.
    expect(GENERATED_AGENT_ROLE_BINDINGS["artifact-default-floor"]).toBeTruthy();
  });
});
