/**
 * ISOLATION regression (epic #1620 M1 Slice B — cinatra#1630, Codex convergence):
 * the system-artifact-renderer registrar projects its "system" set + provider
 * bindings from the generated build map, which carries an entry for EVERY bundled
 * `kind:"artifact"` extension that declares `cinatra.artifact.ui.renderers` — NOT
 * only system ones (`resolution: "required"` == `systemExtensions`; every other
 * bundled artifact is `resolution: "guardedOptional"`).
 *
 * Without a `resolution` filter a bundled NON-system (`guardedOptional`) artifact
 * renderer would leak into the system set: auto-bound as a representation provider
 * for EVERY org (activate-without-install) AND exempted from capability teardown
 * (survive-uninstall). This suite mocks the generated map to include both a
 * `required` and a `guardedOptional` artifact and proves the guardedOptional is
 * excluded from BOTH the system-package set and the provider-spec projection.
 *
 * A SEPARATE file (not the real-map suite) because `vi.mock` is module-scoped.
 */
import { describe, expect, it, vi } from "vitest";

// Mock the generated build map: one `required` system base and one bundled
// `guardedOptional` (non-system) artifact renderer, both declaring `image/*`.
vi.mock("@/lib/generated/artifact-renderers", () => ({
  GENERATED_ARTIFACT_RENDERERS: {
    "@cinatra-ai/image-artifact::detail": {
      resolution: "required",
      packageName: "@cinatra-ai/image-artifact",
      slot: "detail",
      representations: ["image/*"],
      propsApiVersion: 1,
      load: async () => ({}),
    },
    "@vendor/marketplace-artifact::detail": {
      resolution: "guardedOptional",
      packageName: "@vendor/marketplace-artifact",
      slot: "detail",
      representations: ["image/*"],
      propsApiVersion: 1,
      load: async () => ({}),
    },
  },
}));

import {
  systemArtifactRendererPackages,
  isSystemArtifactRendererPackage,
  systemRepresentationProviderSpecs,
} from "@/lib/artifacts/system-artifact-renderer-registrar";

const SYSTEM = "@cinatra-ai/image-artifact";
const NON_SYSTEM = "@vendor/marketplace-artifact";

describe("registrar projects ONLY resolution:required entries as system bases", () => {
  it("the system-package set includes the required base and EXCLUDES the bundled guardedOptional artifact", () => {
    const pkgs = systemArtifactRendererPackages();
    expect(pkgs).toContain(SYSTEM);
    expect(pkgs.has(NON_SYSTEM)).toBe(false);
    // isSystemArtifactRendererPackage gates the teardown exemption — a
    // guardedOptional artifact must NOT be exempt from uninstall.
    expect(isSystemArtifactRendererPackage(SYSTEM)).toBe(true);
    expect(isSystemArtifactRendererPackage(NON_SYSTEM)).toBe(false);
  });

  it("the provider-spec projection binds the required base but NEVER the guardedOptional one", () => {
    const specs = systemRepresentationProviderSpecs();
    // The required base projects at least one allowlisted-MIME spec.
    expect(specs.some((s) => s.packageName === SYSTEM)).toBe(true);
    // The guardedOptional artifact — same `image/*` representation — is never
    // auto-bound as a system provider (would be activate-without-install).
    expect(specs.some((s) => s.packageName === NON_SYSTEM)).toBe(false);
  });
});
