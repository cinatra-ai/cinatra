// cinatra#3485 fix leg 3, the sixth read-only round, finding 3. The HOST server
// actions are a second write road onto the very same external-MCP rows: the
// "MCP Servers" connector publishes them as its `createServerAction` /
// `deleteServerAction` (src/lib/register-host-connector-services.ts). They
// promote a personal keyless server to global, they change its owner and they
// delete it, so the connection IDENTITY that carries its Sharing tab panel has
// to follow them exactly as it follows the connector's own setup handlers.
//
// Only the leaves are stubbed here: the row store and the identity store. The
// REASONING under test is the one lifecycle both roads travel
// (`src/lib/external-mcp-keyless-identity.ts`); the same lifecycle is proved
// over the REAL identity seam in
// `src/lib/__tests__/mcp-server-connection-workspace-share.test.ts`.

import { describe, it, expect, vi, beforeEach } from "vitest";

const ORG = "org-1";
const KEYLESS_PREFIX = "external-mcp-keyless-";

type ServerRow = {
  id: string;
  label: string;
  serverUrl: string;
  scope: string;
  userId: string | null;
  nangoConnectionId: string | null;
  createdAt?: string;
  updatedAt?: string;
};
type IdentityRow = {
  id: string;
  connectionId: string;
  ownerUserId: string;
  organizationId: string | null;
  deletedAt: Date | null;
};

const servers = new Map<string, ServerRow>();
const identities = new Map<string, IdentityRow>();
let identitySeq = 0;
let storeClock = 0;
let sessionUserId = "u1";
let sessionRole: string | null = null;
let sessionOrganizationId: string | null = ORG;

function nextStamp(): string {
  storeClock += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, storeClock)).toISOString();
}
// A row a case places by hand was already there when the case began: the store's
// columns are NOT NULL, so it carries stamps older than anything the case writes.
const PLACED_BEFORE = "2025-12-31T00:00:00.000Z";
function stampsOf(row: ServerRow | undefined): { createdAt: string; updatedAt: string } {
  return {
    createdAt: row?.createdAt ?? PLACED_BEFORE,
    updatedAt: row?.updatedAt ?? PLACED_BEFORE,
  };
}

class ExternalMcpServerWriteConflictError extends Error {}

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: async () => ({
    user: { id: sessionUserId, role: sessionRole },
    session: { activeOrganizationId: sessionOrganizationId },
  }),
  requireAdminSession: async () => {
    if (!String(sessionRole ?? "").split(",").map((v) => v.trim()).includes("admin")) {
      throw Object.assign(new Error("NEXT_REDIRECT"), { __redirectTo: "/not-authorized" });
    }
    return {
      user: { id: sessionUserId, role: sessionRole },
      session: { activeOrganizationId: sessionOrganizationId },
    };
  },
  isPlatformAdmin: (session: { user?: { role?: string | null } | null } | null) =>
    String(session?.user?.role ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .includes("admin"),
  getActorContext: vi.fn(),
}));

