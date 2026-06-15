// Transitive REQUIRED-closure seeding (fixes the linkedin-oauth-connector
// boot crash; see PR #204, #253).
//
// A bundled serverEntry connector (`@cinatra-ai/dependent-connector`, the
// linkedin-connector stand-in) declares a REQUIRED runtime edge to a bundled
// but serverEntry-less, NOT-required-in-prod connector
// (`@cinatra-ai/oauth-target`, the linkedin-oauth-connector stand-in). Under
// PR #204's base filter the oauth target got NO anchor row, so the boot
// closure gate (extension-closure-boot-gate.ts → dependency-closure.ts
// findBrokenClosures) found the dependent's required edge unsatisfiable and
// threw fail-closed on every prod boot.
//
// This suite drives the REAL seed path (ensureStaticBundleLifecycleAnchors)
// and feeds the resulting anchor set into the REAL boot-closure scanner
// (findBrokenClosures) to prove: the oauth target is now anchored AND the
// dependent's closure resolves (no broken closure). It also covers the pure
// transitiveRequiredClosure helper directly (transitivity, cycles, edge-type
// filtering, unbundled targets).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type {
  ExtensionDependency,
  InstalledExtension,
} from "@cinatra-ai/extensions/canonical-types";

const readInstalledExtensionsByPackageName = vi.fn();
const installExtensionManifest = vi.fn();
const sourceSwitchExtension = vi.fn();
const isPackageRequiredInProd = vi.fn<(pkg: string) => boolean>(() => false);

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...args: unknown[]) =>
    readInstalledExtensionsByPackageName(...args),
}));
vi.mock("@cinatra-ai/extensions/lifecycle-primitive", () => ({
  installExtensionManifest: (...args: unknown[]) => installExtensionManifest(...args),
  sourceSwitchExtension: (...args: unknown[]) => sourceSwitchExtension(...args),
}));
vi.mock("@cinatra-ai/extensions/required-in-prod", () => ({
  isPackageRequiredInProd: (pkg: string) => isPackageRequiredInProd(pkg),
}));

// Registry mirroring the real linkedin shape: a seeded serverEntry connector
// requiring a serverEntry-less, not-required connector; plus a peer/optional
// target and an unrelated serverEntry-less, not-required record to prove
// neither is over-anchored. The factory is hoisted, so edges are inlined here
// (no top-level helper references allowed inside vi.mock).
vi.mock("@/lib/generated/extensions.server", () => {
  const edge = (
    packageName: string,
    over: Partial<ExtensionDependency> = {},
  ): ExtensionDependency => ({
    packageName,
    kind: "connector",
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "*" },
    requirement: "required",
    ...over,
  });
  return {
    STATIC_EXTENSION_RECORDS: [
      {
        packageName: "@cinatra-ai/dependent-connector", // linkedin-connector stand-in
        kind: "connector",
        version: "0.1.0",
        serverEntry: "./register", // base-seed (serverEntry)
        requestedHostPorts: [],
        sdkAbiRange: null,
        dependencies: [
          edge("@cinatra-ai/oauth-target"), // REQUIRED → must be anchored transitively
          edge("@cinatra-ai/peer-target", { edgeType: "peer" }), // peer → never followed
          edge("@cinatra-ai/optional-target", { requirement: "optional" }), // optional → never followed
        ],
      },
      {
        packageName: "@cinatra-ai/oauth-target", // linkedin-oauth-connector stand-in
        kind: "connector",
        version: "0.1.0",
        serverEntry: null, // serverEntry-less, not required-in-prod → MISSED by base filter
        requestedHostPorts: [],
        sdkAbiRange: null,
        dependencies: [],
      },
      {
        packageName: "@cinatra-ai/peer-target",
        kind: "connector",
        version: "0.1.0",
        serverEntry: null,
        requestedHostPorts: [],
        sdkAbiRange: null,
        dependencies: [],
      },
      {
        packageName: "@cinatra-ai/optional-target",
        kind: "connector",
        version: "0.1.0",
        serverEntry: null,
        requestedHostPorts: [],
        sdkAbiRange: null,
        dependencies: [],
      },
      {
        packageName: "@cinatra-ai/unrelated-ui-ext",
        kind: "connector",
        version: "0.1.0",
        serverEntry: null, // serverEntry-less, not required, NOT depended-on → never anchored
        requestedHostPorts: [],
        sdkAbiRange: null,
        dependencies: [],
      },
    ],
    GENERATED_EXTENSION_SERVER_ENTRIES: {},
  };
});

