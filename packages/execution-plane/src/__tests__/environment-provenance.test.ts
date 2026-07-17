import { describe, expect, it } from "vitest";

import {
  computeEnvironmentRecipeKey,
  ENVIRONMENT_BUILDER_VERSION,
  type EnvironmentBuildRecipe,
} from "../environment/recipe";
import {
  signEnvironmentProvenance,
  verifyEnvironmentProvenance,
} from "../environment/provenance";

const recipe: EnvironmentBuildRecipe = {
  spec: { pip: ["pandas==2.2.1"] },
  l0BaseDigest: "sha256:l0",
  builderVersion: ENVIRONMENT_BUILDER_VERSION,
  platform: { os: "linux", arch: "arm64" },
  buildPolicy: { networkPolicy: "registry-allowlist", registryAllowlist: ["pypi.org"] },
  resolvedArtifacts: { pip: "abc" },
};

const prov = () => ({
  recipeKey: computeEnvironmentRecipeKey(recipe),
  recipe,
  imageDigest: "sha256:l1img",
  builderIdentity: ENVIRONMENT_BUILDER_VERSION,
  builtAtMs: 1_000,
});

describe("environment layer provenance", () => {
  it("signs and verifies round-trip", () => {
    const signed = signEnvironmentProvenance(prov(), "key");
    expect(verifyEnvironmentProvenance(signed, "key")).toBe(true);
  });

  it("rejects a wrong key, a tampered field, and an empty signature", () => {
    const signed = signEnvironmentProvenance(prov(), "key");
    expect(verifyEnvironmentProvenance(signed, "other-key")).toBe(false);
    expect(
      verifyEnvironmentProvenance({ ...signed, imageDigest: "sha256:evil" }, "key"),
    ).toBe(false);
    expect(verifyEnvironmentProvenance({ ...signed, signature: "" }, "key")).toBe(false);
  });

  it("rejects a recipeKey inconsistent with the embedded recipe (even if signed)", () => {
    // Sign a record whose claimed key does not match its recipe — internal
    // consistency is checked BEFORE the MAC, so even a "validly signed" but
    // self-inconsistent record never verifies.
    const signed = signEnvironmentProvenance({ ...prov(), recipeKey: "not-the-key" }, "key");
    expect(verifyEnvironmentProvenance(signed, "key")).toBe(false);
  });
});
