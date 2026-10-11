// cinatra#4098 — `runDevAutoSetup` by install: development runs the connector
// devSetup hooks (as today), a preview instance (the `preview` install profile
// on a production runtime) runs the connector hooks ONLY, and a production
// deployment skips everything. The development fixture account stays unseeded
// on a preview: its rule keeps refusing a production runtime.
//
// One fake connector is materialized on disk (the shell's discovery reads
// `<cwd>/extensions/<vendor>/<slug>/package.json`) and its hook is served by the
// generated loader map. Every database, sign-in and fixture-password seam is a
// module mock registered ONCE (KB-133: no per-case re-registration), so no case
// reaches a database, a file under the instance or a container.
//
// SECRET BOUNDARY: assertions read statuses and call counts only.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
}));
const { FAKE_PACKAGE, runDevSetup, runPostgresQueriesSync, signUpEmail, resolveDevFixturePassword } = h;

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
  retireDevFixturePassword: vi.fn(),
  rotateDevFixturePassword: vi.fn(),
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
  root = mkdtempSync(path.join(tmpdir(), "dev-auto-setup-4098-"));
  const pkgDir = path.join(root, "extensions", "cinatra-unit", "fake-4098-connector");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: FAKE_PACKAGE, cinatra: { devSetup: "./src/dev-setup" } }),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
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
    // No fixture account: no password resolved, no sign-up, no database read or write.
    expect(resolveDevFixturePassword).not.toHaveBeenCalled();
    expect(signUpEmail).not.toHaveBeenCalled();
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
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