vi.mock("@/lib/external-mcp-registry", () => ({
  ExternalMcpServerWriteConflictError,
  getExternalMcpServerByIdFresh: (id: string) => {
    const row = servers.get(id);
    return row ? { ...row, ...stampsOf(row) } : null;
  },
  normalizeExternalMcpRowStamp: (value: unknown) => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value !== "string" || value.trim() === "") return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  },
  // The guarded writes stamp the row and hand their stamps back, as the real
  // ones do: an INSERT mints a creation instant, an UPDATE leaves it standing.
  insertExternalMcpServerStrict: (input: ServerRow) => {
    if (servers.has(input.id)) throw new ExternalMcpServerWriteConflictError("id exists");
    const stamp = nextStamp();
    servers.set(input.id, { ...input, createdAt: stamp, updatedAt: stamp });
    return { createdAt: stamp, updatedAt: stamp };
  },
  updateExternalMcpServerGuarded: (
    input: ServerRow,
    expected: { scope: string; userId: string | null; nangoConnectionId?: string | null },
  ) => {
    const real = servers.get(input.id);
    if (!real || real.scope !== expected.scope || real.userId !== expected.userId) {
      throw new ExternalMcpServerWriteConflictError("guard miss");
    }
    if (
      expected.nangoConnectionId !== undefined &&
      (real.nangoConnectionId ?? null) !== (expected.nangoConnectionId ?? null)
    ) {
      throw new ExternalMcpServerWriteConflictError("guard miss");
    }
    const { createdAt } = stampsOf(real);
    const updatedAt = nextStamp();
    servers.set(input.id, { ...input, createdAt, updatedAt });
    return { createdAt, updatedAt };
  },
  deleteExternalMcpServerGuarded: (id: string) => {
    servers.delete(id);
  },
  externalMcpKeylessConnectionId: (serverId: string) => `${KEYLESS_PREFIX}${serverId}`,
  // The identity store's live-unique natural key, and the seam's foreign-row
  // HARD-FAIL on top of it: an existing LIVE row is returned unchanged, and a
  // row naming somebody else refuses the save outright.
  registerExternalMcpKeylessConnectionIdentity: async (
    connectionId: string,
    identity: { ownerUserId: string; organizationId: string | null },
  ) => {
    const live = liveIdentityAt(connectionId);
    if (live) {
      if (live.ownerUserId !== identity.ownerUserId) {
        throw new Error("already registered to a different user");
      }
      if (
        live.organizationId !== null &&
        identity.organizationId !== null &&
        live.organizationId !== identity.organizationId
      ) {
        throw new Error("registered under a different organization");
      }
      return;
    }
    const row: IdentityRow = {
      id: `identity-${++identitySeq}`,
      connectionId,
      ownerUserId: identity.ownerUserId,
      organizationId: identity.organizationId,
      deletedAt: null,
    };
    identities.set(row.id, row);
  },
  readExternalMcpKeylessConnectionIdentity: async (connectionId: string) =>
    liveIdentityAt(connectionId),
  retireExternalMcpKeylessConnectionIdentityRow: async (identityId: string) => {
    const row = identities.get(identityId);
    if (row && row.deletedAt === null) row.deletedAt = new Date();
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { __redirectTo: url });
  },
}));

const MCP_SERVER_SETUP_HREF = "/connectors/cinatra-ai/mcp-server-connector/setup";
vi.mock("@/lib/connectors-registry.server", () => ({
  getConnectorSetupHref: (slug: string) =>
    slug === "mcp-server-connector" ? MCP_SERVER_SETUP_HREF : null,
}));

