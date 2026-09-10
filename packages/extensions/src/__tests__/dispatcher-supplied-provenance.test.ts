// HONEST ROW PROVENANCE AND EXPLICIT SOURCE ROUTING (cinatra#3204 D2 —
// criterion 20, and the routing half of the heuristic replacement).
//
// Two things are pinned here, and they are the two the issue names:
//
//   1. the row a SUPPLIED install creates records `local` / `github` with the
//      content digest — never the synthetic `type:"verdaccio"`,
//      `integrity:"dispatcher-install"` row this seam used to write for every
//      install, and never `registryUrl`;
//   2. the carve-out is decided by DECLARED provenance, not by the package NAME.
//      The regression fence is the pair of refs the name-shape guess got wrong:
//      a scoped name and a versioned ref, both supplied — previously classified
//      registry-backed and driven down a road they did not come from.
//
// The canonical store, lifecycle primitive and activate hook are mocked with the
// same scaffolding dispatcher-install-row-anchor.test.ts uses, so this isolates
// the dispatch decision with no DB.
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = {
  id: string;
  packageName: string;
  status: string;
  ownerLevel?: string;
  ownerId?: string | null;
  organizationId: string | null;
  source: Record<string, unknown> | null;
};
let rows: Row[] = [];

const installExtensionManifest = vi.fn(async (row: Row) => {
  rows.push({ ...row });
  return row;
});
const dropRow = vi.fn(async (id: string) => {
  rows = rows.filter((r) => r.id !== id);
});
const readInstalledExtensionById = vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null);
const readInstalledExtensionsByPackageName = vi.fn(async (pkg: string) =>
  rows.filter((r) => r.packageName === pkg),
);

vi.mock("@cinatra-ai/agents", () => ({
  withInstallLock: async (_packageName: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...a: unknown[]) =>
    readInstalledExtensionsByPackageName(...(a as [string])),
  readInstalledExtensionById: (...a: unknown[]) => readInstalledExtensionById(...(a as [string])),
  listInstalledExtensions: vi.fn(async (): Promise<unknown[]> => []),
  readEffectiveStatusByPackageNames: vi.fn(async () => new Map()),
}));

vi.mock("../lifecycle-primitive", () => ({
  installExtensionManifest: (...a: unknown[]) => installExtensionManifest(...(a as [Row])),
  supersedeOrganizationRowsForWorkspaceInstall: vi.fn(async () => [] as string[]),
  transitionExtensionLifecycle: vi.fn(async () => null),
  // Every install below finalizes, so the rollback path is never taken; the
  // stub exists so a regression that DID roll back would be visible as a
  // dropped row rather than an unmocked-import crash. It deliberately does not
  // name the canonical store's internal writers — the drift guard
  // (drift-canonical-gate-reach.test.ts) allow-lists those by file, and a test
  // fixture has no business appearing on that list.
  deleteNonFinalizedCanonicalRow: async (id: string) => {
    await dropRow(id);
  },
}));

vi.mock("../required-in-prod", () => ({
  isPackageRequiredInProd: () => false,
  checkRequiredExtensionVersionPin: () => ({ ok: true }),
}));

const fireExtensionActivate = vi.fn();
vi.mock("../activate-hook", () => ({
  fireExtensionActivate: (...a: unknown[]) =>
    fireExtensionActivate(...(a as [string, string | null, string | undefined])),
}));

import { extensionRegistry } from "../index";
import { makeHandler } from "./__mocks__/extension-handler";
import type { Actor, PackageRef } from "../index";

const DIGEST = "a".repeat(64);
const SHA = "b".repeat(40);

const actor: Actor = {
  actorType: "system",
  userId: "u1",
  source: "worker",
  orgId: "org-1",
  orgRole: "org_admin",
};

const ref = (over: Partial<PackageRef> & Record<string, unknown>): PackageRef =>
  ({
    registryUrl: "https://registry.example.com",
    packageName: "@acme/thing-skill",
    version: "1.0.0",
    ...over,
  }) as PackageRef;

const localRef = (over: Record<string, unknown> = {}) =>
  ref({
    provenance: { type: "local", path: "snapshots/thing.tgz", contentDigest: DIGEST },
    ...over,
  });

beforeEach(() => {
  extensionRegistry._resetForTesting();
  rows = [];
  vi.clearAllMocks();
  fireExtensionActivate.mockResolvedValue({ finalized: true, activated: false });
});

