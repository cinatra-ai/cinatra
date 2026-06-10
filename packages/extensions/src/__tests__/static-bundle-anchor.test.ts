// Static-bundle lifecycle correctness (IOC-34/IOC-35).
//
// Covers the three cooperating pieces that make bundled `serverEntry`
// extensions lifecycle-correct end-to-end, without a DB:
//   1. the pure anchor provenance helpers (static-bundle-anchor.ts);
//   2. the lifecycle primitive's uninstall TOMBSTONE for anchor rows
//      (lifecycle-primitive.ts) — archive and uninstall converge;
//   3. the lifecycle-correctness CHAIN of record: primitive transition →
//      pure effective-status aggregation → (the loader's strict gate is
//      asserted on the resulting map in src/lib/__tests__/
//      static-bundle-loader-gate.test.ts against the same semantics).
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import type { InstalledExtension } from "../canonical-types";

vi.mock("server-only", () => ({}));
vi.mock("../canonical-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("../canonical-store")>();
  return {
    // Keep the PURE aggregation real for the chain test below.
    aggregateEffectiveStatusByPackageName: original.aggregateEffectiveStatusByPackageName,
    readInstalledExtensionById: vi.fn(),
    _internalInsertInstalledExtension: vi.fn(async (row) => ({
      ...row,
      createdAt: new Date("2026-06-10T00:00:00Z"),
      updatedAt: new Date("2026-06-10T00:00:00Z"),
    })),
    _internalUpdateInstalledExtensionStatus: vi.fn(),
    _internalUpdateInstalledExtensionSource: vi.fn(),
    _internalDeleteInstalledExtension: vi.fn(async () => undefined),
  };
});
vi.mock("../permissions-store", () => ({
  deleteExtensionPermissions: vi.fn(async () => undefined),
}));

import * as store from "../canonical-store";
import { aggregateEffectiveStatusByPackageName } from "../canonical-store";
import { deleteExtensionPermissions } from "../permissions-store";
import { installExtensionManifest, transitionExtensionLifecycle } from "../lifecycle-primitive";
import {
  STATIC_BUNDLE_ANCHOR_PATH_PREFIX,
  isStaticBundleAnchorSource,
  staticBundleAnchorPath,
  staticBundleAnchorSource,
  staticBundleAnchorVersion,
} from "../static-bundle-anchor";

const PKG = "@cinatra-ai/bundled-connector";

