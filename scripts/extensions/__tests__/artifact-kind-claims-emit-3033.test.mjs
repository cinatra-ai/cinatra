// cinatra#3033 (CELL4) — the manifest generator carries each artifact pack's
// own CROSS-NAMESPACE claims (a `cinatra.artifact.objectTypes[].type` outside
// the pack's own package) as the claims map the one kind-label function reads.
// Pinned on records the suite controls, never on the shipped fleet's names.
import { describe, expect, it } from "vitest";

import {
  artifactKindClaimEntries,
  emitArtifactKindLabels,
} from "../generate-extension-manifest.mjs";

describe("artifactKindClaimEntries — the packs' own cross-namespace claims", () => {
  it("an artifact record declaring an id outside its own package yields that one entry", () => {
    const records = [
      { packageName: "@x/claimer-artifacts", kind: "artifact", artifactObjectTypeIds: ["@x/ns:thing"] },
    ];
    expect(artifactKindClaimEntries(records)).toEqual([
      { typeId: "@x/ns:thing", packageName: "@x/claimer-artifacts" },
    ]);
  });

  it("a record declaring four ids outside its own package yields four entries, each valued by it", () => {
    const records = [
      {
        packageName: "@x/mail-artifacts",
        kind: "artifact",
        artifactObjectTypeIds: ["@x/mail:d", "@x/mail:a", "@x/mail:c", "@x/mail:b"],
      },
    ];
    expect(artifactKindClaimEntries(records)).toEqual([
      { typeId: "@x/mail:a", packageName: "@x/mail-artifacts" },
      { typeId: "@x/mail:b", packageName: "@x/mail-artifacts" },
      { typeId: "@x/mail:c", packageName: "@x/mail-artifacts" },
      { typeId: "@x/mail:d", packageName: "@x/mail-artifacts" },
    ]);
  });

  it("an id inside the record's own package yields none", () => {
    const records = [
      { packageName: "@x/own-artifact", kind: "artifact", artifactObjectTypeIds: ["@x/own-artifact:doc"] },
    ];
    expect(artifactKindClaimEntries(records)).toEqual([]);
  });

  it("an id two artifact records declare yields none", () => {
    const records = [
      { packageName: "@x/one-artifacts", kind: "artifact", artifactObjectTypeIds: ["@x/ns:shared"] },
      { packageName: "@x/two-artifacts", kind: "artifact", artifactObjectTypeIds: ["@x/ns:shared"] },
    ];
    expect(artifactKindClaimEntries(records)).toEqual([]);
  });

  it("a non-artifact record yields none", () => {
    const records = [
      { packageName: "@x/some-connector", kind: "connector", artifactObjectTypeIds: ["@x/ns:thing"] },
    ];
    expect(artifactKindClaimEntries(records)).toEqual([]);
  });

  it("a record without the field yields none and does not throw", () => {
    const records = [{ packageName: "@x/old-artifact", kind: "artifact", displayName: "Old" }];
    expect(() => artifactKindClaimEntries(records)).not.toThrow();
    expect(artifactKindClaimEntries(records)).toEqual([]);
  });
});

describe("emitArtifactKindLabels — the claims map appended after the labels map", () => {
  const records = [
    {
      packageName: "@x/zeta-artifacts",
      kind: "artifact",
      displayName: "Zeta",
      artifactObjectTypeIds: ["@x/z:b", "@x/z:a"],
    },
    {
      packageName: "@x/alpha-artifacts",
      kind: "artifact",
      displayName: "Alpha",
      artifactObjectTypeIds: ["@x/a:one", "@x/alpha-artifacts:own"],
    },
  ];

  it("emits byte-identically whatever order the records arrive in, entries sorted by id", () => {
    const emitted = emitArtifactKindLabels(records);
    expect(emitArtifactKindLabels([...records].reverse())).toBe(emitted);
    const claims = emitted.slice(emitted.indexOf("GENERATED_ARTIFACT_KIND_CLAIMS"));
    const a = claims.indexOf('"@x/a:one": "@x/alpha-artifacts",');
    const za = claims.indexOf('"@x/z:a": "@x/zeta-artifacts",');
    const zb = claims.indexOf('"@x/z:b": "@x/zeta-artifacts",');
    expect(a).toBeGreaterThan(-1);
    expect(za).toBeGreaterThan(a);
    expect(zb).toBeGreaterThan(za);
    expect(claims).not.toContain("@x/alpha-artifacts:own");
  });

  it("emits a well-formed EMPTY claims map and keeps the empty labels map", () => {
    const emitted = emitArtifactKindLabels([]);
    expect(emitted).toContain(
      "export const GENERATED_ARTIFACT_KIND_CLAIMS: Readonly<Record<string, string>> = {\n};",
    );
    expect(emitted).toContain(
      "export const GENERATED_ARTIFACT_KIND_LABELS: Readonly<Record<string, string>> = {\n};",
    );
  });
});
