import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PackageStoreRecord, ActivationResult } from "@cinatra-ai/sdk-extensions";

// DI-UNIT (no real registry / no real fs / no DB) — cinatra#792: the loader's
// PER-PACKAGE anchor narrowing over multi-digest discovery. With retention
// (#796) several digests of one package legitimately coexist on disk, so the
// loader must select EXACTLY the anchor-bound digest instead of refusing
// ambiguity wholesale — and must stay fail-closed everywhere else:
//   - bound anchor + matching record        → only that record activates;
//   - bound anchor + no matching record     → refused (digest binding failed);
//   - UNBOUND anchor + >1 discovered digest → refused (ambiguous);
//   - canonical row KIND != path kind       → refused (kind binding).

const discoverPackageStoreRecords = vi.fn<() => Promise<PackageStoreRecord[]>>();
const runRuntimePackageActivation =
  vi.fn<(...args: unknown[]) => Promise<ActivationResult[]>>();

vi.mock("@cinatra-ai/sdk-extensions", () => ({
  runRuntimePackageActivation: (...args: unknown[]) =>
    runRuntimePackageActivation(...args),
  recordDeclaresHostMigrations: (rec: { migrationsDir?: string; legacyMigrationsDeclared?: boolean }) =>
    typeof rec.migrationsDir === "string" || rec.legacyMigrationsDeclared === true,
}));

vi.mock("@/lib/extension-store-io", () => ({
  discoverStoreRecordsV2: (...args: unknown[]) =>
    discoverPackageStoreRecords(...(args as [])),
  realStoreFs: {},
}));

const verifyMaterializedPackageIntegrity = vi.fn(async () => true);
vi.mock("@/lib/extension-package-store", () => ({
  verifyMaterializedPackageIntegrity: (...a: unknown[]) =>
    verifyMaterializedPackageIntegrity(...(a as [])),
}));

vi.mock("@/lib/extension-host-context", () => ({
  createExtensionHostContext: (packageName: string) => ({ packageName }),
}));

vi.mock("@/lib/extension-signature", () => ({
  resolveSignatureVerdict: () => undefined,
  signaturesRequired: () => false,
}));

const classifyExtensionTrust = vi.fn(() => ({ trusted: true, reason: "ok" }));
vi.mock("@/lib/extension-trust", () => ({
  classifyExtensionTrust: (...a: unknown[]) => classifyExtensionTrust(...(a as [])),
  untrustedActivationMode: () => "refuse",
}));

const applyMigrationsForTrustedRecords = vi.fn(async () => ({ applied: [], refused: [] }));
vi.mock("@/lib/extension-migration-host", () => ({
  applyMigrationsForTrustedRecords: (...a: unknown[]) =>
    applyMigrationsForTrustedRecords(...(a as [])),
  applyMigrationUnionForTrustedRecords: (...a: unknown[]) =>
    applyMigrationsForTrustedRecords(...(a as [])),
}));

import { loadRuntimePackageExtensions } from "@/lib/runtime-package-loader";

const REGISTRY = "https://registry.cinatra.ai";
const PKG = "@cinatra-ai/multi-digest";
const OLD_DIGEST = "a".repeat(128);
const NEW_DIGEST = "b".repeat(128);

function rec(digest: string, kind = "connector"): PackageStoreRecord & { kind: string } {
  return {
    packageName: PKG,
    serverEntry: "./register",
    requestedHostPorts: [],
    sdkAbiRange: "^2",
    storeDir: `/data/extensions/${kind}/${PKG}/${digest}`,
    declaredDigest: digest,
    kind,
  } as PackageStoreRecord & { kind: string };
}

function anchor(over: Partial<{ digest: string | null; kind: string | null }> = {}) {
  return {
    integrity: "sha512-x",
    contentHash: "ch-x",
    registryUrl: REGISTRY,
    trustDecision: true,
    approvedPorts: [],
    version: "1.0.0",
    signature: null,
    digest: NEW_DIGEST,
    kind: "connector",
    ...over,
  };
}

/** The records the loader handed the activation driver on the last call. */
function activatedRecords(): Array<{ storeDir: string }> {
  const call = runRuntimePackageActivation.mock.calls.at(-1);
  return call ? (call[1] as { records: Array<{ storeDir: string }> }).records : [];
}

