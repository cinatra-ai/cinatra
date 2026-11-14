// cinatra#4137 — the GENERIC hand-over of a refused fixture account's
// connection, offered to every connector's devSetup hook.
//
// A boot that refuses the development fixture account makes the install's
// connections for the instance's first administrator (cinatra#4112). A
// connection an earlier boot made for the fixture account is handed to that
// administrator by the hook that made it, through the host helper on its
// context (`helpers.reownRefusedFixtureConnection`): the hook names its own
// external-MCP row and answers the key check for its own service; the HOST
// resolves the refused account and the new owner. The shell itself no longer
// hands anything over and names no connector.
//
// Driven through the REAL shell (`runDevAutoSetup`) and the REAL registry
// writers, with one FAKE connector (`@cinatra-unit/fake-4137-connector`, row
// `fake-workspace`) whose hook asks for the hand-over. Only the edges are
// faked, in memory: the database, the connection service, the identity store
// + seam + use gate. Each case is one fresh boot over the state it seeds.
//
// SECRET BOUNDARY: the keys are synthetic; assertions compare them by identity.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const db = {
    users: [] as Array<{ id: string; email: string; role: string | null; userType: string | null; createdAt: number }>,
    members: [] as Array<{ userId: string; organizationId: string; createdAt: number }>,
    servers: new Map<string, Record<string, unknown>>(),
  };
  const nango = new Map<string, string>();
  const identities: Array<{
    id: string;
    organizationId: string | null;
    connectorPackageId: string;
    connectorKey: string;
    connectionId: string;
    ownerUserId: string;
    createdAt: Date;
    deletedAt: Date | null;
  }> = [];
  const grants = new Set<string>();
  const faults = { nangoReadThrows: 0, identityFailOwner: null as string | null };
  const hook = {
    /** What the fake connector's hook saw and got back. */
    offered: undefined as boolean | undefined,
    outcome: undefined as string | undefined,
    serverId: "fake-workspace",
    ask: true,
  };
  return {
    db,
    nango,
    identities,
    grants,
    faults,
    hook,
    publicBaseUrl: { value: null as string | null },
    checkKey: vi.fn(async (): Promise<"ok" | "unauthorized" | "unreachable"> => "ok"),
    identityReads: { count: 0 },
  };
});

// ---- the database ----------------------------------------------------------

function answer(query: { text: string; values?: unknown[] }): { rows: unknown[] } {
  const text = query.text;
  const values = query.values ?? [];
  if (text.includes('"external_mcp_servers"')) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith("SELECT")) {
      const rows = [...h.db.servers.values()];
      if (text.includes("WHERE id = $1")) return { rows: rows.filter((r) => r.id === values[0]) };
      return { rows };
    }
    if (trimmed.startsWith("DELETE")) {
      h.db.servers.delete(String(values[0]));
      return { rows: [] };
    }
    return { rows: [] };
  }
  if (text.includes("WHERE email = $1")) {
    return { rows: h.db.users.filter((u) => u.email === values[0]).slice(0, 1).map((u) => ({ id: u.id })) };
  }
  if (text.includes("r = 'admin'")) {
    let rows = h.db.users.filter((u) => (u.role ?? "").split(",").map((r) => r.trim()).includes("admin"));
    if (text.includes(`COALESCE("userType", 'human') = 'human'`)) rows = rows.filter((u) => (u.userType ?? "human") === "human");
    rows = [...rows].sort((a, b) => a.createdAt - b.createdAt);
    return { rows: rows.slice(0, 1).map((u) => ({ id: u.id })) };
  }
  if (text.includes('FROM public."member"')) {
    const m = h.db.members.filter((r) => r.userId === values[0]).sort((a, b) => a.createdAt - b.createdAt)[0];
    return { rows: m ? [{ id: m.organizationId }] : [] };
  }
  if (text.includes('SET "userType"')) {
    const u = h.db.users.find((r) => r.id === values[0]);
    if (u) u.userType = String(values[1]);
    return { rows: [] };
  }
  if (text.includes('"userType" = $2')) {
    const u = h.db.users.find((r) => r.id === values[0] && r.userType === values[1]);
    return { rows: u ? [{ marked: 1 }] : [] };
  }
  return { rows: [] };
}

