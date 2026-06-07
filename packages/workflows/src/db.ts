import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __cinatraWorkflowsPool: Pool | undefined;
}

// Lazy pool + drizzle bootstrap. The pool is created on first use (not at
// module import) so `next build` page-data collection — and any other
// import-time evaluation without SUPABASE_DB_URL — does not throw. `new Pool()`
// never opens a connection until the first query, so deferring creation is free.
// This is the build-hermeticity invariant guarded by
// src/lib/__tests__/db-pool-lazy-init.test.ts — NEVER create the pool via a
// top-level `const … = new Pool()`.
//
// The idle-error listener keeps the process alive when Postgres drops idle
// connections: pg.Pool emits 'error' on an unexpected backend disconnect, which
// Node otherwise treats as an uncaught exception.
let workflowsPoolInstance: Pool | undefined;
function getWorkflowsPool(): Pool {
  if (workflowsPoolInstance) return workflowsPoolInstance;
  if (globalThis.__cinatraWorkflowsPool) {
    return (workflowsPoolInstance = globalThis.__cinatraWorkflowsPool);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for @cinatra-ai/workflows");
  }
  const pool = new Pool({ connectionString });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) => {
      console.error("[workflows] pg pool idle client error:", err.message);
    });
  }
  workflowsPoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraWorkflowsPool = pool;
  }
  return pool;
}

function createWorkflowsDb() {
  return drizzle(getWorkflowsPool(), { schema });
}
let workflowsDbInstance: ReturnType<typeof createWorkflowsDb> | undefined;
function getWorkflowsDb(): ReturnType<typeof createWorkflowsDb> {
  return (workflowsDbInstance ??= createWorkflowsDb());
}

// Lazy value-export proxies preserve a stable `releaseWorkflowsPool` / `db`
// import contract (zero consumer changes) while deferring pool creation to
// first use. Method access is bound to the real target.
export const releaseWorkflowsPool: Pool = new Proxy({} as Pool, {
  get(_t, prop) {
    const target: any = getWorkflowsPool();
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export const db: ReturnType<typeof createWorkflowsDb> = new Proxy(
  {} as ReturnType<typeof createWorkflowsDb>,
  {
    get(_t, prop) {
      const target: any = getWorkflowsDb();
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  },
);
