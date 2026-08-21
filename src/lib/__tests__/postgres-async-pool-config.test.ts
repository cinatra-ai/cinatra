/**
 * cinatra#2882 — the async seam's ceiling must NOT ride the startup packet.
 *
 * THE REGRESSION THIS FILE EXISTS TO PREVENT. `pg` treats `statement_timeout`
 * (and `lock_timeout`, `idle_in_transaction_session_timeout`) in a Pool/Client
 * config as a PostgreSQL STARTUP PARAMETER — `Client.getStartupConf()`
 * (`node_modules/pg/lib/client.js`) copies it straight into the startup packet.
 * A PgBouncer/Supavisor-class pooler forwards only the startup parameters it
 * allowlists and answers anything else with a FATAL
 * `unsupported startup parameter: statement_timeout`, so behind such a DSN
 * EVERY `pool.connect()` fails. The three migrated notification clears swallow
 * rejections by design, so the symptom would be notifications silently no
 * longer being deleted — with a green dedicated suite, because that suite runs
 * against direct Postgres where the parameter is accepted.
 *
 * So the seam's universally-enforced bound is CLIENT-side (`query_timeout` +
 * `connectionTimeoutMillis`, neither of which touches the wire), and the
 * server-side cancel is issued as transaction-scoped SQL. These are unit-tier
 * pins: they need no database, because the thing being pinned is the shape of
 * the config object and the statement list, not their effect.
 *
 * The real-Postgres proof that the bound actually fires lives in
 * `notification-delete-async-seam.integration.test.ts` ("the seam's own
 * ceiling").
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The seam reads its ceiling ONCE at module load, so it has to be set before
// the dynamic import below. A distinctive value keeps the assertions honest —
// a hard-coded 30000 would also pass if the config silently ignored the env.
const BOUND_MS = 12_345;
process.env.POSTGRES_ASYNC_TIMEOUT_MS = String(BOUND_MS);

const getPooledDbMock = vi.fn();

vi.mock("@/lib/db/pooled", () => ({
  getPooledDb: (...args: unknown[]) => getPooledDbMock(...args),
}));

type PoolConfig = Record<string, unknown>;

/** The queries a run issued, in order, with a fake client that records them. */
function installFakePool(): { texts: string[]; released: unknown[] } {
  const texts: string[] = [];
  const released: unknown[] = [];
  const client = {
    query: async (text: string) => {
      texts.push(text);
      return { rows: [], rowCount: 0 };
    },
    release: (err?: unknown) => {
      released.push(err);
    },
  };
  getPooledDbMock.mockReturnValue({ connect: async () => client });
  return { texts, released };
}

/** The `poolConfig` the seam handed to `getPooledDb` on its last call. */
function lastPoolConfig(): PoolConfig {
  const call = getPooledDbMock.mock.calls.at(-1);
  expect(call, "getPooledDb was never called").toBeDefined();
  const options = (call as unknown[])[0] as { poolConfig?: PoolConfig };
  return options.poolConfig ?? {};
}

async function seam() {
  return await import("@/lib/postgres-async");
}

beforeEach(() => {
  getPooledDbMock.mockReset();
  installFakePool();
});

describe("cinatra#2882 async seam — the pool config", () => {
  // Exactly the keys `Client.getStartupConf()` forwards into the startup
  // packet, besides the ones every connection must carry (user/database/
  // application_name/replication/options). Any of these in a pool config is
  // the bug.
  const STARTUP_PARAMETER_KEYS = [
    "statement_timeout",
    "lock_timeout",
    "idle_in_transaction_session_timeout",
  ] as const;

  it("carries NO statement_timeout — the bound must not ride the startup packet", async () => {
    const { getPostgresAsyncPool } = await seam();
    getPostgresAsyncPool("postgres://u:p@example.invalid:5432/db");

    const poolConfig = lastPoolConfig();
    // `toBeUndefined()` would also pass for an explicit `statement_timeout:
    // undefined`, which pg's own `val()` treats as absent today but which is
    // one truthiness change away from being sent. Pin the KEY.
    expect(Object.keys(poolConfig)).not.toContain("statement_timeout");
    for (const key of STARTUP_PARAMETER_KEYS) {
      expect(Object.keys(poolConfig)).not.toContain(key);
    }
  });

  it("bounds the checkout and the read client-side, at the documented ceiling", async () => {
    const { getPostgresAsyncPool } = await seam();
    getPostgresAsyncPool("postgres://u:p@example.invalid:5432/db");

    const poolConfig = lastPoolConfig();
    // Both are pg-client-local timers; neither is negotiated with the server,
    // so they hold against any DSN. `query_timeout` is the PRIMARY bound now,
    // so it sits AT the ceiling rather than above it as a backstop.
    expect(poolConfig.connectionTimeoutMillis).toBe(BOUND_MS);
    expect(poolConfig.query_timeout).toBe(BOUND_MS);
  });
});

describe("cinatra#2882 async seam — the server-side cancel", () => {
  const CONNECTION_STRING = "postgres://u:p@example.invalid:5432/db";
  const QUERIES = [
    { text: "DELETE FROM notifications WHERE id = $1", values: ["a"] },
    { text: "DELETE FROM notifications WHERE id = $1", values: ["b"] },
  ];

  it("issues SET LOCAL statement_timeout INSIDE the transaction, once", async () => {
    const { texts } = installFakePool();
    const { runPostgresQueriesAsync } = await seam();

    await runPostgresQueriesAsync({
      connectionString: CONNECTION_STRING,
      queries: QUERIES,
      transaction: true,
    });

    // It travels WITH the BEGIN, in one simple-query round trip, so it can
    // never be left behind by an edit that moves one and not the other.
    expect(texts[0]).toMatch(/^BEGIN;\s*SET LOCAL statement_timeout = \d+$/);
    expect(texts.at(-1)).toBe("COMMIT");
    // ...and nowhere else in the list.
    expect(texts.filter((t) => /statement_timeout/i.test(t))).toHaveLength(1);
    // Strictly under the client-side read timeout, so the CLEAN server-side
    // cancel wins whenever the server is answering at all.
    const ms = Number(/statement_timeout = (\d+)/.exec(texts[0])?.[1]);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("never issues it on the autocommit path — a session SET would leak through a pooler", async () => {
    const { texts } = installFakePool();
    const { runPostgresQueriesAsync } = await seam();

    await runPostgresQueriesAsync({
      connectionString: CONNECTION_STRING,
      queries: QUERIES,
    });

    expect(texts).toEqual(QUERIES.map((q) => q.text));
    expect(texts.some((t) => /statement_timeout/i.test(t))).toBe(false);
    // No BEGIN either — `SET LOCAL` outside a transaction block is a no-op
    // warning, and the session-scoped form it would have to become is exactly
    // the pooled-connection state leak this seam avoids.
    expect(texts.some((t) => /^BEGIN/i.test(t))).toBe(false);
  });
});
