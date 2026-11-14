// cinatra#4112 — the Twenty CRM connection a development boot makes, driven
// end to end through the REAL pieces: the real boot shell (`runDevAutoSetup`),
// the REAL pinned twenty-connector `cinatra.devSetup` hook (imported from the
// materialized extensions checkout, the same module the generated loader
// serves), and the REAL host registry writers the hook reaches
// (`getExternalMcpServerById`, `upsertExternalMcpServer`,
// `resolveExternalMcpServerBearer`, `devAttachTwentyBearerFromMintedKey` ->
// `saveTwentyConnection`, `disconnectTwentyConnection`).
//
// Only the edges are faked, each faithfully and in memory:
//   - the database (`runPostgresQueriesSync`): the user / member rows the shell
//     reads and the `external_mcp_servers` table the registry reads and writes;
//     the first-administrator query is answered by evaluating the clauses the
//     query text actually carries, so a clause missing from the product SQL is
//     a clause missing from the answer;
//   - the connection service (Nango): a key store per connection id;
//   - the connection identity store + the identity seam: live rows unique per
//     natural key, soft delete, a conflicting owner refused;
//   - the use gate: allows a connection whose live identity carries the
//     workspace grant the sanctioned save seeds;
//   - Twenty: `docker exec … generate-api-key` mints a fresh key, the REST
//     probe answers 200 for a key Twenty knows and 401 otherwise.
//
// Each `boot()` is a fresh process (modules re-imported) over the same stored
// state, so a second boot sees exactly what the first one left behind.
//
// SECRET BOUNDARY: the keys here are synthetic test values; assertions compare
// them by identity only.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TWENTY_HOOK_SOURCE = path.resolve(
  __dirname,
  "../../../extensions/cinatra-ai/twenty-connector/src/dev-setup.ts",
);

type UserRow = { id: string; email: string; role: string | null; userType: string | null; createdAt: number };
type ServerRow = {
  id: string;
  label: string;
  server_url: string;
  nango_connection_id: string | null;
  scope: string;
  org_id: string | null;
  user_id: string | null;
  enabled: boolean;
  allowed_tools: string[] | null;
  allowed_catalog_tools: string[] | null;
  transport: string | null;
  created_at: Date;
  updated_at: Date;
};
type Identity = {
  id: string;
  organizationId: string | null;
  connectorPackageId: string;
  connectorKey: string;
  connectionId: string;
  ownerUserId: string;
  createdAt: Date;
  deletedAt: Date | null;
};

