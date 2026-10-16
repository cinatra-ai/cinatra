/**
 * Unit tests for the shared async pooled-DB scaffold (#303).
 *
 * `pg.Pool` is mocked so no real connection is opened. We assert the behavior
 * the hand-rolled per-site pools all had: lazy first-use creation, idempotent
 * caching by name, a once-registered idle-error listener, the throw-if-missing
 * default resolver vs the opt-in fail-open resolver, and name validation.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeHandler = (...args: unknown[]) => void;

const constructed: Array<{
  config: unknown;
  listeners: Record<string, number>;
  handlers: Record<string, FakeHandler[]>;
}> = [];

vi.mock("pg", () => {
  class FakePool {
    config: unknown;
    listeners: Record<string, number> = {};
    handlers: Record<string, FakeHandler[]> = {};
    constructor(config: unknown) {
      this.config = config;
      constructed.push({ config, listeners: this.listeners, handlers: this.handlers });
    }
    listenerCount(event: string): number {
      return this.listeners[event] ?? 0;
    }
    on(event: string, handler?: FakeHandler): this {
      this.listeners[event] = (this.listeners[event] ?? 0) + 1;
      if (handler) (this.handlers[event] ??= []).push(handler);
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


describe("shared async runner factory capture", () => {
  it("initializes without pool IO and keeps the first supplied factory", async () => {
    vi.resetModules();
    const pooled = await import("@/lib/db/pooled");
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const released: unknown[] = [];
    const firstFactory = vi.fn(() => ({
      connect: async () => ({
        query: async (text: string, values: unknown[]) => { queries.push({ text, values }); return { rows: [{ value: "fake" }], rowCount: 1 }; },
        release: (error?: unknown) => { released.push(error); },
      }),
    }));
    const replacementFactory = vi.fn(() => { throw new Error("must not replace the captured factory"); });
    const before = constructed.length;
    const runner = pooled.initializePostgresAsyncRunner(firstFactory as unknown as typeof pooled.getPooledDb);
    expect(firstFactory).not.toHaveBeenCalled();
    expect(constructed).toHaveLength(before);
    expect(pooled.initializePostgresAsyncRunner(replacementFactory as typeof pooled.getPooledDb)).toBe(runner);
    expect(await pooled.runPostgresQueriesAsync({ connectionString: "postgres://fake-factory/db", queries: [{ text: "SELECT value WHERE key = $1", values: ["key"] }], transaction: false })).toEqual([{ rows: [{ value: "fake" }], rowCount: 1 }]);
    expect(queries).toEqual([{ text: "SELECT value WHERE key = $1", values: ["key"] }]);
    expect(released).toEqual([undefined]);
    expect(firstFactory).toHaveBeenCalledTimes(1);
    expect(replacementFactory).not.toHaveBeenCalled();
    expect(constructed).toHaveLength(before);
    vi.resetModules();
  });
});

describe("a backend kill on a checked-out client (cinatra#2894)", () => {
  // pg-pool removes its own idle 'error' listener from a client while the
  // client is checked out. A backend kill, a server restart or a network cut
  // then emits 'error' on a client that may have no listener at all; an
  // EventEmitter throws on that, and in the app it is an uncaught exception
  // that ends the process. The fake client is a plain EventEmitter so the
  // test reads exactly that throw.
  const KILL_MESSAGE = "terminating connection due to administrator command";

  // Plays the pool's 'connect' event: pg-pool emits it once for each NEW
  // client, before the first checkout of that client.
  function connectNewClient(): EventEmitter {
    const client = new EventEmitter();
    for (const handler of constructed[0].handlers.connect ?? []) handler(client);
    return client;
  }

  it("handles the client's error instead of throwing it", () => {
    getPooledDb({ name: "checked-out" });
    const client = connectNewClient();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => client.emit("error", new Error(KILL_MESSAGE))).not.toThrow();
    } finally {
      logged.mockRestore();
    }
  });

  it("logs the pool name and the error message, never the connection string", () => {
    getPooledDb({ name: "checked-out" });
    const client = connectNewClient();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      client.emit("error", new Error(KILL_MESSAGE));
      expect(logged).toHaveBeenCalledTimes(1);
      const line = logged.mock.calls[0].map(String).join(" ");
      expect(line).toContain("[checked-out]");
      expect(line).toContain(KILL_MESSAGE);
      expect(line).not.toContain("postgres://");
      expect(line).not.toContain("user:pass");
    } finally {
      logged.mockRestore();
    }
  });

  it("adds one listener per new client, never one per checkout or per call", () => {
    getPooledDb({ name: "reused" });
    getPooledDb({ name: "reused" });
    expect(constructed).toHaveLength(1);
    expect(constructed[0].listeners.connect).toBe(1);
    const client = connectNewClient();
    expect(client.listenerCount("error")).toBe(1);
    // Five checkouts and releases of the same client: whatever the pool
    // emits for them must not add another listener.
    for (let i = 0; i < 5; i += 1) {
      for (const event of ["acquire", "release"]) {
        for (const handler of constructed[0].handlers[event] ?? []) handler(client);
      }
    }
    expect(client.listenerCount("error")).toBe(1);
  });
});
