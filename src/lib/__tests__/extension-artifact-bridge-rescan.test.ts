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

const { writeAllowedMock, hasLiveRowMock } = vi.hoisted(() => ({
  writeAllowedMock: vi.fn(async (): Promise<boolean> => true),
  // cinatra#792 — the rescan's tri-state discriminator between a REFUSED anchor
  // (a live canonical row exists but resolution returned null) and a genuinely
  // ABSENT row. Default false = no live row = the ungoverned CG-1 allowance.
  hasLiveRowMock: vi.fn(async (): Promise<boolean> => false),
}));
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: writeAllowedMock,
  hasLiveInstallRow: hasLiveRowMock,
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

import { artifactPackSurfaceRegistry, objectTypeRegistry } from "@cinatra-ai/objects";
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
  // Explicit-declared-types manifest (ratified rule, entry 95, epic #1785): the
  // pack declares the ONE self-owned object type it registers. Umbrella/derived
  // minting is retired, so a type-less manifest would register NOTHING; the
  // rescan mechanics under test (anchor narrowing, digest binding, fail-closed)
  // observe registration via this declared `${name}:artifact` type id.
  return {
    name,
    version: "0.1.0",
    cinatra: {
      kind: "artifact",
      artifact: {
        accepts: { file: { mimeTypes: ["text/markdown"] } },
        objectTypes: [{ type: `${name}:artifact`, claim: "dedicated", schema: { type: "object" } }],
      },
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
    hasLiveRowMock.mockReset().mockResolvedValue(false);
  });
  afterEach(() => {
    rmSync(storeRoot, { recursive: true, force: true });
    objectTypeRegistry._clearForTests();
  });

  it("registers a runtime-installed metadata-only artifact from the store (no rebuild) WITH provenance", async () => {
    writeStorePackage(storeRoot, "store-thing-artifact", "deadbeef", artifactPkg("@cinatra-ai/store-thing-artifact"));

    const res = await rescanArtifactBridgeFromStore({ storeRoot });
    expect(res.registered).toEqual(["@cinatra-ai/store-thing-artifact"]);
    // The boot claim-activation backstop (cinatra#1493) consumes the registered
    // package WITH its anchor-vetted store dir.
    expect(res.registeredRecords).toHaveLength(1);
    expect(res.registeredRecords[0].packageName).toBe("@cinatra-ai/store-thing-artifact");
    expect(res.registeredRecords[0].storeDir).toContain("store-thing-artifact");

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
    // Explicit-declared-types manifest (entry 95, epic #1785) — see artifactPkg.
    return {
      name,
      version: "0.1.0",
      cinatra: {
        kind: "artifact",
        artifact: {
          accepts: { file: { mimeTypes: [mime] } },
          objectTypes: [{ type: `${name}:artifact`, claim: "dedicated", schema: { type: "object" } }],
        },
      },
    };
  }

  beforeEach(() => {
    storeRoot = mkdtempSync(path.join(tmpdir(), "artifact-store-792-"));
    objectTypeRegistry._clearForTests();
    writeAllowedMock.mockReset().mockResolvedValue(true);
    anchorMock.mockReset().mockResolvedValue(null);
    hasLiveRowMock.mockReset().mockResolvedValue(false);
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
    hasLiveRowMock.mockReset().mockResolvedValue(false);
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
    hasLiveRowMock.mockResolvedValue(false); // no live row proves the CG-1 case
    const res = await rescanArtifactBridgeFromStore({ storeRoot });
    expect(res.registered).toEqual([PKG]);
    expect(objectTypeRegistry.resolve(TYPE_ID)).not.toBeNull();
  });

  it("FAIL-CLOSED: a single-digest artifact whose anchor is REFUSED (null) while a live row EXISTS does not register", async () => {
    // `null` from the resolver conflates "no row" with "row present but refused"
    // (activeDigest/journal mismatch, ambiguous scope). A live canonical row
    // proves the package is DB-governed → never register its unpinned digest
    // through the CG-1 ungoverned allowance.
    anchorMock.mockResolvedValue(null);
    hasLiveRowMock.mockResolvedValue(true);
    const res = await rescanArtifactBridgeFromStore({ storeRoot });
    expect(res.registered).toEqual([]);
    expect(objectTypeRegistry.resolve(TYPE_ID)).toBeNull();
  });
});