const h = vi.hoisted(() => {
  const db = {
    users: [] as Array<{ id: string; email: string; role: string | null; userType: string | null; createdAt: number }>,
    members: [] as Array<{ userId: string; organizationId: string; createdAt: number }>,
    servers: new Map<string, Record<string, unknown>>(),
  };
  const nango = new Map<string, string>();
  const identities: Array<Record<string, unknown> & { id: string; connectorKey: string; connectionId: string; ownerUserId: string; organizationId: string | null; deletedAt: Date | null }> = [];
  const grants = new Set<string>();
  const twenty = { validKeys: new Set<string>(), down: false, minted: 0 };
  // Injected faults (each one-shot or budgeted, reset per case).
  const faults = {
    /** The next N connection-service credential reads throw. */
    nangoReadThrows: 0,
    /** The next identity registration for this owner inserts its row, then fails. */
    identityFailOwner: null as string | null,
    /** After this many authenticated REST answers, Twenty answers 503. */
    restOkBudget: null as number | null,
  };
  return {
    faults,
    db,
    nango,
    identities,
    grants,
    twenty,
    publicBaseUrl: { value: null as string | null },
    surfaces: { registry: null as unknown, nango: null as unknown },
    hookPath: { value: "" },
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
    if (trimmed.startsWith("INSERT")) {
      const [id, label, serverUrl, nangoConnectionId, scope, orgId, userId, enabled, allowedTools, allowedCatalogTools, transport] = values;
      const prior = h.db.servers.get(String(id));
      h.db.servers.set(String(id), {
        id,
        label,
        server_url: serverUrl,
        nango_connection_id: nangoConnectionId,
        scope,
        org_id: orgId,
        user_id: userId,
        enabled,
        allowed_tools: allowedTools,
        allowed_catalog_tools: allowedCatalogTools,
        transport,
        created_at: prior?.created_at ?? new Date(),
        updated_at: new Date(),
      });
      return { rows: [] };
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
    // Evaluate exactly the clauses the product query carries.
    let rows = h.db.users.filter((u) =>
      (u.role ?? "").split(",").map((r) => r.trim()).includes("admin"),
    );
    if (text.includes("id NOT LIKE 'usr-%'")) rows = rows.filter((u) => !u.id.startsWith("usr-"));
    if (text.includes(`COALESCE("userType", 'human') = 'human'`)) {
      rows = rows.filter((u) => (u.userType ?? "human") === "human");
    }
    if (text.includes("lower(email) <> lower($1)")) {
      rows = rows.filter((u) => u.email.toLowerCase() !== String(values[0]).toLowerCase());
    }
    rows = [...rows].sort((a, b) => a.createdAt - b.createdAt);
    return { rows: rows.slice(0, 1).map((u) => ({ id: u.id })) };
  }
  if (text.includes('FROM public."member"')) {
    const m = h.db.members
      .filter((r) => r.userId === values[0])
      .sort((a, b) => a.createdAt - b.createdAt)[0];
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
  // The connector access seed's "earliest user" read is out of scope here:
  // answering none makes that seed skip.
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
  ensureNangoIntegration: async () => undefined,
  importNangoConnection: async (input: { connectionId: string; credentials: { apiKey: string } }) => {
    h.nango.set(input.connectionId, input.credentials.apiKey);
  },
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
  return h.identities.find(
    (r) => r.connectorKey === connectorKey && r.connectionId === connectionId && r.deletedAt === null,
  ) ?? null;
}

vi.mock("@cinatra-ai/extensions/connection-identity-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readNangoConnectionByNaturalKey: async (connectorKey: string, connectionId: string) =>
    liveIdentity(connectorKey, connectionId),
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
    // ON CONFLICT against the live-unique index returns the existing live row.
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
    if (row.ownerUserId !== input.ownerUserId) {
      throw new Error("The connection is already registered to a different user");
    }
    if (h.faults.identityFailOwner === input.ownerUserId) {
      // The row is standing; the grant seed after it fails.
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
      if (!h.grants.has(input.identity.id)) {
        throw Object.create(original.ConnectionUseDeniedError.prototype);
      }
    },
  };
});

vi.mock("@/lib/connector-client-providers", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listManagedExternalMcpEndpointUrls: () => [],
}));

// ---- Twenty: the container, its health check and its key mint --------------

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawnSync: (cmd: string, argv: string[]) => {
    if (cmd === "docker" && argv[0] === "ps") return { status: 0, stdout: "cinatra-twenty-1\n", stderr: "" };
    if (cmd === "curl") return { status: h.twenty.down ? 7 : 0, stdout: "", stderr: "" };
    if (cmd === "docker" && argv[0] === "exec" && argv.includes("workspace:generate-api-key")) {
      h.twenty.minted += 1;
      const key = `eyJunit.eyJmint${h.twenty.minted}.sig${h.twenty.minted}`;
      h.twenty.validKeys.add(key);
      return { status: 0, stdout: `Generated API key: ${key}\n`, stderr: "" };
    }
    if (cmd === "docker" && argv[0] === "exec") return { status: 0, stdout: "", stderr: "" };
    return { status: 1, stdout: "", stderr: "" };
  },
}));

// ---- the shell's own seams -------------------------------------------------

vi.mock("@/lib/generated/extensions.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  GENERATED_DEV_SETUP_MODULES: {
    "@cinatra-ai/twenty-connector": {
      resolution: "guardedOptional",
      load: () => import(/* @vite-ignore */ h.hookPath.value),
    },
  },
}));

