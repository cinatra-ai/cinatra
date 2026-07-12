// cinatra#1407 defect 1 — direct coverage for the SANCTIONED external-MCP
// API-key credential-path helpers in external-mcp-registry.ts (the
// mcp-server-write-actions test mocks these; this exercises the REAL bodies):
//   - importExternalMcpApiKeyConnection: Nango import + readback-verify + the
//     `externalMcp` identity seam; fail-closed when Nango is unconfigured; a
//     GENERIC error on any vault / readback failure (never the key value); the
//     identity is registered so the use-gate can later mint the bearer.
//   - revokeExternalMcpApiKeyConnection: identity soft-delete FIRST, then the
//     upstream token; never throws; no-op on an empty id.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

// external-mcp-registry.ts pulls the postgres/url/mcp-base layers at MODULE LOAD;
// stub them so the import resolves (the helpers under test never touch them).
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: () => [{ rows: [], rowCount: 0 }],
}));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  ensurePostgresSchema: () => {},
  postgresSchema: "public",
}));
vi.mock("@/lib/url-policy", () => ({ isPrivateUrl: () => false }));
vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getMcpPublicBaseUrl: () => ({ publicBaseUrl: null }),
}));

const ensureNangoIntegration = vi.fn();
const importNangoConnection = vi.fn();
const deleteNangoConnection = vi.fn();
const getNangoCredentials = vi.fn();
const isNangoConfigured = vi.fn();
vi.mock("@/lib/nango-system", () => ({
  ensureNangoIntegration: (...a: unknown[]) => ensureNangoIntegration(...a),
  importNangoConnection: (...a: unknown[]) => importNangoConnection(...a),
  deleteNangoConnection: (...a: unknown[]) => deleteNangoConnection(...a),
  getNangoCredentials: (...a: unknown[]) => getNangoCredentials(...a),
  isNangoConfigured: (...a: unknown[]) => isNangoConfigured(...a),
}));

const registerSavedConnectionIdentity = vi.fn();
vi.mock("@/lib/connection-identity-seam", () => ({
  registerSavedConnectionIdentity: (...a: unknown[]) => registerSavedConnectionIdentity(...a),
}));

const readNangoConnectionByNaturalKey = vi.fn();
const softDeleteNangoConnection = vi.fn();
vi.mock("@cinatra-ai/extensions/connection-identity-store", () => ({
  readNangoConnectionByNaturalKey: (...a: unknown[]) => readNangoConnectionByNaturalKey(...a),
  softDeleteNangoConnection: (...a: unknown[]) => softDeleteNangoConnection(...a),
}));

// Use-gate + trusted-context mocks for the bearer-resolution subject-threading
// tests (cinatra#1407 — a user row mints only for its owner).
const enforceConnectionUse = vi.fn();
class ConnectionUseDeniedError extends Error {}
vi.mock("@/lib/connection-use-gate", () => ({
  enforceConnectionUse: (...a: unknown[]) => enforceConnectionUse(...a),
  ConnectionUseDeniedError,
}));
vi.mock("@/lib/authz/actor-context", () => ({ POLICY_VERSION: 1 }));
const resolveExtensionActorSummary = vi.fn();
vi.mock("@/lib/extension-host-actor", () => ({
  resolveExtensionActorSummary: (...a: unknown[]) => resolveExtensionActorSummary(...a),
}));

import {
  importExternalMcpApiKeyConnection,
  revokeExternalMcpApiKeyConnection,
  resolveExternalMcpServerBearer,
  EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY,
  type ExternalMcpServerRecord,
} from "@/lib/external-mcp-registry";

const KEY = "sk-external-mcp-super-secret";
const CONN = "external-mcp-abc123";
const IDENTITY = { ownerUserId: "u1", organizationId: null, seed: "owner" as const };

beforeEach(() => {
  vi.clearAllMocks();
  isNangoConfigured.mockReturnValue(true);
  ensureNangoIntegration.mockResolvedValue(undefined);
  importNangoConnection.mockResolvedValue(undefined);
  getNangoCredentials.mockResolvedValue({ apiKey: KEY });
  registerSavedConnectionIdentity.mockResolvedValue({ id: "id-row" });
  readNangoConnectionByNaturalKey.mockResolvedValue({ id: "id-row", ownerUserId: "owner1", organizationId: null });
  softDeleteNangoConnection.mockResolvedValue(undefined);
  deleteNangoConnection.mockResolvedValue(undefined);
  enforceConnectionUse.mockResolvedValue(undefined);
  resolveExtensionActorSummary.mockResolvedValue({ userId: "owner1", organizationId: null, orgRole: null });
});

function bearerRow(scope: string): ExternalMcpServerRecord {
  return {
    id: "r1",
    label: "L",
    serverUrl: "https://mcp.example.com/sse",
    nangoConnectionId: "external-mcp-x",
    scope: scope as ExternalMcpServerRecord["scope"],
    orgId: null,
    userId: scope === "user" ? "owner1" : null,
    enabled: true,
    allowedTools: null,
    allowedCatalogTools: null,
    createdAt: "",
    updatedAt: "",
  };
}

