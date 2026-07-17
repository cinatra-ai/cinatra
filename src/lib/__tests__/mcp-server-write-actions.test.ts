// cinatra#658 (PR-4 + TOCTOU hardening) — HOST-side write-action authorization
// for the mcp-server-connector schema-config surface (createServer / deleteServer).
//
// These prove the per-operation authorization the host enforces INSIDE the
// handler (defense in depth over the action endpoint's `use`-tier gate):
//   - a `global` write/delete requires platform admin;
//   - a `user` write/delete needs only an authenticated actor + own-row ownership;
//   - an unsafe scope (org/team/workspace) is REJECTED fail-closed (codex finding
//     2: the store can't scope it safely today);
//   - an id-overwrite re-derives authority from the EXISTING row.
//
// TOCTOU hardening (Refs cinatra#658): the authorization read is FRESH (bypasses
// the registry's 30s TTL cache) and the write is CONDITIONAL on the row still
// matching the witnessed scope+owner. The mock below models that compare-and-write:
// `getExternalMcpServerByIdFresh` returns the configurable AUTHZ view, while the
// guarded writers compare against the REAL `servers` map — so a stale authz view
// over a row that has since flipped surfaces as a write conflict (fail-closed),
// exactly the cross-worker cache-staleness race.

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- mocks ----------------------------------------------------------------
let sessionUserId = "u1";
let platformAdmin = false;
type Row = {
  id: string;
  scope: string;
  userId: string | null;
  label: string;
  serverUrl: string;
  // cinatra#1407 defect 1: the stored connection id (apiKeyConfigured is derived
  // connector-side as `nangoConnectionId != null`).
  nangoConnectionId?: string | null;
};
// The REAL backing store (what the guarded compare-and-write checks against).
const servers = new Map<string, Row>();
// The AUTHZ view the FRESH read returns. Defaults to mirroring `servers`; a test
// can OVERRIDE a single id to a stale row to simulate the TOCTOU race (authz sees
// the stale row, the guarded write sees the real — flipped — row).
const authzOverride = new Map<string, Row | null>();

// cinatra#1407 defect 1 — record the connection-service calls the handlers make
// (plain-data recorders, mirroring the `servers`/`authzOverride` pattern so the
// vi.mock factory closes over them without a hoisting concern). Never records or
// asserts anything a real log would leak beyond the key the TEST itself supplies.
const importedApiKeys: { connectionId: string; apiKey: string; identity: unknown }[] = [];
const revokedConnections: string[] = [];
let apiKeyImportShouldFail = false;

class ExternalMcpServerWriteConflictError extends Error {
  constructor(message = "conflict") {
    super(message);
    this.name = "ExternalMcpServerWriteConflictError";
  }
}

function guardMatches(
  real: Row | undefined,
  expected: { scope: string; userId: string | null; nangoConnectionId?: string | null },
): boolean {
  if (!real) return false;
  // NULL-safe equality, mirroring `user_id IS NOT DISTINCT FROM`.
  if (real.scope !== expected.scope || real.userId !== expected.userId) return false;
  // cinatra#1407: when a nango witness is provided, the row's current connection
  // must ALSO still match (NULL-safe), mirroring the SQL `nango_connection_id IS
  // NOT DISTINCT FROM $n` the guarded write/delete adds.
  if (expected.nangoConnectionId !== undefined) {
    return (real.nangoConnectionId ?? null) === (expected.nangoConnectionId ?? null);
  }
  return true;
}

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: async () => ({ user: { id: sessionUserId } }),
  isPlatformAdmin: () => platformAdmin,
}));

