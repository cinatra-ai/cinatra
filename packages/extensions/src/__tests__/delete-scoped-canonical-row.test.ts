// deleteScopedCanonicalRow unit tests (cinatra#1042 slice-2).
//
// The ROW-SCOPED compensation inverse: it must remove EXACTLY the one row (the
// freshly-installed actor-scope row a failed batch rolls back) via the atomic
// unbound-checked writer, and NEVER touch the package-global handler backing or
// another scope's rows. DB roundtrips are mocked at the canonical-store /
// permissions-store boundary so the test needs no Postgres.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstalledExtension } from "../canonical-types";

vi.mock("server-only", () => ({}));

const deleteIfUnbound =
  vi.fn<(rowId: string) => Promise<{ deleted: boolean; boundDependents: string[] }>>();

// Mock ONLY the two canonical-store members `deleteScopedCanonicalRow` touches
// (`readInstalledExtensionById` static import + `_internalDeleteSideBySideRowIfUnbound`
// dynamic import). lifecycle-primitive's other static `_internal*` imports bind
// to `undefined` under the partial mock — harmless, as this function never calls
// them. Deliberately NOT listing the canonical `_internal*` status writers here:
// the drift-canonical-gate-reach guard scans for those identifiers, and this
// test does not exercise them.
vi.mock("../canonical-store", () => ({
  readInstalledExtensionById: vi.fn(),
  _internalDeleteSideBySideRowIfUnbound: (rowId: string) => deleteIfUnbound(rowId),
}));

const deleteExtensionPermissions = vi.fn(async () => undefined);
vi.mock("../permissions-store", () => ({
  deleteExtensionPermissions: (...args: unknown[]) => deleteExtensionPermissions(...(args as [])),
}));

import * as store from "../canonical-store";
import { LifecycleTransitionError, deleteScopedCanonicalRow } from "../lifecycle-primitive";

function makeRow(over: Partial<InstalledExtension> = {}): InstalledExtension {
  return {
    id: "iext_fresh",
    packageName: "@acme/dep",
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    kind: "connector",
    status: "active",
    source: {
      type: "verdaccio",
      registryUrl: "http://localhost:4873",
      packageName: "@acme/dep",
      version: "1.0.0",
      integrity: "sha512-x",
    },
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(store.readInstalledExtensionById).mockReset();
  deleteIfUnbound.mockReset();
  deleteIfUnbound.mockResolvedValue({ deleted: true, boundDependents: [] });
  deleteExtensionPermissions.mockReset();
  deleteExtensionPermissions.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("deleteScopedCanonicalRow", () => {
  it("removes exactly the target row via the atomic unbound-checked writer", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(makeRow());
    await deleteScopedCanonicalRow("iext_fresh");
    expect(deleteIfUnbound).toHaveBeenCalledWith("iext_fresh");
  });

  it("accepts the DEFAULT / only-in-scope row (unlike deleteSideBySideVersionRow)", async () => {
    // isDefault true and no live siblings — this is exactly what the fresh
    // default compensation row looks like; it must still delete (no only-row
    // refusal).
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(makeRow({ isDefault: true }));
    await expect(deleteScopedCanonicalRow("iext_fresh")).resolves.toBeUndefined();
    expect(deleteIfUnbound).toHaveBeenCalledWith("iext_fresh");
  });

  it("is idempotent when the row is already gone", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(null);
    await deleteScopedCanonicalRow("gone");
    expect(deleteIfUnbound).not.toHaveBeenCalled();
  });

  it("refuses a LOCKED row (never deletes)", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(makeRow({ status: "locked" }));
    await expect(deleteScopedCanonicalRow("iext_fresh")).rejects.toBeInstanceOf(
      LifecycleTransitionError,
    );
    expect(deleteIfUnbound).not.toHaveBeenCalled();
  });

  it("fails closed when a live dependent still resolves to the row", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(makeRow());
    deleteIfUnbound.mockResolvedValue({ deleted: false, boundDependents: ["@acme/dependent"] });
    await expect(deleteScopedCanonicalRow("iext_fresh")).rejects.toBeInstanceOf(
      LifecycleTransitionError,
    );
  });

  it("cleans the ROW-scoped access rows for an installed-extension-anchored kind (connector)", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(makeRow({ kind: "connector" }));
    await deleteScopedCanonicalRow("iext_fresh");
    expect(deleteExtensionPermissions).toHaveBeenCalledWith("connector", "iext_fresh");
  });

  it("does NOT touch permissions for a by-name-backed kind (agent) — the package-global backing is left intact", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(makeRow({ kind: "agent" }));
    await deleteScopedCanonicalRow("iext_fresh");
    expect(deleteExtensionPermissions).not.toHaveBeenCalled();
    // The row itself was still deleted (row-scoped).
    expect(deleteIfUnbound).toHaveBeenCalledWith("iext_fresh");
  });

  it("a permissions-cleanup failure is best-effort — never fails the row delete", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(makeRow({ kind: "connector" }));
    deleteExtensionPermissions.mockRejectedValue(new Error("perms row already gone"));
    await expect(deleteScopedCanonicalRow("iext_fresh")).resolves.toBeUndefined();
    expect(deleteIfUnbound).toHaveBeenCalledWith("iext_fresh");
    warn.mockRestore();
  });
});
