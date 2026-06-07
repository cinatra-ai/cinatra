import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

declare global {
  var __cinatraAgentBuilderPool: Pool | undefined;
}

// Lazy pool + drizzle bootstrap. The pool is created on first use (not at
// module import) so `next build` page-data collection — and any other
// import-time evaluation without SUPABASE_DB_URL — does not throw. `new Pool()`
// never opens a connection until the first query, so deferring creation is free.
//
// The idle-error listener (registered at pool creation) keeps the process alive
// when Supabase drops idle connections: pg.Pool emits 'error' on an unexpected
// backend disconnect, which Node.js otherwise treats as an uncaught exception.
let agentBuilderPoolInstance: Pool | undefined;
function getAgentBuilderPool(): Pool {
  if (agentBuilderPoolInstance) return agentBuilderPoolInstance;
  if (globalThis.__cinatraAgentBuilderPool) {
    return (agentBuilderPoolInstance = globalThis.__cinatraAgentBuilderPool);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for @cinatra/agent-builder");
  }
  const pool = new Pool({ connectionString });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) => {
      console.error("[agent-builder] pg pool idle client error:", err.message);
    });
  }
  agentBuilderPoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraAgentBuilderPool = pool;
  }
  return pool;
}

function createAgentBuilderDb() {
  return drizzle(getAgentBuilderPool(), { schema });
}
let agentBuilderDbInstance: ReturnType<typeof createAgentBuilderDb> | undefined;
function getAgentBuilderDb(): ReturnType<typeof createAgentBuilderDb> {
  return (agentBuilderDbInstance ??= createAgentBuilderDb());
}

// Lazy value-export proxies preserve the historical `agentBuilderPool` / `db`
// import contract (zero consumer changes) while deferring pool creation to
// first use. Method access is bound to the real target.
export const agentBuilderPool: Pool = new Proxy({} as Pool, {
  get(_t, prop) {
    const target: any = getAgentBuilderPool();
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export const db: ReturnType<typeof createAgentBuilderDb> = new Proxy(
  {} as ReturnType<typeof createAgentBuilderDb>,
  {
    get(_t, prop) {
      const target: any = getAgentBuilderDb();
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  },
);
