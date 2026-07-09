// Save-seam contract tests (cinatra#952 W2, step A2): the foreign-row
// HARD-FAIL (global non-org-qualified unique index), seed idempotency (a
// reconnect never resets a widened policy), scope-aware seeding, the
// key→package map's lockstep with the W1 backfill map, and the revocation
// helper's identity-FIRST ordering.

import { describe, it, expect, vi, beforeEach } from "vitest";

const insertNangoConnection = vi.fn();
const softDeleteNangoConnection = vi.fn(async (_id: string) => {});
const readNangoConnectionByNaturalKey = vi.fn();
vi.mock("@cinatra-ai/extensions/connection-identity-store", () => ({
  insertNangoConnection: (...a: unknown[]) => insertNangoConnection(...a),
  softDeleteNangoConnection: (id: string) => softDeleteNangoConnection(id),
  readNangoConnectionByNaturalKey: (...a: unknown[]) => readNangoConnectionByNaturalKey(...a),
}));

// Multi-scope W1: visibility fields are non-empty token arrays. This mirrors
// what `defaultAccessPolicyForKind` returns (the seam forwards it unchanged).
const OWNER_POLICY = {
  runListVisibility: ["owner"],
  runDataVisibility: ["owner"],
  runExecuteVisibility: ["owner"],
  allowRunSharing: false,
};
vi.mock("@cinatra-ai/extensions/install-access-contract", () => ({
  defaultAccessPolicyForKind: () => OWNER_POLICY,
}));

const seedExtensionAccessPolicyIfAbsent = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@cinatra-ai/extensions/permissions-store", () => ({
  seedExtensionAccessPolicyIfAbsent: (...a: unknown[]) => seedExtensionAccessPolicyIfAbsent(...a),
}));

const deleteNangoConnection = vi.fn(async (..._a: unknown[]) => {});
const removeNangoConnectionRecord = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/lib/nango-system", () => ({
  deleteNangoConnection: (...a: unknown[]) => deleteNangoConnection(...a),
  removeNangoConnectionRecord: (...a: unknown[]) => removeNangoConnectionRecord(...a),
}));

import {
  registerSavedConnectionIdentity,
  revokeConnection,
  ConnectionIdentityConflictError,
  HOST_CONNECTOR_KEY_TO_PACKAGE,
} from "@/lib/connection-identity-seam";
import { CONNECTOR_KEY_TO_PACKAGE } from "../../../migrations/core/core__0014_nango-connection-identity-backfill.mjs";

const baseRow = {
  id: "conn-uuid",
  organizationId: "org-1",
  connectorPackageId: "@cinatra-ai/github-connector",
  connectorKey: "github",
  connectionId: "c-1",
  ownerUserId: "user-1",
  createdAt: new Date(),
  deletedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  insertNangoConnection.mockResolvedValue(baseRow);
  seedExtensionAccessPolicyIfAbsent.mockResolvedValue(true);
});

describe("HOST_CONNECTOR_KEY_TO_PACKAGE lockstep", () => {
  it("is a strict superset of the W1 backfill map (plus the externalMcp sentinel)", () => {
    for (const [key, pkg] of Object.entries(CONNECTOR_KEY_TO_PACKAGE)) {
      expect(HOST_CONNECTOR_KEY_TO_PACKAGE[key]).toBe(pkg);
    }
    expect(HOST_CONNECTOR_KEY_TO_PACKAGE.externalMcp).toBe("@cinatra-ai/host:external-mcp");
  });
});