describe("criterion 20 — the row records where the package actually came from", () => {
  it("a LOCAL supplied install writes local provenance with the content digest", async () => {
    extensionRegistry.register(makeHandler("skill"));
    await extensionRegistry.install("skill", localRef(), actor);

    expect(installExtensionManifest).toHaveBeenCalledTimes(1);
    const written = installExtensionManifest.mock.calls[0]![0];
    expect(written.source).toMatchObject({
      type: "local",
      path: "snapshots/thing.tgz",
      contentDigest: DIGEST,
    });
  });

  it("a GITHUB supplied install writes github provenance with BOTH the sha and the digest", async () => {
    extensionRegistry.register(makeHandler("skill"));
    await extensionRegistry.install(
      "skill",
      ref({
        provenance: {
          type: "github",
          repo: "owner/repo",
          ref: "v1.0.0",
          resolvedSha: SHA,
          contentDigest: DIGEST,
        },
      }),
      actor,
    );

    const written = installExtensionManifest.mock.calls[0]![0];
    expect(written.source).toMatchObject({
      type: "github",
      repo: "owner/repo",
      resolvedSha: SHA,
      contentDigest: DIGEST,
    });
    // The revision identifier and the content digest are both there, and they
    // are different values: one says which commit, the other which bytes.
    expect((written.source as Record<string, unknown>).resolvedSha).not.toBe(
      (written.source as Record<string, unknown>).contentDigest,
    );
  });

  it("a supplied row is NEVER presented as registry-attested", async () => {
    extensionRegistry.register(makeHandler("skill"));
    await extensionRegistry.install("skill", localRef(), actor);

    const source = installExtensionManifest.mock.calls[0]![0].source as Record<string, unknown>;
    expect(source.type).not.toBe("verdaccio");
    expect(source.integrity).toBeUndefined();
    expect(source.registryUrl).toBeUndefined();
    expect(JSON.stringify(source)).not.toContain("dispatcher-install");
  });

  it("REGRESSION: a registry install still writes the placeholder verdaccio row", async () => {
    extensionRegistry.register(makeHandler("skill"));
    await extensionRegistry.install("skill", ref({}), actor);

    const source = installExtensionManifest.mock.calls[0]![0].source as Record<string, unknown>;
    expect(source.type).toBe("verdaccio");
    expect(source.integrity).toBe("dispatcher-install");
  });
});

describe("the carve-out is decided by DECLARED provenance, not by the package NAME", () => {
  it("a SCOPED supplied ref gets a row and the pipeline — the name no longer decides", async () => {
    extensionRegistry.register(makeHandler("skill"));
    await extensionRegistry.install("skill", localRef({ packageName: "@acme/scoped-skill" }), actor);

    expect(installExtensionManifest).toHaveBeenCalledTimes(1);
    expect(fireExtensionActivate).toHaveBeenCalled();
    expect(installExtensionManifest.mock.calls[0]![0].source).toMatchObject({ type: "local" });
  });

  it("a VERSIONED supplied ref gets a row and the pipeline — a version is not a source", async () => {
    extensionRegistry.register(makeHandler("skill"));
    await extensionRegistry.install(
      "skill",
      localRef({ packageName: "owner/repo", version: "1.2.3" }),
      actor,
    );

    expect(installExtensionManifest).toHaveBeenCalledTimes(1);
    expect(installExtensionManifest.mock.calls[0]![0].source).toMatchObject({ type: "local" });
  });

  it("REGRESSION: a ref that declares NOTHING and looks handler-owned still gets no row", async () => {
    extensionRegistry.register(makeHandler("skill"));
    // Bare `owner/repo`, no version, no declared provenance — the legacy
    // github/local skill carve-out, unchanged.
    await extensionRegistry.install(
      "skill",
      ref({ packageName: "owner/repo", version: undefined }),
      actor,
    );

    expect(installExtensionManifest).not.toHaveBeenCalled();
    expect(fireExtensionActivate).not.toHaveBeenCalled();
  });

  it("REGRESSION: a supplied ref with an INCOMPLETE declaration falls back, never widens", async () => {
    extensionRegistry.register(makeHandler("skill"));
    // No content digest: there is nothing for the supplied entry to verify, so
    // the ref must NOT be promoted onto the supplied road on the strength of an
    // unverifiable claim.
    await extensionRegistry.install(
      "skill",
      ref({
        packageName: "owner/repo",
        version: undefined,
        // Deliberately incomplete — the type says a content digest is required,
        // and this asserts the RUNTIME check that stands behind that type when a
        // row or a wire payload arrives without one.
        provenance: { type: "local", path: "snapshots/x.tgz" } as never,
      }),
      actor,
    );

    expect(installExtensionManifest).not.toHaveBeenCalled();
  });
});
