// cinatra#4894 — the runtime-store road hands a pack's own `cinatra.consumes`
// to the host context: discovery reads it off the materialized manifest, the
// loader hands it to `createExtensionHostContext` / the non-default ctx, and
// `ctx.mcp.callPrimitive` refuses what that manifest does not declare. The
// fixture packs are made up; the SDK driver is a fake that drives makeContext and
// the settle hook like the real one, the host ctx factory is real, and the host
// self-invoker is a stub that records what reached it.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PackageStoreRecord, ActivationResult, ExtensionHostContext } from "@cinatra-ai/sdk-extensions";

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
const reached: string[] = [];
vi.mock("@/lib/extension-self-mcp", () => ({
  callHostPrimitive: vi.fn(async (name: string) => {
    reached.push(name);
    return { called: name };
  }),
}));
vi.mock("@/lib/extension-host-actor", () => ({
  resolveExtensionActorContext: vi.fn(async () => null),
  resolveExtensionActorSummary: vi.fn(async () => null),
  requireExtensionOrganizationId: vi.fn(async () => "org-1"),
}));
// The compiled-in map names the store pack too, with a DIFFERENT declaration:
// a store-loaded version must be judged by its own manifest, never by this map.
vi.mock("@/lib/generated/extensions.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  GENERATED_EXTENSION_CONSUMES_DECLARATIONS: {
    "@example-org/store-agent": { consumes: [{ primitive: "bundled_only_tool", requirement: "required" }] },
  },
}));

import { discoverStoreRecordsV2 } from "@/lib/extension-store-io";
import { loadRuntimePackageExtensions } from "@/lib/runtime-package-loader";
import { __resetVersionKeyedServingForTests } from "@/lib/extension-version-keyed-serving";
import { _resetExtensionMcpForTests } from "@/lib/extension-mcp-registry";

const PKG = "@example-org/store-agent";
const UNDECLARED_PKG = "@example-org/store-quiet";
const DIGEST_A = "a".repeat(128);
const DIGEST_B = "b".repeat(128);
const DIGEST_C = "c".repeat(128);

function manifest(name: string, version: string, consumes?: unknown): string {
  return JSON.stringify({
    name,
    version,
    cinatra: {
      kind: "agent",
      serverEntry: "./register.mjs",
      requestedHostPorts: ["mcp"],
      ...(consumes === undefined ? {} : { consumes }),
    },
  });
}

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cinatra-store-consumes-"));
  const put = async (name: string, digest: string, text: string) => {
    const [scope, slug] = name.split("/");
    const dir = path.join(root, "agent", scope, slug, digest);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), text);
  };
  await put(
    PKG,
    DIGEST_A,
    manifest(PKG, "0.2.0", [
      { primitive: "store_item_read", requirement: "required" },
      { primitive: "store_item_list", requirement: "optional" },
    ]),
  );
  await put(PKG, DIGEST_B, manifest(PKG, "0.1.0", [{ primitive: "store_item_list", requirement: "required" }]));
  await put(UNDECLARED_PKG, DIGEST_C, manifest(UNDECLARED_PKG, "0.1.0"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(() => {
  reached.length = 0;
  runRuntimePackageActivation.mockReset();
  __resetVersionKeyedServingForTests();
  _resetExtensionMcpForTests();
});

function anchors(packageName: string) {
  const base = {
    contentHash: "ch",
    registryUrl: "https://registry.example.org",
    trustDecision: true,
    approvedPorts: ["mcp"],
    signature: null,
    kind: "agent",
  };
  if (packageName === PKG) {
    return [
      { ...base, integrity: "sha512-a", version: "0.2.0", isDefault: true, digest: DIGEST_A },
      { ...base, integrity: "sha512-b", version: "0.1.0", isDefault: false, digest: DIGEST_B },
    ];
  }
  return [{ ...base, integrity: "sha512-c", version: "0.1.0", isDefault: true, digest: DIGEST_C }];
}

/** Load the store through the real loader with a fake driver; return each record's ctx. */
async function loadContexts(): Promise<Map<string, ExtensionHostContext>> {
  const contexts = new Map<string, ExtensionHostContext>();
  runRuntimePackageActivation.mockImplementation(async (_root, deps) => {
    const results: ActivationResult[] = [];
    for (const record of deps.records ?? []) {
      const ctx = deps.makeContext(record.packageName, record.requestedHostPorts ?? [], record);
      contexts.set(`${record.packageName}@${record.version}`, ctx);
      deps.onRegisterSettled?.(record, true);
      results.push({ packageName: record.packageName, status: "registered" } as ActivationResult);
    }
    return results;
  });
  await loadRuntimePackageExtensions(root, {
    resolveInstallAnchors: async (packageName: string) => anchors(packageName) as never,
    readDependencyEdgesByPackage: async () => new Map(),
  } as never);
  return contexts;
}

describe("discovery reads each store manifest's own cinatra.consumes", () => {
  it("a record carries its manifest's raw consumes declaration, or an empty one when absent", async () => {
    const records = await discoverStoreRecordsV2(root);
    const byKey = new Map(records.map((r) => [`${r.packageName}@${r.declaredDigest}`, r]));
    expect(byKey.get(`${PKG}@${DIGEST_A}`)?.consumesDeclaration).toEqual({
      consumes: [
        { primitive: "store_item_read", requirement: "required" },
        { primitive: "store_item_list", requirement: "optional" },
      ],
    });
    expect(byKey.get(`${PKG}@${DIGEST_B}`)?.consumesDeclaration).toEqual({
      consumes: [{ primitive: "store_item_list", requirement: "required" }],
    });
    expect(byKey.get(`${UNDECLARED_PKG}@${DIGEST_C}`)?.consumesDeclaration).toEqual({});
  });
});

describe("the runtime-store loader hands the declaration to the host context", () => {
  it("the default version calls what its manifest declares and is refused the rest", async () => {
    const contexts = await loadContexts();
    const ctx = contexts.get(`${PKG}@0.2.0`);
    expect(ctx).toBeDefined();
    await expect(ctx!.mcp.callPrimitive("store_item_read", {})).resolves.toEqual({ called: "store_item_read" });
    await expect(ctx!.mcp.callPrimitive("store_item_list", {})).resolves.toEqual({ called: "store_item_list" });
    // Named by the compiled-in map only: the loaded manifest decides.
    await expect(ctx!.mcp.callPrimitive("bundled_only_tool", {})).rejects.toThrow(
      /not declared in the package's cinatra\.consumes/,
    );
    expect(reached).toEqual(["store_item_read", "store_item_list"]);
  });

  it("the non-default version is judged by its OWN manifest", async () => {
    const contexts = await loadContexts();
    const ctx = contexts.get(`${PKG}@0.1.0`);
    expect(ctx).toBeDefined();
    await expect(ctx!.mcp.callPrimitive("store_item_list", {})).resolves.toEqual({ called: "store_item_list" });
    await expect(ctx!.mcp.callPrimitive("store_item_read", {})).rejects.toThrow(
      /not declared in the package's cinatra\.consumes/,
    );
    expect(reached).toEqual(["store_item_list"]);
  });

  it("a store pack with no cinatra.consumes is refused every call", async () => {
    const contexts = await loadContexts();
    const ctx = contexts.get(`${UNDECLARED_PKG}@0.1.0`);
    expect(ctx).toBeDefined();
    await expect(ctx!.mcp.callPrimitive("store_item_read", {})).rejects.toThrow(
      /not declared in the package's cinatra\.consumes/,
    );
    expect(reached).toEqual([]);
  });
});