vi.mock("@/lib/postgres-sync", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runPostgresQueriesSync: (input: { queries: Array<{ text: string; values?: unknown[] }> }) =>
    input.queries.map((q) => answer(q)),
}));

// ---- the connection service ------------------------------------------------

vi.mock("@/lib/nango-system", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isNangoConfigured: () => true,
  getNangoCredentials: async (_key: string, connectionId: string) => {
    if (h.faults.nangoReadThrows > 0) {
      h.faults.nangoReadThrows -= 1;
      throw new Error("connection service unavailable (injected)");
    }
    const apiKey = h.nango.get(connectionId);
    return apiKey ? { type: "API_KEY", apiKey } : null;
  },
  deleteNangoConnection: async (_key: string, connectionId: string) => {
    h.nango.delete(connectionId);
  },
}));

// ---- the connection identity store, seam and use gate ----------------------

function liveIdentity(connectorKey: string, connectionId: string) {
  return (
    h.identities.find((r) => r.connectorKey === connectorKey && r.connectionId === connectionId && r.deletedAt === null) ??
    null
  );
}

vi.mock("@cinatra-ai/extensions/connection-identity-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readNangoConnectionByNaturalKey: async (connectorKey: string, connectionId: string) => {
    h.identityReads.count += 1;
    return liveIdentity(connectorKey, connectionId);
  },
  softDeleteNangoConnection: async (id: string) => {
    const row = h.identities.find((r) => r.id === id && r.deletedAt === null);
    if (row) row.deletedAt = new Date();
  },
}));

vi.mock("@/lib/connection-identity-seam", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerSavedConnectionIdentity: async (input: {
    connectorKey: string;
    connectionId: string;
    ownerUserId: string;
    organizationId: string | null;
    seed?: "owner" | "workspace";
    onIdentityRow?: (row: { id: string; created: boolean }) => void;
  }) => {
    let row = liveIdentity(input.connectorKey, input.connectionId);
    let created = false;
    if (!row) {
      row = {
        id: `identity-${h.identities.length + 1}`,
        organizationId: input.organizationId,
        connectorPackageId: "@unit/external-mcp",
        connectorKey: input.connectorKey,
        connectionId: input.connectionId,
        ownerUserId: input.ownerUserId,
        createdAt: new Date(),
        deletedAt: null,
      };
      h.identities.push(row);
      created = true;
    }
    input.onIdentityRow?.({ id: row.id, created });
    if (row.ownerUserId !== input.ownerUserId) throw new Error("The connection is already registered to a different user");
    if (h.faults.identityFailOwner === input.ownerUserId) {
      h.faults.identityFailOwner = null;
      throw new Error("grant seed failed (injected)");
    }
    if (input.seed === "workspace") h.grants.add(row.id);
    return { ...row, created };
  },
}));

vi.mock("@/lib/connection-use-gate", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown> & { ConnectionUseDeniedError: new (...a: unknown[]) => Error }>();
  return {
    ...original,
    enforceConnectionUse: async (input: { identity: { id: string } }) => {
      if (!h.grants.has(input.identity.id)) throw Object.create(original.ConnectionUseDeniedError.prototype);
    },
  };
});

vi.mock("@/lib/connector-client-providers", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listManagedExternalMcpEndpointUrls: () => [],
}));

// ---- the shell's own seams: one fake connector whose hook asks ------------

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawnSync: () => ({ status: 1, stdout: "", stderr: "" }),
}));

vi.mock("@/lib/generated/extensions.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  GENERATED_DEV_SETUP_MODULES: {
    "@cinatra-unit/fake-4137-connector": {
      resolution: "guardedOptional",
      load: async () => ({
        runDevSetup: async (ctx: { helpers: Record<string, unknown> }) => {
          const helper = ctx.helpers.reownRefusedFixtureConnection;
          h.hook.offered = typeof helper === "function";
          if (h.hook.ask && typeof helper === "function") {
            h.hook.outcome = await (helper as (input: unknown) => Promise<string>)({
              serverId: h.hook.serverId,
              checkKey: h.checkKey,
            });
          }
          return { status: "skipped" as const, reason: "unit fake hook" };
        },
      }),
    },
  },
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auth: {
    api: {
      signUpEmail: async () => {
        throw new Error("registration is closed in this unit test");
      },
    },
    $context: Promise.resolve({}),
  },
}));

