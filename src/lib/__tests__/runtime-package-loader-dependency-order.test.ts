// #180 item 8 — DEPENDENCY-ORDERED ACTIVATION (DI-unit, no registry/fs/DB):
// the loader topo-sorts activatable records DEPENDENCIES-FIRST over the
// injected persisted-edge map before handing them to the activation driver;
// an unreadable edge map degrades to discovery order (loud warning), never a
// refusal.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PackageStoreRecord, ActivationResult } from "@cinatra-ai/sdk-extensions";
import type { ExtensionDependency } from "@cinatra-ai/extensions/canonical-types";

const discoverPackageStoreRecords = vi.fn<() => Promise<PackageStoreRecord[]>>();
const runRuntimePackageActivation =
  vi.fn<(...args: unknown[]) => Promise<ActivationResult[]>>();

vi.mock("@cinatra-ai/sdk-extensions", () => ({
  DEFAULT_PACKAGE_STORE_PATH: "/data/extensions/packages",
  discoverPackageStoreRecords: (...args: unknown[]) =>
    discoverPackageStoreRecords(...(args as [])),
  runRuntimePackageActivation: (...args: unknown[]) => runRuntimePackageActivation(...args),
  recordDeclaresHostMigrations: () => false,
}));

vi.mock("@/lib/extension-package-store", () => ({
  verifyMaterializedPackageIntegrity: async () => true,
}));
vi.mock("@/lib/extension-host-context", () => ({
  createExtensionHostContext: (packageName: string) => ({ packageName }),
}));
vi.mock("@/lib/extension-signature", () => ({
  resolveSignatureVerdict: () => undefined,
  signaturesRequired: () => false,
}));
vi.mock("@/lib/extension-trust", () => ({
  classifyExtensionTrust: () => ({ trusted: true, reason: "ok" }),
  untrustedActivationMode: () => "refuse",
}));
vi.mock("@/lib/extension-migration-host", () => ({
  applyMigrationsForTrustedRecords: async () => ({ applied: [], refused: [] }),
}));

import { loadRuntimePackageExtensions } from "@/lib/runtime-package-loader";

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
    registryUrl: "https://registry.cinatra.ai",
    trustDecision: true,
    approvedPorts: [],
    version: "1.0.0",
    signature: null,
  };
}

function edge(packageName: string): ExtensionDependency {
  return {
    packageName,
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "*" },
    requirement: "required",
  };
}

function activatedOrder(): string[] {
  const call = runRuntimePackageActivation.mock.calls[0]!;
  const opts = call[1] as { records: PackageStoreRecord[] };
  return opts.records.map((r) => r.packageName);
}

describe("loadRuntimePackageExtensions — dependency-ordered activation (#180 item 8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runRuntimePackageActivation.mockResolvedValue([]);
  });

  it("activates DEPENDENCIES-FIRST over the persisted edges (deterministic lexicographic tie-break), regardless of discovery order", async () => {
    // Discovery order: dependent first (worst case). dependent -> lib -> base.
    discoverPackageStoreRecords.mockResolvedValue([
      rec("@cinatra-ai/dependent", "/store/dependent"),
      rec("@cinatra-ai/lib", "/store/lib"),
      rec("@cinatra-ai/base", "/store/base"),
      rec("@cinatra-ai/standalone", "/store/standalone"),
    ]);
    const edges = new Map<string, ExtensionDependency[]>([
      ["@cinatra-ai/dependent", [edge("@cinatra-ai/lib")]],
      ["@cinatra-ai/lib", [edge("@cinatra-ai/base")]],
    ]);
    await loadRuntimePackageExtensions("/store", {
      resolveInstallAnchor: async (name) => anchor(name),
      readDependencyEdgesByPackage: async () => edges,
    });
    // Kahn with a lexicographic tie-break: base first (only ready dep-free
    // name < standalone), then lib (now ready, < standalone), then dependent
    // (< standalone), then standalone — deterministic, test-pinned.
    expect(activatedOrder()).toEqual([
      "@cinatra-ai/base",
      "@cinatra-ai/lib",
      "@cinatra-ai/dependent",
      "@cinatra-ai/standalone",
    ]);
  });

  it("an unreadable edge map degrades to DISCOVERY order with a warning (ordering never blocks boot)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    discoverPackageStoreRecords.mockResolvedValue([
      rec("@cinatra-ai/zeta", "/store/zeta"),
      rec("@cinatra-ai/alpha", "/store/alpha"),
    ]);
    await loadRuntimePackageExtensions("/store", {
      resolveInstallAnchor: async (name) => anchor(name),
      readDependencyEdgesByPackage: async () => {
        throw new Error("canonical store unreachable");
      },
    });
    expect(activatedOrder()).toEqual(["@cinatra-ai/zeta", "@cinatra-ai/alpha"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dependency-ordered activation degraded to discovery order"),
    );
    warn.mockRestore();
  });

  it("a CYCLE among activatable records falls back to deterministic lexicographic order with the loud warning (loader-level pin)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    discoverPackageStoreRecords.mockResolvedValue([
      rec("@cinatra-ai/b", "/store/b"),
      rec("@cinatra-ai/a", "/store/a"),
    ]);
    const edges = new Map<string, ExtensionDependency[]>([
      ["@cinatra-ai/a", [edge("@cinatra-ai/b")]],
      ["@cinatra-ai/b", [edge("@cinatra-ai/a")]],
    ]);
    await loadRuntimePackageExtensions("/store", {
      resolveInstallAnchor: async (name) => anchor(name),
      readDependencyEdgesByPackage: async () => edges,
    });
    expect(activatedOrder()).toEqual(["@cinatra-ai/a", "@cinatra-ai/b"]); // lexicographic fallback
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dependency CYCLE"));
    warn.mockRestore();
  });

  it("a SINGLE activatable record never consults the edge reader (no new boot dependency for the trivial case)", async () => {
    const readEdges = vi.fn(async () => new Map());
    discoverPackageStoreRecords.mockResolvedValue([rec("@cinatra-ai/solo", "/store/solo")]);
    await loadRuntimePackageExtensions("/store", {
      resolveInstallAnchor: async (name) => anchor(name),
      readDependencyEdgesByPackage: readEdges,
    });
    expect(readEdges).not.toHaveBeenCalled();
    expect(activatedOrder()).toEqual(["@cinatra-ai/solo"]);
  });
});