const req = (packageName: string): ExtensionDependency => ({
  packageName,
  kind: "connector",
  edgeType: "runtime",
  versionConstraint: { kind: "semver-range", range: "*" },
  requirement: "required",
});
const peer = (packageName: string): ExtensionDependency => ({ ...req(packageName), edgeType: "peer" });
const opt = (packageName: string): ExtensionDependency => ({ ...req(packageName), requirement: "optional" });

// Real anchor helpers + the real boot-closure scanner — seeding and the assert
// must agree on the edge shape, so we do NOT mock them.
import {
  isStaticBundleAnchorSource,
  staticBundleAnchorSource,
} from "@cinatra-ai/extensions/static-bundle-anchor";
import { findBrokenClosures } from "@cinatra-ai/extensions/dependency-closure";

import { transitiveRequiredClosure } from "@/lib/static-bundle-lifecycle";

const RECORDS = [
  {
    packageName: "@cinatra-ai/dependent-connector",
    serverEntry: "./register",
    dependencies: [
      req("@cinatra-ai/oauth-target"),
      peer("@cinatra-ai/peer-target"),
      opt("@cinatra-ai/optional-target"),
    ],
  },
  { packageName: "@cinatra-ai/oauth-target", serverEntry: null, dependencies: [] },
  { packageName: "@cinatra-ai/peer-target", serverEntry: null, dependencies: [] },
  { packageName: "@cinatra-ai/optional-target", serverEntry: null, dependencies: [] },
  { packageName: "@cinatra-ai/unrelated-ui-ext", serverEntry: null, dependencies: [] },
] as never[];

async function runSeeder() {
  const { ensureStaticBundleLifecycleAnchors } = await import("@/lib/static-bundle-lifecycle");
  return ensureStaticBundleLifecycleAnchors();
}

describe("transitiveRequiredClosure (pure)", () => {
  it("follows ONLY required non-peer edges; ignores peer/optional and unbundled targets", () => {
    const closure = transitiveRequiredClosure(["@cinatra-ai/dependent-connector"], RECORDS);
    // dependent + its required target only — peer/optional targets excluded.
    expect([...closure].sort()).toEqual([
      "@cinatra-ai/dependent-connector",
      "@cinatra-ai/oauth-target",
    ]);
  });

  it("is transitive across a chain", () => {
    const chain = [
      { packageName: "a", serverEntry: "./register", dependencies: [req("b")] },
      { packageName: "b", serverEntry: null, dependencies: [req("c")] },
      { packageName: "c", serverEntry: null, dependencies: [] },
      { packageName: "d", serverEntry: null, dependencies: [] }, // unrelated
    ] as never[];
    expect([...transitiveRequiredClosure(["a"], chain)].sort()).toEqual(["a", "b", "c"]);
  });

  it("terminates on a dependency cycle", () => {
    const cyclic = [
      { packageName: "a", serverEntry: "./register", dependencies: [req("b")] },
      { packageName: "b", serverEntry: null, dependencies: [req("a")] }, // cycle back to a
    ] as never[];
    expect([...transitiveRequiredClosure(["a"], cyclic)].sort()).toEqual(["a", "b"]);
  });

  it("ignores an edge whose target is not in the registry (unbundled)", () => {
    const recs = [
      { packageName: "a", serverEntry: "./register", dependencies: [req("ghost")] },
    ] as never[];
    expect([...transitiveRequiredClosure(["a"], recs)]).toEqual(["a"]);
  });
});

