// cinatra#4098 — `runDevAutoSetup` by install: development runs the connector
// devSetup hooks (as today), a preview instance (the `preview` install profile
// on a production runtime) runs the connector hooks ONLY, and a production
// deployment skips everything. The development fixture account stays unseeded
// on a preview: its rule keeps refusing a production runtime.
//
// The working directory has NO `extensions/` folder, as in the image: the
// shell names the connectors from the generated loader map, which serves one
// fake connector hook. Every database, sign-in, fixture-password and
// connection-owner seam is a module mock registered ONCE (KB-133: no per-case
// re-registration), so no case reaches a database, a file under the instance
// or a container. On a preview the install-made connections belong to the
// first administrator (cinatra#4112), and a connection an earlier development
// boot made for the fixture account is handed over to them.
//
// SECRET BOUNDARY: assertions read statuses and call counts only.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Every value a hoisted `vi.mock` factory reads is made by `vi.hoisted`.
const h = vi.hoisted(() => ({
  FAKE_PACKAGE: "@cinatra-unit/fake-4098-connector",
  spawnSync: vi.fn(),
  runDevSetup: vi.fn(async () => ({ status: "skipped" as const, reason: "unit fake hook" })),
  runPostgresQueriesSync: vi.fn<(...args: unknown[]) => Array<{ rows: unknown[] }>>(() => [{ rows: [] }]),
  signUpEmail: vi.fn<(...args: unknown[]) => Promise<never>>(async () => {
    throw new Error("no sign-in store in a unit test");
  }),
  resolveDevFixturePassword: vi.fn(() => ({ password: "unit-only", source: "generated" })),
  setDevActorForExternalMcp: vi.fn(),
  devReownRefusedFixtureTwentyConnection: vi.fn<(input: { refusedFixtureUserId: string }) => Promise<"reowned">>(
    async () => "reowned",
  ),
  rotateDevFixturePassword: vi.fn(),
  retireDevFixturePassword: vi.fn(),
  // The rows the database answers by the query it is asked: the first
  // administrator (the query that names the `admin` role), the fixture account
  // (the query by e-mail address) and an organisation membership.
  rows: { firstAdministrator: [] as Array<{ id: string }>, fixture: [] as Array<{ id: string }>, member: [] as Array<{ id: string }> },
}));
const {
  FAKE_PACKAGE,
  runDevSetup,
  runPostgresQueriesSync,
  signUpEmail,
  resolveDevFixturePassword,
  setDevActorForExternalMcp,
  devReownRefusedFixtureTwentyConnection,
  rotateDevFixturePassword,
  retireDevFixturePassword,
} = h;

vi.mock("node:child_process", () => ({ spawnSync: (...args: unknown[]) => h.spawnSync(...args) }));

vi.mock("@/lib/generated/extensions.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  GENERATED_DEV_SETUP_MODULES: {
    [h.FAKE_PACKAGE]: { resolution: "guardedOptional", load: async () => ({ runDevSetup: h.runDevSetup }) },
  },
}));

vi.mock("@/lib/postgres-sync", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runPostgresQueriesSync: (...args: unknown[]) => h.runPostgresQueriesSync(...args),
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auth: { api: { signUpEmail: (...args: unknown[]) => h.signUpEmail(...args) }, $context: Promise.resolve({}) },
}));

vi.mock("@/lib/dev-fixture-secret", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveDevFixturePassword: () => h.resolveDevFixturePassword(),
  printDevFixtureSecretOnce: vi.fn(),
  removeDevFixturePasswordFile: vi.fn(),
  rotateDevFixturePassword: (...args: unknown[]) => h.rotateDevFixturePassword(...args),
  retireDevFixturePassword: (...args: unknown[]) => h.retireDevFixturePassword(...args),
}));

vi.mock("@/lib/external-mcp-registry", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setDevActorForExternalMcp: (...args: unknown[]) => h.setDevActorForExternalMcp(...args),
  devReownRefusedFixtureTwentyConnection: (input: { refusedFixtureUserId: string }) =>
    h.devReownRefusedFixtureTwentyConnection(input),
}));

vi.mock("@cinatra-ai/mcp-server/credentials", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMcpPublicBaseUrl: () => ({ publicBaseUrl: null, publicBaseUrlSource: "none" }),
}));

import { runDevAutoSetup } from "@/lib/dev-auto-setup";
import { devFixtureSeedingAllowed } from "@/lib/dev-fixture-secret";

const KEYS = ["CINATRA_RUNTIME_MODE", "CINATRA_INSTALL_PROFILE", "NODE_ENV"] as const;
type Env = Partial<Record<(typeof KEYS)[number], string>>;

// NODE_ENV is typed read-only on process.env; the cases set it through this view.
const ENV = process.env as Record<string, string | undefined>;

let root = "";
let saved: Record<string, string | undefined> = {};
let cwdSpy: { mockRestore: () => void } | null = null;

