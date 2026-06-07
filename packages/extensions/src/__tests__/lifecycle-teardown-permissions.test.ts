// Lifecycle teardown cleans the polymorphic access rows
// for installed-extension-anchored kinds (connector/artifact/workflow) on
// hard-delete, preserves them on archive, and never touches agent/skill here
// (those are keyed by template/package id and cleaned in their own paths).

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InstalledExtension } from "../canonical-types";

vi.mock("server-only", () => ({}));

const { readByIdMock, deletePermsMock } = vi.hoisted(() => ({
  readByIdMock: vi.fn(),
  deletePermsMock: vi.fn(async () => undefined),
}));

vi.mock("../canonical-store", () => ({
  readInstalledExtensionById: readByIdMock,
  _internalDeleteInstalledExtension: vi.fn(async () => undefined),
  _internalInsertInstalledExtension: vi.fn(),
  _internalUpdateInstalledExtensionStatus: vi.fn(async (id: string, status: string) => ({ id, status })),
  _internalUpdateInstalledExtensionSource: vi.fn(),
}));
vi.mock("../permissions-store", () => ({
  deleteExtensionPermissions: deletePermsMock,
}));

import { transitionExtensionLifecycle } from "../lifecycle-primitive";

function row(kind: InstalledExtension["kind"]): InstalledExtension {
  return {
    id: "ext-1",
    packageName: "@cinatra-ai/x",
    ownerLevel: "organization",
    ownerId: "org-1",
    organizationId: "org-1",
    kind,
    status: "active",
    source: { type: "local", path: "x", resolvedCommitOrTreeHash: "h" },
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date("2026-05-21T00:00:00Z"),
    updatedAt: new Date("2026-05-21T00:00:00Z"),
  };
}

const opts = {
  actor: { source: "cli" as const, roles: ["platform_admin"] },
  reason: "teardown test",
};

describe("lifecycle teardown — polymorphic permission cleanup", () => {
  beforeEach(() => {
    readByIdMock.mockReset();
    deletePermsMock.mockClear();
  });

  for (const kind of ["connector", "artifact", "workflow"] as const) {
    it(`uninstall cleans permissions for kind=${kind}`, async () => {
      readByIdMock.mockResolvedValue(row(kind));
      await transitionExtensionLifecycle("ext-1", "uninstall", opts);
      expect(deletePermsMock).toHaveBeenCalledWith(kind, "ext-1");
    });
  }

  for (const kind of ["agent", "skill"] as const) {
    it(`uninstall does NOT clean permissions here for kind=${kind}`, async () => {
      readByIdMock.mockResolvedValue(row(kind));
      await transitionExtensionLifecycle("ext-1", "uninstall", opts);
      expect(deletePermsMock).not.toHaveBeenCalled();
    });
  }

  it("archive PRESERVES permissions (no cleanup) for kind=connector", async () => {
    readByIdMock.mockResolvedValue(row("connector"));
    await transitionExtensionLifecycle("ext-1", "archive", opts);
    expect(deletePermsMock).not.toHaveBeenCalled();
  });
});
