// The DISPATCHER hop of the write path (cinatra#2694 / S2 #2696).
//
// The install action resolves the target→ownership tuple (S1) and the dependency
// batch threads it per member; the LAST hop is here — `extensionRegistry.install`
// must write the canonical row AT that anchor and resolve the real-integrity
// pipeline against the SAME anchor, instead of re-deriving both from the actor's
// active organization.
//
// Pinned here:
//   1. a WORKSPACE-anchored install creates the row with the EXACT tuple
//      (owner_level='workspace', organization_id NULL, owner_id='__platform__')
//      and fires the pipeline at the org-NULL scope, from an actor whose active
//      org is org-1;
//   2. the SAME install from a DIFFERENT organization resolves the SAME single
//      row (the anchor, not the actor, is the row identity) — no second row;
//   3. NO threaded tuple → byte-identical to today (org-anchored row, pipeline
//      at the actor's org) — the regression fence;
//   4. rollback of a non-finalizing workspace-anchored install removes the row
//      it created (the org-NULL placeholder is rolled back like any other);
//   5. the actor-scoped gates are NOT re-anchored: the row anchor moves, the
//      actor's own scope keeps driving what it drove before.
//
// The canonical store + lifecycle primitive + activate hook are mocked (the same
// scaffolding as dispatcher-install-ordering.test.ts) so the test isolates the
// dispatch anchoring with no DB. The DB-LAYER assertion that this exact tuple is
// admitted, read back by identity and never widens an existing row lives in
// src/lib/__tests__/install-semantics-write-path.integration.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = {
  id: string;
  packageName: string;
  status: string;
  ownerLevel?: string;
  ownerId?: string | null;
  organizationId: string | null;
  source: { type: string; integrity?: string } | null;
};
let rows: Row[] = [];
const callOrder: string[] = [];

const installExtensionManifest = vi.fn(async (row: Row) => {
  callOrder.push(`createRow:${row.id}`);
  rows.push({ ...row });
  return row;
});
const transitionExtensionLifecycle = vi.fn(async () => null);
const _internalDeleteInstalledExtension = vi.fn(async (id: string) => {
  callOrder.push(`deleteRow:${id}`);
  rows = rows.filter((r) => r.id !== id);
});
const readInstalledExtensionById = vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null);
const readInstalledExtensionsByPackageName = vi.fn(async (pkg: string) =>
  rows.filter((r) => r.packageName === pkg),
);
const listInstalledExtensions = vi.fn(async (): Promise<unknown[]> => []);

const PLACEHOLDER_INTEGRITY = new Set(["", "dispatcher-install", "pending-resolution", "latest", "HEAD"]);

