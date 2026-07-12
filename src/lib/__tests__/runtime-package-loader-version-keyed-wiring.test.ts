import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PackageStoreRecord, ActivationResult, ExtensionHostContext } from "@cinatra-ai/sdk-extensions";

// cinatra#1392 S8 — the PRODUCTION loader injection of version-keyed retention
// (the wiring the S4/#1410 slices deferred): `loadRuntimePackageExtensions`
// begins a sink per NON-DEFAULT versioned record at makeContext, threads it into
// the side-effect-free ctx, COMMITS it in the per-record settle hook on register
// success (ABORTS on failure), and refreshes the pre-resolved edge maps from the
// canonical rows after every pass. DI-unit: the SDK driver is a FAKE that drives
// makeContext/onRegisterSettled exactly like the real one; the version-keyed
// registry, the pre-resolved edge maps, and the host ctx factory are REAL.

const discoverPackageStoreRecords = vi.fn<() => Promise<PackageStoreRecord[]>>();
type DriverDeps = {
  records?: readonly PackageStoreRecord[];
  makeContext: (pkg: string, ports: readonly string[], rec: PackageStoreRecord) => ExtensionHostContext;
  onRegisterSettled?: (rec: PackageStoreRecord, registered: boolean) => void;
};
const runRuntimePackageActivation = vi.fn<(root: string, deps: DriverDeps) => Promise<ActivationResult[]>>();

vi.mock(import("@cinatra-ai/sdk-extensions"), async (importOriginal) => {
  // PARTIAL mock: the REAL host-context factory (deliberately unmocked here)
  // consumes the SDK's env-override validators + port-tier table, so only the
  // activation driver + the migration predicate are replaced.
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

// The batched canonical read the edge-map refresh consumes.
const listInstalledExtensions = vi.fn(async () => [] as unknown[]);
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  listInstalledExtensions: (...a: unknown[]) => listInstalledExtensions(...(a as [])),
}));

import { loadRuntimePackageExtensions } from "@/lib/runtime-package-loader";
import {
  isVersionKeyedServable,
  resolveVersionKeyedMcpTool,
  __resetVersionKeyedServingForTests,
} from "@/lib/extension-version-keyed-serving";
import {
  getPreResolvedVersionedEdges,
  __resetPreResolvedEdgesForTests,
} from "@/lib/extension-pre-resolved-edges";
import { listExtensionMcpTools, _resetExtensionMcpForTests } from "@/lib/extension-mcp-registry";

const PKG = "@x/dep";
const V_DEFAULT = "0.2.0";
const V_SIB = "0.1.4";

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

/** A fake driver that runs register(ctx) per record and settles, like the real one. */
function driveWith(registerBehavior: (rec: PackageStoreRecord, ctx: ExtensionHostContext) => boolean) {
  runRuntimePackageActivation.mockImplementation(async (_root, deps) => {
    const results: ActivationResult[] = [];
    for (const record of deps.records ?? []) {
      const ctx = deps.makeContext(record.packageName, record.requestedHostPorts ?? [], record);
      const ok = registerBehavior(record, ctx);
      deps.onRegisterSettled?.(record, ok);
      results.push({
        packageName: record.packageName,
        status: ok ? "registered" : "failed",
      } as ActivationResult);
    }
    return results;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetVersionKeyedServingForTests();
  __resetPreResolvedEdgesForTests();
  _resetExtensionMcpForTests();
  discoverPackageStoreRecords.mockResolvedValue([rec("digA", V_DEFAULT), rec("digB", V_SIB)]);
  listInstalledExtensions.mockResolvedValue([]);
});

describe("loadRuntimePackageExtensions — version-keyed retention wiring (S8)", () => {
  it("a NON-DEFAULT versioned record's register RETAINS servable tools; the default registers globally", async () => {
    driveWith((record, ctx) => {
      // Both versions register one tool through their ctx, like a real register(ctx).
      ctx.mcp.registerTool({
        name: record.isDefault === false ? "dep_tool_v014" : "dep_tool",
        handler: async () => ({ from: record.version }),
      } as never);
      return true;
    });
    const results = await loadRuntimePackageExtensions("/store", {
      resolveInstallAnchors: async () => anchors() as never,
    });
    expect(results.map((r) => r.status)).toEqual(["registered", "registered"]);
    // The sibling's tool is retained version-keyed and SERVABLE (committed) …
    expect(isVersionKeyedServable(PKG, V_SIB)).toBe(true);
    expect(resolveVersionKeyedMcpTool(PKG, V_SIB, "dep_tool_v014").kind).toBe("serve");
    // … and never leaked into the global registry; the default's tool is global.
    expect(listExtensionMcpTools().map((t) => t.name)).toEqual(["dep_tool"]);
  });

  it("a FAILED non-default register ABORTS the retention (nothing servable)", async () => {
    driveWith((record, ctx) => {
      if (record.isDefault === false) {
        ctx.mcp.registerTool({ name: "half_registered", handler: async () => ({}) } as never);
        return false; // register threw downstream
      }
      return true;
    });
    await loadRuntimePackageExtensions("/store", {
      resolveInstallAnchors: async () => anchors() as never,
    });
    expect(isVersionKeyedServable(PKG, V_SIB)).toBe(false);
  });

  it("every pass refreshes the pre-resolved edge maps from the canonical rows", async () => {
    driveWith(() => true);
    listInstalledExtensions.mockResolvedValue([
      {
        id: "i-caller",
        packageName: "@x/caller",
        status: "active",
        isDefault: true,
        dependencyEdges: [
          {
            packageName: PKG,
            edgeType: "runtime",
            versionConstraint: { kind: "exact", version: V_SIB },
            requirement: "required",
            resolvedInstallId: "i-sib",
            resolutionReason: "planner",
          },
        ],
      },
      { id: "i-sib", packageName: PKG, status: "active", isDefault: false, version: V_SIB, dependencyEdges: [] },
    ] as never);
    await loadRuntimePackageExtensions("/store", {
      resolveInstallAnchors: async () => anchors() as never,
    });
    expect(listInstalledExtensions).toHaveBeenCalled();
    expect(
      getPreResolvedVersionedEdges("@x/caller", { version: null, isDefault: true })?.get(PKG),
    ).toEqual({ kind: "versioned", version: V_SIB, resolvedInstallId: "i-sib" });
  });

  it("a failed canonical read keeps the PREVIOUS maps (loader never throws)", async () => {
    driveWith(() => true);
    listInstalledExtensions.mockRejectedValue(new Error("db down"));
    const results = await loadRuntimePackageExtensions("/store", {
      resolveInstallAnchors: async () => anchors() as never,
    });
    expect(results).toHaveLength(2);
  });
});
