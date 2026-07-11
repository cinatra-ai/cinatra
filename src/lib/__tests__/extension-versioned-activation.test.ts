import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PackageStoreRecord, ActivationResult } from "@cinatra-ai/sdk-extensions";

// cinatra#1040 S4 — the host loader's VERSIONED activation seam (DI-unit; no real
// registry / fs / DB). With the MULTI-VERSION resolver the loader activates every
// live version side-by-side, keyed by (packageName, version): each anchor's digest
// binds to its own store record, each version's ports are approved∩own-manifest
// (no cross-version leakage), the DEFAULT version is elected the normal host
// context and a non-default sibling the side-effect-free one.

const discoverPackageStoreRecords = vi.fn<() => Promise<(PackageStoreRecord & { kind: string })[]>>();
const runRuntimePackageActivation =
  vi.fn<(...args: unknown[]) => Promise<ActivationResult[]>>();

vi.mock("@cinatra-ai/sdk-extensions", () => ({
  runRuntimePackageActivation: (...args: unknown[]) => runRuntimePackageActivation(...args),
  recordDeclaresHostMigrations: (rec: { migrationsDir?: string; legacyMigrationsDeclared?: boolean }) =>
    typeof rec.migrationsDir === "string" || rec.legacyMigrationsDeclared === true,
}));

vi.mock("@/lib/extension-store-io", () => ({
  discoverStoreRecordsV2: (...args: unknown[]) => discoverPackageStoreRecords(...(args as [])),
  realStoreFs: {},
}));

vi.mock("@/lib/extension-package-store", () => ({
  verifyMaterializedPackageIntegrity: async () => true,
}));

const createExtensionHostContext = vi.fn((packageName: string) => ({ packageName, kind: "default-ctx" }));
const createNonDefaultVersionHostContext = vi.fn((packageName: string) => ({
  packageName,
  kind: "non-default-ctx",
}));
vi.mock("@/lib/extension-host-context", () => ({
  createExtensionHostContext: (...a: unknown[]) => createExtensionHostContext(...(a as [string])),
  createNonDefaultVersionHostContext: (...a: unknown[]) =>
    createNonDefaultVersionHostContext(...(a as [string])),
}));

// Signature verdict is per-anchor (keyed on the anchor's version). Default =
// undefined (no signing); a test can mark a specific version signed.
const resolveSignatureVerdict = vi.fn<(input: { version?: string }) => boolean | undefined>(
  () => undefined,
);
vi.mock("@/lib/extension-signature", () => ({
  resolveSignatureVerdict: (...a: unknown[]) => resolveSignatureVerdict(...(a as [{ version?: string }])),
  signaturesRequired: () => false,
}));

// Trust tier derives from the per-anchor signature verdict: signed -> the
// privileged `trusted-signed` tier (eligible for host DDL); else bootstrap.
vi.mock("@/lib/extension-trust", () => ({
  classifyExtensionTrust: (input: { signatureVerified?: boolean }) => ({
    trusted: true,
    reason: "ok",
    tier: input.signatureVerified ? "trusted-signed" : "trusted-bootstrap",
  }),
  untrustedActivationMode: () => "refuse",
}));

const applyMigrationsForTrustedRecords =
  vi.fn<(recs: { packageName: string; version?: string }[]) => Promise<unknown>>(async () => ({
    applied: [],
    refused: [],
  }));
vi.mock("@/lib/extension-migration-host", () => ({
  applyMigrationsForTrustedRecords: (...a: unknown[]) =>
    applyMigrationsForTrustedRecords(...(a as [{ packageName: string; version?: string }[]])),
}));

import { loadRuntimePackageExtensions } from "@/lib/runtime-package-loader";

const PKG = "@cinatra-ai/sbs";
const DEF_DIGEST = "d".repeat(128);
const SIB_DIGEST = "5".repeat(128);

function rec(digest: string, ports: string[]): PackageStoreRecord & { kind: string } {
  return {
    packageName: PKG,
    serverEntry: "./register.mjs",
    requestedHostPorts: ports, // the version's OWN manifest-declared ports
    sdkAbiRange: "^2",
    storeDir: `/data/connector/${PKG}/${digest}`,
    declaredDigest: digest,
    kind: "connector",
  } as PackageStoreRecord & { kind: string };
}

function anchor(over: { digest: string; version: string; isDefault: boolean; approvedPorts: string[] }) {
  return {
    integrity: "sha512-x",
    contentHash: "ch-x",
    registryUrl: "https://registry.cinatra.ai",
    trustDecision: true,
    kind: "connector",
    signature: null,
    ...over,
  };
}

function activatedRecords(): PackageStoreRecord[] {
  const call = runRuntimePackageActivation.mock.calls.at(-1);
  return call ? (call[1] as { records: PackageStoreRecord[] }).records : [];
}
function capturedMakeContext(): (p: string, ports: readonly string[], rec: PackageStoreRecord) => unknown {
  const call = runRuntimePackageActivation.mock.calls.at(-1);
  return (call![1] as { makeContext: (p: string, ports: readonly string[], rec: PackageStoreRecord) => unknown })
    .makeContext;
}