// cinatra#3319 T51: the store surface of the artifact pack surface channel
// agrees with the runtime's store winner. A store rescan keeps a store surface
// only for a package that it registers from a store record in the same pass; a
// package in its scope that it skips, refuses or no longer finds on disk loses
// its store surface. The development-tree surface is the bundled scan's.
describe("rescanArtifactBridgeFromStore — cinatra#3319 store surfaces of the pack surface channel", () => {
  let storeRoot: string;
  const PKG = "@cinatra-ai/t51-artifacts";
  const OTHER = "@cinatra-ai/t51-other-artifacts";
  const D1 = "d1".padEnd(64, "0");
  const D2 = "d2".padEnd(64, "0");

  beforeEach(() => {
    storeRoot = mkdtempSync(path.join(tmpdir(), "artifact-store-3319-t51-"));
    objectTypeRegistry._clearForTests();
    artifactPackSurfaceRegistry._clearForTests();
    writeAllowedMock.mockReset().mockResolvedValue(true);
    anchorMock.mockReset().mockResolvedValue(null);
    hasLiveRowMock.mockReset().mockResolvedValue(false);
  });
  afterEach(() => {
    rmSync(storeRoot, { recursive: true, force: true });
    objectTypeRegistry._clearForTests();
    artifactPackSurfaceRegistry._clearForTests();
  });

  it("3319 T51 (a) a valid store record joined by a second digest of the same package, kind and version that the live row does not bind: the rescan registers neither and removes the store surface it had registered", async () => {
    // A live row whose anchor binds no digest: one record registers.
    anchorMock.mockResolvedValue({ digest: null, kind: "artifact" });
    writeStorePackage(storeRoot, "t51", D1, artifactPkg(PKG));
    expect((await rescanArtifactBridgeFromStore({ storeRoot })).registered).toEqual([PKG]);
    expect(artifactPackSurfaceRegistry.get(PKG, "store")?.record).toEqual({ source: "store", digest: D1 });
    // A second digest arrives: the runtime activates neither record.
    writeStorePackage(storeRoot, "t51", D2, artifactPkg(PKG));
    expect((await rescanArtifactBridgeFromStore({ storeRoot })).registered).toEqual([]);
    expect(artifactPackSurfaceRegistry.get(PKG, "store")).toBeNull();
  });

  it("3319 T51 (b) an install rescan of one package whose row is no longer live removes that package's store surface only: another package's store surface and the pack's development-tree surface stand", async () => {
    writeStorePackage(storeRoot, "t51", D1, artifactPkg(PKG));
    writeStorePackage(storeRoot, "t51-other", D2, artifactPkg(OTHER));
    expect((await rescanArtifactBridgeFromStore({ storeRoot })).registered.sort()).toEqual([PKG, OTHER].sort());
    artifactPackSurfaceRegistry.register({
      packageName: PKG,
      version: "0.1.0",
      fileMimeTypes: ["text/markdown"],
      matcherSkillIds: [],
      record: { source: "bundled" },
    });
    writeAllowedMock.mockResolvedValue(false);
    const res = await rescanArtifactBridgeFromStore({ storeRoot, onlyPackage: PKG });
    expect(res.skippedNotActive).toEqual([PKG]);
    expect(artifactPackSurfaceRegistry.get(PKG, "store")).toBeNull();
    expect(artifactPackSurfaceRegistry.get(PKG, "bundled")?.record).toEqual({ source: "bundled" });
    expect(artifactPackSurfaceRegistry.get(OTHER, "store")?.record).toEqual({ source: "store", digest: D2 });
  });

  it("3319 T51 (c) a full rescan that no longer finds the package's record on disk removes its store surface", async () => {
    writeStorePackage(storeRoot, "t51", D1, artifactPkg(PKG));
    await rescanArtifactBridgeFromStore({ storeRoot });
    expect(artifactPackSurfaceRegistry.get(PKG, "store")?.record).toEqual({ source: "store", digest: D1 });
    rmSync(path.join(storeRoot, "artifact"), { recursive: true, force: true });
    expect((await rescanArtifactBridgeFromStore({ storeRoot })).registered).toEqual([]);
    expect(artifactPackSurfaceRegistry.get(PKG, "store")).toBeNull();
  });

  it("3319 T51 (d) with two digests on disk, the store surface of the digest the row binds stands", async () => {
    anchorMock.mockResolvedValue({ digest: D2, kind: "artifact" });
    writeStorePackage(storeRoot, "t51", D1, artifactPkg(PKG));
    writeStorePackage(storeRoot, "t51", D2, artifactPkg(PKG));
    expect((await rescanArtifactBridgeFromStore({ storeRoot })).registered).toEqual([PKG]);
    expect(artifactPackSurfaceRegistry.get(PKG, "store")?.record).toEqual({ source: "store", digest: D2 });
  });

  it("3319 T51 (e) a later manifest of the record that the bridge refuses removes the store surface of the earlier valid one", async () => {
    writeStorePackage(storeRoot, "t51", D1, artifactPkg(PKG));
    await rescanArtifactBridgeFromStore({ storeRoot });
    expect(artifactPackSurfaceRegistry.get(PKG, "store")?.record).toEqual({ source: "store", digest: D1 });
    // A key an artifact manifest may not carry: the bridge refuses the whole manifest.
    const valid = artifactPkg(PKG);
    writeStorePackage(storeRoot, "t51", D1, {
      ...valid,
      cinatra: { ...(valid.cinatra as Record<string, unknown>), serverEntry: "./server.js" },
    });
    expect((await rescanArtifactBridgeFromStore({ storeRoot })).registered).toEqual([]);
    expect(artifactPackSurfaceRegistry.get(PKG, "store")).toBeNull();
  });

  it("3319 T51 (f) a pack that declares no type of its own registers no object type, and its store surface stands across rescans", async () => {
    writeStorePackage(storeRoot, "t51", D1, {
      name: PKG,
      version: "0.1.0",
      cinatra: { kind: "artifact", artifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } } },
    });
    expect((await rescanArtifactBridgeFromStore({ storeRoot })).registered).toEqual([]);
    expect((await rescanArtifactBridgeFromStore({ storeRoot })).registered).toEqual([]);
    expect(artifactPackSurfaceRegistry.get(PKG, "store")).toMatchObject({
      version: "0.1.0",
      fileMimeTypes: ["text/markdown"],
      record: { source: "store", digest: D1 },
    });
  });
});
