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

// cinatra#792 — the rescan resolves the trusted install anchor (digest +
// canonical-row kind) for EVERY package: multi-digest narrowing picks the bound
// digest, and the anchor kind gates single-digest records too (a row governing a
// different kind refuses). A null anchor = the ungoverned (no-row) CG-1
// allowance, so the pre-existing tests (which mock a null anchor) are unaffected.
const { anchorMock } = vi.hoisted(() => ({
  anchorMock: vi.fn(
    async (): Promise<{ digest: string | null; kind?: string | null } | null> => null,
  ),
}));
vi.mock("@/lib/extension-install-anchor", () => ({
  makeDefaultInstallAnchorResolver: async () => anchorMock,
}));

import { objectTypeRegistry } from "@cinatra-ai/objects";
import { rescanArtifactBridgeFromStore } from "@/lib/extension-artifact-bridge-rescan";

function writeStorePackage(
  storeRoot: string,
  _pkgDir: string,
  digest: string,
  pkg: Record<string, unknown>,
): void {
  // V2 layout (cinatra#791): <root>/<kind>/<slug>/<digest>/ — the path kind
  // comes from the manifest's cinatra.kind and the slug from its name; the
  // digest segment must be long hex, so short test labels are padded.
  const kind = ((pkg.cinatra as Record<string, unknown> | undefined)?.kind as string) ?? "artifact";
  const name = pkg.name as string;
  const dir = path.join(storeRoot, kind, ...name.split("/"), digest.padEnd(64, "0"));
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
    anchorMock.mockReset().mockResolvedValue(null);
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

// cinatra#792 — multi-digest narrowing + anchor kind binding: with retention
// (#796) several digests of one package may be on disk; only the anchor-bound
// digest may register, and the canonical row's kind must agree with the
// record's path kind (fail closed on everything else).
describe("rescanArtifactBridgeFromStore — cinatra#792 anchor narrowing", () => {
  let storeRoot: string;
  const PKG = "@cinatra-ai/multi-artifact";
  const TYPE_ID = `${PKG}:artifact`;
  const DIG_A = "a1".padEnd(64, "0");
  const DIG_B = "b2".padEnd(64, "0");

  function artifactPkgWithMime(name: string, mime: string): Record<string, unknown> {
    return {
      name,
      version: "0.1.0",
      cinatra: { kind: "artifact", artifact: { accepts: { file: { mimeTypes: [mime] } } } },
    };
  }

  beforeEach(() => {
    storeRoot = mkdtempSync(path.join(tmpdir(), "artifact-store-792-"));
    objectTypeRegistry._clearForTests();
    writeAllowedMock.mockReset().mockResolvedValue(true);
    anchorMock.mockReset().mockResolvedValue(null);
    // Two digests of the SAME package on disk (a retained prior + the active).
    writeStorePackage(storeRoot, "m", DIG_A, artifactPkgWithMime(PKG, "text/markdown"));
    writeStorePackage(storeRoot, "m", DIG_B, artifactPkgWithMime(PKG, "text/plain"));
  });
  afterEach(() => {
    rmSync(storeRoot, { recursive: true, force: true });
    objectTypeRegistry._clearForTests();
  });

  it("registers ONLY the anchor-bound digest (never the retained prior)", async () => {
    anchorMock.mockResolvedValue({ digest: DIG_A, kind: "artifact" });
    const res = await rescanArtifactBridgeFromStore({ storeRoot });
    expect(res.registered).toEqual([PKG]); // exactly once — DIG_B skipped
    const def = objectTypeRegistry.resolve(TYPE_ID) as {
      isArtifact?: { accepts?: { file?: { mimeTypes?: string[] } } };
    } | null;
    expect(def?.isArtifact?.accepts?.file?.mimeTypes).toEqual(["text/markdown"]);
  });

  it("FAIL-CLOSED: the canonical row kind contradicts the store path kind → nothing registers", async () => {
    anchorMock.mockResolvedValue({ digest: DIG_A, kind: "connector" });
    const res = await rescanArtifactBridgeFromStore({ storeRoot });
    expect(res.registered).toEqual([]);
    expect(objectTypeRegistry.resolve(TYPE_ID)).toBeNull();
  });

  it("FAIL-CLOSED: a digest-unbound anchor with >1 digest on disk → nothing registers", async () => {
    anchorMock.mockResolvedValue({ digest: null, kind: "artifact" });
    const res = await rescanArtifactBridgeFromStore({ storeRoot });
    expect(res.registered).toEqual([]);
    expect(objectTypeRegistry.resolve(TYPE_ID)).toBeNull();
  });

  it("FAIL-CLOSED: no anchor at all with >1 digest on disk → nothing registers", async () => {
    anchorMock.mockResolvedValue(null);
    const res = await rescanArtifactBridgeFromStore({ storeRoot });
    expect(res.registered).toEqual([]);
    expect(objectTypeRegistry.resolve(TYPE_ID)).toBeNull();
  });
});

// cinatra#792 — single-digest anchor KIND binding: even with exactly one digest
// on disk, the canonical row's kind must agree with the store path kind. A row
// that governs the package under a DIFFERENT kind (e.g. connector) must refuse
// an artifact object-type registration; a package with NO row keeps the
// ungoverned (no-row) CG-1 allowance.
describe("rescanArtifactBridgeFromStore — cinatra#792 single-digest anchor kind binding", () => {
  let storeRoot: string;
  const PKG = "@cinatra-ai/single-artifact";
  const TYPE_ID = `${PKG}:artifact`;
  const DIG = "5e".padEnd(64, "0");

  beforeEach(() => {
    storeRoot = mkdtempSync(path.join(tmpdir(), "artifact-store-792-single-"));
    objectTypeRegistry._clearForTests();
    writeAllowedMock.mockReset().mockResolvedValue(true);
    anchorMock.mockReset().mockResolvedValue(null);
    // Exactly ONE digest of the package on disk, under artifact/.
    writeStorePackage(storeRoot, "s", DIG, artifactPkg(PKG));
  });
  afterEach(() => {
    rmSync(storeRoot, { recursive: true, force: true });
    objectTypeRegistry._clearForTests();
  });

  it("FAIL-CLOSED: a single on-disk artifact whose canonical row kind is NOT artifact does not register", async () => {
    // The row governs this package as a connector; only an artifact dir is on
    // disk. The kind must refuse it even though there is a single digest.
    anchorMock.mockResolvedValue({ digest: DIG, kind: "connector" });
    const res = await rescanArtifactBridgeFromStore({ storeRoot });
    expect(res.registered).toEqual([]);
    expect(objectTypeRegistry.resolve(TYPE_ID)).toBeNull();
  });

  it("registers a single-digest artifact whose canonical row kind agrees (artifact)", async () => {
    anchorMock.mockResolvedValue({ digest: DIG, kind: "artifact" });
    const res = await rescanArtifactBridgeFromStore({ storeRoot });
    expect(res.registered).toEqual([PKG]);
    expect(objectTypeRegistry.resolve(TYPE_ID)).not.toBeNull();
  });

  it("FAIL-CLOSED: a single-digest artifact whose row pins a DIFFERENT digest does not register", async () => {
    anchorMock.mockResolvedValue({ digest: "ff".padEnd(64, "0"), kind: "artifact" });
    const res = await rescanArtifactBridgeFromStore({ storeRoot });
    expect(res.registered).toEqual([]);
    expect(objectTypeRegistry.resolve(TYPE_ID)).toBeNull();
  });

  it("registers a single-digest artifact with no canonical row (CG-1 ungoverned allowance)", async () => {
    anchorMock.mockResolvedValue(null); // no row → ungoverned bundled/disk artifact
    const res = await rescanArtifactBridgeFromStore({ storeRoot });
    expect(res.registered).toEqual([PKG]);
    expect(objectTypeRegistry.resolve(TYPE_ID)).not.toBeNull();
  });
});
