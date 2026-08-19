import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PackageStoreRecord, ActivationResult, ExtensionHostContext } from "@cinatra-ai/sdk-extensions";

// cinatra#2762 round-6 — the INSTALL serving record is gated on the DEFAULT
// record's OWN outcome, never on the package-wide failure set.
//
// The defect this pins: `loadRuntimePackageExtensions` built `failedNames` per
// PACKAGE, so a failing NON-DEFAULT sibling suppressed the install serving
// record even though the DEFAULT record had registered cleanly and owns the
// package's unversioned global names. The boot path runs no capability
// teardown, so the `bundled` record written by the static pass survived, and
// the settings surface then rendered "Installed but not in service — version X
// is serving instead" over a perfectly healthy default install, greying
// Activate and Update.
//
// DI-unit, in the shape of runtime-package-loader-version-keyed-wiring.test.ts:
// the SDK activation driver is a FAKE that drives makeContext /
// onRegisterSettled AND the default-only bootstrap pass exactly like the real
// one; the loader under test, the serving-record registry, and the settings
// model that turns the record into copy are all REAL.

const discoverPackageStoreRecords = vi.fn<() => Promise<PackageStoreRecord[]>>();
type DriverDeps = {
  records?: readonly PackageStoreRecord[];
  makeContext: (pkg: string, ports: readonly string[], rec: PackageStoreRecord) => ExtensionHostContext;
  onRegisterSettled?: (rec: PackageStoreRecord, registered: boolean) => void;
};
const runRuntimePackageActivation = vi.fn<(root: string, deps: DriverDeps) => Promise<ActivationResult[]>>();

vi.mock(import("@cinatra-ai/sdk-extensions"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runRuntimePackageActivation: (...args: unknown[]) =>
      runRuntimePackageActivation(...(args as [string, DriverDeps])),
    recordDeclaresHostMigrations: () => false,
  };
});

vi.mock("@/lib/extension-store-io", () => ({
  discoverStoreRecordsV2: () => discoverPackageStoreRecords(),
  realStoreFs: {},
}));

vi.mock("@/lib/extension-package-store", () => ({
  verifyMaterializedPackageIntegrity: async () => true,
}));

vi.mock("@/lib/extension-signature", () => ({
  resolveSignatureVerdict: () => undefined,
  signaturesRequired: () => false,
}));

vi.mock("@/lib/extension-trust", () => ({
  classifyExtensionTrust: () => ({ trusted: true, tier: "trusted-bootstrap", reason: "ok" }),
  untrustedActivationMode: () => "refuse",
}));

vi.mock("@/lib/extension-migration-host", () => ({
  applyMigrationsForTrustedRecords: async () => ({ applied: [], refused: [] }),
  applyMigrationUnionForTrustedRecords: async () => ({ applied: [], refused: [] }),
}));

const listInstalledExtensions = vi.fn(async () => [] as unknown[]);
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  listInstalledExtensions: (...a: unknown[]) => listInstalledExtensions(...(a as [])),
}));

import { loadRuntimePackageExtensions } from "@/lib/runtime-package-loader";
import {
  recordServingImplementation,
  readServingRecord,
  __resetServingRecords,
} from "@/lib/extension-capabilities-registry";
import { __resetPreResolvedEdgesForTests } from "@/lib/extension-pre-resolved-edges";
import { _resetExtensionMcpForTests } from "@/lib/extension-mcp-registry";
import { resolveServingState } from "../../../packages/extensions/src/screens/extension-settings-model";

const PKG = "@x/dep";
const V_DEFAULT = "0.2.0";
const V_SIB = "0.1.4";
const V_BUNDLED = "0.1.0";

function rec(digest: string, version: string): PackageStoreRecord {
  return {
    packageName: PKG,
    version,
    serverEntry: "./register",
    requestedHostPorts: ["mcp"],
    sdkAbiRange: "^2",
    storeDir: `/store/connector/dep/${digest}`,
    declaredDigest: digest,
    kind: "connector",
  } as unknown as PackageStoreRecord;
}

function anchors() {
  return [
    {
      integrity: "sha512-a",
      contentHash: "ch-a",
      registryUrl: "https://registry.cinatra.ai",
      trustDecision: true,
      approvedPorts: ["mcp"],
      version: V_DEFAULT,
      isDefault: true,
      signature: null,
      digest: "digA",
      kind: "connector",
    },
    {
      integrity: "sha512-b",
      contentHash: "ch-b",
      registryUrl: "https://registry.cinatra.ai",
      trustDecision: true,
      approvedPorts: ["mcp"],
      version: V_SIB,
      isDefault: false,
      signature: null,
      digest: "digB",
      kind: "connector",
    },
  ];
}

/**
 * A fake driver in the REAL driver's shape: a failure-isolated register pass
 * that settles EVERY record that reached makeContext, then a bootstrap pass
 * over the registered DEFAULTS only (a non-default sibling registers and
 * stops). `bootstrap-threw` is therefore only ever a default's own failure —
 * which is exactly what the fixed gate relies on.
 */