describe("loadRuntimePackageExtensions — versioned side-by-side activation (cinatra#1040 S4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runRuntimePackageActivation.mockResolvedValue([]);
    resolveSignatureVerdict.mockReturnValue(undefined);
    applyMigrationsForTrustedRecords.mockResolvedValue({ applied: [], refused: [] });
  });

  it("activates BOTH versions side-by-side, each bound to its OWN digest, carrying version + isDefault", async () => {
    discoverPackageStoreRecords.mockResolvedValue([rec(DEF_DIGEST, ["settings"]), rec(SIB_DIGEST, ["secrets"])]);
    runRuntimePackageActivation.mockResolvedValue([{ packageName: PKG, status: "registered" }]);

    await loadRuntimePackageExtensions("/data", {
      resolveInstallAnchors: async () => [
        anchor({ digest: DEF_DIGEST, version: "0.2.0", isDefault: true, approvedPorts: ["settings", "secrets"] }),
        anchor({ digest: SIB_DIGEST, version: "0.1.4", isDefault: false, approvedPorts: ["settings", "secrets"] }),
      ],
    });

    const recs = activatedRecords();
    expect(recs).toHaveLength(2);
    const byVersion = new Map(recs.map((r) => [r.version, r]));
    expect(byVersion.get("0.2.0")).toMatchObject({ isDefault: true, declaredDigest: DEF_DIGEST });
    expect(byVersion.get("0.1.4")).toMatchObject({ isDefault: false, declaredDigest: SIB_DIGEST });
  });

  it("intersects each version's ports with its OWN manifest — no cross-version port leakage (acceptance scenario 2)", async () => {
    discoverPackageStoreRecords.mockResolvedValue([rec(DEF_DIGEST, ["settings"]), rec(SIB_DIGEST, ["secrets"])]);
    runRuntimePackageActivation.mockResolvedValue([{ packageName: PKG, status: "registered" }]);

    await loadRuntimePackageExtensions("/data", {
      resolveInstallAnchors: async () => [
        anchor({ digest: DEF_DIGEST, version: "0.2.0", isDefault: true, approvedPorts: ["settings", "secrets"] }),
        anchor({ digest: SIB_DIGEST, version: "0.1.4", isDefault: false, approvedPorts: ["settings", "secrets"] }),
      ],
    });

    const byVersion = new Map(activatedRecords().map((r) => [r.version, r.requestedHostPorts]));
    // Each version gets approved_union ∩ its OWN declared ports — never the sibling's.
    expect(byVersion.get("0.2.0")).toEqual(["settings"]);
    expect(byVersion.get("0.1.4")).toEqual(["secrets"]);
  });

  it("elects the DEFAULT version the normal host context and a non-default sibling the side-effect-free one", async () => {
    discoverPackageStoreRecords.mockResolvedValue([rec(DEF_DIGEST, []), rec(SIB_DIGEST, [])]);
    runRuntimePackageActivation.mockResolvedValue([{ packageName: PKG, status: "registered" }]);

    await loadRuntimePackageExtensions("/data", {
      resolveInstallAnchors: async () => [
        anchor({ digest: DEF_DIGEST, version: "0.2.0", isDefault: true, approvedPorts: [] }),
        anchor({ digest: SIB_DIGEST, version: "0.1.4", isDefault: false, approvedPorts: [] }),
      ],
    });

    const make = capturedMakeContext();
    const recs = activatedRecords();
    const def = recs.find((r) => r.version === "0.2.0")!;
    const sib = recs.find((r) => r.version === "0.1.4")!;
    make(PKG, [], def);
    make(PKG, [], sib);
    expect(createExtensionHostContext).toHaveBeenCalledTimes(1);
    expect(createNonDefaultVersionHostContext).toHaveBeenCalledTimes(1);
  });

  it("falls back to the SINGULAR resolver (one default anchor) when no plural resolver is wired — pre-S4 behavior", async () => {
    discoverPackageStoreRecords.mockResolvedValue([rec(DEF_DIGEST, ["settings"])]);
    runRuntimePackageActivation.mockResolvedValue([{ packageName: PKG, status: "registered" }]);

    await loadRuntimePackageExtensions("/data", {
      resolveInstallAnchor: async () =>
        anchor({ digest: DEF_DIGEST, version: "1.0.0", isDefault: true, approvedPorts: ["settings"] }),
    });

    const recs = activatedRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ version: "1.0.0", isDefault: true, requestedHostPorts: ["settings"] });
  });

  it("a SIGNED non-default sibling does NOT authorize the UNSIGNED default's privileged migrations (signature scope is per-identity)", async () => {
    // The non-default sibling (0.1.4) is signed; the DEFAULT (0.2.0) is NOT.
    resolveSignatureVerdict.mockImplementation((input) => (input.version === "0.1.4" ? true : undefined));
    discoverPackageStoreRecords.mockResolvedValue([rec(DEF_DIGEST, []), rec(SIB_DIGEST, [])]);
    runRuntimePackageActivation.mockResolvedValue([{ packageName: PKG, status: "registered" }]);

    await loadRuntimePackageExtensions("/data", {
      resolveInstallAnchors: async () => [
        anchor({ digest: DEF_DIGEST, version: "0.2.0", isDefault: true, approvedPorts: [] }),
        anchor({ digest: SIB_DIGEST, version: "0.1.4", isDefault: false, approvedPorts: [] }),
      ],
    });

    // The migration pass runs for DEFAULT + signed only. The default is UNSIGNED
    // and the signed version is NON-DEFAULT, so NEITHER may run host DDL — the
    // signed sibling must not lend its signature to the default's migrations.
    const migrated = applyMigrationsForTrustedRecords.mock.calls.at(-1)?.[0] ?? [];
    expect(migrated).toEqual([]);
  });
});
