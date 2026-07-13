// core__0039 — chat-capture turn ledger (cinatra#1367, epic #1358 S9 —
// lifecycle-only slice; the assistant→agent target-mapping arm is deferred to
// the assistants epic #1037).
//
// One brand-new table: chat_capture_turns — the durable per-(thread, turn)
// record for the autosave-style chat-capture detection pipeline. A detection
// job claims its (thread_id, turn_id) row before any work (idempotency: BullMQ
// jobId dedup only suppresses while the completed job is retained in Redis;
// the ledger is the durable gate), records the produced skill + revision on
// capture (provenance that survives thread deletion), and carries
// classifier_called for the per-user rolling-window LLM-classifier quota
// (reserved via an atomic conditional UPDATE). No FK to chat_threads ON
// PURPOSE — the ledger is provenance that must survive a thread delete.
//
// Status vocabulary (CHECK below) is mirrored by CHAT_CAPTURE_TURN_STATUSES in
// src/lib/chat-capture/ledger.ts and by the bootstrap DDL leaf
// src/lib/chat-capture-schema.ts; chat-capture-schema.test.ts pins the sync.
// Nonterminal/re-claimable: 'claimed', 'classifying', 'error'; terminal:
// every 'skipped_*' + 'captured'.
//
// SEQ COORDINATION: renumbered to core__0039 — 0037 landed as artifact-uninstall (#1474), 0038 is claimed by
// concurrently-open sibling lanes at authoring time; the runner tolerates
// sequence gaps (the 0021/0023 precedent) if either lane lands elsewhere.
//
// ADDITIVE (brand-new empty table; migrations/README.md "Additive") — no
// artifact is REQUIRED. Shipped anyway (the core__0027 / core__0030 / core__0034
// precedent) to keep the fresh-bootstrap and operator-upgrade paths aligned and
// give the table a ledgered row. The DDL MIRRORS the idempotent bootstrap
// (buildCreateStoreSchemaQueries → chatCaptureSchemaQueries in
// src/lib/chat-capture-schema.ts) — a no-op on a bootstrap-seeded schema,
// ledger-faked on a fresh install, executed by `db migrate` on an existing
// deployment. No `noTransaction()` (guarded DDL on an empty table is instant).
// Unqualified names ride the runner's search_path (the app schema).

/** Idempotent DDL mirroring the bootstrap — safe to run after it. */
export const chatCaptureLedgerDdlSql = `
  CREATE TABLE IF NOT EXISTS chat_capture_turns (
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
  );
  CREATE INDEX IF NOT EXISTS chat_capture_turns_owner_created_idx
    ON chat_capture_turns (owner_user_id, created_at DESC);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(chatCaptureLedgerDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Fresh addition — exact pre-0037 shape on any lineage. Ledger rows
  // (idempotency + provenance + quota accounting) are deliberately
  // non-recoverable operational state.
  pgm.sql(`DROP TABLE IF EXISTS chat_capture_turns;`);
}
