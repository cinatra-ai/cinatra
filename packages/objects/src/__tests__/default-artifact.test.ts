// Built-in floor semantic artifact type.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// register-artifact-extensions.ts is `import "server-only"`; neutralise the
// RSC guard for the node test env (same pattern as artifact-bridge.test.ts).
vi.mock("server-only", () => ({}));

import {
  parseSemanticArtifactManifest,
  DEFAULT_ARTIFACT_EXTENSION,
  isDefaultArtifactType,
} from "../semantic-manifest";
import {
  parseArtifactObjectTypeClaims,
  validateObjectTypeClaimSchemaSources,
} from "../claims";
import { registerArtifactExtensions } from "../integration/register-artifact-extensions";
import { objectTypeRegistry } from "../registry";

// The shipped package.json `cinatra.artifact` block is the source of truth.
const pkgJson = JSON.parse(
  readFileSync(
    join(__dirname, "../../../../extensions/cinatra-ai/default-artifact/package.json"),
    "utf8",
  ),
);

describe("@cinatra-ai/default-artifact — built-in floor type", () => {
  it("constant + helper identify the floor type and reject others", () => {
    expect(DEFAULT_ARTIFACT_EXTENSION).toBe("@cinatra-ai/default-artifact");
    expect(isDefaultArtifactType("@cinatra-ai/default-artifact")).toBe(true);
    expect(isDefaultArtifactType("@cinatra-ai/marketing-icp-artifact")).toBe(false);
    expect(isDefaultArtifactType(null)).toBe(false);
    expect(isDefaultArtifactType(undefined)).toBe(false);
  });

  it("the shipped manifest is a valid semantic manifest (no substrate fields)", () => {
    expect(pkgJson.name).toBe("@cinatra-ai/default-artifact");
    expect(pkgJson.cinatra.kind).toBe("artifact");
    const r = parseSemanticArtifactManifest(pkgJson.cinatra.artifact);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // floor admits any form, satisfies nothing, no templates/skills
      expect(r.manifest.accepts.file?.mimeTypes).toEqual(["*/*"]);
      expect(r.manifest.accepts.connectorRef?.resolvedMimeTypes).toEqual(["*/*"]);
      expect(r.manifest.accepts.dashboard).toBe(true);
      expect(r.manifest.satisfies).toBeUndefined();
      expect(r.manifest.templates).toBeUndefined();
      expect(r.manifest.skills).toBeUndefined();
    }
  });

  it("registers through the semantic bridge from a fixture dir", () => {
    objectTypeRegistry._clearForTests();
    const root = mkdtempSync(join(tmpdir(), "default-art-"));
    const dir = join(root, "default-artifact");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkgJson));
    expect(registerArtifactExtensions(root)).toBe(1);
    const entry = objectTypeRegistry
      .listArtifacts()
      .find((d) => d.type === "@cinatra-ai/default-artifact:artifact");
    expect(entry).toBeDefined();
    expect(entry?.isArtifact?.accepts.dashboard).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// cinatra#1433 AC-1 — the "default object IS default artifact" exception: the
// floor extension declares a lower-priority DEFAULT claim on the generic
// object type via the #1432 manifest mechanism. The entry below is the exact
// contract the default-artifact manifest PR declares; the inline schema is
// REQUIRED (the claimed type is registered by `@cinatra-ai/objects`, which is
// neither the claimant nor a manifest dependency — the #1432 AC-4 rule).
// ---------------------------------------------------------------------------
const EXPECTED_FLOOR_CLAIM = {
  type: "@cinatra-ai/objects:object",
  claim: "default",
  dispositions: {
    projection: "artifact-safe",
    pinnable: false,
    snapshotPolicy: "none",
    sensitivity: "normal",
  },
  schema: { type: "object" },
};

describe("#1433 AC-1 — the generic-object DEFAULT claim contract", () => {
  it("the claim entry is schema-valid and satisfies the schema-source rule with zero dependencies", () => {
    const parsed = parseArtifactObjectTypeClaims([EXPECTED_FLOOR_CLAIM]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.claims[0].claim).toBe("default");
    expect(
      validateObjectTypeClaimSchemaSources({
        packageName: DEFAULT_ARTIFACT_EXTENSION,
        claims: parsed.claims,
        dependencyPackageNames: [],
      }),
    ).toEqual([]);
  });

  it("a manifest carrying the claim parses as a valid semantic manifest", () => {
    const withClaim = {
      ...pkgJson.cinatra.artifact,
      objectTypes: [EXPECTED_FLOOR_CLAIM],
    };
    const r = parseSemanticArtifactManifest(withClaim);
    expect(r.ok).toBe(true);
  });

  it("once the pinned default-artifact checkout carries objectTypes, it is exactly this claim", () => {
    const objectTypes = pkgJson.cinatra.artifact.objectTypes;
    if (objectTypes === undefined) {
      // Pre-re-pin window: the companion default-artifact manifest PR has not
      // been pinned into cinatra-required-extensions.lock.json yet. The two
      // tests above pin the contract the re-pin must satisfy; this equality
      // check arms itself automatically on the re-pin.
      return;
    }
    expect(objectTypes).toEqual([EXPECTED_FLOOR_CLAIM]);
  });
});