vi.mock("@/lib/external-mcp-registry", () => ({
  ExternalMcpServerWriteConflictError,
  // llm-providers S2 (#1713): the write handler coerces a posted transport
  // through this helper; mirror the real closed-vocabulary coercion.
  normalizeExternalMcpTransport: (value: unknown) =>
    value === "streamable-http" || value === "sse" ? value : "unknown",
  getExternalMcpServerByIdFresh: (id: string) =>
    authzOverride.has(id) ? authzOverride.get(id) : servers.get(id) ?? null,
  insertExternalMcpServerStrict: (input: Row) => {
    if (servers.has(input.id)) throw new ExternalMcpServerWriteConflictError("id exists");
    servers.set(input.id, input);
  },
  updateExternalMcpServerGuarded: (
    input: Row,
    expected: { scope: string; userId: string | null; nangoConnectionId?: string | null },
  ) => {
    if (!guardMatches(servers.get(input.id), expected)) {
      throw new ExternalMcpServerWriteConflictError("guard miss");
    }
    servers.set(input.id, input);
  },
  deleteExternalMcpServerGuarded: (
    id: string,
    expected: { scope: string; userId: string | null; nangoConnectionId?: string | null },
  ) => {
    if (!guardMatches(servers.get(id), expected)) {
      throw new ExternalMcpServerWriteConflictError("guard miss");
    }
    servers.delete(id);
  },
  // cinatra#1407 defect 1 — the sanctioned credential path. The import records
  // its args (so a test can assert the key round-trips + the identity seed) and
  // can be flipped to fail (fail-closed path). Revoke records the ids it revokes.
  importExternalMcpApiKeyConnection: async (
    connectionId: string,
    apiKey: string,
    identity: unknown,
  ) => {
    if (apiKeyImportShouldFail) {
      throw new Error("The connection service could not store the API key. Please try again.");
    }
    importedApiKeys.push({ connectionId, apiKey, identity });
  },
  revokeExternalMcpApiKeyConnection: async (connectionId: string | null | undefined) => {
    if (connectionId) revokedConnections.push(connectionId);
  },
}));

// Import AFTER the mocks are registered.
const { createServerHandler, deleteServerHandler } = await import("@/lib/mcp-server-write-actions");

beforeEach(() => {
  sessionUserId = "u1";
  platformAdmin = false;
  servers.clear();
  authzOverride.clear();
  importedApiKeys.length = 0;
  revokedConnections.length = 0;
  apiKeyImportShouldFail = false;
});

describe("createServerHandler authz", () => {
  it("a non-admin can create a PERSONAL (user) server bound to their own id", async () => {
    const r = await createServerHandler({ label: "Mine", serverUrl: "https://a", scope: "user" });
    expect(r.banner).toBe("saved");
    const created = [...servers.values()][0];
    expect(created.scope).toBe("user");
    expect(created.userId).toBe("u1");
  });

  it("a non-admin CANNOT create a GLOBAL server (platform admin required)", async () => {
    platformAdmin = false;
    await expect(createServerHandler({ label: "G", serverUrl: "https://a", scope: "global" })).rejects.toThrow(/platform admin/i);
  });

  it("an admin CAN create a GLOBAL server", async () => {
    platformAdmin = true;
    const r = await createServerHandler({ label: "G", serverUrl: "https://a", scope: "global" });
    expect(r.banner).toBe("saved");
    expect([...servers.values()][0].scope).toBe("global");
  });

  it("rejects an unsafe scope (org/team/workspace) fail-closed", async () => {
    for (const scope of ["org", "team", "workspace", "nonsense"]) {
      await expect(createServerHandler({ label: "X", serverUrl: "https://a", scope })).rejects.toThrow(/not yet supported/i);
    }
  });

  it("requires label + serverUrl", async () => {
    await expect(createServerHandler({ serverUrl: "https://a", scope: "user" })).rejects.toThrow(/label/i);
    await expect(createServerHandler({ label: "L", scope: "user" })).rejects.toThrow(/server URL/i);
  });

  it("id-overwrite guard: a non-admin cannot overwrite an existing GLOBAL row", async () => {
    servers.set("g1", { id: "g1", scope: "global", userId: null, label: "G", serverUrl: "https://g" });
    platformAdmin = false;
    await expect(createServerHandler({ id: "g1", label: "G2", serverUrl: "https://g2", scope: "user" })).rejects.toThrow(/platform admin/i);
  });

  it("id-overwrite guard: a non-admin cannot overwrite ANOTHER user's row", async () => {
    servers.set("o1", { id: "o1", scope: "user", userId: "other", label: "O", serverUrl: "https://o" });
    sessionUserId = "u1";
    platformAdmin = false;
    await expect(createServerHandler({ id: "o1", label: "O2", serverUrl: "https://o2", scope: "user" })).rejects.toThrow(/your own/i);
  });

  it("id-overwrite guard: a user CAN overwrite their OWN row", async () => {
    servers.set("m1", { id: "m1", scope: "user", userId: "u1", label: "M", serverUrl: "https://m" });
    const r = await createServerHandler({ id: "m1", label: "M2", serverUrl: "https://m2", scope: "user" });
    expect(r.banner).toBe("saved");
    expect(servers.get("m1")?.label).toBe("M2");
  });

  it("an admin editing a USER row PRESERVES the existing owner (no ownership steal)", async () => {
    // codex final-r1 finding 1: an admin overwrite of someone else's user row must
    // NOT silently reassign the row to the admin.
    servers.set("owned", { id: "owned", scope: "user", userId: "alice", label: "A", serverUrl: "https://a" });
    sessionUserId = "admin";
    platformAdmin = true;
    const r = await createServerHandler({ id: "owned", label: "A2", serverUrl: "https://a2", scope: "user" });
    expect(r.banner).toBe("saved");
    expect(servers.get("owned")?.userId).toBe("alice"); // preserved, NOT "admin"
  });

  it("an existing ORG-scoped row can be modified ONLY by a platform admin", async () => {
    // codex final-r1 finding 2: a scope the module can't safely reason about is
    // admin-only to touch.
    servers.set("org1", { id: "org1", scope: "org", userId: null, label: "O", serverUrl: "https://o" });
    platformAdmin = false;
    await expect(createServerHandler({ id: "org1", label: "O2", serverUrl: "https://o2", scope: "user" })).rejects.toThrow(/platform admin/i);
  });

  // --- TOCTOU race (Refs cinatra#658) -------------------------------------
  it("REFUSES an overwrite when the row was promoted to GLOBAL under the actor (stale-cache race)", async () => {
    // The actor (u1) owns the row per the AUTHZ view, so the per-operation authz
    // checks pass. But the REAL row has been promoted to `global` (no owner) by a
    // concurrent admin — the guarded UPDATE must refuse rather than clobber the
    // now-global row by id.
    servers.set("row1", { id: "row1", scope: "global", userId: null, label: "G", serverUrl: "https://g" });
    authzOverride.set("row1", { id: "row1", scope: "user", userId: "u1", label: "G", serverUrl: "https://g" });
    sessionUserId = "u1";
    platformAdmin = false;
    await expect(
      createServerHandler({ id: "row1", label: "hijack", serverUrl: "https://attacker", scope: "user" }),
    ).rejects.toThrow(/changed while saving|not authorized/i);
    // The real global row is untouched.
    expect(servers.get("row1")?.scope).toBe("global");
    expect(servers.get("row1")?.label).toBe("G");
  });

  it("REFUSES a strict-insert when a row with the supplied id was created concurrently", async () => {
    // Fresh authz read sees no row (authzOverride → null), so the create path is
    // chosen — but a concurrent worker created the id. The strict INSERT must
    // refuse (no ON CONFLICT clobber).
    authzOverride.set("c1", null);
    servers.set("c1", { id: "c1", scope: "global", userId: null, label: "real", serverUrl: "https://real" });
    sessionUserId = "u1";
    platformAdmin = false;
    await expect(
      createServerHandler({ id: "c1", label: "evil", serverUrl: "https://evil", scope: "user" }),
    ).rejects.toThrow(/changed while saving|not authorized/i);
    expect(servers.get("c1")?.label).toBe("real");
  });
});

