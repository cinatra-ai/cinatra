import "server-only";
import { getPooledDb, initializePostgresAsyncRunner } from "@/lib/db/pooled";

// Preserve the original module-load timeout/factory capture boundary without
// creating a pool, checkout or query. Pooled-only imports do not initialize.
initializePostgresAsyncRunner(getPooledDb);

export { getPostgresAsyncPool, runPostgresQueriesAsync } from "@/lib/db/pooled";
