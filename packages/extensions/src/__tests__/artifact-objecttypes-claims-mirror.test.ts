// objectTypes-claims mirror + schema-source gate (cinatra#1432, AC-3 + AC-4).
//
// AC-3: the `objectTypes` field declaration is kept BYTE-IDENTICAL across the
// canonical semantic manifest (packages/objects/src/semantic-manifest.ts) and
// the extensions handler's descriptor copy (packages/extensions/src/
// artifact-handler.ts) — the established lock-step convention. The entry
// SCHEMA is shared from the pure claims leaf, so only this one field line is
// mirrored; this test pins it identical so a drift fails here, not at a jsonb
// round-trip.
//
// AC-4: the handler's validate() rejects a claim with no resolvable schema
// source (no inline schema, not self-registered, no declared dependency).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi } from "vitest";

// The handler imports the objects barrel for its listActive facet; validate()
// never touches it. Mock the barrel to keep this a leaf-light UNIT test (the
// artifact-handler-generic-vendor precedent). The `/claims` subpath is a
// distinct entry the mock does not intercept — validate() uses the REAL leaf.
vi.mock("@cinatra-ai/objects", () => ({
  objectTypeRegistry: { listArtifacts: () => [] },
}));

import { createArtifactExtensionHandler } from "../artifact-handler";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

function mirrorBlock(relPath: string): string {
  const text = readFileSync(join(REPO_ROOT, relPath), "utf8");
  const begin = text.indexOf("// BEGIN objectTypes-claims-mirror");
  const endMarker = "// END objectTypes-claims-mirror";
  const end = text.indexOf(endMarker);
  if (begin < 0 || end < 0) {
    throw new Error(`objectTypes-claims-mirror block not found in ${relPath}`);
  }
  return text.slice(begin, end + endMarker.length);
}

describe("objectTypes-claims mirror parity (AC-3)", () => {
  it("the mirror block is byte-identical across the objects manifest and the extensions handler", () => {
    const objectsBlock = mirrorBlock("packages/objects/src/semantic-manifest.ts");
    const extensionsBlock = mirrorBlock("packages/extensions/src/artifact-handler.ts");
    expect(objectsBlock.length).toBeGreaterThan(0);
    expect(extensionsBlock).toBe(objectsBlock);
  });
});

const handler = createArtifactExtensionHandler();
if (!handler.validate) throw new Error("artifact handler must expose validate()");
const validate = handler.validate.bind(handler);

function artifactManifest(overrides: {
  name: string;
  objectTypes: unknown[];
  dependencies?: unknown[];
}) {
  return {
    name: overrides.name,
    cinatra: {
      kind: "artifact",
      artifact: {
        accepts: { file: { mimeTypes: ["text/markdown"] } },
        objectTypes: overrides.objectTypes,
      },
      ...(overrides.dependencies ? { dependencies: overrides.dependencies } : {}),
    },
  };
}

describe("handler.validate objectTypes schema-source rule (AC-4)", () => {
  it("accepts a claim with an inline JSON Schema", async () => {
    const r = await validate(
      artifactManifest({
        name: "@third/party-artifact",
        objectTypes: [{ type: "@vendor/pkg:thing", claim: "dedicated", schema: { type: "object" } }],
      }),
    );
    expect(r.valid).toBe(true);
  });

  it("accepts a self-registered type with no inline schema", async () => {
    const r = await validate(
      artifactManifest({
        name: "@vendor/pkg-artifact",
        objectTypes: [{ type: "@vendor/pkg-artifact:thing", claim: "dedicated" }],
      }),
    );
    expect(r.valid).toBe(true);
  });

  it("accepts a dependency-registered type (declared cinatra.dependencies edge)", async () => {
    const r = await validate(
      artifactManifest({
        name: "@third/party-artifact",
        objectTypes: [{ type: "@vendor/pkg:thing", claim: "default" }],
        dependencies: [{ packageName: "@vendor/pkg", edgeType: "required" }],
      }),
    );
    expect(r.valid).toBe(true);
  });

  it("REJECTS a claim with no schema source (AC-4)", async () => {
    const r = await validate(
      artifactManifest({
        name: "@third/party-artifact",
        objectTypes: [{ type: "@vendor/pkg:thing", claim: "dedicated" }],
      }),
    );
    expect(r.valid).toBe(false);
    expect((r.errors ?? []).join(" ")).toMatch(/no schema source/);
  });

  it("REJECTS a duplicate claimed type within one manifest", async () => {
    const r = await validate(
      artifactManifest({
        name: "@third/party-artifact",
        objectTypes: [
          { type: "@vendor/pkg:thing", claim: "dedicated", schema: { type: "object" } },
          { type: "@vendor/pkg:thing", claim: "default", schema: { type: "object" } },
        ],
      }),
    );
    expect(r.valid).toBe(false);
    expect((r.errors ?? []).join(" ")).toMatch(/duplicate objectTypes claim/);
  });
});
