// Bootstrap DDL for the chat-capture turn ledger (cinatra#1367, epic #1358 S9
// — the lifecycle-only slice; the assistant→agent target-mapping arm is
// deferred to #1037).
//
// `chat_capture_turns` is the durable per-(thread, turn) record for the
// autosave-style chat-capture pipeline. One row per DETECTED user turn, doing
// triple duty:
//   1. idempotency — the detection job claims its (thread_id, turn_id) row
//      before any work; a terminal row makes every re-delivery a no-op
//      (BullMQ jobId dedup is only best-effort suppression: completed jobs
//      age out of Redis retention, the ledger is the durable gate);
//   2. provenance — a captured turn records the skill + revision it produced
//      (thread/turn → skill/revision traceability that survives thread
//      deletion, per the #1367 design);
//   3. rate accounting — `classifier_called` rows per owner in a rolling
//      window back the per-user LLM-classifier cap (the quota reservation is
//      an atomic conditional UPDATE against this table).
//
// Status vocabulary (mirrored by CHAT_CAPTURE_TURN_STATUSES in
// src/lib/chat-capture/ledger.ts; chat-capture-schema.test.ts pins the sync):
//   claimed            — row claimed by a detection job; nonterminal.
//   classifying        — quota reserved, classifier call in flight; nonterminal.
//   skipped_disabled   — master switch or the per-user preference was off.
//   skipped_missing    — thread/turn no longer resolvable (deleted/edited) or
//                        owner drifted since enqueue.
//   skipped_prefilter  — lexical pre-filter rejected the turn (NO classifier
//                        call — ordinary turns cost zero LLM, provable from
//                        classifier_called=false).
//   skipped_rate_capped— per-user classifier quota exhausted.
//   skipped_classifier — classifier judged the turn not a durable instruction.
//   captured           — distilled into the owner's chat-capture skill.
//   error              — pipeline failure; retryable (a re-claim is allowed).
// Terminal: every `skipped_*` + `captured`. Nonterminal (re-claimable):
// `claimed`, `classifying`, `error` — so a worker crash or a transient failure
// never strands a turn (codex round-0 finding 3, 2026-07-13).
//
// A pure string builder with ZERO imports — a synchronous leaf, safe for
// drizzle-store.ts's synchronous require() composition (same contract as
// skill-lifecycle-schema.ts / the postgres-sync-leaf-imports test).

/**
 * chat_capture_turns — spread into buildCreateStoreSchemaQueries (additive,
 * brand-new table; no FK to chat_threads ON PURPOSE: the ledger is provenance
 * that must survive thread deletion).
 */
export function chatCaptureSchemaQueries(schemaName: string): { text: string }[] {
  const q = schemaName.replaceAll('"', '""');
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."chat_capture_turns" (
      thread_id text NOT NULL,
      turn_id text NOT NULL,
      owner_user_id text NOT NULL,
      status text NOT NULL DEFAULT 'claimed',
      classifier_called boolean NOT NULL DEFAULT false,
      skill_id text,
      revision_id text,
      detail text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (thread_id, turn_id),
      CONSTRAINT chat_capture_turns_status_check CHECK (status IN ('claimed','classifying','skipped_disabled','skipped_missing','skipped_prefilter','skipped_rate_capped','skipped_classifier','captured','error'))
    )`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS chat_capture_turns_owner_created_idx ON "${q}"."chat_capture_turns" (owner_user_id, created_at DESC)`,
    },
  ];
}
