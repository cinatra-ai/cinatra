import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PackageStoreRecord, ActivationResult } from "@cinatra-ai/sdk-extensions";

// DI-UNIT (no real registry / no real fs / no DB): proves that
// `loadRuntimePackageExtensions({ onlyPackage })` narrows the store scan to the
// SINGLE matching record so only it runs the trust gate + activation, leaves the
// non-matching records UN-touched (never imported), and treats a zero-match
// `onlyPackage` exactly like an empty store ([]).
//
// The sdk-extensions discovery + activation driver, the host integrity verifier,
// the host-context factory, and the migration-host pass are all mocked so the
// test exercises ONLY the loader's onlyPackage-filter + per-candidate trust
// wiring, with zero IO.

// --- mocked SDK surface -------------------------------------------------------
const discoverPackageStoreRecords = vi.fn<() => Promise<PackageStoreRecord[]>>();
const runRuntimePackageActivation =
  vi.fn<(...args: unknown[]) => Promise<ActivationResult[]>>();

vi.mock("@cinatra-ai/sdk-extensions", () => ({
  DEFAULT_PACKAGE_STORE_PATH: "/data/extensions/packages",
  discoverPackageStoreRecords: (...args: unknown[]) =>
    discoverPackageStoreRecords(...(args as [])),
  runRuntimePackageActivation: (...args: unknown[]) =>
    runRuntimePackageActivation(...args),
}));

// Host-side static deps the loader imports — stubbed so no DB / fs / registries
// are touched. The integrity verifier + signature verdict + trust classifier are
// real-shaped fakes; the host-context factory returns an opaque ctx.
const verifyMaterializedPackageIntegrity = vi.fn(async () => true);
vi.mock("@/lib/extension-package-store", () => ({
  verifyMaterializedPackageIntegrity: (...a: unknown[]) =>
    verifyMaterializedPackageIntegrity(...(a as [])),
}));

vi.mock("@/lib/extension-host-context", () => ({
  createExtensionHostContext: (packageName: string) => ({ packageName }),
}));

vi.mock("@/lib/extension-signature", () => ({
  resolveSignatureVerdict: () => undefined, // no signing configured → no-op
  // extension-trust-config reads `signaturesRequired` to derive
  // allowMarketplaceBootstrapTrust. This DI-unit test models "no signing
  // configured", so signatures are NOT required (bootstrap trust allowed).
  signaturesRequired: () => false,
}));

const classifyExtensionTrust = vi.fn(() => ({ trusted: true, reason: "ok" }));
vi.mock("@/lib/extension-trust", () => ({
  classifyExtensionTrust: (...a: unknown[]) => classifyExtensionTrust(...(a as [])),
  untrustedActivationMode: () => "refuse",
}));

// Migration pre-flight: a clean no-op (no refusals) so every trusted record stays
// activatable.
const applyMigrationsForTrustedRecords = vi.fn(async () => ({ applied: [], refused: [] }));
vi.mock("@/lib/extension-migration-host", () => ({
  applyMigrationsForTrustedRecords: (...a: unknown[]) =>
    applyMigrationsForTrustedRecords(...(a as [])),
}));

import { loadRuntimePackageExtensions } from "@/lib/runtime-package-loader";

const REGISTRY = "https://registry.cinatra.ai";

function rec(packageName: string, storeDir: string): PackageStoreRecord {
  return {
    packageName,
    serverEntry: "./register",
    requestedHostPorts: [],
    sdkAbiRange: "^2",
    storeDir,
  } as PackageStoreRecord;
}

function anchor(name: string) {
  return {
    integrity: `sha512-${name}`,
    contentHash: `ch-${name}`,
    registryUrl: REGISTRY,
    trustDecision: true,
    approvedPorts: [],
    version: "1.0.0",
    signature: null,
  };
}