function liveIdentityAt(connectionId: string): IdentityRow | null {
  return (
    [...identities.values()].find(
      (r) => r.connectionId === connectionId && r.deletedAt === null,
    ) ?? null
  );
}
/** Every identity row still live, which is one panel each on the Sharing tab. */
function liveIdentities(): IdentityRow[] {
  return [...identities.values()].filter((r) => r.deletedAt === null);
}
/** The live identities a person would see listed as their own. */
function panelsOf(ownerUserId: string): IdentityRow[] {
  return liveIdentities().filter((r) => r.ownerUserId === ownerUserId);
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const { createExternalMcpServerAction, deleteExternalMcpServerAction } = await import(
  "@/app/campaigns/actions"
);

/** The host action redirects on success, so every call ends in that signal. */
async function save(fields: Record<string, string>): Promise<string> {
  try {
    await createExternalMcpServerAction(form(fields));
  } catch (err) {
    return String((err as { __redirectTo?: string }).__redirectTo ?? "");
  }
  throw new Error("the action returned without redirecting");
}
async function remove(id: string): Promise<string> {
  try {
    await deleteExternalMcpServerAction(form({ id }));
  } catch (err) {
    return String((err as { __redirectTo?: string }).__redirectTo ?? "");
  }
  throw new Error("the action returned without redirecting");
}

beforeEach(() => {
  servers.clear();
  identities.clear();
  identitySeq = 0;
  storeClock = 0;
  sessionUserId = "u1";
  sessionRole = null;
  sessionOrganizationId = ORG;
});

describe("the host MCP-server actions reconcile the keyless connection identity (cinatra#3485)", () => {
  it("a personal server saved through the host action gets its connection identity, so it draws a panel", async () => {
    await save({ id: "srv-host-1", label: "Mine", serverUrl: "https://mcp.example", scope: "user" });
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].connectionId).toBe(`${KEYLESS_PREFIX}srv-host-1`);
    expect(rows[0].ownerUserId).toBe("u1");
    expect(rows[0].organizationId).toBe(ORG);
  });

  it("PROMOTING a personal keyless server to global moves the identity, and its previous owner keeps no panel", async () => {
    sessionUserId = "u2";
    await save({ id: "srv-promote", label: "Mine", serverUrl: "https://mcp.example", scope: "user" });
    expect(panelsOf("u2")).toHaveLength(1);
    // An admin promotes that row to global through the same host action.
    sessionUserId = "admin-1";
    sessionRole = "admin";
    expect(
      await save({
        id: "srv-promote",
        label: "Shared",
        serverUrl: "https://mcp.example",
        scope: "global",
      }),
    ).toBe(`${MCP_SERVER_SETUP_HREF}?saved=1`);
    expect(servers.get("srv-promote")?.scope).toBe("global");
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerUserId).toBe("admin-1");
    expect(panelsOf("u2")).toHaveLength(0);
  });

  it("DELETING a keyless server through the host action retires its identity: no panel for a server that is gone", async () => {
    await save({ id: "srv-host-del", label: "Mine", serverUrl: "https://mcp.example", scope: "user" });
    expect(liveIdentities()).toHaveLength(1);
    expect(await remove("srv-host-del")).toBe(`${MCP_SERVER_SETUP_HREF}?deleted=1`);
    expect(servers.has("srv-host-del")).toBe(false);
    expect(liveIdentities()).toHaveLength(0);
  });

  it("an EDIT through the host action keeps the row's stored key, and writes no keyless identity for a row that has one", async () => {
    // A row the connector's own setup surface saved WITH a key: the host action
    // has no key field at all, so a label edit must not decide anything about it.
    servers.set("srv-keyed", {
      id: "srv-keyed",
      label: "Keyed",
      serverUrl: "https://mcp.example",
      scope: "user",
      userId: "u1",
      nangoConnectionId: "external-mcp-stored",
    });
    await save({ id: "srv-keyed", label: "Renamed", serverUrl: "https://mcp.example", scope: "user" });
    expect(servers.get("srv-keyed")?.label).toBe("Renamed");
    expect(servers.get("srv-keyed")?.nangoConnectionId).toBe("external-mcp-stored");
    expect(liveIdentities()).toHaveLength(0);
  });

  it("the host action never retires the orphan identity of somebody else's deleted server", async () => {
    // The first person's server, and the identity their delete failed to retire.
    sessionUserId = "u2";
    await save({ id: "srv-host-orphan", label: "Mine", serverUrl: "https://mcp.example", scope: "user" });
    const orphan = liveIdentities()[0];
    servers.delete("srv-host-orphan");
    // Another person registers their own row at the same id and deletes it.
    sessionUserId = "u1";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await save({ id: "srv-host-orphan", label: "Mine too", serverUrl: "https://mcp.example", scope: "user" });
    await remove("srv-host-orphan");
    const rows = liveIdentities();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(orphan.id);
    expect(rows[0].ownerUserId).toBe("u2");
    error.mockRestore();
    // Their own delete of the absent id is what repairs it.
    sessionUserId = "u2";
    await remove("srv-host-orphan");
    expect(liveIdentities()).toHaveLength(0);
  });
});
