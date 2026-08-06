import { describe, it, expect, vi } from "vitest";

// The handler imports the objects registry for its listActive facet; validate()
// never touches it. Mock the barrel so this UNIT test stays leaf-light (the
// artifact-handler-list-active / -generic-vendor precedent).
vi.mock("@cinatra-ai/objects", () => ({
  objectTypeRegistry: { listArtifacts: () => [] },
}));

import { ARTIFACT_ALLOWED_CINATRA_KEYS } from "@cinatra-ai/sdk-extensions/artifact-contract";
import { createArtifactExtensionHandler } from "../artifact-handler";

// cinatra#2469 — "every extension kind must be able to self-define
// `cinatra.logo`" (maintainer decision 2026-08-06, generalizing #1482/#2467
// beyond connectors).
//
// This is the EXTENSION-MANAGEMENT half of the same allowlist the conformance
// gate derives and the objects bridge enforces. All three read the ONE canonical
// `ARTIFACT_ALLOWED_CINATRA_KEYS`; this file pins the handler's observable
// behavior so the widening cannot land in the Set while a consumer silently
// keeps rejecting (the drift the #979 addendum exists to prevent).

const handler = createArtifactExtensionHandler();
if (!handler.validate) {
  throw new Error("artifact handler must expose validate()");
}
const validate = handler.validate.bind(handler);

const ARTIFACT_PKG = "@cinatra-ai/fixture-logo-artifact";
const baseArtifact = { accepts: { file: { mimeTypes: ["text/markdown"] } } };

describe("artifact-handler validate() — the cross-kind cinatra.logo key (cinatra#2469)", () => {
  it("accepts an artifact manifest that self-declares cinatra.logo", async () => {
    const result = await validate({
      name: ARTIFACT_PKG,
      cinatra: { kind: "artifact", logo: "./logo.svg", artifact: baseArtifact },
    });
    expect(result.valid, result.errors?.join("; ")).toBe(true);
  });

  it("accepts the full self-describing card identity together (logo + displayName + vendor)", async () => {
    const result = await validate({
      name: ARTIFACT_PKG,
      cinatra: {
        kind: "artifact",
        logo: "./logo.svg",
        displayName: "Fixture Logo Artifact",
        vendor: { key: "cinatra-ai", name: "Cinatra" },
        artifact: baseArtifact,
      },
    });
    expect(result.valid, result.errors?.join("; ")).toBe(true);
  });

  it("still REJECTS a near-miss key — the allowlist stayed closed, it did not open", async () => {
    for (const key of ["logoUrl", "logos", "logoSvg"]) {
      const result = await validate({
        name: ARTIFACT_PKG,
        cinatra: { kind: "artifact", [key]: "./logo.svg", artifact: baseArtifact },
      });
      expect(result.valid, key).toBe(false);
      expect(result.errors?.some((e) => e.includes(key)), key).toBe(true);
    }
  });

  it("renders the extraneous-key message FROM the live Set (never a stale hand-copied list)", async () => {
    const result = await validate({
      name: ARTIFACT_PKG,
      cinatra: { kind: "artifact", riskLevel: "low", artifact: baseArtifact },
    });
    expect(result.valid).toBe(false);
    const msg = result.errors?.find((e) => e.includes("may only declare cinatra."));
    expect(msg).toBeDefined();
    // Every admitted key — including the newly-admitted `logo` — is advertised,
    // so an author is never told a conformant key is disallowed.
    for (const key of ARTIFACT_ALLOWED_CINATRA_KEYS) {
      expect(msg, key).toContain(key);
    }
    expect(msg).toContain("riskLevel");
  });

  it("the handler VALUE-validates nothing about the logo — path safety is the generator's fail-closed job", async () => {
    // `resolveDeclaredLogo` (generation) owns `.svg`-only, in-package
    // containment, symlink escape and the sanitizer verdict, and turns a bad
    // declaration into a BUILD error. The manifest layer carries the key as
    // DATA (the same discipline as vendor/displayName/views), so a
    // path-shaped-but-unresolvable value is not this layer's rejection.
    const result = await validate({
      name: ARTIFACT_PKG,
      cinatra: { kind: "artifact", logo: "./does-not-exist.svg", artifact: baseArtifact },
    });
    expect(result.valid, result.errors?.join("; ")).toBe(true);
  });
});
