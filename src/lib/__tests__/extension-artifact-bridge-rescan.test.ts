// cinatra#661 — production artifact-bridge package-store rescan.
//
// Exercises the REAL rescan over a temp `/data`-like store dir + the REAL
// objects registry. Only the DB-status gate (`isArtifactExtensionWriteAllowed`)
// is mocked so the fail-closed install-status behaviour is asserted without a DB.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { writeAllowedMock } = vi.hoisted(() => ({
  writeAllowedMock: vi.fn(async (): Promise<boolean> => true),
}));
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: writeAllowedMock,
}));

import { objectTypeRegistry } from "@cinatra-ai/objects";
import { rescanArtifactBridgeFromStore } from "@/lib/extension-artifact-bridge-rescan";

function writeStorePackage(
  storeRoot: string,
  pkgDir: string,
  digest: string,
  pkg: Record<string, unknown>,
): void {
  const dir = path.join(storeRoot, pkgDir, digest);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
}

function artifactPkg(name: string): Record<string, unknown> {
  return {
    name,
    version: "0.1.0",
    cinatra: {
      kind: "artifact",
      artifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } },
    },
  };
}

describe("rescanArtifactBridgeFromStore (cinatra#661)", () => {
  let storeRoot: string;

  beforeEach(() => {
    storeRoot = mkdtempSync(path.join(tmpdir(), "artifact-store-"));
    objectTypeRegistry._clearForTests();
    writeAllowedMock.mockReset().mockResolvedValue(true);
  });
  afterEach(() => {
    rmSync(storeRoot, { recursive: true, force: true });
    objectTypeRegistry._clearForTests();
  });

  it("registers a runtime-installed metadata-only artifact from the store (no rebuild) WITH provenance", async () => {
    writeStorePackage(storeRoot, "store-thing-artifact", "deadbeef", artifactPkg("@cinatra-ai/store-thing-artifact"));

    const res = await rescanArtifactBridgeFromStore({ storeRoot });
    expect(res.registered).toEqual(["@cinatra-ai/store-thing-artifact"]);

    const typeId = "@cinatra-ai/store-thing-artifact:artifact";
    expect(objectTypeRegistry.resolve(typeId)).not.toBeNull();
    // provenance recorded → teardown can reach it.
    expect(objectTypeRegistry.getTypesForPackage("@cinatra-ai/store-thing-artifact")).toEqual([
      typeId,
    ]);
  });

  it("a missing store root is a clean no-op (no /data volume)", async () => {
    const res = await rescanArtifactBridgeFromStore({ storeRoot: path.join(storeRoot, "does-not-exist") });
    expect(res.registered).toEqual([]);
    expect(objectTypeRegistry.listArtifacts()).toHaveLength(0);
  });

  it("skips non-artifact store packages", async () => {
    writeStorePackage(storeRoot, "a-connector", "c0ffee", {
      name: "@cinatra-ai/a-connector",
      version: "1.0.0",
      cinatra: { kind: "connector", serverEntry: "./register" },
    });
    const res = await rescanArtifactBridgeFromStore({ storeRoot });
    expect(res.registered).toEqual([]);
    expect(objectTypeRegistry.listArtifacts()).toHaveLength(0);
  });

  it("FAIL-CLOSED: an archived install in the store is NOT re-registered", async () => {
    writeStorePackage(storeRoot, "archived-artifact", "dead", artifactPkg("@cinatra-ai/archived-artifact"));
    // The canonical row for this package is archived → write not allowed.
    writeAllowedMock.mockResolvedValue(false);

    const res = await rescanArtifactBridgeFromStore({ storeRoot });
    expect(res.registered).toEqual([]);
    expect(res.skippedNotActive).toEqual(["@cinatra-ai/archived-artifact"]);
    expect(objectTypeRegistry.resolve("@cinatra-ai/archived-artifact:artifact")).toBeNull();
  });

  it("onlyPackage scopes the rescan to a single package (activate-hook path)", async () => {
    writeStorePackage(storeRoot, "one-artifact", "a1", artifactPkg("@cinatra-ai/one-artifact"));
    writeStorePackage(storeRoot, "two-artifact", "b2", artifactPkg("@cinatra-ai/two-artifact"));

    const res = await rescanArtifactBridgeFromStore({ storeRoot, onlyPackage: "@cinatra-ai/two-artifact" });
    expect(res.registered).toEqual(["@cinatra-ai/two-artifact"]);
    expect(objectTypeRegistry.resolve("@cinatra-ai/two-artifact:artifact")).not.toBeNull();
    expect(objectTypeRegistry.resolve("@cinatra-ai/one-artifact:artifact")).toBeNull();
  });

  it("is idempotent across restarts (replace-by-id, no duplicates)", async () => {
    writeStorePackage(storeRoot, "store-thing-artifact", "deadbeef", artifactPkg("@cinatra-ai/store-thing-artifact"));
    await rescanArtifactBridgeFromStore({ storeRoot });
    await rescanArtifactBridgeFromStore({ storeRoot });
    const typeId = "@cinatra-ai/store-thing-artifact:artifact";
    expect(objectTypeRegistry.listArtifacts().filter((d) => d.type === typeId)).toHaveLength(1);
  });
});