describe("loadRuntimePackageExtensions — onlyPackage targeted activation (DI-unit, no registry)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyMaterializedPackageIntegrity.mockResolvedValue(true);
    classifyExtensionTrust.mockReturnValue({ trusted: true, reason: "ok" });
    applyMigrationsForTrustedRecords.mockResolvedValue({ applied: [], refused: [] });
    runRuntimePackageActivation.mockResolvedValue([]);
  });

  it("narrows 3 discovered records to ONLY the matching package: trust gate + activation run for it alone", async () => {
    const THREE = [
      rec("@cinatra-ai/alpha", "/store/alpha"),
      rec("@cinatra-ai/beta", "/store/beta"),
      rec("@cinatra-ai/gamma", "/store/gamma"),
    ];
    discoverPackageStoreRecords.mockResolvedValue(THREE);
    runRuntimePackageActivation.mockResolvedValue([
      { packageName: "@cinatra-ai/beta", status: "registered" },
    ]);

    // The injected anchor resolver is the per-candidate trust gate; spy it so we
    // can prove it ran for the matching package only.
    const resolveInstallAnchor = vi.fn(async (name: string) => anchor(name));

    const results = await loadRuntimePackageExtensions("/store", {
      onlyPackage: "@cinatra-ai/beta",
      resolveInstallAnchor,
    });

    // The trust gate (anchor resolution + classifier) ran for the MATCHING
    // package only — never the other two.
    expect(resolveInstallAnchor).toHaveBeenCalledTimes(1);
    expect(resolveInstallAnchor).toHaveBeenCalledWith("@cinatra-ai/beta");
    expect(classifyExtensionTrust).toHaveBeenCalledTimes(1);
    expect(classifyExtensionTrust).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: "@cinatra-ai/beta" }),
    );
    expect(verifyMaterializedPackageIntegrity).toHaveBeenCalledTimes(1);

    // Activation was driven for the single matching record (and that record only).
    expect(runRuntimePackageActivation).toHaveBeenCalledTimes(1);
    const driverArgs = runRuntimePackageActivation.mock.calls[0]![1] as {
      records: PackageStoreRecord[];
    };
    expect(driverArgs.records.map((r) => r.packageName)).toEqual(["@cinatra-ai/beta"]);

    expect(results).toEqual([{ packageName: "@cinatra-ai/beta", status: "registered" }]);
  });

  it("never imports / trust-gates the NON-matching records", async () => {
    discoverPackageStoreRecords.mockResolvedValue([
      rec("@cinatra-ai/alpha", "/store/alpha"),
      rec("@cinatra-ai/beta", "/store/beta"),
      rec("@cinatra-ai/gamma", "/store/gamma"),
    ]);
    const resolveInstallAnchor = vi.fn(async (name: string) => anchor(name));

    await loadRuntimePackageExtensions("/store", {
      onlyPackage: "@cinatra-ai/gamma",
      resolveInstallAnchor,
    });

    const probed = resolveInstallAnchor.mock.calls.map((c) => c[0]);
    expect(probed).toEqual(["@cinatra-ai/gamma"]);
    expect(probed).not.toContain("@cinatra-ai/alpha");
    expect(probed).not.toContain("@cinatra-ai/beta");

    // Only the matching record was ever handed to the activation driver.
    const driverArgs = runRuntimePackageActivation.mock.calls[0]![1] as {
      records: PackageStoreRecord[];
    };
    expect(driverArgs.records.map((r) => r.packageName)).toEqual(["@cinatra-ai/gamma"]);
  });

  it("onlyPackage matching ZERO of the discovered records returns [] (clean no-op, like an empty store)", async () => {
    discoverPackageStoreRecords.mockResolvedValue([
      rec("@cinatra-ai/alpha", "/store/alpha"),
      rec("@cinatra-ai/beta", "/store/beta"),
      rec("@cinatra-ai/gamma", "/store/gamma"),
    ]);
    const resolveInstallAnchor = vi.fn(async (name: string) => anchor(name));

    const results = await loadRuntimePackageExtensions("/store", {
      onlyPackage: "@cinatra-ai/not-in-store",
      resolveInstallAnchor,
    });

    expect(results).toEqual([]);
    // No candidate ⇒ no trust gate, no activation.
    expect(resolveInstallAnchor).not.toHaveBeenCalled();
    expect(classifyExtensionTrust).not.toHaveBeenCalled();
    expect(runRuntimePackageActivation).not.toHaveBeenCalled();
  });
});
