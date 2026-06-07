import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

declare global {
  var __cinatraMetricsCostPool: Pool | undefined;
}

// Lazy pool + drizzle bootstrap. The pool is created on first use (not at
// module import) so `next build` page-data collection — and any other
// import-time evaluation without SUPABASE_DB_URL — does not throw. `new Pool()`
// never opens a connection until the first query, so deferring creation is free.
//
// The idle-error listener (registered at pool creation) keeps the process alive
// when Supabase drops idle connections: pg.Pool emits 'error' on an unexpected
// backend disconnect, which Node.js otherwise treats as an uncaught exception.
let metricsCostPoolInstance: Pool | undefined;
function getMetricsCostPool(): Pool {
  if (metricsCostPoolInstance) return metricsCostPoolInstance;
  if (globalThis.__cinatraMetricsCostPool) {
    return (metricsCostPoolInstance = globalThis.__cinatraMetricsCostPool);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for @cinatra-ai/metric-cost-api");
  }
  const pool = new Pool({ connectionString });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) => {
      console.error("[metric-cost-api] pg pool idle client error:", err.message);
    });
  }
  metricsCostPoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraMetricsCostPool = pool;
  }
  return pool;
}

function createMetricsCostDb() {
  return drizzle(getMetricsCostPool(), { schema });
}
let metricsCostDbInstance: ReturnType<typeof createMetricsCostDb> | undefined;
function getMetricsCostDb(): ReturnType<typeof createMetricsCostDb> {
  return (metricsCostDbInstance ??= createMetricsCostDb());
}

// Lazy value-export proxies preserve the historical `metricsCostPool` / `db`
// import contract (zero consumer changes) while deferring pool creation to
// first use. Method access is bound to the real target.
export const metricsCostPool: Pool = new Proxy({} as Pool, {
  get(_t, prop) {
    const target: any = getMetricsCostPool();
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export const db: ReturnType<typeof createMetricsCostDb> = new Proxy(
  {} as ReturnType<typeof createMetricsCostDb>,
  {
    get(_t, prop) {
      const target: any = getMetricsCostDb();
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  },
);

// ---------------------------------------------------------------------------
// Metadata table — used for storing subscription costs and other key-value data
// ---------------------------------------------------------------------------
import { pgSchema, text as pgText } from "drizzle-orm/pg-core";

const cinatraMetaSchema = pgSchema(process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra");

export const metadataTable = cinatraMetaSchema.table("metadata", {
  key:   pgText("key").primaryKey(),
  value: pgText("value").notNull(),
});