vi.mock("@cinatra-ai/agents", () => ({
  withInstallLock: async (_packageName: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...a: unknown[]) =>
    readInstalledExtensionsByPackageName(...(a as [string])),
  readInstalledExtensionById: (...a: unknown[]) => readInstalledExtensionById(...(a as [string])),
  _internalDeleteInstalledExtension: (...a: unknown[]) =>
    _internalDeleteInstalledExtension(...(a as [string])),
  listInstalledExtensions: (...a: unknown[]) => listInstalledExtensions(...(a as [])),
  readEffectiveStatusByPackageNames: vi.fn(async () => new Map()),
}));
vi.mock("../lifecycle-primitive", () => ({
  installExtensionManifest: (...a: unknown[]) => installExtensionManifest(...(a as [Row])),
  transitionExtensionLifecycle: (...a: unknown[]) => transitionExtensionLifecycle(...(a as [])),
  deleteNonFinalizedCanonicalRow: async (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    const integrity = typeof row.source?.integrity === "string" ? row.source.integrity : null;
    const nonFinalized =
      (row.status === "active" || row.status === "locked") &&
      integrity !== null &&
      PLACEHOLDER_INTEGRITY.has(integrity);
    if (!nonFinalized) {
      throw new Error(`deleteNonFinalizedCanonicalRow refused — '${id}' is not a non-finalized placeholder`);
    }
    await _internalDeleteInstalledExtension(id);
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
import { makeHandler, makeRef } from "./__mocks__/extension-handler";
import type { Actor } from "../index";
import { WORKSPACE_ANCHOR_ROW_OWNERSHIP } from "../install-access-target";
import { PLATFORM_OWNER_SENTINEL } from "../canonical-types";

const orgActor = (orgId: string): Actor => ({
  actorType: "system",
  userId: "u1",
  source: "worker",
  orgId,
  orgRole: "org_admin",
});

beforeEach(() => {
  extensionRegistry._resetForTesting();
  rows = [];
  callOrder.length = 0;
  vi.clearAllMocks();
  listInstalledExtensions.mockResolvedValue([]);
});

describe("cinatra#2696 — the dispatcher writes the row at the THREADED anchor", () => {
  it("a workspace-anchored artifact install creates the row with the EXACT workspace tuple", async () => {
    extensionRegistry.register(makeHandler("artifact"));
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: false });

    await extensionRegistry.install("artifact", makeRef("@v/ws-artifact"), orgActor("org-1"), {
      rowOwnership: WORKSPACE_ANCHOR_ROW_OWNERSHIP,
    });

    expect(installExtensionManifest).toHaveBeenCalledTimes(1);
    const written = installExtensionManifest.mock.calls[0]![0];
    expect({
      ownerLevel: written.ownerLevel,
      ownerId: written.ownerId,
      organizationId: written.organizationId,
    }).toEqual({
      ownerLevel: "workspace",
      ownerId: PLATFORM_OWNER_SENTINEL,
      organizationId: null,
    });
    // The pipeline resolves the SAME row — org-NULL, not org-1 — and since
    // cinatra#2698 it is handed the anchor TIER as well: at the org-NULL scope
    // a product-installed workspace row and a bundled platform anchor share an
    // `organization_id`, so the org alone no longer identifies the row.
    expect(fireExtensionActivate).toHaveBeenCalledWith("@v/ws-artifact", null, "1.0.0", {
      ownerLevel: "workspace",
    });
  });

  it("the workspace row is resolved from ANOTHER organization's actor — one row, app-wide", async () => {
    extensionRegistry.register(makeHandler("artifact"));
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: false });

    await extensionRegistry.install("artifact", makeRef("@v/ws-artifact"), orgActor("org-1"), {
      rowOwnership: WORKSPACE_ANCHOR_ROW_OWNERSHIP,
    });
    // Mark it finalized (real integrity) so the second install is the
    // "already installed" short-circuit rather than a placeholder retry.
    rows[0]!.source = { type: "verdaccio", integrity: "sha512-real" };

    await extensionRegistry.install("artifact", makeRef("@v/ws-artifact"), orgActor("org-2"), {
      rowOwnership: WORKSPACE_ANCHOR_ROW_OWNERSHIP,
    });

    // No SECOND row was created for org-2: the anchor is the row identity.
    expect(installExtensionManifest).toHaveBeenCalledTimes(1);
    expect(rows.filter((r) => r.packageName === "@v/ws-artifact")).toHaveLength(1);
  });

  it("REGRESSION: with NO threaded tuple the row is org-anchored exactly as before", async () => {
    extensionRegistry.register(makeHandler("artifact"));
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: false });

    await extensionRegistry.install("artifact", makeRef("@v/org-artifact"), orgActor("org-1"));

    const written = installExtensionManifest.mock.calls[0]![0];
    expect({
      ownerLevel: written.ownerLevel,
      ownerId: written.ownerId,
      organizationId: written.organizationId,
    }).toEqual({
      ownerLevel: "organization",
      ownerId: "org-1",
      organizationId: "org-1",
    });
    expect(fireExtensionActivate).toHaveBeenCalledWith("@v/org-artifact", "org-1", "1.0.0");
  });

  it("REGRESSION: an actor with NO active org still writes the platform anchor", async () => {
    extensionRegistry.register(makeHandler("artifact"));
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: false });

    await extensionRegistry.install("artifact", makeRef("@v/plat-artifact"), {
      actorType: "system",
      userId: "u1",
      source: "worker",
    });

    const written = installExtensionManifest.mock.calls[0]![0];
    expect({
      ownerLevel: written.ownerLevel,
      ownerId: written.ownerId,
      organizationId: written.organizationId,
    }).toEqual({ ownerLevel: "platform", ownerId: null, organizationId: null });
  });

  it("a workspace-anchored install whose pipeline does NOT finalize rolls the org-NULL row back", async () => {
    extensionRegistry.register(makeHandler("artifact"));
    fireExtensionActivate.mockResolvedValue({ finalized: false, activated: false, reason: "anchor-refused" });

    await expect(
      extensionRegistry.install("artifact", makeRef("@v/ws-broken"), orgActor("org-1"), {
        rowOwnership: WORKSPACE_ANCHOR_ROW_OWNERSHIP,
      }),
    ).rejects.toThrow(/did not finalize/);

    expect(rows.filter((r) => r.packageName === "@v/ws-broken")).toHaveLength(0);
    expect(_internalDeleteInstalledExtension).toHaveBeenCalledTimes(1);
  });

  it("an EXISTING org-anchored row for the same package is NOT touched by a workspace-anchored install", async () => {
    rows = [
      {
        id: "iext_org_pre",
        packageName: "@v/both-artifact",
        status: "active",
        ownerLevel: "organization",
        ownerId: "org-1",
        organizationId: "org-1",
        source: { type: "verdaccio", integrity: "sha512-real" },
      },
    ];
    extensionRegistry.register(makeHandler("artifact"));
    fireExtensionActivate.mockResolvedValue({ finalized: true, activated: false });

    await extensionRegistry.install("artifact", makeRef("@v/both-artifact"), orgActor("org-1"), {
      rowOwnership: WORKSPACE_ANCHOR_ROW_OWNERSHIP,
    });

    // A NEW row at the workspace anchor; the pre-existing org row is untouched.
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "iext_org_pre")).toEqual({
      id: "iext_org_pre",
      packageName: "@v/both-artifact",
      status: "active",
      ownerLevel: "organization",
      ownerId: "org-1",
      organizationId: "org-1",
      source: { type: "verdaccio", integrity: "sha512-real" },
    });
    expect(transitionExtensionLifecycle).not.toHaveBeenCalled();
  });
});