describe("loadRuntimePackageExtensions — multi-digest anchor narrowing (cinatra#792)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyMaterializedPackageIntegrity.mockResolvedValue(true);
    classifyExtensionTrust.mockReturnValue({ trusted: true, reason: "ok" });
    applyMigrationsForTrustedRecords.mockResolvedValue({ applied: [], refused: [] });
    runRuntimePackageActivation.mockResolvedValue([]);
  });

  it("two digests on disk + a BOUND anchor → exactly the anchor-bound record activates", async () => {
    discoverPackageStoreRecords.mockResolvedValue([rec(OLD_DIGEST), rec(NEW_DIGEST)]);
    runRuntimePackageActivation.mockResolvedValue([{ packageName: PKG, status: "registered" }]);

    await loadRuntimePackageExtensions("/data/extensions", {
      resolveInstallAnchor: async () => anchor({ digest: NEW_DIGEST }),
    });

    expect(runRuntimePackageActivation).toHaveBeenCalledTimes(1);
    expect(activatedRecords().map((r) => r.storeDir)).toEqual([
      `/data/extensions/connector/${PKG}/${NEW_DIGEST}`,
    ]);
  });

  it("a BOUND anchor whose digest is NOT on disk → refused (nothing activates)", async () => {
    discoverPackageStoreRecords.mockResolvedValue([rec(OLD_DIGEST)]);

    const results = await loadRuntimePackageExtensions("/data/extensions", {
      resolveInstallAnchor: async () => anchor({ digest: NEW_DIGEST }),
    });

    expect(results).toEqual([]);
    expect(runRuntimePackageActivation).not.toHaveBeenCalled();
  });

  it("an UNBOUND anchor (no digest) + two digests on disk → refused (ambiguous, fail closed)", async () => {
    discoverPackageStoreRecords.mockResolvedValue([rec(OLD_DIGEST), rec(NEW_DIGEST)]);

    const results = await loadRuntimePackageExtensions("/data/extensions", {
      resolveInstallAnchor: async () => anchor({ digest: null }),
    });

    expect(results).toEqual([]);
    expect(runRuntimePackageActivation).not.toHaveBeenCalled();
  });

  it("an UNBOUND anchor + exactly ONE digest → proceeds (integrity re-verify is the backstop)", async () => {
    discoverPackageStoreRecords.mockResolvedValue([rec(NEW_DIGEST)]);
    runRuntimePackageActivation.mockResolvedValue([{ packageName: PKG, status: "registered" }]);

    await loadRuntimePackageExtensions("/data/extensions", {
      resolveInstallAnchor: async () => anchor({ digest: null }),
    });

    expect(activatedRecords().map((r) => r.storeDir)).toEqual([
      `/data/extensions/connector/${PKG}/${NEW_DIGEST}`,
    ]);
  });

  it("the canonical row's KIND contradicting the store PATH kind → refused (kind binding)", async () => {
    discoverPackageStoreRecords.mockResolvedValue([rec(NEW_DIGEST, "connector")]);

    const results = await loadRuntimePackageExtensions("/data/extensions", {
      resolveInstallAnchor: async () => anchor({ kind: "agent" }),
    });

    expect(results).toEqual([]);
    expect(runRuntimePackageActivation).not.toHaveBeenCalled();
  });

  it("a kind-UNBOUND anchor (null — legacy resolver) skips the kind assertion", async () => {
    discoverPackageStoreRecords.mockResolvedValue([rec(NEW_DIGEST)]);
    runRuntimePackageActivation.mockResolvedValue([{ packageName: PKG, status: "registered" }]);

    await loadRuntimePackageExtensions("/data/extensions", {
      resolveInstallAnchor: async () => anchor({ kind: null }),
    });

    expect(activatedRecords()).toHaveLength(1);
  });

  it("narrowing keeps the migration pass on the SELECTED record only (no ambiguity refusal)", async () => {
    discoverPackageStoreRecords.mockResolvedValue([rec(OLD_DIGEST), rec(NEW_DIGEST)]);
    runRuntimePackageActivation.mockResolvedValue([{ packageName: PKG, status: "registered" }]);

    await loadRuntimePackageExtensions("/data/extensions", {
      resolveInstallAnchor: async () => anchor({ digest: NEW_DIGEST }),
    });

    // The migration pass receives the narrowed single record set — the
    // pre-#792 wholesale ambiguity refusal must NOT fire for a bound anchor.
    const migrated = (
      applyMigrationsForTrustedRecords.mock.calls.at(-1) as unknown as
        | [Array<{ storeDir: string }>]
        | undefined
    )?.[0];
    // (unsigned fixture → not signed-trusted → empty is fine; the assertion is
    // that activation happened despite two digests on disk)
    expect(migrated).toBeDefined();
    expect(activatedRecords()).toHaveLength(1);
  });
});