beforeAll(() => {
  // An empty working directory: no `extensions/` checkout, as in the image.
  root = mkdtempSync(path.join(tmpdir(), "dev-auto-setup-4098-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.firstAdministrator = [];
  h.rows.fixture = [];
  h.rows.member = [];
  runPostgresQueriesSync.mockImplementation((...args: unknown[]) => {
    const input = args[0] as { queries?: Array<{ text?: string }> } | undefined;
    return (input?.queries ?? []).map((q) => {
      const text = q.text ?? "";
      if (text.includes("'admin'")) return { rows: h.rows.firstAdministrator };
      if (text.includes("WHERE email = $1")) return { rows: h.rows.fixture };
      if (text.includes('public."member"')) return { rows: h.rows.member };
      return { rows: [] };
    });
  });
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);
});

afterEach(() => {
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

describe("runDevAutoSetup by install (cinatra#4098)", () => {
  it("development runs the connector hooks", async () => {
    setEnv({ CINATRA_RUNTIME_MODE: "development", NODE_ENV: "test" });
    expect(existsSync(path.join(root, "extensions"))).toBe(false);
    const result = await runDevAutoSetup();
    expect(runDevSetup).toHaveBeenCalledTimes(1);
    expect(result.hooks.map((h) => h.packageName)).toEqual([FAKE_PACKAGE]);
  });

  it("production with the preview profile runs the connector hooks and nothing of the fixture setup", async () => {
    setEnv({ CINATRA_RUNTIME_MODE: "production", NODE_ENV: "production", CINATRA_INSTALL_PROFILE: "preview" });
    const result = await runDevAutoSetup();
    expect(runDevSetup).toHaveBeenCalledTimes(1);
    expect(result.hooks).toEqual([{ packageName: FAKE_PACKAGE, status: { status: "skipped", reason: "unit fake hook" } }]);
    expect(result.connectorPolicies).toEqual({
      status: "skipped",
      reason: "preview instance: connector hooks only, no development fixtures",
    });
    // No fixture account: no password resolved, rotated or retired, no sign-up,
    // and nothing written to the database (reads only).
    expect(resolveDevFixturePassword).not.toHaveBeenCalled();
    expect(rotateDevFixturePassword).not.toHaveBeenCalled();
    expect(retireDevFixturePassword).not.toHaveBeenCalled();
    expect(signUpEmail).not.toHaveBeenCalled();
    const texts = runPostgresQueriesSync.mock.calls.flatMap((call) =>
      ((call[0] as { queries?: Array<{ text?: string }> }).queries ?? []).map((q) => q.text ?? ""),
    );
    expect(texts.some((t) => /\b(INSERT|UPDATE|DELETE)\b/i.test(t))).toBe(false);
    // With no first administrator yet, no owner is pushed and nothing is handed over.
    expect(setDevActorForExternalMcp).toHaveBeenCalledWith(null);
    expect(devReownRefusedFixtureTwentyConnection).not.toHaveBeenCalled();
  });

  it("a preview makes the install's connections for the first administrator, before the hooks run", async () => {
    setEnv({ CINATRA_RUNTIME_MODE: "production", NODE_ENV: "production", CINATRA_INSTALL_PROFILE: "preview" });
    h.rows.firstAdministrator = [{ id: "admin-1" }];
    h.rows.member = [{ id: "org-1" }];
    let ownerWhenHookRan: unknown = "not run";
    runDevSetup.mockImplementationOnce(async () => {
      ownerWhenHookRan = setDevActorForExternalMcp.mock.calls.at(-1)?.[0];
      return { status: "skipped" as const, reason: "unit fake hook" };
    });
    await runDevAutoSetup();
    expect(setDevActorForExternalMcp).toHaveBeenCalledWith({ userId: "admin-1", organizationId: "org-1" });
    expect(ownerWhenHookRan).toEqual({ userId: "admin-1", organizationId: "org-1" });
    // No fixture account was left behind: there is nothing to hand over.
    expect(devReownRefusedFixtureTwentyConnection).not.toHaveBeenCalled();
  });

  it("a preview hands the fixture account's connection from an earlier development boot to the first administrator", async () => {
    setEnv({ CINATRA_RUNTIME_MODE: "production", NODE_ENV: "production", CINATRA_INSTALL_PROFILE: "preview" });
    h.rows.firstAdministrator = [{ id: "admin-1" }];
    h.rows.member = [{ id: "org-1" }];
    h.rows.fixture = [{ id: "fixture-1" }];
    await runDevAutoSetup();
    expect(devReownRefusedFixtureTwentyConnection).toHaveBeenCalledTimes(1);
    expect(devReownRefusedFixtureTwentyConnection).toHaveBeenCalledWith({ refusedFixtureUserId: "fixture-1" });
    // The account itself is only read: its password is never rotated or retired.
    expect(rotateDevFixturePassword).not.toHaveBeenCalled();
    expect(retireDevFixturePassword).not.toHaveBeenCalled();
    expect(runDevSetup).toHaveBeenCalledTimes(1);
  });

  it("production without the preview profile skips the auto-setup", async () => {
    for (const env of [
      { CINATRA_RUNTIME_MODE: "production", NODE_ENV: "production" },
      { CINATRA_RUNTIME_MODE: "production", NODE_ENV: "production", CINATRA_INSTALL_PROFILE: "demo" },
      { NODE_ENV: "production", CINATRA_INSTALL_PROFILE: "preview" },
    ] satisfies Env[]) {
      setEnv(env);
      const result = await runDevAutoSetup();
      expect(result).toEqual({ hooks: [], connectorPolicies: { status: "skipped", reason: "not development" } });
    }
    expect(runDevSetup).not.toHaveBeenCalled();
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("the fixture-account rule keeps refusing a preview's production runtime", () => {
    const decision = devFixtureSeedingAllowed({
      runtimeMode: "production",
      nodeEnv: "production",
      env: { CINATRA_RUNTIME_MODE: "production", CINATRA_INSTALL_PROFILE: "preview" },
      authBaseUrl: "http://localhost:3000",
      publicBaseUrl: null,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("runtime");
  });
});
