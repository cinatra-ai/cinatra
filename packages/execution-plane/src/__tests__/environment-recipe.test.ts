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
  resolvedArtifacts: {
    pip: { resolved: "abc", integrity: "abc-int" },
    os: { resolved: "def", integrity: "def-int" },
  },
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
        // Same digests, opposite manager order AND opposite inner-field order:
        // canonicalization must render an identical key.
        resolvedArtifacts: {
          os: { integrity: "def-int", resolved: "def" },
          pip: { integrity: "abc-int", resolved: "abc" },
        },
      }),
    );
    expect(a).toBe(b);
  });

  it("busts on base digest, builder version, platform, policy, resolved artifacts, and spec", () => {
    const base = computeEnvironmentRecipeKey(recipe());
    expect(computeEnvironmentRecipeKey(recipe({ l0BaseDigest: "sha256:other" }))).not.toBe(base);
    expect(computeEnvironmentRecipeKey(recipe({ builderVersion: "cinatra-env-builder/3" }))).not.toBe(base);
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
      computeEnvironmentRecipeKey(
        recipe({
          resolvedArtifacts: {
            pip: { resolved: "abc", integrity: "abc-int" },
            os: { resolved: "DRIFTED", integrity: "def-int" },
          },
        }),
      ),
    ).not.toBe(base);
    expect(
      computeEnvironmentRecipeKey(recipe({ spec: { pip: ["pandas==2.2.2"], os: ["pandoc"] } })),
    ).not.toBe(base);
  });

  it("byte-differing artifact at the SAME resolved version busts the key (AC1 byte identity)", () => {
    // Same declared spec, same pinned name==version lock digests — a re-pushed
    // wheel / rebuilt deb changes ONLY the integrity manifest. The recipe key
    // MUST bust so the cache never serves one build's bytes under another's
    // resolution.
    const base = computeEnvironmentRecipeKey(recipe());
    const byteDrifted = computeEnvironmentRecipeKey(
      recipe({
        resolvedArtifacts: {
          pip: { resolved: "abc", integrity: "abc-REPUSHED-WHEEL" },
          os: { resolved: "def", integrity: "def-int" },
        },
      }),
    );
    expect(byteDrifted).not.toBe(base);

    // And the integrity binding is independent per manager.
    const osByteDrifted = computeEnvironmentRecipeKey(
      recipe({
        resolvedArtifacts: {
          pip: { resolved: "abc", integrity: "abc-int" },
          os: { resolved: "def", integrity: "def-REBUILT-DEB" },
        },
      }),
    );
    expect(osByteDrifted).not.toBe(base);
    expect(osByteDrifted).not.toBe(byteDrifted);
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