vi.mock("@/lib/dev-fixture-secret", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveDevFixturePassword: () => ({ password: "unit-only", source: "generated" }),
  printDevFixtureSecretOnce: () => undefined,
  removeDevFixturePasswordFile: () => undefined,
  retireDevFixturePassword: async () => true,
  rotateDevFixturePassword: async () => true,
}));

vi.mock("@cinatra-ai/mcp-server/credentials", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMcpPublicBaseUrl: () => ({ publicBaseUrl: h.publicBaseUrl.value, publicBaseUrlSource: "none" }),
}));

// ---- fixtures --------------------------------------------------------------

const FIXTURE_EMAIL = "cinatra-uat@example.com";
const LANE_ADDRESS = "https://lane-4137.example.com";
const ORG = "org-default";
const ADMIN_ID = "admin-user-1";
const FIXTURE_ID = "fixture-user-1";
const OTHER_ID = "other-admin-2";
const KEY = "unit-stored-key-4137";
const SERVER_URL = "http://localhost:3999/mcp";

const KEYS = ["CINATRA_RUNTIME_MODE", "CINATRA_INSTALL_PROFILE", "NODE_ENV", "BETTER_AUTH_URL"] as const;
const ENV = process.env as Record<string, string | undefined>;

let root = "";
let saved: Record<string, string | undefined> = {};
const spies: Array<{ mockRestore: () => void }> = [];

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "dev-auto-setup-4137-"));
  const pkgDir = path.join(root, "extensions", "cinatra-unit", "fake-4137-connector");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "@cinatra-unit/fake-4137-connector", cinatra: { devSetup: "./src/dev-setup" } }),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  h.db.users.length = 0;
  h.db.members.length = 0;
  h.db.servers.clear();
  h.nango.clear();
  h.identities.length = 0;
  h.grants.clear();
  h.faults.nangoReadThrows = 0;
  h.faults.identityFailOwner = null;
  h.hook.offered = undefined;
  h.hook.outcome = undefined;
  h.hook.serverId = "fake-workspace";
  h.hook.ask = true;
  h.identityReads.count = 0;
  h.publicBaseUrl.value = null;
  h.checkKey.mockReset();
  h.checkKey.mockImplementation(async () => "ok");
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete ENV[k];
  ENV.CINATRA_RUNTIME_MODE = "development";
  ENV.NODE_ENV = "test";
  spies.push(vi.spyOn(process, "cwd").mockReturnValue(root));
  for (const level of ["log", "warn", "error", "info"] as const) {
    spies.push(vi.spyOn(console, level).mockImplementation(() => {}));
  }
});

afterEach(() => {
  while (spies.length) spies.pop()?.mockRestore();
  vi.unstubAllGlobals();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete ENV[k];
    else ENV[k] = saved[k];
  }
});

/** One boot: a fresh process over the stored state. */
async function boot(): Promise<void> {
  vi.resetModules();
  delete (globalThis as Record<string, unknown>).__cinatraExternalMcpServerCache;
  const { runDevAutoSetup } = await import("@/lib/dev-auto-setup");
  const result = await runDevAutoSetup();
  expect(result.hooks.map((r) => r.packageName)).toEqual(["@cinatra-unit/fake-4137-connector"]);
}

function seatUser(user: { id: string; email: string; role?: string | null; userType?: string | null; createdAt: number }): void {
  h.db.users.push({ role: null, userType: "human", ...user } as (typeof h.db.users)[number]);
  h.db.members.push({ userId: user.id, organizationId: ORG, createdAt: user.createdAt });
}