function driveWith(behavior: {
  register: (rec: PackageStoreRecord) => boolean;
  bootstrap?: (rec: PackageStoreRecord) => boolean;
}) {
  runRuntimePackageActivation.mockImplementation(async (_root, deps) => {
    const results: ActivationResult[] = [];
    const registeredDefaults: PackageStoreRecord[] = [];
    for (const record of deps.records ?? []) {
      deps.makeContext(record.packageName, record.requestedHostPorts ?? [], record);
      const ok = behavior.register(record);
      deps.onRegisterSettled?.(record, ok);
      results.push(
        ok
          ? { packageName: record.packageName, status: "registered" }
          : { packageName: record.packageName, status: "failed", reason: "register-threw" },
      );
      if (ok && record.isDefault !== false) registeredDefaults.push(record);
    }
    for (const record of registeredDefaults) {
      const ok = behavior.bootstrap?.(record) ?? true;
      results.push(
        ok
          ? { packageName: record.packageName, status: "bootstrapped" }
          : { packageName: record.packageName, status: "failed", reason: "bootstrap-threw" },
      );
    }
    return results;
  });
}

/** What the settings page would render for the healthy default install row. */
const pageStateForDefaultInstall = () =>
  resolveServingState({
    installedVersion: V_DEFAULT,
    serving: readServingRecord(PKG),
    isProductInstall: true,
    isArchived: false,
  });

beforeEach(() => {
  vi.clearAllMocks();
  __resetServingRecords();
  __resetPreResolvedEdgesForTests();
  _resetExtensionMcpForTests();
  discoverPackageStoreRecords.mockResolvedValue([rec("digA", V_DEFAULT), rec("digB", V_SIB)]);
  listInstalledExtensions.mockResolvedValue([]);
  // Boot order: the StaticBundleLoader's pass runs FIRST and records the
  // image's copy. Nothing tears it down, so it is what stands if the runtime
  // pass declines to write.
  recordServingImplementation({ packageName: PKG, origin: "bundled", version: V_BUNDLED });
});

describe("loadRuntimePackageExtensions — the install serving record follows the DEFAULT record's own outcome", () => {
  it("a healthy DEFAULT still records as serving when a NON-DEFAULT sibling FAILS (round-6 blocker)", async () => {
    driveWith({ register: (record) => record.isDefault !== false });

    const results = await loadRuntimePackageExtensions("/store", {
      resolveInstallAnchors: async () => anchors() as never,
    });
    // The shape under test: the default registered + bootstrapped cleanly and
    // the sibling failed, so the PACKAGE-wide failure set is non-empty.
    expect(results.map((r) => r.status).sort()).toEqual(["bootstrapped", "failed", "registered"]);

    // The install's own version is what is serving — the bundled record is
    // REPLACED, not left standing.
    expect(readServingRecord(PKG)).toEqual({ origin: "install", version: V_DEFAULT });
    // …so the settings page does NOT accuse the healthy install.
    expect(pageStateForDefaultInstall()).toEqual({ named: false });
  });

  it("with no failing sibling at all, the record is identical (the sibling changes nothing)", async () => {
    discoverPackageStoreRecords.mockResolvedValue([rec("digA", V_DEFAULT)]);
    driveWith({ register: () => true });

    await loadRuntimePackageExtensions("/store", {
      resolveInstallAnchors: async () => [anchors()[0]] as never,
    });

    expect(readServingRecord(PKG)).toEqual({ origin: "install", version: V_DEFAULT });
    expect(pageStateForDefaultInstall()).toEqual({ named: false });
  });

  it("a DEFAULT that registers but BOOTSTRAPS-THROWS still records nothing (half-activated is not serving)", async () => {
    driveWith({ register: () => true, bootstrap: () => false });

    await loadRuntimePackageExtensions("/store", {
      resolveInstallAnchors: async () => anchors() as never,
    });

    // The bundled record stands, which is the #2762 state the surface must name.
    expect(readServingRecord(PKG)).toEqual({ origin: "bundled", version: V_BUNDLED });
    const state = pageStateForDefaultInstall();
    expect(state.named).toBe(true);
    if (state.named) {
      expect(state.title).toBe("Installed but not in service");
      expect(state.servingVersion).toBe(V_BUNDLED);
    }
  });

  it("a DEFAULT whose own REGISTER fails records nothing, even when the sibling registers", async () => {
    driveWith({ register: (record) => record.isDefault === false });

    await loadRuntimePackageExtensions("/store", {
      resolveInstallAnchors: async () => anchors() as never,
    });

    expect(readServingRecord(PKG)).toEqual({ origin: "bundled", version: V_BUNDLED });
    expect(pageStateForDefaultInstall().named).toBe(true);
  });
});
