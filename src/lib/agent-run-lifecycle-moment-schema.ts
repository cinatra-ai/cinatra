// Bootstrap DDL for the agent_runs LIFECYCLE MOMENT TRIPLE (cinatra#2928,
// lifecycle-b W2a) — a pure string builder with ZERO imports, so
// `drizzle-store.ts` can compose it synchronously (the same leaf shape as
// `agent-run-created-at-schema.ts` and `review-island-grant-schema.ts`).
//
// WHY A LEAF AND NOT THREE INLINE LINES. `src/lib/drizzle-store.ts` sits AT its
// file-size ceiling, which may only ever shrink. The leaf carries the three
// statements and the reasoning; the composing module pays one spread that rides
// an existing line.
//
// WHAT THE THREE COLUMNS ARE. A run records which lifecycle moment it is
// waiting at, which card that moment is, and the card's server-checked
// reference:
//
//   lifecycle_moment     — one of the five moments (recommendation | schedule |
//                          hitl | review | audit). NULL when the run is at no
//                          moment at all, which is every run that is simply
//                          running or finished.
//   lifecycle_card_kind  — the `LifecycleCardKind` that moment mounts, so a host
//                          reads the card off the row instead of deriving it.
//   lifecycle_card_ref   — the card's reference, re-checked server-side under
//                          the reader's own identity on every mount. It is NOT a
//                          capability: holding one buys nothing, because the
//                          resolve re-authorizes from scratch.
//
// WHY THE ROW CARRIES IT. Today a screen re-derives what a run is waiting for
// from the SHAPE of its pause — a synthetic task id prefix, the presence of a
// field name on an interrupt. A wait for a setup field and a wait for a review
// are two different facts and are recorded as two different facts here, so no
// surface has to tell them apart by pattern-matching a pause.
//
// ADDITIVE AND NULLABLE, on purpose. Every pre-existing row reads NULL, which is
// exactly "this run is at no recorded moment" — the behaviour every surface
// already has for a run whose moment it cannot name. No backfill: a moment is a
// LIVE fact about a waiting run, and inventing one for a historical row would be
// recording something nobody observed.
//
// SCHEMA PATH. Three new NULLABLE columns and one NON-UNIQUE partial index are
// what `scripts/audit/schema-migration-gate.mjs` classifies as ADDITIVE, so this
// ships through the idempotent bootstrap alone — the `human_present` /
// `timeout_seconds` / `streamed_text` precedent, which is how every previous
// additive `agent_runs` column landed. There is deliberately NO numbered
// migration twin: the versioned chain exists for transformational change to
// tables that already hold user data, and nothing here rewrites a row.
//
// ON REPLAY every statement is a no-op (ADD COLUMN IF NOT EXISTS / CREATE INDEX
// IF NOT EXISTS), and no statement of any kind writes to an existing row.

export function agentRunLifecycleMomentSchemaQueries(
  schemaName: string,
): { text: string }[] {
  const s = schemaName.replaceAll('"', '""');
  return [
    { text: `ALTER TABLE "${s}"."agent_runs" ADD COLUMN IF NOT EXISTS lifecycle_moment text` },
    { text: `ALTER TABLE "${s}"."agent_runs" ADD COLUMN IF NOT EXISTS lifecycle_card_kind text` },
    { text: `ALTER TABLE "${s}"."agent_runs" ADD COLUMN IF NOT EXISTS lifecycle_card_ref text` },
    // Reading "which runs are parked at a moment" is the run-list and
    // notification query; the partial index keeps it off a sequential scan
    // without indexing the overwhelming majority of rows, which carry NULL.
    { text: `CREATE INDEX IF NOT EXISTS agent_runs_lifecycle_moment_idx ON "${s}"."agent_runs" (lifecycle_moment) WHERE lifecycle_moment IS NOT NULL` },
  ];
}
