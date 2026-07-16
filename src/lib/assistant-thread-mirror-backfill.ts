// Dormant chat-thread → structured-mirror one-shot backfill (cinatra#1218,
// epic #1216 S2 — the first cutover-owned data residual named on the issue).
//
// The P2b lockstep mirror (src/lib/project-inheritance.ts) is SELF-BACKFILLING
// but only for threads that RECEIVE A WRITE: a legacy `chat_threads` row whose
// thread never gets another save has no `assistant_threads` /
// `assistant_turns` shadow. This pass mirrors exactly those DORMANT threads so
// the structured store covers the whole legacy corpus before the S2 delete
// stage retires the legacy write path (after which nothing would ever
// self-backfill them).
//
// REUSES the P2b pure builders verbatim (`buildAssistantThreadMirrorQueries`)
// so the backfilled shadow is byte-policy-identical to a live mirror write:
// set-once org anchor, `legacy:`-namespaced injective turn ids, ON CONFLICT DO
// NOTHING inserts, content NEVER copied, run_id NEVER fabricated.
//
// ORG ANCHOR: `explicitMirrorOrgId` is null — a boot pass has no auth-derived
// session org, and the anchor is SET-ONCE (repairable later; the team→org
// anchoring decision is flagged on #1218). Team-owned threads mirror with a
// NULL org by P2b policy regardless.
//
// IDEMPOTENT WITHOUT A MARKER: the dormancy query itself (`LEFT JOIN …
// WHERE a.id IS NULL`) converges to zero rows after the first pass, so a
// re-run is one cheap SELECT; a partially-failed pass simply retries the
// remainder next boot. Per-thread transactions keep one malformed payload from
// aborting the whole pass.

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { buildAssistantThreadMirrorQueries } from "@/lib/project-inheritance";

export type DormantThreadBackfillResult = {
  scanned: number;
  backfilled: number;
  failed: number;
  skippedReason?: string;
};

const BATCH_LIMIT = 200;

function schemaIdent(): string {
  return postgresSchema.replaceAll('"', '""');
}

/** One dormant legacy row: the thread id + its raw payload JSON. */
export type DormantThreadRow = { id: string; payload: string };

export function listDormantChatThreads(afterId = "", limit = BATCH_LIMIT): DormantThreadRow[] {
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT c.id, c.payload
               FROM "${schema}"."chat_threads" c
               LEFT JOIN "${schema}"."assistant_threads" a ON a.id = c.id
               WHERE a.id IS NULL AND c.id > $1
               ORDER BY c.id
               LIMIT $2`,
        values: [afterId, limit],
      },
    ],
  });
  return (res?.rows ?? [])
    .map((r) => r as Record<string, unknown>)
    .filter((r): r is { id: string; payload: string } =>
      typeof r.id === "string" && typeof r.payload === "string",
    );
}

/** Parse a legacy payload into the mirror's thread input. Defensive: a
 *  malformed payload yields a minimal `{ id }` thread — the mirror then
 *  shadows identity only (empty turn set), which is still strictly better
 *  than no shadow and self-heals on any later legacy write. */
export function parseThreadPayloadForMirror(
  row: DormantThreadRow,
): { id: string } & Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      // The row id is authoritative — a payload-embedded id never overrides it.
      return { ...(parsed as Record<string, unknown>), id: row.id };
    }
  } catch {
    // fall through to the identity-only shadow
  }
  return { id: row.id };
}

/**
 * Mirror every dormant legacy chat thread into the structured store. Batched;
 * per-thread transactional; soft-failing per row. Returns counts for the boot
 * log. Kill switch: CINATRA_ASSISTANT_THREAD_BACKFILL=off.
 */
export function runDormantAssistantThreadMirrorBackfill(options?: {
  log?: (message: string) => void;
}): DormantThreadBackfillResult {
  if (
    (process.env.CINATRA_ASSISTANT_THREAD_BACKFILL ?? "").trim().toLowerCase() === "off"
  ) {
    return { scanned: 0, backfilled: 0, failed: 0, skippedReason: "disabled via CINATRA_ASSISTANT_THREAD_BACKFILL=off" };
  }
  ensurePostgresSchema();
  const log = options?.log ?? (() => {});
  let scanned = 0;
  let backfilled = 0;
  let failed = 0;

  // Keyset pagination over the dormant set — deterministic forward progress
  // regardless of per-row failures (a failed row stays dormant and is picked
  // up by the next boot's pass; it can never wedge this one).
  let cursor = "";
  for (;;) {
    const rows = listDormantChatThreads(cursor, BATCH_LIMIT);
    if (rows.length === 0) break;
    for (const row of rows) {
      scanned += 1;
      try {
        const thread = parseThreadPayloadForMirror(row);
        const queries = buildAssistantThreadMirrorQueries({
          schemaName: postgresSchema,
          thread,
          explicitMirrorOrgId: null,
        });
        runPostgresQueriesSync({
          connectionString: getPostgresConnectionString(),
          queries,
          transaction: true,
        });
        backfilled += 1;
      } catch (err) {
        failed += 1;
        log(
          `[assistant-thread-backfill] thread ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    cursor = rows[rows.length - 1].id;
  }
  return { scanned, backfilled, failed };
}