/** A reachable instance with a fixture account an earlier boot left and a first administrator. */
function refusedFixtureAndAdministrator(): void {
  h.publicBaseUrl.value = LANE_ADDRESS;
  seatUser({ id: FIXTURE_ID, email: FIXTURE_EMAIL, userType: "uat-fixture", createdAt: 10 });
  seatUser({ id: ADMIN_ID, email: "operator@example.test", role: "admin", createdAt: 20 });
}

/** An install-made connection an earlier boot made for `owner` on row `id`. */
function existingConnection(owner: string, id = "fake-workspace"): string {
  const connectionId = `${id}-connection`;
  h.nango.set(connectionId, KEY);
  h.db.servers.set(id, {
    id,
    label: "Unit row",
    server_url: SERVER_URL,
    nango_connection_id: connectionId,
    scope: "workspace",
    org_id: null,
    user_id: null,
    enabled: true,
    allowed_tools: null,
    allowed_catalog_tools: null,
    transport: "unknown",
    created_at: new Date(0),
    updated_at: new Date(0),
  });
  const identity = {
    id: `identity-earlier-${id}`,
    organizationId: ORG,
    connectorPackageId: "@unit/external-mcp",
    connectorKey: "externalMcp",
    connectionId,
    ownerUserId: owner,
    createdAt: new Date(0),
    deletedAt: null,
  };
  h.identities.push(identity);
  h.grants.add(identity.id);
  return connectionId;
}

function ownerOf(connectionId: string): string | null {
  return liveIdentity("externalMcp", connectionId)?.ownerUserId ?? null;
}

