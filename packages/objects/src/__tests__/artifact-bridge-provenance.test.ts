import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// register-artifact-extensions.ts is `import "server-only"` (fs + bridge);
// neutralise the RSC guard for the node test env.
vi.mock("server-only", () => ({}));

import { objectTypeRegistry } from "../registry";
import {
  registerArtifactExtensions,
  registerArtifactExtensionDir,
} from "../integration/register-artifact-extensions";

// cinatra#661 — the teardown blocker fix. The bridge MUST register artifact
// object types WITH package provenance so `removeByPackage` (the runtime
// archive/uninstall teardown) can deregister exactly the bridge-registered
// types, WITHOUT reaping host built-in (provenance-less) artifact types.

function writeExt(root: string, dir: string, pkg: Record<string, unknown>): void {
  mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, dir, "package.json"), JSON.stringify(pkg, null, 2));
}

function artifactPkg(name: string): Record<string, unknown> {
  return {
    name,
    version: "0.0.1",
    cinatra: {
      kind: "artifact",
      artifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } },
    },
  };
}

describe("artifact-bridge provenance + teardown (cinatra#661)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "artifact-bridge-prov-"));
    objectTypeRegistry._clearForTests();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    objectTypeRegistry._clearForTests();
  });

  it("bridge-registered artifact type carries provenance → removeByPackage tears it down", () => {
    writeExt(root, "fixture-thing-artifact", artifactPkg("@cinatra-ai/fixture-thing-artifact"));
    expect(registerArtifactExtensions(root)).toBe(1);

    const typeId = "@cinatra-ai/fixture-thing-artifact:artifact";
    expect(objectTypeRegistry.resolve(typeId)).not.toBeNull();
    expect(objectTypeRegistry.getTypesForPackage("@cinatra-ai/fixture-thing-artifact")).toEqual([
      typeId,
    ]);

    // The teardown path (invalidateObjectTypesForPackage → removeByPackage).
    const removed = objectTypeRegistry.removeByPackage("@cinatra-ai/fixture-thing-artifact");
    expect(removed).toEqual([typeId]);
    // Gone from resolve + listArtifacts in-process (no restart).
    expect(objectTypeRegistry.resolve(typeId)).toBeNull();
    expect(
      objectTypeRegistry.listArtifacts().some((d) => d.type === typeId),
    ).toBe(false);
  });

  it("a provenance-less HOST built-in artifact type is NEVER reaped by removeByPackage", () => {
    // Register a built-in WITHOUT provenance (the register-all-object-types.ts model).
    objectTypeRegistry.register({
      type: "@cinatra-ai/artifact:object",
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { file: { mimeTypes: ["*/*"] }, dashboard: true } },
    });
    // And a bridge type WITH the SAME-ish vendor but a distinct package name.
    writeExt(root, "fixture-thing-artifact", artifactPkg("@cinatra-ai/fixture-thing-artifact"));
    registerArtifactExtensions(root);

    // Tearing down the bridge package must not touch the built-in.
    objectTypeRegistry.removeByPackage("@cinatra-ai/fixture-thing-artifact");
    expect(objectTypeRegistry.resolve("@cinatra-ai/artifact:object")).not.toBeNull();
    // The built-in has no provenance, so no package owns it.
    expect(objectTypeRegistry.getTypesForPackage("@cinatra-ai/artifact")).toEqual([]);
  });

  it("registerArtifactExtensionDir registers ONE store-dir package (the rescan entry) WITH provenance", () => {
    // Mirror the store layout: the package.json is directly at the dir.
    const storeDir = path.join(root, "fixture-thing-artifact", "deadbeef");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(
      path.join(storeDir, "package.json"),
      JSON.stringify(artifactPkg("@cinatra-ai/store-thing-artifact"), null, 2),
    );

    expect(registerArtifactExtensionDir(storeDir)).toBe(true);
    const typeId = "@cinatra-ai/store-thing-artifact:artifact";
    expect(objectTypeRegistry.resolve(typeId)).not.toBeNull();
    expect(objectTypeRegistry.getTypesForPackage("@cinatra-ai/store-thing-artifact")).toEqual([
      typeId,
    ]);
    // Idempotent replace-by-id across restarts.
    expect(registerArtifactExtensionDir(storeDir)).toBe(true);
    expect(
      objectTypeRegistry.listArtifacts().filter((d) => d.type === typeId).length,
    ).toBe(1);
  });

  it("registerArtifactExtensionDir refuses a non-artifact dir", () => {
    const storeDir = path.join(root, "conn", "deadbeef");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(
      path.join(storeDir, "package.json"),
      JSON.stringify({ name: "@x/conn", version: "1.0.0", cinatra: { kind: "connector" } }, null, 2),
    );
    expect(registerArtifactExtensionDir(storeDir)).toBe(false);
    expect(objectTypeRegistry.listArtifacts()).toHaveLength(0);
  });
});
