// cinatra#4112 — who owns the connections a development (or preview) boot makes
// when the development fixture account is not available.
//
// The Twenty CRM attach (`devAttachTwentyBearerFromMintedKey`) is made for the
// actor the boot shell pushes through `setDevActorForExternalMcp` before the
// connector hooks run. On a private development boot that is the fixture
// account, exactly as before. On an instance that refuses the fixture account
// it is the instance's FIRST ADMINISTRATOR and that administrator's
// organisation. A production deployment pushes nobody, and an instance with no
// administrator yet pushes nobody and says so.
//
// One fake connector is materialized on disk (the shell's discovery reads
// `<cwd>/extensions/<vendor>/<slug>/package.json`) and its hook is served by the
// generated loader map; the hook records the owner it would attach for. Every
// database, sign-in and fixture-password seam is a module mock registered ONCE
// (KB-133: no per-case re-registration). The module under test is re-imported
// per case so its in-process fixture-actor cache never leaks between cases.
//
// SECRET BOUNDARY: assertions read ids, statuses and call counts only.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Owner = { userId: string; organizationId: string } | null;
type Query = { text: string; values?: unknown[] };

// Every value a hoisted `vi.mock` factory reads is made by `vi.hoisted`.
const h = vi.hoisted(() => {
  const state = {
    /** The owner the shell last pushed into the external-MCP holder. */
    pushedOwner: null as { userId: string; organizationId: string } | null,
    /** The owner the connector hook saw when it ran (what the attach would use). */
    ownerAtHook: undefined as { userId: string; organizationId: string } | null | undefined,
    publicBaseUrl: null as string | null,
    fixtureUserId: null as string | null,
    adminUserId: null as string | null,
    orgByUser: {} as Record<string, string>,
    adminQueries: [] as string[],
  };
  return {
    FAKE_PACKAGE: "@cinatra-unit/fake-4112-connector",
    state,
    setDevActorForExternalMcp: vi.fn((owner: { userId: string; organizationId: string } | null) => {
      state.pushedOwner = owner;
    }),
    runDevSetup: vi.fn(async () => {
      state.ownerAtHook = state.pushedOwner;
      return { status: "skipped" as const, reason: "unit fake hook" };
    }),
    signUpEmail: vi.fn<(...args: unknown[]) => Promise<never>>(async () => {
      throw new Error("registration is closed in this unit test");
    }),
    rotateDevFixturePassword: vi.fn(async () => true),
    removeDevFixturePasswordFile: vi.fn(),
  };
});
const { FAKE_PACKAGE, state, setDevActorForExternalMcp, runDevSetup, signUpEmail } = h;

function answer(query: { text: string; values?: unknown[] }): { rows: unknown[] } {
  const text = query.text;
  if (text.includes("WHERE email = $1")) {
    return { rows: h.state.fixtureUserId ? [{ id: h.state.fixtureUserId }] : [] };
  }
  if (text.includes("regexp_split_to_table")) {
    h.state.adminQueries.push(text);
    return { rows: h.state.adminUserId ? [{ id: h.state.adminUserId }] : [] };
  }
  if (text.includes('FROM public."member"')) {
    const org = h.state.orgByUser[String(query.values?.[0])];
    return { rows: org ? [{ id: org }] : [] };
  }
  if (text.includes('SET "userType"')) return { rows: [] };
  if (text.includes('"userType" = $2')) return { rows: [{ marked: 1 }] };
  // The connector access seed's "earliest user" read: no users, so it skips.
  return { rows: [] };
}

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

vi.mock("@/lib/generated/extensions.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  GENERATED_DEV_SETUP_MODULES: {
    [h.FAKE_PACKAGE]: { resolution: "guardedOptional", load: async () => ({ runDevSetup: h.runDevSetup }) },
  },
}));

vi.mock("@/lib/postgres-sync", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runPostgresQueriesSync: (input: { queries: Query[] }) => input.queries.map((q) => answer(q)),
}));

vi.mock("@/lib/external-mcp-registry", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setDevActorForExternalMcp: (owner: Owner) => h.setDevActorForExternalMcp(owner),
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auth: { api: { signUpEmail: (...args: unknown[]) => h.signUpEmail(...args) }, $context: Promise.resolve({}) },
}));

