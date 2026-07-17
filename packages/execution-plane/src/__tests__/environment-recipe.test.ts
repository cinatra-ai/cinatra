import { describe, expect, it } from "vitest";

import {
  computeEnvironmentRecipeKey,
  computeEnvironmentSpecKey,
  ENVIRONMENT_BUILDER_VERSION,
  resolvedArtifactDigest,
  type EnvironmentBuildRecipe,
  type EnvironmentSpecKeyInputs,
} from "../environment/recipe";

const baseInputs: EnvironmentSpecKeyInputs = {
  spec: { pip: ["pandas==2.2.1"], os: ["pandoc"] },
  l0BaseDigest: "sha256:l0base",
  builderVersion: ENVIRONMENT_BUILDER_VERSION,
  platform: { os: "linux", arch: "arm64" },
  buildPolicy: {
    networkPolicy: "registry-allowlist",
    registryAllowlist: ["pypi.org", "deb.debian.org"],
  },
};

const recipe = (over?: Partial<EnvironmentBuildRecipe>): EnvironmentBuildRecipe => ({
  ...baseInputs,
  resolvedArtifacts: { pip: "abc", os: "def" },
  ...over,
});

describe("cache identity = FULL effective build recipe (cinatra#1708 AC1)", () => {
  it("same full recipe ⇒ same key, independent of declaration order", () => {
    const a = computeEnvironmentRecipeKey(recipe());
    const b = computeEnvironmentRecipeKey(
      recipe({
        spec: { os: ["pandoc"], pip: ["pandas==2.2.1"] },
        buildPolicy: {
          networkPolicy: "registry-allowlist",
          registryAllowlist: ["deb.debian.org", "pypi.org"],
        },
        resolvedArtifacts: { os: "def", pip: "abc" },
      }),
    );
    expect(a).toBe(b);
  });

  it("busts on base digest, builder version, platform, policy, resolved artifacts, and spec", () => {
    const base = computeEnvironmentRecipeKey(recipe());
    expect(computeEnvironmentRecipeKey(recipe({ l0BaseDigest: "sha256:other" }))).not.toBe(base);
    expect(computeEnvironmentRecipeKey(recipe({ builderVersion: "cinatra-env-builder/2" }))).not.toBe(base);
    expect(
      computeEnvironmentRecipeKey(recipe({ platform: { os: "linux", arch: "amd64" } })),
    ).not.toBe(base);
    expect(
      computeEnvironmentRecipeKey(
        recipe({
          buildPolicy: { networkPolicy: "registry-allowlist", registryAllowlist: ["pypi.org"] },
        }),
      ),
    ).not.toBe(base);
    // Resolved lockfile drift busts the key EVEN when the declared spec is unchanged.
    expect(
      computeEnvironmentRecipeKey(recipe({ resolvedArtifacts: { pip: "abc", os: "DRIFTED" } })),
    ).not.toBe(base);
    expect(
      computeEnvironmentRecipeKey(recipe({ spec: { pip: ["pandas==2.2.2"], os: ["pandoc"] } })),
    ).not.toBe(base);
  });

  it("spec key covers the PRE-resolution inputs only", () => {
    const a = computeEnvironmentSpecKey(baseInputs);
    const b = computeEnvironmentSpecKey({ ...baseInputs, l0BaseDigest: "sha256:other" });
    expect(a).not.toBe(b);
    // Two agents declaring the same set in different order share a spec key.
    const c = computeEnvironmentSpecKey({
      ...baseInputs,
      spec: { os: ["pandoc"], pip: ["pandas==2.2.1"] },
    });
    expect(c).toBe(a);
  });

  it("resolvedArtifactDigest is a stable content hash", () => {
    expect(resolvedArtifactDigest("lock")).toBe(resolvedArtifactDigest("lock"));
    expect(resolvedArtifactDigest("lock")).not.toBe(resolvedArtifactDigest("lock2"));
  });
});
