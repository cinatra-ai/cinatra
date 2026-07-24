import "server-only";
/**
 * The ONE consumer of kernel-guarded batches — cinatra#1938 (archive epic S2).
 *
 * `guardedBatchQueries` is the kernel's only unwrap (it refuses anything not
 * WeakSet-minted by `buildGuardedOrgWriteBatch`), and this wrapper is the only
 * module that calls it — passing `transaction: true` UNCONDITIONALLY, so a
 * guarded batch structurally cannot run outside a transaction (the prepended
 * advisory lock is xact-scoped and the in-SQL capability guard must abort the
 * whole batch). The S2 boundary gate pins this single-consumer property.
 */
import {
  guardedBatchQueries,
  type GuardedOrgWriteBatch,
} from "@cinatra-ai/org-write-kernel";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString } from "@/lib/postgres-config";

export function runGuardedOrgWriteBatchSync(
  batch: GuardedOrgWriteBatch,
  options?: { timeoutMs?: number },
): Array<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> {
  const queries = guardedBatchQueries(batch).map((q) => ({
    text: q.text,
    values: q.values ? [...q.values] : undefined,
  }));
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries,
    transaction: true,
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}