vi.mock("@/lib/extension-capabilities-registry", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveCapabilityProviders: (capability: string) => {
    if (capability === "@cinatra-ai/host:external-mcp-registry") return [{ impl: h.surfaces.registry }];
    if (capability === "nango-system") return [{ impl: h.surfaces.nango }];
    return [];
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
const LANE_ADDRESS = "https://lane-4112.example.com";
const ORG = "org-default";
const ADMIN_ID = "admin-user-1";
const FIXTURE_ID = "fixture-user-1";
const OTHER_ID = "other-admin-2";
const TWENTY_REST = "http://localhost:3300";
const CONNECTION_ID = `twenty-workspace-${createHash("sha256").update(TWENTY_REST).digest("hex").slice(0, 16)}`;

const KEYS = [
  "CINATRA_RUNTIME_MODE",
  "CINATRA_INSTALL_PROFILE",
  "NODE_ENV",
  "NEXT_PUBLIC_APP_URL",
  "BETTER_AUTH_URL",
  "NEXT_PUBLIC_BETTER_AUTH_URL",
] as const;
const ENV = process.env as Record<string, string | undefined>;

let root = "";
let saved: Record<string, string | undefined> = {};
const spies: Array<{ mockRestore: () => void }> = [];

beforeAll(() => {
  h.hookPath.value = TWENTY_HOOK_SOURCE;
  root = mkdtempSync(path.join(tmpdir(), "dev-auto-setup-4112-hook-"));
  // Discovery reads `<cwd>/extensions/<vendor>/<slug>/package.json`: declare
  // ONLY the Twenty connector, so no other connector's hook runs.
  const pkgDir = path.join(root, "extensions", "cinatra-ai", "twenty-connector");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "@cinatra-ai/twenty-connector", cinatra: { devSetup: "./src/dev-setup" } }),
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
  h.twenty.validKeys.clear();
  h.twenty.down = false;
  h.twenty.minted = 0;
  h.faults.nangoReadThrows = 0;
  h.faults.identityFailOwner = null;
  h.faults.restOkBudget = null;
  h.publicBaseUrl.value = null;
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete ENV[k];
  ENV.CINATRA_RUNTIME_MODE = "development";
  ENV.NODE_ENV = "test";
  spies.push(vi.spyOn(process, "cwd").mockReturnValue(root));
  for (const level of ["log", "warn", "error", "info"] as const) {
    spies.push(vi.spyOn(console, level).mockImplementation(() => {}));
  }
  vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
    if (h.twenty.down) return new Response(null, { status: 503 });
    if (String(url) === `${TWENTY_REST}/rest/companies?limit=1`) {
      const key = (init?.headers?.Authorization ?? "").replace(/^Bearer /, "");
      if (h.faults.restOkBudget !== null) {
        if (h.faults.restOkBudget <= 0) return new Response(null, { status: 503 });
        h.faults.restOkBudget -= 1;
      }
      return new Response(null, { status: h.twenty.validKeys.has(key) ? 200 : 401 });
    }
    return new Response(null, { status: 404 });
  });
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
  const reg = await import("@/lib/external-mcp-registry");
  const nango = await import("@/lib/nango-system");
  // The same surface `register-host-connector-services.ts` publishes.
  h.surfaces.registry = {
    upsertServer: reg.upsertExternalMcpServer,
    deleteServer: reg.deleteExternalMcpServer,
    getServerById: reg.getExternalMcpServerById,
    listServers: reg.listExternalMcpServers,
    resolveBearer: reg.resolveExternalMcpServerBearer,
    nangoProviderConfigKey: reg.EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY,
    devAttachTwentyBearer: (input: { instanceUrl: string; apiKey: string }) =>
      reg.devAttachTwentyBearerFromMintedKey(input),
  };
  h.surfaces.nango = {
    isNangoConfigured: nango.isNangoConfigured,
    ensureNangoIntegration: nango.ensureNangoIntegration,
    importNangoConnection: nango.importNangoConnection,
    getNangoCredentials: nango.getNangoCredentials,
  };
  const { runDevAutoSetup } = await import("@/lib/dev-auto-setup");
  const result = await runDevAutoSetup();
  // The REAL Twenty hook ran: discovered, loaded and returned a status of its
  // own (an import failure or a missing entry point would be an "error").
  expect(result.hooks.map((r) => r.packageName)).toEqual(["@cinatra-ai/twenty-connector"]);
  expect(result.hooks[0]?.status.status).not.toBe("error");
}