describe("resolveExternalMcpServerBearer — user-scoped rows mint ONLY for their owner (cinatra#1407)", () => {
  it("threads the current human subject for a USER row so the owner's own call mints (OWN short-circuit)", async () => {
    resolveExtensionActorSummary.mockResolvedValue({ userId: "owner1", organizationId: null, orgRole: null });
    const bearer = await resolveExternalMcpServerBearer(bearerRow("user"));
    expect(bearer).toBe(KEY);
    expect(enforceConnectionUse).toHaveBeenCalledTimes(1);
    expect(enforceConnectionUse.mock.calls[0][0]).toMatchObject({ subjectUserId: "owner1" });
  });

  it("a GLOBAL row keeps subjectUserId undefined (org/workspace grant path, unchanged) and never consults the subject resolver", async () => {
    const bearer = await resolveExternalMcpServerBearer(bearerRow("global"));
    expect(bearer).toBe(KEY);
    expect(enforceConnectionUse.mock.calls[0][0].subjectUserId).toBeUndefined();
    expect(resolveExtensionActorSummary).not.toHaveBeenCalled();
  });

  it("a USER row with NO trusted subject falls through (subjectUserId undefined → owner grant denies)", async () => {
    resolveExtensionActorSummary.mockResolvedValue(null);
    await resolveExternalMcpServerBearer(bearerRow("user"));
    expect(enforceConnectionUse.mock.calls[0][0].subjectUserId).toBeUndefined();
  });

  it("returns null (no bearer) when the use-gate DENIES", async () => {
    enforceConnectionUse.mockRejectedValue(new ConnectionUseDeniedError("denied"));
    const bearer = await resolveExternalMcpServerBearer(bearerRow("user"));
    expect(bearer).toBeNull();
  });
});

describe("importExternalMcpApiKeyConnection", () => {
  it("imports the key under the shared external-MCP provider, readback-verifies, and seeds the identity", async () => {
    await importExternalMcpApiKeyConnection(CONN, KEY, IDENTITY);
    expect(importNangoConnection).toHaveBeenCalledWith({
      providerConfigKey: EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY,
      connectionId: CONN,
      credentials: { type: "API_KEY", apiKey: KEY },
    });
    expect(getNangoCredentials).toHaveBeenCalledWith(
      EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY,
      CONN,
      { forceRefresh: true },
    );
    // Without this identity `gateExternalMcpConnectionUse` fails closed → no bearer.
    expect(registerSavedConnectionIdentity).toHaveBeenCalledWith({
      connectorKey: "externalMcp",
      connectionId: CONN,
      ownerUserId: "u1",
      organizationId: null,
      seed: "owner",
    });
  });

  it("FAIL-CLOSED when Nango is not configured (never imports, never registers an identity)", async () => {
    isNangoConfigured.mockReturnValue(false);
    await expect(importExternalMcpApiKeyConnection(CONN, KEY, IDENTITY)).rejects.toThrow(/not configured/i);
    expect(importNangoConnection).not.toHaveBeenCalled();
    expect(registerSavedConnectionIdentity).not.toHaveBeenCalled();
  });

  it("throws a GENERIC readback-mismatch error carrying NO key value, and skips the identity", async () => {
    getNangoCredentials.mockResolvedValue({ apiKey: "STORED-SOMETHING-ELSE" });
    const err = await importExternalMcpApiKeyConnection(CONN, KEY, IDENTITY).catch((e) => e);
    expect(String((err as Error)?.message)).toMatch(/readback mismatch/i);
    expect(String((err as Error)?.message)).not.toContain(KEY);
    expect(registerSavedConnectionIdentity).not.toHaveBeenCalled();
  });

  it("maps a vault failure to a GENERIC error that never leaks the key", async () => {
    importNangoConnection.mockRejectedValue(new Error(`nango blew up and echoed ${KEY}`));
    const err = await importExternalMcpApiKeyConnection(CONN, KEY, IDENTITY).catch((e) => e);
    expect(String((err as Error)?.message)).toMatch(/could not store the api key/i);
    expect(String((err as Error)?.message)).not.toContain(KEY);
    expect(registerSavedConnectionIdentity).not.toHaveBeenCalled();
  });
});

describe("revokeExternalMcpApiKeyConnection", () => {
  it("soft-deletes the identity FIRST, then deletes the Nango token", async () => {
    await revokeExternalMcpApiKeyConnection(CONN);
    expect(readNangoConnectionByNaturalKey).toHaveBeenCalledWith("externalMcp", CONN);
    expect(softDeleteNangoConnection).toHaveBeenCalledWith("id-row");
    expect(deleteNangoConnection).toHaveBeenCalledWith(EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY, CONN);
  });

  it("is a no-op on an empty id", async () => {
    await revokeExternalMcpApiKeyConnection(null);
    await revokeExternalMcpApiKeyConnection(undefined);
    await revokeExternalMcpApiKeyConnection("");
    expect(readNangoConnectionByNaturalKey).not.toHaveBeenCalled();
    expect(deleteNangoConnection).not.toHaveBeenCalled();
  });

  it("never throws even when BOTH teardown steps fail", async () => {
    readNangoConnectionByNaturalKey.mockRejectedValue(new Error("identity store down"));
    deleteNangoConnection.mockRejectedValue(new Error("nango down"));
    await expect(revokeExternalMcpApiKeyConnection(CONN)).resolves.toBeUndefined();
  });

  it("still deletes the Nango token when there is no identity row", async () => {
    readNangoConnectionByNaturalKey.mockResolvedValue(null);
    await revokeExternalMcpApiKeyConnection(CONN);
    expect(softDeleteNangoConnection).not.toHaveBeenCalled();
    expect(deleteNangoConnection).toHaveBeenCalledWith(EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY, CONN);
  });
});