describe("createServerHandler API key persistence (cinatra#1407 defect 1)", () => {
  it("persists a supplied API key and sets nangoConnectionId (apiKeyConfigured round-trip)", async () => {
    const r = await createServerHandler({
      label: "Keyed",
      serverUrl: "https://k",
      scope: "user",
      apiKey: "sk-secret",
    });
    expect(r.banner).toBe("saved");
    const created = [...servers.values()][0];
    // apiKeyConfigured is derived connector-side as `nangoConnectionId != null` —
    // it can now become true (the whole point of the fix).
    expect(created.nangoConnectionId).toBeTruthy();
    expect(created.nangoConnectionId).toMatch(/^external-mcp-/);
    // Exactly one credential import, under the SAME id stored on the row, with the
    // key routed straight through, plus an OWNER-seeded identity (per-user row).
    expect(importedApiKeys).toHaveLength(1);
    expect(importedApiKeys[0].connectionId).toBe(created.nangoConnectionId);
    expect(importedApiKeys[0].apiKey).toBe("sk-secret");
    // A user row's credential is personal: owner-seeded, bound to NO org (never
    // the acting admin's org).
    expect(importedApiKeys[0].identity).toMatchObject({
      ownerUserId: "u1",
      organizationId: null,
      seed: "owner",
    });
    expect(revokedConnections).toHaveLength(0);
  });

  it("a blank / absent API key leaves nangoConnectionId null and imports nothing", async () => {
    await createServerHandler({ label: "NoKey", serverUrl: "https://n", scope: "user" });
    await createServerHandler({ label: "Blank", serverUrl: "https://b", scope: "user", apiKey: "   " });
    for (const row of servers.values()) expect(row.nangoConnectionId ?? null).toBeNull();
    expect(importedApiKeys).toHaveLength(0);
  });

  it("a GLOBAL keyed server is WORKSPACE-seeded (org-shared) for the org-bound mint", async () => {
    platformAdmin = true;
    await createServerHandler({ label: "G", serverUrl: "https://g", scope: "global", apiKey: "sk-g" });
    expect(importedApiKeys).toHaveLength(1);
    expect(importedApiKeys[0].identity).toMatchObject({ ownerUserId: "u1", seed: "workspace" });
  });

  it("FAIL-CLOSED: a key that cannot be persisted never lands a row (and rolls back)", async () => {
    apiKeyImportShouldFail = true;
    await expect(
      createServerHandler({ label: "X", serverUrl: "https://x", scope: "user", apiKey: "sk-x" }),
    ).rejects.toThrow(/could not store the api key|connection service/i);
    // No row persisted — never advertise a key it cannot mint.
    expect(servers.size).toBe(0);
  });

  it("preserves an existing row's stored connection on a KEYLESS edit (no silent key drop)", async () => {
    servers.set("k1", {
      id: "k1",
      scope: "user",
      userId: "u1",
      label: "K",
      serverUrl: "https://k",
      nangoConnectionId: "external-mcp-old",
    });
    const r = await createServerHandler({ id: "k1", label: "K-renamed", serverUrl: "https://k2", scope: "user" });
    expect(r.banner).toBe("saved");
    expect(servers.get("k1")?.nangoConnectionId).toBe("external-mcp-old");
    expect(importedApiKeys).toHaveLength(0);
    expect(revokedConnections).toHaveLength(0);
  });

  it("RE-KEYING imports a NEW connection and revokes the PRIOR one", async () => {
    servers.set("k1", {
      id: "k1",
      scope: "user",
      userId: "u1",
      label: "K",
      serverUrl: "https://k",
      nangoConnectionId: "external-mcp-old",
    });
    const r = await createServerHandler({ id: "k1", label: "K", serverUrl: "https://k", scope: "user", apiKey: "sk-new" });
    expect(r.banner).toBe("saved");
    const stored = servers.get("k1")!;
    expect(stored.nangoConnectionId).toMatch(/^external-mcp-/);
    expect(stored.nangoConnectionId).not.toBe("external-mcp-old");
    expect(importedApiKeys[0].connectionId).toBe(stored.nangoConnectionId);
    // Prior credential revoked AFTER the successful re-key (no stale credential).
    expect(revokedConnections).toContain("external-mcp-old");
  });

  it("rolls back the just-imported credential when the guarded write CONFLICTS (TOCTOU)", async () => {
    // Real row is global; authz view says the actor owns a user row → per-op authz
    // passes, guarded UPDATE conflicts. The imported credential must be revoked and
    // the real row untouched.
    servers.set("row1", { id: "row1", scope: "global", userId: null, label: "G", serverUrl: "https://g" });
    authzOverride.set("row1", { id: "row1", scope: "user", userId: "u1", label: "G", serverUrl: "https://g" });
    sessionUserId = "u1";
    platformAdmin = false;
    await expect(
      createServerHandler({ id: "row1", label: "hijack", serverUrl: "https://x", scope: "user", apiKey: "sk-x" }),
    ).rejects.toThrow(/changed while saving/i);
    expect(importedApiKeys).toHaveLength(1);
    expect(revokedConnections).toContain(importedApiKeys[0].connectionId);
    expect(servers.get("row1")?.scope).toBe("global");
    expect(servers.get("row1")?.label).toBe("G");
  });

  it("RESURRECTION guard: a keyless edit CONFLICTS when the connection moved under it", async () => {
    // Real row already re-keyed to a NEW connection; the actor's fresh-authz view
    // still shows the OLD one. A keyless edit that would write the OLD connection
    // back must FAIL CLOSED — never resurrect the revoked pointer (which would
    // leave the row advertising an unmintable key).
    servers.set("k1", { id: "k1", scope: "user", userId: "u1", label: "K", serverUrl: "https://k", nangoConnectionId: "external-mcp-NEW" });
    authzOverride.set("k1", { id: "k1", scope: "user", userId: "u1", label: "K", serverUrl: "https://k", nangoConnectionId: "external-mcp-OLD" });
    await expect(
      createServerHandler({ id: "k1", label: "renamed", serverUrl: "https://k", scope: "user" }),
    ).rejects.toThrow(/changed while saving/i);
    // The row keeps its NEW connection (not resurrected to OLD).
    expect(servers.get("k1")?.nangoConnectionId).toBe("external-mcp-NEW");
  });
});

