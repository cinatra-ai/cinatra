import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// register-artifact-extensions.ts is `import "server-only"` (fs + bridge);
// neutralise the RSC guard for the node test env.
vi.mock("server-only", () => ({}));

import {
  artifactPackSurfaceRegistry,
  matcherManifestRegistry,
  objectTypeRegistry,
} from "../registry";
import {
  registerArtifactExtensionDir,
  registerArtifactExtensions,
  registerParsedArtifactManifest,
} from "../integration/register-artifact-extensions";

// cinatra#3319 (MUST-FIX 2 of pre-review 3): THE ARTIFACT PACK SURFACE
// CHANNEL. A pack whose types the host registers leaves no trace in the
// object-type registry, so the bridge records the pack's manifest surface on
// the same registration pass as the matcher channel: the manifest's version,
// its file accepts, its matcher skill ids and the record the bridge read it
// from. The runtime-discovery dispatcher's artifact facet reports it; the
// upload picker reads it there.

const PKG = "@cinatra-ai/t46-artifacts";
const DIGEST = "b".repeat(64);

function manifest(over: Record<string, unknown> = {}, artifact: Record<string, unknown> = {}) {
  return {
    name: PKG,
    version: "1.0.0",
    cinatra: {
      kind: "artifact",
      artifact: { accepts: { file: { mimeTypes: ["text/markdown"] } }, ...artifact },
      ...over,
    },
  };
}

function writeAt(dir: string, pkg: unknown): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  return dir;
}

describe("artifact pack surface channel (cinatra#3319)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "t46-surface-"));
    objectTypeRegistry._clearForTests();
    matcherManifestRegistry._clearForTests();
    artifactPackSurfaceRegistry?._clearForTests();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    objectTypeRegistry._clearForTests();
    matcherManifestRegistry._clearForTests();
    artifactPackSurfaceRegistry?._clearForTests();
  });

  it("3319 T46 (a) a store record the rescan registers records the pack's version, accepts, matcher skills and the record's digest, though the pack declares no type", () => {
    const dir = writeAt(path.join(root, "store", DIGEST), manifest({}, { skills: { matchers: ["t46-matcher"] } }));
    registerArtifactExtensionDir(dir, { source: "store", digest: DIGEST });
    expect(artifactPackSurfaceRegistry.get(PKG, "store")).toEqual({
      packageName: PKG,
      version: "1.0.0",
      fileMimeTypes: ["text/markdown"],
      matcherSkillIds: ["t46-matcher"],
      record: { source: "store", digest: DIGEST },
    });
    // The same pass wrote the matcher channel, from the same manifest.
    expect(matcherManifestRegistry.get(PKG)?.matcherSkillIds).toEqual(["t46-matcher"]);
  });

  it("3319 T46 (b) the bundled scan records the development tree as the record", () => {
    writeAt(path.join(root, "cinatra-ai", "t46-artifacts"), manifest());
    registerArtifactExtensions(root);
    expect(artifactPackSurfaceRegistry.get(PKG, "bundled")).toEqual({
      packageName: PKG,
      version: "1.0.0",
      fileMimeTypes: ["text/markdown"],
      matcherSkillIds: [],
      record: { source: "bundled" },
    });
  });

  it("3319 T46 (c) a manifest the bridge refuses records no surface; a store record and the development tree each keep their own surface, and a later registration from the same kind of record replaces the earlier one", () => {
    // A key an artifact manifest may not carry: the whole manifest is refused.
    const refused = writeAt(path.join(root, "refused", DIGEST), manifest({ serverEntry: "./server.js" }));
    registerArtifactExtensionDir(refused, { source: "store", digest: DIGEST });
    expect(artifactPackSurfaceRegistry.listForPackage(PKG)).toEqual([]);
    // A store record, then the development tree (the registry warm's bundled
    // scan runs again after the store rescan): neither replaces the other.
    const stored = writeAt(path.join(root, "store", DIGEST), manifest());
    registerArtifactExtensionDir(stored, { source: "store", digest: DIGEST });
    writeAt(path.join(root, "dev", "cinatra-ai", "t46-artifacts"), { ...manifest(), version: "1.1.0" });
    registerArtifactExtensions(path.join(root, "dev"));
    expect(artifactPackSurfaceRegistry.get(PKG, "store")).toMatchObject({
      version: "1.0.0",
      record: { source: "store", digest: DIGEST },
    });
    expect(artifactPackSurfaceRegistry.get(PKG, "bundled")).toMatchObject({
      version: "1.1.0",
      record: { source: "bundled" },
    });
    expect(artifactPackSurfaceRegistry.listForPackage(PKG)).toHaveLength(2);
    // Another store record replaces the store surface; the development tree's stands.
    const other = "c".repeat(64);
    const stored2 = writeAt(path.join(root, "store", other), { ...manifest(), version: "1.2.0" });
    registerArtifactExtensionDir(stored2, { source: "store", digest: other });
    expect(artifactPackSurfaceRegistry.get(PKG, "store")).toMatchObject({
      version: "1.2.0",
      record: { source: "store", digest: other },
    });
    expect(artifactPackSurfaceRegistry.get(PKG, "bundled")?.version).toBe("1.1.0");
    expect(artifactPackSurfaceRegistry.list()).toHaveLength(2);
  });

  it("3319 T46 (d) a registration with no record names none, and a caller of the parsed-manifest seam with no origin leaves the channel as it was", () => {
    const dir = writeAt(path.join(root, "plain"), manifest());
    registerArtifactExtensionDir(dir);
    expect(artifactPackSurfaceRegistry.get(PKG, null)?.record).toBeNull();
    expect(artifactPackSurfaceRegistry.get(PKG, "store")).toBeNull();
    artifactPackSurfaceRegistry._clearForTests();
    registerParsedArtifactManifest(
      { accepts: { file: { mimeTypes: ["text/plain"] } } } as never,
      PKG,
    );
    expect(artifactPackSurfaceRegistry.listForPackage(PKG)).toEqual([]);
  });
});