vi.mock("@/lib/dev-fixture-secret", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveDevFixturePassword: () => ({ password: "unit-only", source: "generated" }),
  printDevFixtureSecretOnce: vi.fn(),
  removeDevFixturePasswordFile: () => h.removeDevFixturePasswordFile(),
  retireDevFixturePassword: vi.fn(async () => true),
  rotateDevFixturePassword: () => h.rotateDevFixturePassword(),
}));

vi.mock("@cinatra-ai/mcp-server/credentials", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMcpPublicBaseUrl: () => ({ publicBaseUrl: h.state.publicBaseUrl, publicBaseUrlSource: "none" }),
}));

type DevAutoSetupModule = typeof import("@/lib/dev-auto-setup");

const KEYS = [
  "CINATRA_RUNTIME_MODE",
  "CINATRA_INSTALL_PROFILE",
  "NODE_ENV",
  "NEXT_PUBLIC_APP_URL",
  "BETTER_AUTH_URL",
  "NEXT_PUBLIC_BETTER_AUTH_URL",
] as const;
type Env = Partial<Record<(typeof KEYS)[number], string>>;

// NODE_ENV is typed read-only on process.env; the cases set it through this view.
const ENV = process.env as Record<string, string | undefined>;

const LANE_ADDRESS = "https://lane-4112.example.com";
const ADMIN = { userId: "admin-user-1", organizationId: "org-default" };
const FIXTURE = { userId: "fixture-user-1", organizationId: "org-default" };

let root = "";
let saved: Record<string, string | undefined> = {};
let cwdSpy: { mockRestore: () => void } | null = null;
let logSpy: { mockRestore: () => void; mock: { calls: unknown[][] } } | null = null;
let mod: DevAutoSetupModule;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "dev-auto-setup-4112-"));
  const pkgDir = path.join(root, "extensions", "cinatra-unit", "fake-4112-connector");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: FAKE_PACKAGE, cinatra: { devSetup: "./src/dev-setup" } }),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(state, {
    pushedOwner: null,
    ownerAtHook: undefined,
    publicBaseUrl: null,
    fixtureUserId: null,
    adminUserId: null,
    orgByUser: {},
    adminQueries: [],
  });
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  setEnv({ CINATRA_RUNTIME_MODE: "development", NODE_ENV: "test" });
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  // A fresh module per case: the shell caches the fixture actor in-process.
  vi.resetModules();
  mod = await import("@/lib/dev-auto-setup");
});

afterEach(() => {
  logSpy?.mockRestore();
  logSpy = null;
  cwdSpy?.mockRestore();
  cwdSpy = null;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete ENV[k];
    else ENV[k] = saved[k];
  }
});

function setEnv(env: Env): void {
  for (const k of KEYS) {
    if (env[k] === undefined) delete ENV[k];
    else ENV[k] = env[k];
  }
}

function logLines(): string[] {
  return (logSpy?.mock.calls ?? []).map((call) => call.map(String).join(" "));
}

function seatFirstAdministrator(): void {
  state.adminUserId = ADMIN.userId;
  state.orgByUser[ADMIN.userId] = ADMIN.organizationId;
}

