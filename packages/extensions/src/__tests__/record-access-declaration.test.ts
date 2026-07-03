// cinatra#951 — recordExtensionAccessDeclaration: the sanctioned canonical
// writer for the cached connector access declaration. Structural
// re-validation at the writer (a malformed declaration can never reach the
// row, no matter the caller), explicit-null clearing, and the not-found
// refusal. DB roundtrips mocked at the canonical-store boundary.

import { describe, expect, it, vi, beforeEach } from "vitest";

import type { InstalledExtension } from "../canonical-types";

vi.mock("server-only", () => ({}));

const readInstalledExtensionById = vi.fn();
const _internalUpdateInstalledExtensionMetadata = vi.fn();
vi.mock("../canonical-store", () => ({
  readInstalledExtensionById: (...a: unknown[]) => readInstalledExtensionById(...a),
  _internalInsertInstalledExtension: vi.fn(),
  _internalUpdateInstalledExtensionStatus: vi.fn(),
  _internalUpdateInstalledExtensionSource: vi.fn(),
  _internalUpdateInstalledExtensionMetadata: (...a: unknown[]) =>
    _internalUpdateInstalledExtensionMetadata(...a),
  _internalDeleteInstalledExtension: vi.fn(),
}));

import {
  LifecycleTransitionError,
  recordExtensionAccessDeclaration,
} from "../lifecycle-primitive";

const row: InstalledExtension = {
  id: "ext-1",
  packageName: "@cinatra-ai/github-connector",
  ownerLevel: "platform",
  ownerId: null,
  organizationId: null,
  kind: "connector",
  status: "active",
  source: {
    type: "verdaccio",
    registryUrl: "http://localhost:4873",
    packageName: "@cinatra-ai/github-connector",
    version: "1.0.0",
    integrity: "sha512-x",
  },
  requiredInProd: false,
  dependencies: [],
  manifestHash: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const DECLARATION = {
  formatVersion: 1,
  mode: "default",
  scope: "user",
  source: "declared",
} as const;

const opts = { actor: { source: "test" }, reason: "unit" };

beforeEach(() => {
  vi.clearAllMocks();
  readInstalledExtensionById.mockResolvedValue(row);
  _internalUpdateInstalledExtensionMetadata.mockImplementation(async (id, patch) => ({
    ...row,
    id,
    ...patch,
  }));
});

describe("recordExtensionAccessDeclaration (cinatra#951)", () => {
  it("persists a well-formed declaration via the metadata writer", async () => {
    await recordExtensionAccessDeclaration("ext-1", DECLARATION, opts);
    expect(_internalUpdateInstalledExtensionMetadata).toHaveBeenCalledWith("ext-1", {
      accessDeclaration: DECLARATION,
    });
  });

  it("explicit null CLEARS the cache", async () => {
    await recordExtensionAccessDeclaration("ext-1", null, opts);
    expect(_internalUpdateInstalledExtensionMetadata).toHaveBeenCalledWith("ext-1", {
      accessDeclaration: null,
    });
  });

  it("REFUSES a malformed declaration (INVALID_INPUT), never writing", async () => {
    const bad = [
      { formatVersion: 2, mode: "default", scope: "user", source: "declared" },
      { formatVersion: 1, mode: "required", scope: "user", source: "declared" },
      { formatVersion: 1, mode: "only", scope: "app", source: "declared" },
      { formatVersion: 1, mode: "only", scope: "admin", source: "declared", extra: 1 },
      "only:admin",
    ];
    for (const declaration of bad) {
      await expect(
        recordExtensionAccessDeclaration("ext-1", declaration as never, opts),
      ).rejects.toThrow(LifecycleTransitionError);
    }
    expect(_internalUpdateInstalledExtensionMetadata).not.toHaveBeenCalled();
  });

  it("REFUSES an unknown row (EXT_NOT_FOUND)", async () => {
    readInstalledExtensionById.mockResolvedValue(null);
    await expect(
      recordExtensionAccessDeclaration("ghost", DECLARATION, opts),
    ).rejects.toThrow(/not found/);
  });
});
