// Manifest `objectTypes` claim schema + schema-source rule (cinatra#1432,
// epic #1424) — the extensions-side half of the claim system, entry-schema
// half. Pins: strict entry parsing, the disposition union shared from the
// claim registry, the duplicate guard, and the fail-closed schema-source rule
// (AC-4) that every claimed type needs a resolvable row schema.

import { describe, expect, it } from "vitest";

import {
  artifactObjectTypeClaimManifestSchema,
  claimedTypeRegisteringPackage,
  parseArtifactObjectTypeClaims,
  validateObjectTypeClaimSchemaSources,
  CLAIMED_OBJECT_TYPE_ID_RE,
} from "../claims";

const VALID_ENTRY = {
  type: "@vendor/pkg:thing",
  claim: "dedicated" as const,
  schema: { type: "object" },
};

describe("artifactObjectTypeClaimManifestSchema", () => {
  it("accepts a minimal dedicated claim with an inline schema", () => {
    const r = artifactObjectTypeClaimManifestSchema.safeParse(VALID_ENTRY);
    expect(r.success).toBe(true);
  });

  it("accepts the full disposition payload (shared claim-registry union)", () => {
    const r = artifactObjectTypeClaimManifestSchema.safeParse({
      type: "@vendor/pkg:thing",
      claim: "default",
      dispositions: {
        projection: "artifact-safe",
        pinnable: true,
        snapshotPolicy: "content",
        redactionPolicyVersion: "v3",
        sensitivity: "sensitive",
      },
      schema: { type: "object" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects a never-projected claim marked pinnable (disposition union rule)", () => {
    const r = artifactObjectTypeClaimManifestSchema.safeParse({
      type: "@vendor/pkg:thing",
      claim: "default",
      dispositions: { projection: "none", pinnable: true },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown key (strict, fail-closed)", () => {
    const r = artifactObjectTypeClaimManifestSchema.safeParse({ ...VALID_ENTRY, extra: 1 });
    expect(r.success).toBe(false);
  });

  it("rejects a non-namespaced type id", () => {
    for (const bad of ["thing", "@vendor/pkg", "vendor/pkg:thing", "@vendor:thing"]) {
      const r = artifactObjectTypeClaimManifestSchema.safeParse({ ...VALID_ENTRY, type: bad });
      expect(r.success, bad).toBe(false);
    }
  });

  it("rejects an unknown claim kind", () => {
    const r = artifactObjectTypeClaimManifestSchema.safeParse({ ...VALID_ENTRY, claim: "shared" });
    expect(r.success).toBe(false);
  });

  it("CLAIMED_OBJECT_TYPE_ID_RE matches @scope/pkg:local-id and nothing looser", () => {
    expect(CLAIMED_OBJECT_TYPE_ID_RE.test("@cinatra-ai/campaigns:email")).toBe(true);
    expect(CLAIMED_OBJECT_TYPE_ID_RE.test("@cinatra-ai/campaigns")).toBe(false);
  });
});

describe("parseArtifactObjectTypeClaims", () => {
  it("parses a non-empty array of valid entries", () => {
    const r = parseArtifactObjectTypeClaims([VALID_ENTRY]);
    expect(r.ok).toBe(true);
  });

  it("rejects an empty array", () => {
    const r = parseArtifactObjectTypeClaims([]);
    expect(r.ok).toBe(false);
  });

  it("rejects a duplicate claimed type within one manifest", () => {
    const r = parseArtifactObjectTypeClaims([VALID_ENTRY, { ...VALID_ENTRY, claim: "default" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/duplicate objectTypes claim/);
  });
});

describe("claimedTypeRegisteringPackage", () => {
  it("returns the @scope/pkg namespace of a claimed type id", () => {
    expect(claimedTypeRegisteringPackage("@cinatra-ai/campaigns:email")).toBe(
      "@cinatra-ai/campaigns",
    );
  });
  it("returns null for a non-namespaced id", () => {
    expect(claimedTypeRegisteringPackage("thing")).toBeNull();
    expect(claimedTypeRegisteringPackage(":thing")).toBeNull();
  });
});

describe("validateObjectTypeClaimSchemaSources (AC-4, fail-closed)", () => {
  it("accepts a claim shipping an inline JSON Schema", () => {
    const errors = validateObjectTypeClaimSchemaSources({
      packageName: "@third/party-artifact",
      claims: [{ type: "@vendor/pkg:thing", schema: { type: "object" } }],
      dependencyPackageNames: [],
    });
    expect(errors).toEqual([]);
  });

  it("accepts a self-registered (self-namespaced) type with no inline schema", () => {
    const errors = validateObjectTypeClaimSchemaSources({
      packageName: "@vendor/pkg",
      claims: [{ type: "@vendor/pkg:thing", schema: undefined }],
      dependencyPackageNames: [],
    });
    expect(errors).toEqual([]);
  });

  it("accepts a dependency-registered type (declared cinatra.dependencies edge)", () => {
    const errors = validateObjectTypeClaimSchemaSources({
      packageName: "@third/party-artifact",
      claims: [{ type: "@vendor/pkg:thing", schema: undefined }],
      dependencyPackageNames: ["@vendor/pkg"],
    });
    expect(errors).toEqual([]);
  });

  it("REJECTS a claim with no inline schema, not self-registered, no dependency", () => {
    const errors = validateObjectTypeClaimSchemaSources({
      packageName: "@third/party-artifact",
      claims: [{ type: "@vendor/pkg:thing", schema: undefined }],
      dependencyPackageNames: ["@unrelated/other"],
    });
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/no schema source/);
  });
});
