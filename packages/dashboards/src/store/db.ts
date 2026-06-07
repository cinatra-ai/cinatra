/**
 * Lazy singleton Drizzle handle for the dashboards package. Mirrors the
 * `betterAuthPool` / `serviceAccountsPool` pattern: pool + drizzle handle
 * cached on `globalThis` so dev hot-reload doesn't multiply connections.
 */
import "server-only";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import { dashboards, dashboardRevisions } from "./schema";
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
  return new Pool({ connectionString });
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
  auditEvents,
};

export function getDashboardsDb() {
  if (globalThis.__cinatraDashboardsDb) return globalThis.__cinatraDashboardsDb;
  const db = drizzle(getDashboardsPool(), { schema: SCHEMA_OBJECT });
  globalThis.__cinatraDashboardsDb = db;
  return db;
}

export type DashboardsDb = ReturnType<typeof getDashboardsDb>;
export { dashboards, dashboardRevisions, auditEvents };
