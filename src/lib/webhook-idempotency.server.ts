import "server-only";

// Host wiring of the leased idempotency ledger (cinatra#340).
//
// Injects the host pg pool + schema-qualified table name into the package's
// IdempotencyLedger (the state machine + attempt-fence live in the package;
// the host owns the connection). Same lazy-pool posture as the secret service.

import type { Pool } from "pg";
import { IdempotencyLedger } from "@cinatra-ai/webhooks";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { getPooledDb } from "@/lib/db/pooled";

// How long a holder owns an in-flight claim before its lease expires and a
// retry may re-claim. Generously above a handler's expected runtime; a crashed
// holder's row becomes reclaimable after this.
const LEASE_SECONDS = 60;

// Lazy pool over the shared pool (@/lib/db/pooled, #303). Resolves the
// connection string via the host helper (which honors the `.env.local`
// fallback), same lazy-pool posture as the secret service.
function getPool(): Pool {
  return getPooledDb({
    name: "webhook-idempotency",
    connectionString: () => getPostgresConnectionString(),
  });
}

function table(): string {
  const s = postgresSchema.replaceAll('"', '""');
  return `"${s}"."webhook_idempotency"`;
}

let ledgerInstance: IdempotencyLedger | undefined;

/** The host-wired idempotency ledger (lazy — no pool at import time). */
export function getWebhookIdempotencyLedger(): IdempotencyLedger {
  if (ledgerInstance) return ledgerInstance;
  const pool = getPool();
  ledgerInstance = new IdempotencyLedger({
    query: (text, params) => pool.query(text, params as unknown[]).then((r) => ({ rows: r.rows })),
    table: table(),
    leaseSeconds: LEASE_SECONDS,
  });
  return ledgerInstance;
}