describe("deleteServerHandler authz", () => {
  it("a non-admin CANNOT delete a GLOBAL server", async () => {
    servers.set("g1", { id: "g1", scope: "global", userId: null, label: "G", serverUrl: "https://g" });
    platformAdmin = false;
    await expect(deleteServerHandler({ id: "g1" })).rejects.toThrow(/platform admin/i);
    expect(servers.has("g1")).toBe(true);
  });

  it("an admin CAN delete a GLOBAL server", async () => {
    servers.set("g1", { id: "g1", scope: "global", userId: null, label: "G", serverUrl: "https://g" });
    platformAdmin = true;
    const r = await deleteServerHandler({ id: "g1" });
    expect(r.banner).toBe("deleted");
    expect(servers.has("g1")).toBe(false);
  });

  it("a user CAN delete their OWN server but NOT another user's", async () => {
    servers.set("mine", { id: "mine", scope: "user", userId: "u1", label: "M", serverUrl: "https://m" });
    servers.set("theirs", { id: "theirs", scope: "user", userId: "other", label: "T", serverUrl: "https://t" });
    expect((await deleteServerHandler({ id: "mine" })).banner).toBe("deleted");
    await expect(deleteServerHandler({ id: "theirs" })).rejects.toThrow(/your own/i);
    expect(servers.has("theirs")).toBe(true);
  });

  it("an ORG/team/workspace row can be deleted ONLY by a platform admin", async () => {
    servers.set("org1", { id: "org1", scope: "org", userId: null, label: "O", serverUrl: "https://o" });
    platformAdmin = false;
    await expect(deleteServerHandler({ id: "org1" })).rejects.toThrow(/platform admin/i);
    expect(servers.has("org1")).toBe(true);
    platformAdmin = true;
    expect((await deleteServerHandler({ id: "org1" })).banner).toBe("deleted");
  });

  it("a missing id is idempotent success (no over-exposure)", async () => {
    const r = await deleteServerHandler({ id: "gone" });
    expect(r.banner).toBe("deleted");
  });

  it("requires an id", async () => {
    await expect(deleteServerHandler({})).rejects.toThrow(/id is required/i);
  });

  it("REVOKES the row's stored API key connection on delete (cinatra#1407 defect 1)", async () => {
    servers.set("k1", {
      id: "k1",
      scope: "user",
      userId: "u1",
      label: "K",
      serverUrl: "https://k",
      nangoConnectionId: "external-mcp-x",
    });
    const r = await deleteServerHandler({ id: "k1" });
    expect(r.banner).toBe("deleted");
    expect(revokedConnections).toContain("external-mcp-x");
  });

  it("a KEYLESS row delete revokes nothing", async () => {
    servers.set("k2", { id: "k2", scope: "user", userId: "u1", label: "K2", serverUrl: "https://k2" });
    await deleteServerHandler({ id: "k2" });
    expect(revokedConnections).toHaveLength(0);
  });

  it("delete guard CONFLICTS when the row was re-keyed under the actor (keeps the live connection)", async () => {
    // Real row re-keyed to NEW; the actor's fresh-authz view still shows OLD. The
    // witnessed guarded delete must refuse (the row keeps its NEW, live connection)
    // rather than removing the row and orphaning the new credential.
    servers.set("k1", { id: "k1", scope: "user", userId: "u1", label: "K", serverUrl: "https://k", nangoConnectionId: "external-mcp-NEW" });
    authzOverride.set("k1", { id: "k1", scope: "user", userId: "u1", label: "K", serverUrl: "https://k", nangoConnectionId: "external-mcp-OLD" });
    await expect(deleteServerHandler({ id: "k1" })).rejects.toThrow(/changed while deleting/i);
    expect(servers.has("k1")).toBe(true);
    expect(servers.get("k1")?.nangoConnectionId).toBe("external-mcp-NEW");
  });

  // --- TOCTOU race (Refs cinatra#658) -------------------------------------
  it("REFUSES a delete when the row was promoted to GLOBAL under the actor (stale-cache race)", async () => {
    // Authz view says the actor owns a user row → owner-delete authz passes. The
    // REAL row is global. The guarded DELETE must refuse rather than delete the
    // now-global row by id.
    servers.set("d1", { id: "d1", scope: "global", userId: null, label: "G", serverUrl: "https://g" });
    authzOverride.set("d1", { id: "d1", scope: "user", userId: "u1", label: "G", serverUrl: "https://g" });
    sessionUserId = "u1";
    platformAdmin = false;
    await expect(deleteServerHandler({ id: "d1" })).rejects.toThrow(/changed while deleting|not authorized/i);
    expect(servers.has("d1")).toBe(true);
  });
});
