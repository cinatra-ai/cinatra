// Retroactive DORMANT-HISTORY durable-content purge (cinatra#1037 P5.6 PR2
// CUTOVER, codex decision-3 — the drop-history invariant).
//
// RELOCATED from the retired src/lib/assistant-thread-mirror-backfill.ts: the
// one-shot boot mirror backfill it lived beside was DELETED in the PR2 write
// cutover (the structured mirror is now the sole writer, so there is no dormant
// legacy corpus left to shadow). This purge survives because it cleans up the
// durable `legacy:` content a PRE-guard boot backfill may ALREADY have copied in
// a deployed database — it is wired to the cutover-marker timestamp as a
// Migrate+Verify production step, independent of the (now-gone) backfill pass.

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";

function schemaIdent(): string {
  return postgresSchema.replaceAll('"', '""');
}

export type DormantContentPurgeResult = {
  /** Count of legacy-mirror content turns in scope (the audit number). */
  auditedContentTurns: number;
  /** Rows whose durable content was nulled (0 on a dry run). */
  purged: number;
  dryRun: boolean;
};

/**
 * Audit (and optionally purge) DORMANT-HISTORY durable content that a PRE-guard
 * boot backfill may have copied into `legacy:` content turns (cinatra#1037 P5.6
 * PR2 CUTOVER, codex decision-3 — the drop-history invariant).
 *
 * Before the (now-removed) `stripTurnContent` guard landed, the dormant-thread
 * boot backfill reused the (post-EXPAND) contentful mirror projection and could
 * copy a pre-cutover thread's message history into durable `legacy:` content
 * turns — making a thread that must DROP wrongly re-appear as post-cutover
 * content. This helper finds those rows and, when `dryRun` is false, NULLs their
 * durable content + ordinal so the thread falls back out of the content-presence
 * gate (the drop-history exclusion), exactly as if it had never been backfilled.
 *
 * SCOPE (fail-safe): only `legacy:`-namespaced, run_id-NULL, content-bearing
 * turns are ever touched — a runtime-native turn (bare UUID / run_id set) can
 * never be reached. `beforeUpdatedAt` (RECOMMENDED for production) restricts the
 * purge to threads not modified since a cutoff — i.e. genuinely dormant
 * pre-cutover threads — so an actively-conversing thread's live durable history
 * is never nulled. The production cutoff is the cutover-marker timestamp.
 * Omitting it audits/purges the WHOLE legacy-mirror content set and MUST NOT be
 * run destructively in production (a lane-DB / test-corpus audit only).
 *
 * DEFAULT dryRun=true — the caller must OPT IN to the destructive purge.
 */
export function purgeBackfilledDormantContentTurns(options?: {
  dryRun?: boolean;
  /** ISO timestamp: restrict to threads whose `updated_at` is strictly before
   *  this (the pre-cutover dormancy cutoff). Omit to scope the whole set. */
  beforeUpdatedAt?: string | null;
}): DormantContentPurgeResult {
  const dryRun = options?.dryRun ?? true;
  const before = options?.beforeUpdatedAt ?? null;
  // A DESTRUCTIVE purge MUST be cutoff-bounded (codex convergence): without a
  // `beforeUpdatedAt` the scope predicate degenerates to "$1 IS NULL → every
  // legacy-mirror content turn", which would null an actively-conversing
  // thread's live durable history. The unbounded form is permitted ONLY for a
  // dry-run AUDIT (count). Fail-closed — guard FIRST, before any DB touch
  // (ensurePostgresSchema itself may hit Postgres on a cold path).
  if (!dryRun && before === null) {
    throw new Error(
      "purgeBackfilledDormantContentTurns: a destructive purge (dryRun:false) requires an explicit beforeUpdatedAt cutoff — refusing an unbounded content wipe.",
    );
  }
  ensurePostgresSchema();
  const schema = schemaIdent();

  // Scope predicate: legacy-mirror content turns, optionally restricted to
  // threads dormant since the cutoff. Parameter $1 is the cutoff (or NULL → no
  // time restriction). The join keys the cutoff on the OWNING thread's
  // updated_at, so a per-turn timestamp can never widen the scope.
  const scope = `t.id LIKE 'legacy:%'
       AND t.run_id IS NULL
       AND t.content IS NOT NULL
       AND ($1::timestamptz IS NULL OR th.updated_at < $1::timestamptz)`;

  const [auditRes] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT count(*)::int AS n
               FROM "${schema}"."assistant_turns" t
               JOIN "${schema}"."assistant_threads" th ON th.id = t.thread_id
               WHERE ${scope}`,
        values: [before],
      },
    ],
  });
  const auditedContentTurns = Number(
    (auditRes?.rows?.[0] as Record<string, unknown> | undefined)?.n ?? 0,
  );

  if (dryRun || auditedContentTurns === 0) {
    return { auditedContentTurns, purged: 0, dryRun };
  }

  const [purgeRes] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      {
        text: `UPDATE "${schema}"."assistant_turns" t
               SET content = NULL, ordinal = NULL, updated_at = now()
               FROM "${schema}"."assistant_threads" th
               WHERE th.id = t.thread_id AND ${scope}`,
        values: [before],
      },
    ],
  });
  const purged = Number(
    (purgeRes as { rowCount?: number } | undefined)?.rowCount ?? auditedContentTurns,
  );
  return { auditedContentTurns, purged, dryRun: false };
}