const row = (over: Partial<InstalledExtension>): InstalledExtension => ({
  id: "iext_x",
  packageName: "@cinatra-ai/x",
  ownerLevel: "platform",
  ownerId: null,
  organizationId: null,
  kind: "connector",
  status: "active",
  source: { type: "local", path: "connector:@cinatra-ai/x", resolvedCommitOrTreeHash: "dev" },
  requiredInProd: false,
  dependencies: [],
  manifestHash: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe("ensureStaticBundleLifecycleAnchors — transitive required-closure seeding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
    isPackageRequiredInProd.mockReturnValue(false);
    // Echo the seeded manifest back as a live platform anchor row so we can
    // assemble the post-seed snapshot the boot gate would read.
    installExtensionManifest.mockImplementation(async (r: Record<string, unknown>) => ({
      ...row({}),
      ...r,
    }));
    sourceSwitchExtension.mockImplementation(async (id: string) => row({ id }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("anchors the serverEntry-less REQUIRED target of a seeded connector (oauth stand-in)", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([]);
    const result = await runSeeder();
    // Exactly the dependent (serverEntry) + its required target — NOT the peer
    // target, the optional target, or the unrelated serverEntry-less record.
    expect(result.seededLive.sort()).toEqual([
      "@cinatra-ai/dependent-connector",
      "@cinatra-ai/oauth-target",
    ]);
    expect(result.failed).toEqual([]);

    const seeded = installExtensionManifest.mock.calls.map(
      (c) => (c[0] as { packageName: string }).packageName,
    );
    expect(seeded).not.toContain("@cinatra-ai/peer-target");
    expect(seeded).not.toContain("@cinatra-ai/optional-target");
    expect(seeded).not.toContain("@cinatra-ai/unrelated-ui-ext");

    const oauthArg = installExtensionManifest.mock.calls.find(
      (c) => (c[0] as { packageName: string }).packageName === "@cinatra-ai/oauth-target",
    )?.[0] as Record<string, unknown>;
    expect(oauthArg).toBeDefined();
    expect(oauthArg.ownerLevel).toBe("platform");
    expect(oauthArg.status).toBe("active");
    expect(isStaticBundleAnchorSource(oauthArg.source as never)).toBe(true);
  });

  it("PROOF: after the real seed, findBrokenClosures reports NO broken closure for the dependent", async () => {
    // BEFORE — the PR #204 base set: only the serverEntry dependent is anchored,
    // its required edge to the serverEntry-less oauth target is unsatisfiable.
    const beforeSnapshot: InstalledExtension[] = [
      row({
        id: "iext_dependent",
        packageName: "@cinatra-ai/dependent-connector",
        status: "active",
        dependencies: [req("@cinatra-ai/oauth-target")],
      }),
    ];
    const beforeBroken = findBrokenClosures(beforeSnapshot);
    expect(beforeBroken).toEqual([
      {
        packageName: "@cinatra-ai/dependent-connector",
        missingRequired: ["@cinatra-ai/oauth-target"],
        rangeViolations: [],
      },
    ]);

    // AFTER — run the REAL seeder and assemble the snapshot from what it wrote.
    readInstalledExtensionsByPackageName.mockResolvedValue([]);
    await runSeeder();
    const afterSnapshot: InstalledExtension[] = installExtensionManifest.mock.calls.map((c) => {
      const r = c[0] as Record<string, unknown>;
      return row({
        id: r.id as string,
        packageName: r.packageName as string,
        status: r.status as InstalledExtension["status"],
        dependencies: (r.dependencies as ExtensionDependency[]) ?? [],
        source: r.source as InstalledExtension["source"],
      });
    });
    // The seeder anchored the oauth target → the dependent's closure now resolves.
    expect(afterSnapshot.map((r) => r.packageName).sort()).toEqual([
      "@cinatra-ai/dependent-connector",
      "@cinatra-ai/oauth-target",
    ]);
    expect(findBrokenClosures(afterSnapshot)).toEqual([]);
  });
});
