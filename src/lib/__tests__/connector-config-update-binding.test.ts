// The live binding of the host connector-config `update` member, over a
// captured fake postgres-sync executor (no database):
//   H-sql  `insertRawMetadataValueIfAbsentInternal` sends exactly one
//          INSERT ... ON CONFLICT (key) DO NOTHING RETURNING key with the raw
//          bytes as given, and reports whether THIS statement inserted.
//   H-bind `updateConnectorConfigInDatabase` reads the raw row, then persists
//          with ONE conditional statement (UPDATE ... RETURNING when present,
//          the insert above when absent); on success the next
//          `readConnectorConfigFromDatabase` inside the TTL is served from the
//          process cache with the stored value; on a store failure the cache
//          entry is evicted and the one log line carries no stored value.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Query = { text: string; values?: unknown[] };

const fake = vi.hoisted(() => ({
  queries: [] as Query[],
  meta: new Map<string, string>(),
  readMetaText: "",
  // A scripted throw for the n-th query (1-based) of the test; null = none.
  throwAt: null as null | { n: number; error: unknown },
  // An override of the insert's rows (to pin the boolean mapping).
  insertRows: null as null | unknown[],
}));

// The two conditional statements, exactly as the binding must send them
// (hoisted: the postgres-sync mock below reads them).
const { CAS_TEXT, INSERT_TEXT } = vi.hoisted(() => {
  const table = `"cinatra_test"."metadata"`;
  return {
    CAS_TEXT: `UPDATE ${table} SET value = $1 WHERE key = $2 AND value = $3 RETURNING key`,
    INSERT_TEXT: `INSERT INTO ${table} (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key`,
  };
});

vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: vi.fn(() => "postgres://stub"),
  postgresSchema: "cinatra_test",
}));
vi.mock("@/lib/objects-dual-write", () => ({ shadowUpsertObject: vi.fn() }));
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn((opts: { queries: Query[] }) =>
    opts.queries.map((q) => {
      fake.queries.push(q);
      if (fake.throwAt && fake.throwAt.n === fake.queries.length) throw fake.throwAt.error;
      const key = String(q.values?.[0]);
      if (q.text === fake.readMetaText) {
        const value = fake.meta.get(key);
        return { rows: value === undefined ? [] : [{ value }], rowCount: value === undefined ? 0 : 1 };
      }
      if (q.text === CAS_TEXT) {
        const [next, casKey, expected] = q.values as [string, string, string];
        if (fake.meta.get(casKey) !== expected) return { rows: [], rowCount: 0 };
        fake.meta.set(casKey, next);
        return { rows: [{ key: casKey }], rowCount: 1 };
      }
      if (q.text === INSERT_TEXT) {
        if (fake.insertRows) return { rows: fake.insertRows, rowCount: fake.insertRows.length };
        if (fake.meta.has(key)) return { rows: [], rowCount: 0 };
        fake.meta.set(key, String(q.values?.[1]));
        return { rows: [{ key }], rowCount: 1 };
      }
      throw new Error(`unexpected query in this test: ${q.text}`);
    }),
  ),
}));

// RELATIVE import deliberately: the root vitest config aliases the
// "@/lib/database" SPECIFIER to tests/__stubs__/database.ts; this test needs
// the REAL module (its cache read) beside the real update binding.
import { readConnectorConfigFromDatabase } from "../database";
import { insertRawMetadataValueIfAbsentInternal } from "../database-metadata";
import { updateConnectorConfigInDatabase } from "../connector-config-update";
import { buildReadMetadataQuery } from "@/lib/drizzle-store";

const SENTINEL = "sentinel-7f3a-row-value";
const KEY = "connector_config:linkedin";

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fake.queries.length = 0;
  fake.meta.clear();
  fake.throwAt = null;
  fake.insertRows = null;
  fake.readMetaText = buildReadMetadataQuery("cinatra_test", "probe").text;
  globalThis.__cinatraConnectorConfigCache?.clear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("H-sql: insertRawMetadataValueIfAbsentInternal", () => {
  it("sends exactly one INSERT ... ON CONFLICT (key) DO NOTHING RETURNING key with the raw bytes as given", () => {
    const raw = '{"b":2,"a":1}';
    expect(insertRawMetadataValueIfAbsentInternal(KEY, raw)).toBe(true);
    expect(fake.queries).toEqual([{ text: INSERT_TEXT, values: [KEY, raw] }]);
    expect(fake.meta.get(KEY)).toBe(raw);
  });

  it("maps rows [{key}] to true and [] to false", () => {
    fake.insertRows = [{ key: KEY }];
    expect(insertRawMetadataValueIfAbsentInternal(KEY, "{}")).toBe(true);
    fake.insertRows = [];
    expect(insertRawMetadataValueIfAbsentInternal(KEY, "{}")).toBe(false);
  });

  it("an existing row is never overwritten and reports false", () => {
    fake.meta.set(KEY, '{"other":true}');
    expect(insertRawMetadataValueIfAbsentInternal(KEY, '{"mine":true}')).toBe(false);
    expect(fake.meta.get(KEY)).toBe('{"other":true}');
  });
});