function seatUser(user: Partial<UserRow> & { id: string; email: string; createdAt: number }, org = ORG): void {
  h.db.users.push({ role: null, userType: "human", ...user });
  h.db.members.push({ userId: user.id, organizationId: org, createdAt: user.createdAt });
}

function seatFirstAdministrator(createdAt = 20): void {
  seatUser({ id: ADMIN_ID, email: "operator@example.test", role: "admin", createdAt });
}

/** A Twenty connection an earlier boot attached for `owner`. */
function existingConnection(owner: string, keyWorks: boolean): string {
  const key = "eyJunit.eyJearlier.sig0";
  if (keyWorks) h.twenty.validKeys.add(key);
  h.nango.set(CONNECTION_ID, key);
  h.db.servers.set("twenty-workspace", {
    id: "twenty-workspace",
    label: "Twenty CRM (local dev)",
    server_url: `${TWENTY_REST}/mcp`,
    nango_connection_id: CONNECTION_ID,
    scope: "workspace",
    org_id: null,
    user_id: null,
    enabled: true,
    allowed_tools: null,
    allowed_catalog_tools: ["find_companies"],
    transport: "unknown",
    created_at: new Date(0),
    updated_at: new Date(0),
  });
  const identity: Identity = {
    id: "identity-earlier",
    organizationId: ORG,
    connectorPackageId: "@unit/external-mcp",
    connectorKey: "externalMcp",
    connectionId: CONNECTION_ID,
    ownerUserId: owner,
    createdAt: new Date(0),
    deletedAt: null,
  };
  h.identities.push(identity);
  h.grants.add(identity.id);
  return key;
}

function twentyRow(): ServerRow | undefined {
  return h.db.servers.get("twenty-workspace") as ServerRow | undefined;
}

function twentyOwner(): { ownerUserId: string; organizationId: string | null } | null {
  const row = twentyRow();
  if (!row?.nango_connection_id) return null;
  const identity = liveIdentity("externalMcp", row.nango_connection_id);
  return identity ? { ownerUserId: identity.ownerUserId, organizationId: identity.organizationId } : null;
}

/** The gated resolver — the one a run's list picker reaches — mints a working key. */
async function resolvesWorkingKey(): Promise<boolean> {
  const reg = await import("@/lib/external-mcp-registry");
  const row = reg.getExternalMcpServerByIdFresh("twenty-workspace");
  if (!row) return false;
  const key = await reg.resolveExternalMcpServerBearer(row);
  return key != null && h.twenty.validKeys.has(key);
}

const hookPresent = existsSync(TWENTY_HOOK_SOURCE);

