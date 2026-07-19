// Regression for the concrete cinatra#1846 symptom.
//
// Before the fix, a `kind:"artifact"` pack that typed its `cinatra.artifact`
// manifest export against the SDK's `SemanticArtifactManifest` and declared an
// `objectTypes` claim array hit `TS2353` ("object literal may only specify known
// properties") — the field was absent from the SDK contract, and a FRESH object
// literal (unlike the parity guard's variable assignment) DOES get an
// excess-property check. Symmetrically, an agent pack could not pin a
// `produces` ref to one claimed type via `objectTypeId`.
//
// These are COMPILE-LEVEL assertions: the file only typechecks (under `pnpm
// typecheck` / tsgo) if the SDK contract admits the fields as fresh-literal keys.
// The runtime bodies just confirm the suite executed.

import { describe, it, expect } from "vitest";
import type {
  SemanticArtifactManifest,
  ArtifactObjectTypeClaim,
  SemanticArtifactRef,
} from "@cinatra-ai/sdk-extensions/artifact-contract";

describe("SDK artifact contract admits objectTypes / objectTypeId (cinatra#1846)", () => {
  it("a fresh-literal manifest WITH objectTypes typechecks (no TS2353)", () => {
    // Exactly the pack-style manifest export shape that regressed: a fresh
    // object literal declaring the full claim payload, typed against the SDK
    // contract. If `objectTypes` (or any claim/disposition field) were not a
    // known key, this literal would fail to compile with TS2353.
    const manifest: SemanticArtifactManifest = {
      accepts: { file: { mimeTypes: ["application/pdf"] } },
      objectTypes: [
        {
          type: "@cinatra-ai/pdf-artifact:pdf",
          claim: "dedicated",
          dispositions: {
            projection: "artifact-safe",
            pinnable: true,
            snapshotPolicy: "content",
            redactionPolicyVersion: "v1",
            sensitivity: "normal",
            mutability: "record",
          },
          schema: { type: "object" },
        },
      ],
    };
    expect(manifest.objectTypes).toHaveLength(1);
    expect(manifest.objectTypes?.[0].claim).toBe("dedicated");
  });

  it("the exported ArtifactObjectTypeClaim types a claim array standalone", () => {
    // A pack can type its claim array off the SDK's exported claim type without
    // importing the internal host package `@cinatra-ai/objects`.
    const claims: ArtifactObjectTypeClaim[] = [
      { type: "@scope/pkg:local", claim: "default" },
    ];
    expect(claims[0].claim).toBe("default");
  });

  it("a fresh-literal SemanticArtifactRef WITH objectTypeId typechecks", () => {
    const ref: SemanticArtifactRef = {
      extension: "@cinatra-ai/pdf-artifact",
      objectTypeId: "@cinatra-ai/pdf-artifact:pdf",
    };
    expect(ref.objectTypeId).toBe("@cinatra-ai/pdf-artifact:pdf");
  });
});