describe("the generic hand-over of a refused fixture account's connection (cinatra#4137)", () => {
  it("every hook's context offers it; a private boot (fixture available) hands nothing over and reads nothing", async () => {
    seatUser({ id: FIXTURE_ID, email: FIXTURE_EMAIL, userType: "uat-fixture", createdAt: 10 });
    seatUser({ id: ADMIN_ID, email: "operator@example.test", role: "admin", createdAt: 20 });
    const connectionId = existingConnection(FIXTURE_ID);

    await boot();

    expect(h.hook.offered).toBe(true);
    expect(h.hook.outcome).toBe("no-owner");
    expect(h.identityReads.count).toBe(0);
    expect(h.checkKey).not.toHaveBeenCalled();
    expect(ownerOf(connectionId)).toBe(FIXTURE_ID);
  });

  it("no administrator yet: no-owner, nothing read", async () => {
    h.publicBaseUrl.value = LANE_ADDRESS;
    seatUser({ id: FIXTURE_ID, email: FIXTURE_EMAIL, userType: "uat-fixture", createdAt: 10 });
    existingConnection(FIXTURE_ID);

    await boot();

    expect(h.hook.outcome).toBe("no-owner");
    expect(h.identityReads.count).toBe(0);
    expect(h.checkKey).not.toHaveBeenCalled();
  });

  it("the named row carries no connection: no-connection, nothing checked", async () => {
    refusedFixtureAndAdministrator();

    await boot();

    expect(h.hook.outcome).toBe("no-connection");
    expect(h.checkKey).not.toHaveBeenCalled();
  });

  it("a connection another person owns is never handed over: not-fixture-owned, nothing checked or changed", async () => {
    refusedFixtureAndAdministrator();
    seatUser({ id: OTHER_ID, email: "second@example.test", role: "admin", createdAt: 30 });
    const connectionId = existingConnection(OTHER_ID);

    await boot();

    expect(h.hook.outcome).toBe("not-fixture-owned");
    expect(h.checkKey).not.toHaveBeenCalled();
    expect(ownerOf(connectionId)).toBe(OTHER_ID);
    expect(h.nango.get(connectionId)).toBe(KEY);
  });

  it("the key works: reowned — the same key and row, and only the ownership moves to the first administrator", async () => {
    refusedFixtureAndAdministrator();
    const connectionId = existingConnection(FIXTURE_ID);

    await boot();

    expect(h.hook.outcome).toBe("reowned");
    expect(h.checkKey).toHaveBeenCalledTimes(1);
    expect(h.checkKey).toHaveBeenCalledWith({ apiKey: KEY, serverUrl: SERVER_URL });
    expect(ownerOf(connectionId)).toBe(ADMIN_ID);
    expect(h.grants.has(liveIdentity("externalMcp", connectionId)!.id)).toBe(true);
    expect(h.nango.get(connectionId)).toBe(KEY);
    expect(h.db.servers.get("fake-workspace")?.nango_connection_id).toBe(connectionId);
  });

  it("the key no longer works: cleared — the connection, its key and its identity are removed", async () => {
    refusedFixtureAndAdministrator();
    const connectionId = existingConnection(FIXTURE_ID);
    h.checkKey.mockImplementation(async () => "unauthorized");

    await boot();

    expect(h.hook.outcome).toBe("cleared");
    expect(h.db.servers.has("fake-workspace")).toBe(false);
    expect(h.nango.has(connectionId)).toBe(false);
    expect(ownerOf(connectionId)).toBeNull();
  });

  it("the service cannot be reached, or the key cannot be read: deferred — nothing changes", async () => {
    refusedFixtureAndAdministrator();
    const connectionId = existingConnection(FIXTURE_ID);
    h.checkKey.mockImplementation(async () => "unreachable");

    await boot();

    expect(h.hook.outcome).toBe("deferred");
    expect(ownerOf(connectionId)).toBe(FIXTURE_ID);
    expect(h.nango.get(connectionId)).toBe(KEY);

    h.checkKey.mockReset();
    h.checkKey.mockImplementation(async () => "ok");
    h.faults.nangoReadThrows = 1;
    await boot();

    expect(h.hook.outcome).toBe("deferred");
    expect(h.checkKey).not.toHaveBeenCalled();
    expect(ownerOf(connectionId)).toBe(FIXTURE_ID);
  });

  it("a failed ownership registration is undone: deferred, and the fixture keeps its working connection", async () => {
    refusedFixtureAndAdministrator();
    const connectionId = existingConnection(FIXTURE_ID);
    h.faults.identityFailOwner = ADMIN_ID;

    await boot();

    expect(h.hook.outcome).toBe("deferred");
    expect(ownerOf(connectionId)).toBe(FIXTURE_ID);
    expect(h.nango.get(connectionId)).toBe(KEY);
  });

  it("a key check that throws: failed — nothing is written", async () => {
    refusedFixtureAndAdministrator();
    const connectionId = existingConnection(FIXTURE_ID);
    h.checkKey.mockImplementation(async () => {
      throw new Error("unsupported instance address");
    });

    await boot();

    expect(h.hook.outcome).toBe("failed");
    expect(ownerOf(connectionId)).toBe(FIXTURE_ID);
    expect(h.db.servers.has("fake-workspace")).toBe(true);
    expect(h.nango.get(connectionId)).toBe(KEY);
  });

  it("the shell hands nothing over by itself: a refused fixture's connection no hook asks for stays where it is", async () => {
    refusedFixtureAndAdministrator();
    h.hook.ask = false;
    // The row the shell used to hand over by itself before cinatra#4137.
    const connectionId = existingConnection(FIXTURE_ID, "twenty-workspace");
    vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));

    await boot();

    expect(h.hook.offered).toBe(true);
    expect(ownerOf(connectionId)).toBe(FIXTURE_ID);
    expect(h.nango.get(connectionId)).toBe(KEY);
  });

  it("a preview instance hands over the connection the fixture account an earlier development boot left owns", async () => {
    ENV.CINATRA_RUNTIME_MODE = "production";
    ENV.NODE_ENV = "production";
    ENV.CINATRA_INSTALL_PROFILE = "preview";
    seatUser({ id: FIXTURE_ID, email: FIXTURE_EMAIL, userType: "uat-fixture", createdAt: 10 });
    seatUser({ id: ADMIN_ID, email: "operator@example.test", role: "admin", createdAt: 20 });
    const connectionId = existingConnection(FIXTURE_ID);

    await boot();

    expect(h.hook.outcome).toBe("reowned");
    expect(ownerOf(connectionId)).toBe(ADMIN_ID);
  });
});
