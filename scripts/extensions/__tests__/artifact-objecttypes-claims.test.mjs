// Generation-time objectTypes-claims gate (cinatra#1432) — the fail-closed
// .mjs restatement of the canonical TS rules the manifest generator runs.
// Pins the vocabulary, the disposition rules, the duplicate guard, and the
// schema-source rule (AC-4) so nothing invalid can become byte-pinned exempt
// generated data.

import { describe, it, expect } from "vitest";

import {
  validateArtifactObjectTypeClaims,
  claimedTypeRegisteringPackage,
  CLAIMED_OBJECT_TYPE_ID_RE,
} from "../artifact-objecttypes-claims.mjs";

const cin = (objectTypes, extra = {}) => ({ kind: "artifact", artifact: { objectTypes }, ...extra });

describe("validateArtifactObjectTypeClaims", () => {
  it("returns no errors when no claims are declared", () => {
    expect(validateArtifactObjectTypeClaims("@v/pkg-artifact", { kind: "artifact", artifact: {} })).toEqual([]);
  });

  it("accepts a valid dedicated claim shipping an inline schema", () => {
    const errors = validateArtifactObjectTypeClaims(
      "@third/party-artifact",
      cin([{ type: "@vendor/pkg:thing", claim: "dedicated", schema: { type: "object" } }]),
    );
    expect(errors).toEqual([]);
  });

  it("accepts a self-registered type with no inline schema", () => {
    const errors = validateArtifactObjectTypeClaims(
      "@vendor/pkg",
      cin([{ type: "@vendor/pkg:thing", claim: "default" }]),
    );
    expect(errors).toEqual([]);
  });

  it("accepts a dependency-registered type", () => {
    const errors = validateArtifactObjectTypeClaims(
      "@third/party-artifact",
      cin([{ type: "@vendor/pkg:thing", claim: "default" }], {
        dependencies: [{ packageName: "@vendor/pkg", edgeType: "required" }],
      }),
    );
    expect(errors).toEqual([]);
  });

  it("rejects a non-empty-array requirement", () => {
    expect(validateArtifactObjectTypeClaims("@v/pkg-artifact", cin([]))).toHaveLength(1);
  });

  it("rejects an unknown entry key", () => {
    const errors = validateArtifactObjectTypeClaims(
      "@v/pkg-artifact",
      cin([{ type: "@v/pkg:thing", claim: "default", schema: {}, bogus: 1 }]),
    );
    expect(errors.join(" ")).toMatch(/unknown key 'bogus'/);
  });

  it("rejects a bad type id", () => {
    const errors = validateArtifactObjectTypeClaims("@v/pkg-artifact", cin([{ type: "thing", claim: "default" }]));
    expect(errors.join(" ")).toMatch(/namespaced id/);
  });

  it("rejects an unknown claim kind", () => {
    const errors = validateArtifactObjectTypeClaims(
      "@v/pkg-artifact",
      cin([{ type: "@v/pkg:thing", claim: "shared", schema: {} }]),
    );
    expect(errors.join(" ")).toMatch(/'claim' must be 'dedicated' or 'default'/);
  });

  it("rejects an unknown disposition key and a bad projection", () => {
    const errors = validateArtifactObjectTypeClaims(
      "@v/pkg-artifact",
      cin([{ type: "@v/pkg:thing", claim: "default", schema: {}, dispositions: { projection: "bogus", weird: 1 } }]),
    );
    expect(errors.join(" ")).toMatch(/unknown key 'weird'/);
    expect(errors.join(" ")).toMatch(/projection must be/);
  });

  it("rejects a never-projected claim marked pinnable", () => {
    const errors = validateArtifactObjectTypeClaims(
      "@v/pkg-artifact",
      cin([{ type: "@v/pkg:thing", claim: "default", schema: {}, dispositions: { projection: "none", pinnable: true } }]),
    );
    expect(errors.join(" ")).toMatch(/cannot be pinnable/);
  });

  it("accepts the mutability class (cinatra#1449) and rejects an unknown value", () => {
    // draftable + record are valid classes (the email-artifacts pack ships both).
    expect(
      validateArtifactObjectTypeClaims(
        "@v/pkg-artifact",
        cin([{ type: "@v/pkg:thing", claim: "dedicated", schema: {}, dispositions: { projection: "artifact-safe", mutability: "draftable" } }]),
      ),
    ).toEqual([]);
    expect(
      validateArtifactObjectTypeClaims(
        "@v/pkg-artifact",
        cin([{ type: "@v/pkg:thing", claim: "dedicated", schema: {}, dispositions: { projection: "none", mutability: "record" } }]),
      ),
    ).toEqual([]);
    const bad = validateArtifactObjectTypeClaims(
      "@v/pkg-artifact",
      cin([{ type: "@v/pkg:thing", claim: "dedicated", schema: {}, dispositions: { projection: "artifact-safe", mutability: "bogus" } }]),
    );
    expect(bad.join(" ")).toMatch(/mutability must be draftable \| record \| external/);
  });

  it("rejects external mutability that is pinnable (cinatra#1449 union invariant)", () => {
    const errors = validateArtifactObjectTypeClaims(
      "@v/pkg-artifact",
      cin([{ type: "@v/pkg:thing", claim: "dedicated", schema: {}, dispositions: { projection: "artifact-safe", pinnable: true, mutability: "external" } }]),
    );
    expect(errors.join(" ")).toMatch(/external mutability requires pinnable:false/);
    // external + pinnable:false is the valid form (pin the snapshot, not the pointer).
    expect(
      validateArtifactObjectTypeClaims(
        "@v/pkg-artifact",
        cin([{ type: "@v/pkg:thing", claim: "dedicated", schema: {}, dispositions: { projection: "artifact-safe", pinnable: false, mutability: "external" } }]),
      ),
    ).toEqual([]);
  });

  it("rejects a duplicate claimed type", () => {
    const errors = validateArtifactObjectTypeClaims(
      "@v/pkg-artifact",
      cin([
        { type: "@v/pkg:thing", claim: "dedicated", schema: {} },
        { type: "@v/pkg:thing", claim: "default", schema: {} },
      ]),
    );
    expect(errors.join(" ")).toMatch(/duplicate objectTypes claim/);
  });

  it("REJECTS a claim with no schema source (AC-4)", () => {
    const errors = validateArtifactObjectTypeClaims(
      "@third/party-artifact",
      cin([{ type: "@vendor/pkg:thing", claim: "dedicated" }]),
    );
    expect(errors.join(" ")).toMatch(/no schema source/);
  });
});

describe("mjs helpers mirror the TS leaf", () => {
  it("claimedTypeRegisteringPackage", () => {
    expect(claimedTypeRegisteringPackage("@cinatra-ai/campaigns:email")).toBe("@cinatra-ai/campaigns");
    expect(claimedTypeRegisteringPackage("thing")).toBeNull();
  });
  it("CLAIMED_OBJECT_TYPE_ID_RE", () => {
    expect(CLAIMED_OBJECT_TYPE_ID_RE.test("@cinatra-ai/campaigns:email")).toBe(true);
    expect(CLAIMED_OBJECT_TYPE_ID_RE.test("@cinatra-ai/campaigns")).toBe(false);
  });
});
