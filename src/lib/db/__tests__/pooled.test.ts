/**
 * Unit tests for the shared async pooled-DB scaffold (#303).
 *
 * `pg.Pool` is mocked so no real connection is opened. We assert the behavior
 * the hand-rolled per-site pools all had: lazy first-use creation, idempotent
 * caching by name, a once-registered idle-error listener, the throw-if-missing
 * default resolver vs the opt-in fail-open resolver, and name validation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constructed: Array<{ config: unknown; listeners: Record<string, number> }> = [];

vi.mock("pg", () => {
  class FakePool {
    config: unknown;
    listeners: Record<string, number> = {};
    constructor(config: unknown) {
      this.config = config;
      constructed.push({ config, listeners: this.listeners });
    }
    listenerCount(event: string): number {
      return this.listeners[event] ?? 0;
    }
    on(event: string): this {
      this.listeners[event] = (this.listeners[event] ?? 0) + 1;
      return this;
    }
  }
  return { Pool: FakePool };
});

// Import AFTER the mock is registered.
import {
  getPooledDb,
  failOpenLocalhost,
  __resetPooledDbForTests,
} from "@/lib/db/pooled";

const env = process.env as Record<string, string | undefined>;
const ORIGINAL_DB_URL = env.SUPABASE_DB_URL;
const ORIGINAL_NODE_ENV = env.NODE_ENV;

beforeEach(() => {
  constructed.length = 0;
  __resetPooledDbForTests();
  env.SUPABASE_DB_URL = "postgres://user:pass@localhost:5432/test";
});

afterEach(() => {
  __resetPooledDbForTests();
  if (ORIGINAL_DB_URL === undefined) delete env.SUPABASE_DB_URL;
  else env.SUPABASE_DB_URL = ORIGINAL_DB_URL;
  if (ORIGINAL_NODE_ENV === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe("getPooledDb", () => {
  it("creates a pool lazily on first call with the resolved connection string", () => {
    expect(constructed).toHaveLength(0);
    getPooledDb({ name: "alpha" });
    expect(constructed).toHaveLength(1);
    expect((constructed[0].config as { connectionString: string }).connectionString).toBe(
      "postgres://user:pass@localhost:5432/test",
    );
  });

  it("registers exactly one idle-error listener", () => {
    getPooledDb({ name: "alpha" });
    expect(constructed[0].listeners.error).toBe(1);
  });

  it("returns the SAME pool instance for the same name (cached)", () => {
    const a = getPooledDb({ name: "alpha" });
    const b = getPooledDb({ name: "alpha" });
    expect(a).toBe(b);
    expect(constructed).toHaveLength(1);
  });

  it("returns DISTINCT pools for distinct names", () => {
    const a = getPooledDb({ name: "alpha" });
    const b = getPooledDb({ name: "beta" });
    expect(a).not.toBe(b);
    expect(constructed).toHaveLength(2);
  });

  it("throws by default when SUPABASE_DB_URL is missing, naming the pool", () => {
    delete env.SUPABASE_DB_URL;
    expect(() => getPooledDb({ name: "needs-db" })).toThrow(/SUPABASE_DB_URL is required for needs-db/);
  });

  it("fails open to localhost only with the opt-in resolver", () => {
    delete env.SUPABASE_DB_URL;
    const pool = getPooledDb({ name: "authz-ish", connectionString: failOpenLocalhost });
    expect(pool).toBeDefined();
    expect((constructed[0].config as { connectionString: string }).connectionString).toBe(
      "postgres://localhost",
    );
  });

  it("rejects an empty name", () => {
    expect(() => getPooledDb({ name: "" })).toThrow(/non-empty string/);
  });

  it("throws on a name collision with different options (no silent reuse)", () => {
    getPooledDb({ name: "shared", connectionString: () => "postgres://a/db" });
    expect(() =>
      getPooledDb({ name: "shared", connectionString: () => "postgres://b/db" }),
    ).toThrow(/already registered with different options/);
    // Only the first pool was ever constructed.
    expect(constructed).toHaveLength(1);
  });

  it("reuses the pool when the SAME name resolves the SAME options", () => {
    const a = getPooledDb({ name: "shared", connectionString: () => "postgres://a/db" });
    const b = getPooledDb({ name: "shared", connectionString: () => "postgres://a/db" });
    expect(a).toBe(b);
    expect(constructed).toHaveLength(1);
  });

  it("merges extra poolConfig onto the connection string", () => {
    getPooledDb({ name: "tuned", poolConfig: { max: 7 } });
    expect((constructed[0].config as { max: number }).max).toBe(7);
  });

  it("caches on globalThis in non-production for HMR reuse", () => {
    env.NODE_ENV = "development";
    __resetPooledDbForTests();
    getPooledDb({ name: "dev-pool" });
    expect((globalThis as { __cinatraPooledDb?: Map<string, unknown> }).__cinatraPooledDb?.has("dev-pool")).toBe(
      true,
    );
  });
});