describe("the owner of the install-made connections (cinatra#4112)", () => {
  it("fixture refused on a reachable instance: the connection is made for the first administrator and their organisation", async () => {
    state.publicBaseUrl = LANE_ADDRESS;
    seatFirstAdministrator();

    await mod.runDevAutoSetup();

    // The refusal is unchanged: no fixture sign-up, its password file is taken away.
    expect(signUpEmail).not.toHaveBeenCalled();
    expect(h.removeDevFixturePasswordFile).toHaveBeenCalled();
    expect(logLines().some((l) => l.includes("refusing to seed the development fixture account"))).toBe(true);
    // The first administrator is pushed BEFORE the connector hook runs.
    expect(runDevSetup).toHaveBeenCalledTimes(1);
    expect(state.ownerAtHook).toEqual(ADMIN);
    expect(setDevActorForExternalMcp).toHaveBeenCalledWith(ADMIN);
    expect(logLines().some((l) => l.includes(`made for the first administrator ${ADMIN.userId}`))).toBe(true);
  });

  it("fixture sign-up refused by a closed registration: the connection is made for the first administrator", async () => {
    // A private instance, so the exposure rule allows the fixture — but its
    // sign-up is refused (the mocked sign-up throws, as the closed-registration
    // gate does once a person exists) and no fixture row exists.
    seatFirstAdministrator();

    await mod.runDevAutoSetup();

    expect(signUpEmail).toHaveBeenCalledTimes(1);
    expect(state.ownerAtHook).toEqual(ADMIN);
  });

  it("fixture available: the connection stays the fixture account's and the first administrator is never read", async () => {
    state.fixtureUserId = FIXTURE.userId;
    state.orgByUser[FIXTURE.userId] = FIXTURE.organizationId;
    seatFirstAdministrator();

    await mod.runDevAutoSetup();

    expect(state.ownerAtHook).toEqual(FIXTURE);
    expect(setDevActorForExternalMcp).toHaveBeenCalledTimes(1);
    expect(setDevActorForExternalMcp).toHaveBeenCalledWith(FIXTURE);
    expect(state.adminQueries).toEqual([]);
  });

  it("no administrator yet: nothing is pushed, the attach stays not resolved, and one log line says why", async () => {
    state.publicBaseUrl = LANE_ADDRESS;

    await mod.runDevAutoSetup();

    expect(runDevSetup).toHaveBeenCalledTimes(1);
    expect(state.ownerAtHook ?? null).toBeNull();
    expect(setDevActorForExternalMcp).not.toHaveBeenCalledWith(expect.objectContaining({ userId: expect.any(String) }));
    const lines = logLines().filter((l) => l.includes("no first administrator on this instance yet"));
    expect(lines).toHaveLength(1);
  });

  it("an administrator without an organisation is not an owner either", async () => {
    state.publicBaseUrl = LANE_ADDRESS;
    state.adminUserId = ADMIN.userId;

    await mod.runDevAutoSetup();

    expect(state.ownerAtHook ?? null).toBeNull();
    expect(logLines().some((l) => l.includes("has no organisation yet"))).toBe(true);
  });

  it("the first administrator is a real person holding the admin role — never the fixture or another machine account", async () => {
    state.publicBaseUrl = LANE_ADDRESS;
    seatFirstAdministrator();

    await mod.runDevAutoSetup();

    expect(state.adminQueries).toHaveLength(1);
    const sql = state.adminQueries[0]!;
    expect(sql).toMatch(/r = 'admin'/);
    expect(sql).toMatch(/COALESCE\("userType", 'human'\) = 'human'/);
    expect(sql).toMatch(/ORDER BY "createdAt" ASC/);
  });

  it("production: no auto-connect — no owner is pushed and nothing is read", async () => {
    seatFirstAdministrator();
    for (const env of [
      { CINATRA_RUNTIME_MODE: "production", NODE_ENV: "production" },
      { CINATRA_RUNTIME_MODE: "production", NODE_ENV: "production", CINATRA_INSTALL_PROFILE: "demo" },
      { NODE_ENV: "production", CINATRA_INSTALL_PROFILE: "preview" },
      { CINATRA_RUNTIME_MODE: "development", NODE_ENV: "production" },
    ] satisfies Env[]) {
      setEnv(env);
      const result = await mod.runDevAutoSetup();
      expect(result).toEqual({ hooks: [], connectorPolicies: { status: "skipped", reason: "not development" } });
      expect(mod.adoptFirstAdministratorAsConnectionOwner()).toBeNull();
    }
    expect(runDevSetup).not.toHaveBeenCalled();
    expect(setDevActorForExternalMcp).not.toHaveBeenCalled();
    expect(state.adminQueries).toEqual([]);
  });

  it("a preview instance may adopt the first administrator (cinatra#4098 runs the connector hooks there)", () => {
    setEnv({ CINATRA_RUNTIME_MODE: "production", NODE_ENV: "production", CINATRA_INSTALL_PROFILE: "preview" });
    seatFirstAdministrator();

    expect(mod.adoptFirstAdministratorAsConnectionOwner()).toEqual(ADMIN);
    expect(setDevActorForExternalMcp).toHaveBeenCalledWith(ADMIN);
  });
});
