import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PackageStoreRecord, ActivationResult, ExtensionHostContext } from "@cinatra-ai/sdk-extensions";

// cinatra#3745 — the runtime loader stamps the loaded identity of a verified
// install: only an anchor with an install id and a digest stamps one, a record
// that fails to register keeps none, and the capability teardown retires it.
// DI-unit: the SDK driver is a FAKE that drives makeContext/onRegisterSettled
// like the real one (which verifies the bytes against the anchor and imports
// the entry before makeContext); the identity registry is REAL.

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
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  listInstalledExtensions: async () => [],
}));

import { loadRuntimePackageExtensions } from "@/lib/runtime-package-loader";
import * as registry from "@/lib/extension-capabilities-registry";

const PKG = "@x/mailer";
const VERSION = "1.2.0";
const DIGEST = "a".repeat(64);

function rec(): PackageStoreRecord {
  return {
    packageName: PKG,
    version: VERSION,
    serverEntry: "./register",
    requestedHostPorts: ["mcp"],
    sdkAbiRange: "^2",
    storeDir: `/store/connector/mailer/${DIGEST}`,
    declaredDigest: DIGEST,
    kind: "connector",
  } as unknown as PackageStoreRecord;
}

function anchor(overrides: Record<string, unknown> = {}) {
  return {
    installId: "install-1",
    integrity: "sha512-a",
    contentHash: "ch-a",
    registryUrl: "https://registry.cinatra.ai",
    trustDecision: true,
    approvedPorts: ["mcp"],
    version: VERSION,
    isDefault: true,
    signature: null,
    digest: DIGEST,
    kind: "connector",
    ...overrides,
  };
}

function driveWith(registered: boolean) {
  runRuntimePackageActivation.mockImplementation(async (_root, deps) => {
    const results: ActivationResult[] = [];
    for (const record of deps.records ?? []) {
      deps.makeContext(record.packageName, record.requestedHostPorts ?? [], record);
      deps.onRegisterSettled?.(record, registered);
      results.push({ packageName: record.packageName, status: registered ? "registered" : "failed" } as ActivationResult);
    }
    return results;
  });
}

// red-first-expect: currentLoadedExtensionIdentity is not a function
const current = () =>
  (registry as unknown as {
    currentLoadedExtensionIdentity: (p: string, v: string) => registry.LoadedExtensionIdentity | undefined;
  }).currentLoadedExtensionIdentity(PKG, VERSION);

beforeEach(() => {
  vi.clearAllMocks();
  registry.__resetCapabilityRegistry();
  discoverPackageStoreRecords.mockResolvedValue([rec()]);
});

describe("loadRuntimePackageExtensions — the loaded identity of a verified install", () => {
  it("stamps the identity of a registered install with an install id and a digest", async () => {
    driveWith(true);
    await loadRuntimePackageExtensions("/store", { resolveInstallAnchors: async () => [anchor()] as never });
    expect(current()).toMatchObject({ packageName: PKG, version: VERSION, installId: "install-1", digest: DIGEST });
    expect(registry.isLoadedExtensionIdentityCurrent(current())).toBe(true);
  });

  it.each([
    ["no install id", { installId: null }],
    ["no digest", { digest: null }],
  ])("stamps none for an anchor with %s", async (_label, overrides) => {
    driveWith(true);
    const results = await loadRuntimePackageExtensions("/store", {
      resolveInstallAnchors: async () => [anchor(overrides)] as never,
    });
    expect(results.map((r) => r.status)).toEqual(["registered"]);
    expect(current()).toBeUndefined();
  });

  it("keeps none for a record that fails to register", async () => {
    driveWith(true);
    await loadRuntimePackageExtensions("/store", { resolveInstallAnchors: async () => [anchor()] as never });
    const before = current();
    driveWith(false);
    await loadRuntimePackageExtensions("/store", { resolveInstallAnchors: async () => [anchor()] as never });
    expect(current()).toBeUndefined();
    expect(registry.isLoadedExtensionIdentityCurrent(before)).toBe(false);
  });

  it("a teardown of the package makes the stamped identity stale", async () => {
    driveWith(true);
    await loadRuntimePackageExtensions("/store", { resolveInstallAnchors: async () => [anchor()] as never });
    const identity = current();
    registry.invalidateProvidersForPackage(PKG);
    expect(registry.isLoadedExtensionIdentityCurrent(identity)).toBe(false);
  });
});