describe("H-bind: updateConnectorConfigInDatabase over the live port", () => {
  it("row present: one raw read, one UPDATE ... RETURNING; the next read inside the TTL is the cached new value", () => {
    fake.meta.set(KEY, JSON.stringify({ accounts: [{ id: "x" }] }));
    updateConnectorConfigInDatabase("linkedin", (current) => ({
      ...(current as Record<string, unknown>),
      loggingEnabled: true,
    }));
    const stored = JSON.stringify({ accounts: [{ id: "x" }], loggingEnabled: true });
    expect(fake.meta.get(KEY)).toBe(stored);
    expect(fake.queries.map((q) => q.text)).toEqual([fake.readMetaText, CAS_TEXT]);
    expect(fake.queries[1]?.values).toEqual([stored, KEY, JSON.stringify({ accounts: [{ id: "x" }] })]);

    fake.queries.length = 0;
    expect(readConnectorConfigFromDatabase("linkedin", {})).toEqual({ accounts: [{ id: "x" }], loggingEnabled: true });
    expect(fake.queries).toEqual([]);
  });

  it("row absent: one raw read, one INSERT ... RETURNING; the cache then serves the inserted value", () => {
    updateConnectorConfigInDatabase("linkedin", (current) => {
      expect(current).toBeNull();
      return { accounts: [] };
    });
    expect(fake.meta.get(KEY)).toBe('{"accounts":[]}');
    expect(fake.queries.map((q) => q.text)).toEqual([fake.readMetaText, INSERT_TEXT]);
    fake.queries.length = 0;
    expect(readConnectorConfigFromDatabase("linkedin", { fallback: true })).toEqual({ accounts: [] });
    expect(fake.queries).toEqual([]);
  });

  it("the update derives from the stored row, never from a cached read", () => {
    fake.meta.set(KEY, JSON.stringify({ accounts: [{ id: "x" }] }));
    readConnectorConfigFromDatabase("linkedin", {}); // caches the old row
    fake.meta.set(KEY, JSON.stringify({ accounts: [{ id: "x" }, { id: "y" }] })); // another process writes
    const seen: unknown[] = [];
    updateConnectorConfigInDatabase("linkedin", (current) => {
      seen.push(current);
      return { ...(current as Record<string, unknown>), loggingEnabled: false };
    });
    expect(seen).toEqual([{ accounts: [{ id: "x" }, { id: "y" }] }]);
    expect(JSON.parse(fake.meta.get(KEY) as string)).toEqual({
      accounts: [{ id: "x" }, { id: "y" }],
      loggingEnabled: false,
    });
  });

  it("a store failure evicts the cache entry and logs one value-free line with the SQLSTATE", () => {
    fake.meta.set(KEY, JSON.stringify({ note: SENTINEL }));
    readConnectorConfigFromDatabase("linkedin", {}); // caches the row
    fake.queries.length = 0;
    fake.throwAt = { n: 2, error: Object.assign(new Error(SENTINEL), { code: "40001" }) };
    let error: unknown;
    try {
      updateConnectorConfigInDatabase("linkedin", (current) => ({ ...(current as object), x: 1 }));
    } catch (e) {
      error = e;
    }
    expect((error as { code?: string }).code).toBe("CONNECTOR_CONFIG_STORE_FAILED");
    expect(String(error)).not.toContain(SENTINEL);
    expect(warn.mock.calls).toEqual([[`[connector-config.update] key=${KEY} code=CONNECTOR_CONFIG_STORE_FAILED sqlstate=40001`]]);
    expect(globalThis.__cinatraConnectorConfigCache?.has(KEY)).toBe(false);
  });

  it("a sealed id (nango) is refused before any query", () => {
    let error: unknown;
    try {
      updateConnectorConfigInDatabase("nango", () => ({}));
    } catch (e) {
      error = e;
    }
    expect((error as { code?: string }).code).toBe("CONNECTOR_CONFIG_UPDATE_UNSUPPORTED");
    expect(fake.queries).toEqual([]);
  });
});