const anchorRow = (status: InstalledExtension["status"] = "active"): InstalledExtension => ({
  id: "iext_anchor",
  packageName: PKG,
  ownerLevel: "platform",
  ownerId: null,
  organizationId: null,
  kind: "connector",
  status,
  source: staticBundleAnchorSource(PKG, "0.1.0"),
  requiredInProd: false,
  dependencies: [],
  manifestHash: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const orgRow = (status: InstalledExtension["status"] = "active"): InstalledExtension => ({
  ...anchorRow(status),
  id: "iext_org",
  ownerLevel: "organization",
  ownerId: "org-1",
  organizationId: "org-1",
  source: { type: "local", path: `connector:${PKG}`, resolvedCommitOrTreeHash: "dev-fixture" },
});

const OPTS = { actor: { source: "test" }, reason: "unit-test" };

beforeEach(() => {
  vi.mocked(store.readInstalledExtensionById).mockReset();
  vi.mocked(store._internalUpdateInstalledExtensionStatus).mockImplementation(
    async (id: string, status: string) =>
      ({ ...anchorRow(status as InstalledExtension["status"]), id }) as never,
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("static-bundle anchor provenance helpers (pure)", () => {
  it("builds and recognizes the anchor source shape", () => {
    const source = staticBundleAnchorSource(PKG, "0.1.0");
    expect(source).toEqual({
      type: "local",
      path: `${STATIC_BUNDLE_ANCHOR_PATH_PREFIX}${PKG}`,
      resolvedCommitOrTreeHash: "bundled@0.1.0",
    });
    expect(staticBundleAnchorPath(PKG)).toBe(`static-bundle:${PKG}`);
    expect(isStaticBundleAnchorSource(source)).toBe(true);
    expect(staticBundleAnchorVersion(source)).toBe("0.1.0");
  });

  it("does NOT recognize other local/registry provenance as an anchor", () => {
    expect(isStaticBundleAnchorSource(orgRow().source)).toBe(false);
    expect(
      isStaticBundleAnchorSource({
        type: "verdaccio",
        registryUrl: "x",
        packageName: PKG,
        version: "0.1.0",
        integrity: "sha512-x",
      }),
    ).toBe(false);
    expect(isStaticBundleAnchorSource(null)).toBe(false);
    expect(staticBundleAnchorVersion(orgRow().source)).toBeNull();
  });

  it("fails closed on an unparseable bundled version", () => {
    expect(
      staticBundleAnchorVersion({
        type: "local",
        path: staticBundleAnchorPath(PKG),
        resolvedCommitOrTreeHash: "garbage",
      }),
    ).toBeNull();
    expect(
      staticBundleAnchorVersion({
        type: "local",
        path: staticBundleAnchorPath(PKG),
        resolvedCommitOrTreeHash: "bundled@",
      }),
    ).toBeNull();
  });
});

describe("archived-start tombstone seed (installExtensionManifest)", () => {
  it("an anchor row may be created DIRECTLY archived (tombstone seed, no live window)", async () => {
    const created = await installExtensionManifest(
      {
        id: "iext_seed",
        packageName: PKG,
        ownerLevel: "platform",
        ownerId: null,
        organizationId: null,
        kind: "connector",
        source: staticBundleAnchorSource(PKG, "0.1.0"),
        requiredInProd: false,
        dependencies: [],
        manifestHash: null,
        status: "archived",
      },
      OPTS,
    );
    expect(created.status).toBe("archived");
  });

  it("a NON-anchor source still refuses an archived start (strict active|locked contract)", async () => {
    await expect(
      installExtensionManifest(
        {
          id: "iext_seed2",
          packageName: PKG,
          ownerLevel: "platform",
          ownerId: null,
          organizationId: null,
          kind: "connector",
          source: {
            type: "verdaccio",
            registryUrl: "http://localhost:4873",
            packageName: PKG,
            version: "0.1.0",
            integrity: "sha512-x",
          },
          requiredInProd: false,
          dependencies: [],
          manifestHash: null,
          status: "archived",
        },
        OPTS,
      ),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
  });
});

describe("uninstall TOMBSTONE for static-bundle anchor rows (lifecycle primitive)", () => {
  it("uninstall of an ACTIVE anchor row ARCHIVES it (tombstone) instead of deleting", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(anchorRow("active"));
    const out = await transitionExtensionLifecycle("iext_anchor", "uninstall", OPTS);
    expect(out?.status).toBe("archived");
    expect(store._internalDeleteInstalledExtension).not.toHaveBeenCalled();
    expect(store._internalUpdateInstalledExtensionStatus).toHaveBeenCalledWith(
      "iext_anchor",
      "archived",
    );
    // Archive semantics: access-policy rows are PRESERVED on the tombstone path.
    expect(deleteExtensionPermissions).not.toHaveBeenCalled();
  });

  it("uninstall of an already-archived anchor row is idempotent (returns the row, no writes)", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(anchorRow("archived"));
    const out = await transitionExtensionLifecycle("iext_anchor", "uninstall", OPTS);
    expect(out?.status).toBe("archived");
    expect(store._internalDeleteInstalledExtension).not.toHaveBeenCalled();
    expect(store._internalUpdateInstalledExtensionStatus).not.toHaveBeenCalled();
  });

  it("uninstall of a NON-anchor row still hard-deletes (unchanged behavior)", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(orgRow("active"));
    const out = await transitionExtensionLifecycle("iext_org", "uninstall", OPTS);
    expect(out).toBeNull();
    expect(store._internalDeleteInstalledExtension).toHaveBeenCalledWith("iext_org");
  });

  it("force_delete of an anchor row hard-deletes (admin factory reset: next boot re-seeds live)", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(anchorRow("active"));
    const out = await transitionExtensionLifecycle("iext_anchor", "force_delete", OPTS);
    expect(out).toBeNull();
    expect(store._internalDeleteInstalledExtension).toHaveBeenCalledWith("iext_anchor");
  });

  it("a LOCKED anchor row still rejects uninstall (required-in-prod protection)", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(anchorRow("locked"));
    await expect(transitionExtensionLifecycle("iext_anchor", "uninstall", OPTS)).rejects.toMatchObject({
      code: "LOCKED_REJECTS_OP",
    });
  });
});

describe("lifecycle-correctness chain: uninstall and archive converge on 'skipped at boot'", () => {
  // The gate of record (behavioral acceptance for IOC-34/IOC-35): a hard
  // `uninstall` (anchor tombstoned, sibling rows deleted) and an `archive`
  // both leave the package's effective canonical status NON-live, which the
  // StaticBundleLoader's strict allow-list skips — and a package with NO rows
  // at all is equally skipped (absence is not in the aggregate map).
  it("post-uninstall row set aggregates to 'archived' (anchor tombstone) → not activatable", async () => {
    // Simulate the dispatcher's package-wide uninstall: org row deleted (null),
    // anchor row tombstoned (archived).
    vi.mocked(store.readInstalledExtensionById).mockResolvedValueOnce(orgRow("active"));
    const orgOut = await transitionExtensionLifecycle("iext_org", "uninstall", OPTS);
    vi.mocked(store.readInstalledExtensionById).mockResolvedValueOnce(anchorRow("active"));
    const anchorOut = await transitionExtensionLifecycle("iext_anchor", "uninstall", OPTS);

    const survivingRows = [orgOut, anchorOut].filter(
      (r): r is InstalledExtension => r !== null,
    );
    expect(survivingRows.map((r) => r.status)).toEqual(["archived"]);

    const effective = aggregateEffectiveStatusByPackageName(survivingRows);
    expect(effective.get(PKG)).toBe("archived"); // NOT "active" → the strict gate skips
  });

  it("post-archive row set aggregates identically — archive ≡ uninstall observably", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValueOnce(anchorRow("active"));
    const archived = await transitionExtensionLifecycle("iext_anchor", "archive", OPTS);
    const effective = aggregateEffectiveStatusByPackageName(
      [archived].filter((r): r is InstalledExtension => r !== null),
    );
    expect(effective.get(PKG)).toBe("archived");
  });

  it("no rows at all (factory reset / pre-anchor hard uninstall) → absent from the map", () => {
    const effective = aggregateEffectiveStatusByPackageName([]);
    expect(effective.has(PKG)).toBe(false); // absent ≠ "active" → the strict gate skips
  });

  it("a surviving live row keeps the package activatable (live-wins aggregate)", () => {
    const effective = aggregateEffectiveStatusByPackageName([
      anchorRow("archived"),
      orgRow("active"),
    ]);
    expect(effective.get(PKG)).toBe("active");
  });
});
