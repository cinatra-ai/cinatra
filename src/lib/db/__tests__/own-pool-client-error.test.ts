/**
 * A cut connection on a checked-out client of a module's own pool must not end
 * the process (cinatra#4151, the follow-up of cinatra#2894).
 *
 * pg-pool removes its own 'error' listener from a client while the client is
 * checked out (a transaction, a multi-step operation), so each module that
 * builds its own pool attaches one listener per client when the pool creates
 * it. `pg` is mocked: each case builds the pool through the module's own entry
 * point, plays the pool's 'connect' with a new client, then emits 'error' on
 * that client as a backend kill does.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constructed: EventEmitter[] = [];

vi.mock("pg", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  class FakePool extends Emitter {
    totalCount = 0;
    idleCount = 0;
    waitingCount = 0;
    constructor(public readonly options: unknown) {
      super();
      constructed.push(this);
    }
    connect(): Promise<never> {
      return Promise.reject(new Error("no database in this test"));
    }
    query(): Promise<never> {
      return Promise.reject(new Error("no database in this test"));
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
  }
  class FakeClient extends Emitter {}
  const types = { setTypeParser: () => undefined, getTypeParser: () => (value: unknown) => value };
  const pg = { Pool: FakePool, Client: FakeClient, types };
  return { ...pg, default: pg };
});

const CONNECTION_STRING = "postgres://pool-user:pool-secret-4151@db.invalid:5432/app";
const POOL_GLOBALS = [
  "__cinatraAgentBuilderPool",
  "__cinatraTriggerClaimPool",
  "__cinatraDashboardsPool",
  "__cinatraDashboardsDb",
  "__cinatraCanonicalManifestPool",
  "__cinatraAnthropicSkillSyncPool",
  "__cinatraBetterAuthPool",
  "__cinatraInstallOpsPool",
  "__cinatraWebhookSecretPool",
];

// Each entry builds the module's pool through the module's own entry point. A
// call that goes on to query fails on the fake pool; only the pool matters here.
const SITES: Array<{ name: string; build: () => unknown }> = [
  {
    name: "agent-builder",
    build: async () => (await import("../../../../packages/agents/src/db")).agentBuilderPool.totalCount,
  },
  {
    name: "trigger-claim",
    build: async () =>
      (await import("../../../../packages/agents/src/trigger-claim")).withTriggerClaim("run-4151", async () => null),
  },
  {
    name: "dashboards",
    build: async () => (await import("../../../../packages/dashboards/src/store/db")).getDashboardsPool(),
  },
  {
    name: "extensions/canonical-store",
    build: async () =>
      (await import("../../../../packages/extensions/src/canonical-store")).readInstalledExtensionById("ext-4151"),
  },
  {
    name: "relocate-worker",
    build: async () => (await import("../../../../packages/skills/src/relocate-worker")).drainQueue(),
  },
  {
    name: "anthropic-skill-sync-store",
    build: async () => (await import("@/lib/anthropic-skill-sync-store")).anthropicSkillSyncPool.totalCount,
  },
  {
    name: "better-auth",
    build: async () => (await import("@/lib/better-auth-db")).betterAuthPool.totalCount,
  },
  {
    name: "extension-install-ops",
    build: async () => (await import("@/lib/extension-install-ops")).readInstallOp("pkg-4151", null),
  },
  {
    name: "webhook-secret-service",
    build: async () => (await import("@/lib/webhook-secret-service")).webhookSecretService.mint({} as never),
  },
];

const env = process.env as Record<string, string | undefined>;
const ORIGINAL_DB_URL = env.SUPABASE_DB_URL;
let loggedLines: () => string[] = () => [];

function clearPoolGlobals(): void {
  for (const key of POOL_GLOBALS) delete (globalThis as Record<string, unknown>)[key];
}

beforeEach(() => {
  constructed.length = 0;
  clearPoolGlobals();
  vi.resetModules();
  env.SUPABASE_DB_URL = CONNECTION_STRING;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  loggedLines = () => errorSpy.mock.calls.map((args) => args.map(String).join(" "));
});

afterEach(() => {
  vi.restoreAllMocks();
  clearPoolGlobals();
  if (ORIGINAL_DB_URL === undefined) delete env.SUPABASE_DB_URL;
  else env.SUPABASE_DB_URL = ORIGINAL_DB_URL;
});

describe("a cut connection on a checked-out client of a module's own pool (cinatra#4151)", () => {
  for (const site of SITES) {
    it(`${site.name}: the client's error is handled and logged without the connection string`, async () => {
      const outcome = await Promise.resolve()
        .then(site.build)
        .then(
          () => "built",
          (err: unknown) => String(err),
        );
      expect(constructed, outcome).toHaveLength(1);
      const pool = constructed[0];

      const client = new EventEmitter();
      pool.emit("connect", client);
      const cut = new Error("terminating connection due to administrator command");
      expect(() => client.emit("error", cut)).not.toThrow();
      expect(() => pool.emit("error", cut)).not.toThrow();

      // one listener per client, attached once when the pool creates it
      expect(client.listenerCount("error")).toBe(1);
      expect(pool.listenerCount("connect")).toBe(1);

      const lines = loggedLines();
      expect(lines).toContain(`[${site.name}] pg pool client error: ${cut.message}`);
      for (const line of lines) {
        expect(line).not.toContain("pool-secret-4151");
        expect(line).not.toContain("postgres://");
      }
    });
  }
});

describe("an idle connection error on the dashboard cube pool (cinatra#4151)", () => {
  const CUBE_GLOBALS = ["__cinatraDashboardsCubePool", "__cinatraDashboardsCubePlatform"];
  const clearCubeGlobals = () => {
    for (const key of CUBE_GLOBALS) delete (globalThis as Record<string, unknown>)[key];
  };
  beforeEach(clearCubeGlobals);
  afterEach(clearCubeGlobals);

  it("dashboards-cubes: the pool's error is handled and logged without the connection string", async () => {
    const outcome = await Promise.resolve()
      .then(async () =>
        (await import("../../../../packages/dashboards/src/cubes/platform-singleton")).getDashboardCubesPlatform(),
      )
      .then(
        () => "built",
        (err: unknown) => String(err),
      );
    expect(constructed, outcome).toHaveLength(1);
    const pool = constructed[0];

    const cut = new Error("terminating connection due to administrator command");
    expect(() => pool.emit("error", cut)).not.toThrow();
    expect(pool.listenerCount("error")).toBe(1);

    const lines = loggedLines();
    expect(lines).toContain(`[dashboards-cubes] pg pool idle client error: ${cut.message}`);
    for (const line of lines) {
      expect(line).not.toContain("pool-secret-4151");
      expect(line).not.toContain("postgres://");
    }
  });
});
