import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __cinatraObjectsPool: Pool | undefined;
}

// Lazy pool + drizzle bootstrap. The pool is created on first use (not at
// module import) so `next build` page-data collection — and any other
// import-time evaluation without SUPABASE_DB_URL — does not throw. `new Pool()`
// never opens a connection until the first query, so deferring creation is free.
let objectsPoolInstance: Pool | undefined;
function getObjectsPool(): Pool {
  if (objectsPoolInstance) return objectsPoolInstance;
  if (globalThis.__cinatraObjectsPool) {
    return (objectsPoolInstance = globalThis.__cinatraObjectsPool);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for @cinatra-ai/objects");
  }
  const pool = new Pool({ connectionString });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) =>
      console.error("[objects] pg pool idle client error:", err.message),
    );
  }
  objectsPoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraObjectsPool = pool;
  }
  return pool;
}

function createObjectsDb() {
  return drizzle(getObjectsPool(), { schema });
}
let objectsDbInstance: ReturnType<typeof createObjectsDb> | undefined;
function getObjectsDb(): ReturnType<typeof createObjectsDb> {
  return (objectsDbInstance ??= createObjectsDb());
}

// Lazy value-export proxies preserve the historical `objectsPool` / `db` import
// contract (zero consumer changes) while deferring pool creation to first use.
// Method access is bound to the real target.
export const objectsPool: Pool = new Proxy({} as Pool, {
  get(_t, prop) {
    const target: any = getObjectsPool();
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export const db: ReturnType<typeof createObjectsDb> = new Proxy(
  {} as ReturnType<typeof createObjectsDb>,
  {
    get(_t, prop) {
      const target: any = getObjectsDb();
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  },
);
