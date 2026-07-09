// admin-parity P2: the per-kind resolveOwnerContext hook. Pins that the
// installed-extension-anchored kinds (connector / artifact / workflow) resolve
// the canonical installed_extension owner row, that a kind-mismatched or
// missing row fails to NULL (→ the caller falls back to the legacy gate), and
// that a connection resolves its owner-bound (user-level) org-anchored context.

import { describe, it, expect, vi, beforeEach } from "vitest";

const readInstalledExtensionById = vi.fn();
vi.mock("../canonical-store", () => ({
  readInstalledExtensionById: (...a: unknown[]) => readInstalledExtensionById(...a),
}));

const readNangoConnectionById = vi.fn();
vi.mock("../connection-identity-store", () => ({
  readNangoConnectionById: (...a: unknown[]) => readNangoConnectionById(...a),
}));

import {
  getExtensionKindHooks,
  __resetExtensionKindHooksCacheForTesting,
} from "../permissions-kind-hooks";

beforeEach(() => {
  vi.clearAllMocks();
  __resetExtensionKindHooksCacheForTesting();
});

async function ownerFor(kind: Parameters<typeof getExtensionKindHooks>[0], id: string) {
  const hooks = await getExtensionKindHooks(kind);
  expect(hooks.resolveOwnerContext).toBeTypeOf("function");
  return hooks.resolveOwnerContext!(id);
}

describe("resolveOwnerContext — installed-extension-anchored kinds", () => {
  it("connector/artifact/workflow return the canonical owner row for a matching kind", async () => {
    for (const kind of ["connector", "artifact", "workflow"] as const) {
      readInstalledExtensionById.mockResolvedValue({
        id: "ie-1",
        kind,
        ownerLevel: "organization",
        ownerId: "org-9",
        organizationId: "org-9",
      });
      expect(await ownerFor(kind, "ie-1")).toEqual({
        ownerLevel: "organization",
        ownerId: "org-9",
        organizationId: "org-9",
      });
    }
  });

  it("preserves a user-owned org-anchored owner context (post-M1 backfill)", async () => {
    readInstalledExtensionById.mockResolvedValue({
      id: "ie-2",
      kind: "artifact",
      ownerLevel: "user",
      ownerId: "user-7",
      organizationId: "org-3",
    });
    expect(await ownerFor("artifact", "ie-2")).toEqual({
      ownerLevel: "user",
      ownerId: "user-7",
      organizationId: "org-3",
    });
  });

  it("fails to NULL on a kind mismatch (a connector resolver over an artifact row)", async () => {
    readInstalledExtensionById.mockResolvedValue({
      id: "ie-3",
      kind: "artifact",
      ownerLevel: "organization",
      ownerId: "org-9",
      organizationId: "org-9",
    });
    expect(await ownerFor("connector", "ie-3")).toBeNull();
  });

  it("fails to NULL on a missing row", async () => {
    readInstalledExtensionById.mockResolvedValue(null);
    expect(await ownerFor("workflow", "missing")).toBeNull();
  });
});

describe("resolveOwnerContext — connection", () => {
  it("resolves the owner-bound (user-level) org-anchored context", async () => {
    readNangoConnectionById.mockResolvedValue({
      id: "conn-1",
      organizationId: "org-5",
      ownerUserId: "user-owner",
      connectorPackageId: "@cinatra-ai/openai-connector",
      connectorKey: "openai",
      connectionId: "c1",
      createdAt: new Date(),
      deletedAt: null,
    });
    expect(await ownerFor("connection", "conn-1")).toEqual({
      ownerLevel: "user",
      ownerId: "user-owner",
      organizationId: "org-5",
    });
  });

  it("carries a NULL org anchor through (an org-less connection yields no admin standing downstream)", async () => {
    readNangoConnectionById.mockResolvedValue({
      id: "conn-2",
      organizationId: null,
      ownerUserId: "user-owner",
      connectorPackageId: "@cinatra-ai/openai-connector",
      connectorKey: "openai",
      connectionId: "c2",
      createdAt: new Date(),
      deletedAt: null,
    });
    expect(await ownerFor("connection", "conn-2")).toEqual({
      ownerLevel: "user",
      ownerId: "user-owner",
      organizationId: null,
    });
  });

  it("fails to NULL on a missing identity row", async () => {
    readNangoConnectionById.mockResolvedValue(null);
    expect(await ownerFor("connection", "missing")).toBeNull();
  });
});
