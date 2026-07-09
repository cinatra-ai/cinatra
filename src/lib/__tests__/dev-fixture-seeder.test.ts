/**
 * Dev-fixture seeder — idempotent provenance logic + end-to-end seeding.
 *
 * The pure `decideFixtureAction` matrix is tested directly. The full
 * `runDevFixtureSeeder` is exercised against the REAL `createExtensionHostContext`
 * with the host's DB / actor / mcp / fs / pg deps mocked, proving: create →
 * idempotent re-run skip → user-edit skip → ungranted-port fail-loud.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decideFixtureAction, checksumOf } from "@/lib/dev-fixture-seeder";

// ---- pure decision matrix ----
describe("decideFixtureAction", () => {
  const base = { pkg: "@x/p", fixtureId: "f1", rev: 1 };
  it("CREATE when no row exists", () => {
    expect(decideFixtureAction({ ...base, currentExists: false, currentChecksum: null, prov: null })).toBe("create");
  });
  it("SKIP when a row exists with no provenance sidecar (user-owned)", () => {
    expect(decideFixtureAction({ ...base, currentExists: true, currentChecksum: "abc", prov: null })).toBe("skip");
  });
  it("SKIP when the stored checksum diverged from the seeded checksum (user edited)", () => {
    const prov = { pkg: "@x/p", id: "f1", rev: 1, checksum: "seeded" };
    expect(decideFixtureAction({ ...base, currentExists: true, currentChecksum: "user-edited", prov })).toBe("skip");
  });
  it("SKIP when still fixture-owned + already at this rev (converged)", () => {
    const prov = { pkg: "@x/p", id: "f1", rev: 1, checksum: "seeded" };
    expect(decideFixtureAction({ ...base, rev: 1, currentExists: true, currentChecksum: "seeded", prov })).toBe("skip");
  });
  it("REPLACE when still fixture-owned + the fixture-set revision advanced", () => {
    const prov = { pkg: "@x/p", id: "f1", rev: 1, checksum: "seeded" };
    expect(decideFixtureAction({ ...base, rev: 2, currentExists: true, currentChecksum: "seeded", prov })).toBe("replace");
  });
  it("SKIP when the provenance pkg/id does not match (another fixture/owner)", () => {
    const prov = { pkg: "@other/p", id: "f1", rev: 1, checksum: "seeded" };
    expect(decideFixtureAction({ ...base, currentExists: true, currentChecksum: "seeded", prov })).toBe("skip");
  });
});

// ---- end-to-end seeding with mocked host deps ----
const { kv, actorOrg, fsMock } = vi.hoisted(() => ({
  kv: new Map<string, unknown>(),
  actorOrg: { current: "orgDev" as string | null },
  fsMock: {
    // vendor → slugs; "<vendor>/<slug>/package.json" → text; "<vendor>/<slug>/<path>" → fixture text
    extensions: [] as Array<{ vendor: string; slug: string; pkgJson: string; fixturePath: string; fixtureText: string }>,
  },
}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (input: { queries: { text: string }[] }) => {
    const text = input.queries[0]?.text ?? "";
    if (text.includes('public."user"')) return [{ rows: actorOrg.current ? [{ id: "userDev" }] : [] }];
    if (text.includes('public."member"')) return [{ rows: actorOrg.current ? [{ id: actorOrg.current }] : [] }];
    return [{ rows: [] }];
  },
}));

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: <T>(id: string, fb: T): T => (kv.has(id) ? (kv.get(id) as T) : fb),
  writeConnectorConfigToDatabase: (id: string, v: unknown): void => {
    kv.set(id, v);
  },
  deleteConnectorConfig: (id: string): void => {
    kv.delete(id);
  },
  getPostgresConnectionString: () => "postgres://stub",
}));

vi.mock("@/lib/extension-host-actor", () => ({
  requireExtensionOrganizationId: async (): Promise<string> => {
    if (!actorOrg.current) throw new Error("no org");
    return actorOrg.current;
  },
  resolveExtensionActorContext: async () => null,
  resolveExtensionActorSummary: async () => null,
}));

vi.mock("@cinatra-ai/mcp-server", () => ({
  // Passthrough that AWAITS fn so the async ctx.settings calls run within scope.
  mcpRequestContextStorage: {
    run: async (_store: unknown, fn: () => unknown) => await fn(),
    getStore: () => undefined,
  },
  registerExtensionMcpTool: () => {},
}));

vi.mock("node:fs/promises", () => ({
  readdir: async (p: string): Promise<string[]> => {
    if (p.endsWith("/extensions")) return [...new Set(fsMock.extensions.map((e) => e.vendor))];
    const m = p.match(/\/extensions\/([^/]+)$/);
    if (m) return fsMock.extensions.filter((e) => e.vendor === m[1]).map((e) => e.slug);
    throw new Error(`unexpected readdir ${p}`);
  },
  readFile: async (p: string): Promise<string> => {
    for (const e of fsMock.extensions) {
      if (p.endsWith(`/extensions/${e.vendor}/${e.slug}/package.json`)) return e.pkgJson;
      if (p.endsWith(`/extensions/${e.vendor}/${e.slug}/${e.fixturePath}`)) return e.fixtureText;
    }
    throw new Error(`ENOENT ${p}`);
  },
}));

import { runDevFixtureSeeder } from "@/lib/dev-fixture-seeder";
import { devFixtureProvenanceKey } from "@/lib/extension-fixture-provenance";

const PKG = "@cinatra-ai/demo-fixture-connector";
const SETTING_KEY_PREFIX = `ext:${PKG}:orgDev:`;

function installFixtureExtension(opts: { ports?: string[]; version?: number; value?: unknown } = {}) {
  fsMock.extensions = [
    {
      vendor: "cinatra-ai",
      slug: "demo-fixture-connector",
      pkgJson: JSON.stringify({
        name: PKG,
        cinatra: { kind: "connector", requestedHostPorts: opts.ports ?? ["settings"], devFixtures: "cinatra/dev-fixtures.json" },
      }),
      fixturePath: "cinatra/dev-fixtures.json",
      fixtureText: JSON.stringify({
        version: opts.version ?? 1,
        fixtures: [{ id: "demo", surface: "setting", key: "pref", value: opts.value ?? "month" }],
      }),
    },
  ];
}

const ACTIVATION_ENV_KEYS = ["CINATRA_RUNTIME_MODE", "CINATRA_INSTALL_PROFILE", "CINATRA_DEV_FIXTURES"] as const;

describe("runDevFixtureSeeder — end-to-end", () => {
  let savedEnv: Record<string, string | undefined>;
  beforeEach(() => {
    kv.clear();
    actorOrg.current = "orgDev";
    fsMock.extensions = [];
    // Snapshot + enable seeding by default (demo profile in a development runtime)
    // so the create / idempotency / user-edit / grant cases below exercise the
    // seeding path. The activation guard itself is covered by the two cases at
    // the end of this block and by install-profile.test.ts.
    savedEnv = Object.fromEntries(ACTIVATION_ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.CINATRA_RUNTIME_MODE = "development";
    process.env.CINATRA_INSTALL_PROFILE = "demo";
    delete process.env.CINATRA_DEV_FIXTURES;
  });
  afterEach(() => {
    for (const k of ACTIVATION_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("skips when no dev user/org is resolvable", async () => {
    actorOrg.current = null;
    installFixtureExtension();
    const r = await runDevFixtureSeeder();
    expect(r.status).toBe("skipped");
    expect(r.created).toBe(0);
  });

  it("CREATEs a setting fixture on first run, then is idempotent (skip) on re-run", async () => {
    installFixtureExtension({ value: "month" });
    const r1 = await runDevFixtureSeeder();
    expect(r1.created).toBe(1);
    expect(kv.get(`${SETTING_KEY_PREFIX}pref`)).toBe("month");
    expect(kv.has(devFixtureProvenanceKey(PKG, "orgDev", "pref"))).toBe(true);

    const r2 = await runDevFixtureSeeder();
    expect(r2.created).toBe(0);
    expect(r2.skipped).toBe(1);
  });

  it("SKIPs (never clobbers) a setting a user edited since seeding", async () => {
    installFixtureExtension({ value: "month" });
    await runDevFixtureSeeder();
    // Simulate a user edit: change the stored value (checksum now diverges).
    kv.set(`${SETTING_KEY_PREFIX}pref`, "agenda-user-choice");
    const r = await runDevFixtureSeeder();
    expect(r.skipped).toBe(1);
    expect(r.replaced).toBe(0);
    expect(kv.get(`${SETTING_KEY_PREFIX}pref`)).toBe("agenda-user-choice"); // preserved
  });

  it("REPLACEs an unchanged fixture-owned row when the fixture-set version advances", async () => {
    installFixtureExtension({ value: "month", version: 1 });
    await runDevFixtureSeeder();
    installFixtureExtension({ value: "week", version: 2 }); // new rev + new value
    const r = await runDevFixtureSeeder();
    expect(r.replaced).toBe(1);
    expect(kv.get(`${SETTING_KEY_PREFIX}pref`)).toBe("week");
  });

  it("fails loud (records an error) when a setting fixture targets an extension WITHOUT the settings grant", async () => {
    installFixtureExtension({ ports: ["mcp"] }); // no "settings" grant
    const r = await runDevFixtureSeeder();
    expect(r.status).toBe("error");
    expect(r.errors.join(" ")).toMatch(/NOT GRANTED/);
    expect(r.created).toBe(0);
  });

  it("computes a stable checksum insensitive to object key order", () => {
    expect(checksumOf({ a: 1, b: 2 })).toBe(checksumOf({ b: 2, a: 1 }));
  });

  // ── fixtures relocation (cinatra-cli#122): demo-mandatory / dev-opt-in ──────
  it("SKIPS entirely (activation guard) on a plain dev boot — no profile, no opt-in", async () => {
    process.env.CINATRA_INSTALL_PROFILE = "dev";
    delete process.env.CINATRA_DEV_FIXTURES;
    installFixtureExtension({ value: "month" });
    const r = await runDevFixtureSeeder();
    expect(r.status).toBe("skipped");
    expect(r.created).toBe(0);
    expect(kv.has(`${SETTING_KEY_PREFIX}pref`)).toBe(false); // never seeded
  });

  it("SEEDS on a plain dev boot when opted in via CINATRA_DEV_FIXTURES=1", async () => {
    process.env.CINATRA_INSTALL_PROFILE = "dev";
    process.env.CINATRA_DEV_FIXTURES = "1";
    installFixtureExtension({ value: "month" });
    const r = await runDevFixtureSeeder();
    expect(r.created).toBe(1);
    expect(kv.get(`${SETTING_KEY_PREFIX}pref`)).toBe("month");
  });
});