describe("registerSavedConnectionIdentity", () => {
  it("inserts + seeds the OWNER default via the ATOMIC if-absent seeder", async () => {
    await registerSavedConnectionIdentity({
      connectorKey: "github",
      connectionId: "c-1",
      ownerUserId: "user-1",
      organizationId: "org-1",
    });
    // cinatra#953 W3: the seed carries the seededDefault provenance marker so
    // the share surface can distinguish the untouched seed from an explicit
    // owner save (the zod parse on every explicit save strips it).
    expect(seedExtensionAccessPolicyIfAbsent).toHaveBeenCalledWith(
      "connection",
      "conn-uuid",
      { ...OWNER_POLICY, seededDefault: true },
      "user-1",
    );
  });

  it("seeds workspace visibility for org-admin APP-scope saves", async () => {
    await registerSavedConnectionIdentity({
      connectorKey: "github",
      connectionId: "c-1",
      ownerUserId: "user-1",
      organizationId: "org-1",
      seed: "workspace",
    });
    expect(seedExtensionAccessPolicyIfAbsent).toHaveBeenCalledWith(
      "connection",
      "conn-uuid",
      expect.objectContaining({ runDataVisibility: ["workspace"], seededDefault: true }),
      "user-1",
    );
  });

  it("force-seeds OWNER for a null-org identity row even when workspace was requested", async () => {
    insertNangoConnection.mockResolvedValue({ ...baseRow, organizationId: null });
    await registerSavedConnectionIdentity({
      connectorKey: "github",
      connectionId: "c-1",
      ownerUserId: "user-1",
      organizationId: null,
      seed: "workspace",
    });
    expect(seedExtensionAccessPolicyIfAbsent).toHaveBeenCalledWith(
      "connection",
      "conn-uuid",
      { ...OWNER_POLICY, seededDefault: true },
      "user-1",
    );
  });

  it("NEVER resets a widened policy on reconnect (atomic if-absent seed, round-2 finding 4)", async () => {
    // An existing (possibly widened) policy row: the atomic seeder's ON
    // CONFLICT DO NOTHING reports false and the reconnect succeeds without
    // any overwriting write path being invoked.
    seedExtensionAccessPolicyIfAbsent.mockResolvedValue(false);
    await expect(
      registerSavedConnectionIdentity({
        connectorKey: "github",
        connectionId: "c-1",
        ownerUserId: "user-1",
        organizationId: "org-1",
      }),
    ).resolves.toMatchObject({ id: "conn-uuid" });
    expect(seedExtensionAccessPolicyIfAbsent).toHaveBeenCalledTimes(1);
  });

  it("HARD-FAILS when the existing live row belongs to a different user", async () => {
    insertNangoConnection.mockResolvedValue({ ...baseRow, ownerUserId: "someone-else" });
    await expect(
      registerSavedConnectionIdentity({
        connectorKey: "github",
        connectionId: "c-1",
        ownerUserId: "user-1",
        organizationId: "org-1",
      }),
    ).rejects.toBeInstanceOf(ConnectionIdentityConflictError);
    expect(seedExtensionAccessPolicyIfAbsent).not.toHaveBeenCalled(); // never seeds the foreign row
  });

  it("HARD-FAILS on a non-null org mismatch; tolerates a null-org legacy row for its owner", async () => {
    insertNangoConnection.mockResolvedValue({ ...baseRow, organizationId: "org-OTHER" });
    await expect(
      registerSavedConnectionIdentity({
        connectorKey: "github",
        connectionId: "c-1",
        ownerUserId: "user-1",
        organizationId: "org-1",
      }),
    ).rejects.toBeInstanceOf(ConnectionIdentityConflictError);

    insertNangoConnection.mockResolvedValue({ ...baseRow, organizationId: null });
    await expect(
      registerSavedConnectionIdentity({
        connectorKey: "github",
        connectionId: "c-1",
        ownerUserId: "user-1",
        organizationId: "org-1",
      }),
    ).resolves.toMatchObject({ organizationId: null });
  });

  it("rejects unknown connector keys (fail-closed)", async () => {
    await expect(
      registerSavedConnectionIdentity({
        connectorKey: "not-a-connector",
        connectionId: "c-1",
        ownerUserId: "user-1",
        organizationId: "org-1",
      }),
    ).rejects.toBeInstanceOf(ConnectionIdentityConflictError);
    expect(insertNangoConnection).not.toHaveBeenCalled();
  });
});

describe("revokeConnection ordering (revocation-next-use)", () => {
  it("soft-deletes the identity row BEFORE the upstream token + blob pointer", async () => {
    const order: string[] = [];
    readNangoConnectionByNaturalKey.mockResolvedValue(baseRow);
    softDeleteNangoConnection.mockImplementation(async () => {
      order.push("identity");
    });
    deleteNangoConnection.mockImplementation(async () => {
      order.push("upstream");
    });
    removeNangoConnectionRecord.mockImplementation(async () => {
      order.push("blob");
    });
    await revokeConnection({
      connectorKey: "github",
      connectionId: "c-1",
      providerConfigKey: "cinatra-github",
    });
    expect(order).toEqual(["identity", "upstream", "blob"]);
  });

  it("skips the blob removal for record-less connections (external-MCP)", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(baseRow);
    await revokeConnection({
      connectorKey: "externalMcp",
      connectionId: "c-x",
      providerConfigKey: "cinatra-external-mcp",
      hasBlobRecord: false,
    });
    expect(removeNangoConnectionRecord).not.toHaveBeenCalled();
    expect(deleteNangoConnection).toHaveBeenCalled();
  });
});
