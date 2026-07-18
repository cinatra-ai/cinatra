import { describe, expect, it } from "vitest";

import {
  EnvironmentMountRefusedError,
  resolveEnvironmentMount,
  type ResolvedEnvironmentMount,
} from "../environment/mount";
import {
  signEnvironmentProvenance,
  type EnvironmentLayerProvenance,
} from "../environment/provenance";
import {
  computeEnvironmentRecipeKey,
  ENVIRONMENT_BUILDER_VERSION,
  type EnvironmentBuildRecipe,
} from "../environment/recipe";

const KEY = "unit-test-provenance-key";

function recipeFor(): EnvironmentBuildRecipe {
  return {
    spec: { pip: ["pandas==2.2.2"] },
    l0BaseDigest: "sha256:l0base",
    builderVersion: ENVIRONMENT_BUILDER_VERSION,
    platform: { os: "linux", arch: "arm64" },
    buildPolicy: {
      networkPolicy: "registry-allowlist",
      registryAllowlist: ["pypi.org"],
    },
    resolvedArtifacts: { pip: { resolved: "sha256:pinned", integrity: "sha256:pinned-int" } },
  };
}

function mountFor(
  over: { imageDigest?: string; key?: string } = {},
): ResolvedEnvironmentMount {
  const recipe = recipeFor();
  const recipeKey = computeEnvironmentRecipeKey(recipe);
  const prov: EnvironmentLayerProvenance = {
    recipeKey,
    recipe,
    imageDigest: over.imageDigest ?? "sha256:layerdigest",
    partition: "instance",
    builderIdentity: ENVIRONMENT_BUILDER_VERSION,
    builtAtMs: 1_000,
  };
  return {
    imageRef: `cinatra-sandbox-l1:${recipeKey}`,
    provenance: signEnvironmentProvenance(prov, over.key ?? KEY),
  };
}

describe("resolveEnvironmentMount — verify-before-mount (fail-closed)", () => {
  it("resolves the SIGNED image digest for a valid mount", () => {
    expect(resolveEnvironmentMount(mountFor(), KEY)).toEqual({
      ok: true,
      imageDigest: "sha256:layerdigest",
    });
  });

  it("resolves the digest from the signed provenance, never an unsigned alias", () => {
    const mount = mountFor({ imageDigest: "sha256:the-real-one" });
    // The imageRef alias is irrelevant to what runs — only the signed digest is.
    mount.imageRef = "cinatra-sandbox-l1:a-lie";
    expect(resolveEnvironmentMount(mount, KEY)).toEqual({
      ok: true,
      imageDigest: "sha256:the-real-one",
    });
  });

  it("refuses when no provenance key is configured", () => {
    expect(resolveEnvironmentMount(mountFor(), undefined)).toEqual({
      ok: false,
      reason: "no_provenance_key",
    });
    expect(resolveEnvironmentMount(mountFor(), "")).toEqual({
      ok: false,
      reason: "no_provenance_key",
    });
  });

  it("refuses a mount signed with a different key", () => {
    expect(resolveEnvironmentMount(mountFor({ key: "some-other-key" }), KEY)).toEqual({
      ok: false,
      reason: "unverifiable_provenance",
    });
  });

  it("refuses a tampered provenance (image digest swapped after signing)", () => {
    const mount = mountFor();
    // Attacker swaps the digest the layer resolves to but cannot re-sign it.
    mount.provenance = { ...mount.provenance, imageDigest: "sha256:swapped" };
    expect(resolveEnvironmentMount(mount, KEY)).toEqual({
      ok: false,
      reason: "unverifiable_provenance",
    });
  });

  it("EnvironmentMountRefusedError carries the machine reason + a message", () => {
    const err = new EnvironmentMountRefusedError("unverifiable_provenance");
    expect(err.reason).toBe("unverifiable_provenance");
    expect(err.name).toBe("EnvironmentMountRefusedError");
    expect(err.message).toMatch(/did not verify/);
    expect(err).toBeInstanceOf(Error);
  });
});
