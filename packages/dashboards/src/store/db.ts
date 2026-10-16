/**
 * Lazy singleton Drizzle handle for the dashboards package. Mirrors the
 * `betterAuthPool` / `serviceAccountsPool` pattern: pool + drizzle handle
 * cached on `globalThis` so dev hot-reload doesn't multiply connections.
 */
import "server-only";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import { dashboards, dashboardRevisions, dashboardEntityLinks } from "./schema";
import { auditEvents } from "./audit-events-schema";

declare global {
  // eslint-disable-next-line no-var
  var __cinatraDashboardsPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __cinatraDashboardsDb: ReturnType<typeof drizzle> | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for @cinatra-ai/dashboards");
  }
  const pool = new Pool({ connectionString });
  // An idle connection the database drops makes the pool emit 'error'; with no
  // listener that ends the process.
  pool.on("error", (err) => {
    console.error("[dashboards] pg pool idle client error:", err.message);
  });
  // pg-pool removes its own 'error' listener from a client while the client is
  // checked out, so a connection cut during a transaction would end the process
  // (cinatra#4151). One listener per client, added once when the pool creates the
  // client; it logs the pool name and the message only, and the pool discards the
  // dead client at release.
  pool.on("connect", (client) => {
    client.on("error", (err: Error) => {
      console.error("[dashboards] pg pool client error:", err.message);
    });
  });
  return pool;
}

export function getDashboardsPool(): Pool {
  if (globalThis.__cinatraDashboardsPool) return globalThis.__cinatraDashboardsPool;
  const pool = createPool();
  globalThis.__cinatraDashboardsPool = pool;
  return pool;
}

const SCHEMA_OBJECT = {
  dashboards,
  dashboardRevisions,
  dashboardEntityLinks,
  auditEvents,
};

export function getDashboardsDb() {
  if (globalThis.__cinatraDashboardsDb) return globalThis.__cinatraDashboardsDb;
  const db = drizzle(getDashboardsPool(), { schema: SCHEMA_OBJECT });
  globalThis.__cinatraDashboardsDb = db;
  return db;
}

export type DashboardsDb = ReturnType<typeof getDashboardsDb>;
export { dashboards, dashboardRevisions, dashboardEntityLinks, auditEvents };