describe.skipIf(!hookPresent)("the Twenty connection a development boot makes (cinatra#4112, real hook)", () => {
  it("a lane boot that refuses the fixture account connects Twenty for the first administrator", async () => {
    h.publicBaseUrl.value = LANE_ADDRESS;
    seatUser({ id: FIXTURE_ID, email: FIXTURE_EMAIL, userType: "uat-fixture", createdAt: 10 });
    seatFirstAdministrator();

    await boot();

    expect(twentyRow()?.nango_connection_id).toBe(CONNECTION_ID);
    expect(twentyOwner()).toEqual({ ownerUserId: ADMIN_ID, organizationId: ORG });
    expect(await resolvesWorkingKey()).toBe(true);
    expect(h.twenty.minted).toBe(1);
  });

  it("a legacy fixture row (human, admin, older than the real administrator) is never chosen", async () => {
    h.publicBaseUrl.value = LANE_ADDRESS;
    // The #1135 shape: the fixture row was seeded as a human and promoted.
    seatUser({ id: FIXTURE_ID, email: FIXTURE_EMAIL, userType: "human", role: "admin", createdAt: 10 });
    seatFirstAdministrator(20);

    await boot();

    expect(twentyOwner()).toEqual({ ownerUserId: ADMIN_ID, organizationId: ORG });
  });

  it("the refused fixture's WORKING connection is handed to the first administrator without minting a key", async () => {
    h.publicBaseUrl.value = LANE_ADDRESS;
    seatUser({ id: FIXTURE_ID, email: FIXTURE_EMAIL, userType: "uat-fixture", createdAt: 10 });
    seatFirstAdministrator();
    const key = existingConnection(FIXTURE_ID, true);

    await boot();

    expect(twentyOwner()).toEqual({ ownerUserId: ADMIN_ID, organizationId: ORG });
    expect(h.nango.get(CONNECTION_ID)).toBe(key);
    expect(h.twenty.minted).toBe(0);
    expect(await resolvesWorkingKey()).toBe(true);

    await boot();
    expect(twentyOwner()).toEqual({ ownerUserId: ADMIN_ID, organizationId: ORG });
    expect(h.twenty.minted).toBe(0);
  });

  it("the refused fixture's DEAD connection (401) is replaced once for the first administrator, and not again", async () => {
    h.publicBaseUrl.value = LANE_ADDRESS;
    seatUser({ id: FIXTURE_ID, email: FIXTURE_EMAIL, userType: "uat-fixture", createdAt: 10 });
    seatFirstAdministrator();
    existingConnection(FIXTURE_ID, false);

    await boot();

    expect(twentyOwner()).toEqual({ ownerUserId: ADMIN_ID, organizationId: ORG });
    expect(await resolvesWorkingKey()).toBe(true);
    expect(h.twenty.minted).toBe(1);

    await boot();
    await boot();
    expect(twentyOwner()).toEqual({ ownerUserId: ADMIN_ID, organizationId: ORG });
    expect(h.twenty.minted).toBe(1);
  });

  it("a connection another person owns is never handed over — the foreign-owner guard still refuses", async () => {
    h.publicBaseUrl.value = LANE_ADDRESS;
    seatUser({ id: FIXTURE_ID, email: FIXTURE_EMAIL, userType: "uat-fixture", createdAt: 10 });
    seatFirstAdministrator();
    seatUser({ id: OTHER_ID, email: "second@example.test", role: "admin", createdAt: 30 });
    const key = existingConnection(OTHER_ID, false);

    await boot();

    expect(twentyOwner()).toEqual({ ownerUserId: OTHER_ID, organizationId: ORG });
    expect(twentyRow()?.nango_connection_id).toBe(CONNECTION_ID);
    expect(h.nango.get(CONNECTION_ID)).toBe(key);
  });

  it("while Twenty cannot be reached, the refused fixture's connection is left as it is", async () => {
    h.publicBaseUrl.value = LANE_ADDRESS;
    seatUser({ id: FIXTURE_ID, email: FIXTURE_EMAIL, userType: "uat-fixture", createdAt: 10 });
    seatFirstAdministrator();
    const key = existingConnection(FIXTURE_ID, true);
    h.twenty.down = true;

    await boot();

    expect(twentyOwner()).toEqual({ ownerUserId: FIXTURE_ID, organizationId: ORG });
    expect(h.nango.get(CONNECTION_ID)).toBe(key);
    expect(h.twenty.minted).toBe(0);
  });

  // ---- fault injection: an uncertain moment never makes things worse --------

  it("a transient connection-service read failure changes nothing; the next boot hands the connection over", async () => {
    h.publicBaseUrl.value = LANE_ADDRESS;
    seatUser({ id: FIXTURE_ID, email: FIXTURE_EMAIL, userType: "uat-fixture", createdAt: 10 });
    seatFirstAdministrator();
    const key = existingConnection(FIXTURE_ID, true);
    h.faults.nangoReadThrows = 1;

    await boot();

    expect(twentyOwner()).toEqual({ ownerUserId: FIXTURE_ID, organizationId: ORG });
    expect(twentyRow()?.nango_connection_id).toBe(CONNECTION_ID);
    expect(h.nango.get(CONNECTION_ID)).toBe(key);
    expect(h.twenty.minted).toBe(0);

    await boot();
    expect(twentyOwner()).toEqual({ ownerUserId: ADMIN_ID, organizationId: ORG });
    expect(h.nango.get(CONNECTION_ID)).toBe(key);
    expect(h.twenty.minted).toBe(0);
  });

  it("a transient read failure while Twenty is also down changes nothing", async () => {
    h.publicBaseUrl.value = LANE_ADDRESS;
    seatUser({ id: FIXTURE_ID, email: FIXTURE_EMAIL, userType: "uat-fixture", createdAt: 10 });
    seatFirstAdministrator();
    const key = existingConnection(FIXTURE_ID, true);
    h.faults.nangoReadThrows = 1;
    h.twenty.down = true;

    await boot();

    expect(twentyOwner()).toEqual({ ownerUserId: FIXTURE_ID, organizationId: ORG });
    expect(twentyRow()?.nango_connection_id).toBe(CONNECTION_ID);
    expect(h.nango.get(CONNECTION_ID)).toBe(key);
    expect(h.twenty.minted).toBe(0);
  });

  it("Twenty failing (503) right after the key check leaves the connection with its key and a live owner", async () => {
    h.publicBaseUrl.value = LANE_ADDRESS;
    seatUser({ id: FIXTURE_ID, email: FIXTURE_EMAIL, userType: "uat-fixture", createdAt: 10 });
    seatFirstAdministrator();
    const key = existingConnection(FIXTURE_ID, true);
    // The key check answers; every later Twenty call answers 503.
    h.faults.restOkBudget = 1;

    await boot();

    expect(twentyRow()?.nango_connection_id).toBe(CONNECTION_ID);
    expect(h.nango.get(CONNECTION_ID)).toBe(key);
    expect(twentyOwner()).not.toBeNull();
    expect(h.twenty.minted).toBe(0);
  });

  it("a failed ownership registration is undone: the fixture keeps its working connection for a later retry", async () => {
    h.publicBaseUrl.value = LANE_ADDRESS;
    seatUser({ id: FIXTURE_ID, email: FIXTURE_EMAIL, userType: "uat-fixture", createdAt: 10 });
    seatFirstAdministrator();
    const key = existingConnection(FIXTURE_ID, true);
    h.faults.identityFailOwner = ADMIN_ID;

    await boot();

    expect(twentyOwner()).toEqual({ ownerUserId: FIXTURE_ID, organizationId: ORG });
    expect(twentyRow()?.nango_connection_id).toBe(CONNECTION_ID);
    expect(h.nango.get(CONNECTION_ID)).toBe(key);
    expect(await resolvesWorkingKey()).toBe(true);
    expect(h.twenty.minted).toBe(0);

    await boot();
    expect(twentyOwner()).toEqual({ ownerUserId: ADMIN_ID, organizationId: ORG });
    expect(h.nango.get(CONNECTION_ID)).toBe(key);
    expect(h.twenty.minted).toBe(0);
  });

  it("a private boot keeps the fixture account as the owner, as before", async () => {
    seatUser({ id: FIXTURE_ID, email: FIXTURE_EMAIL, userType: "uat-fixture", createdAt: 10 });
    seatFirstAdministrator();

    await boot();

    expect(twentyOwner()).toEqual({ ownerUserId: FIXTURE_ID, organizationId: ORG });
    expect(await resolvesWorkingKey()).toBe(true);
  });

  it("with no administrator yet, the row carries no connection and nothing is owned", async () => {
    h.publicBaseUrl.value = LANE_ADDRESS;
    seatUser({ id: FIXTURE_ID, email: FIXTURE_EMAIL, userType: "uat-fixture", createdAt: 10 });

    await boot();

    expect(twentyRow()?.nango_connection_id ?? null).toBeNull();
    expect(h.identities).toEqual([]);
  });
});
