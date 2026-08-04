import "server-only";

/**
 * Idempotent DDL slice for the skill-matcher's provider-neutral run model
 * (setup-flow S6), spread into `ensurePostgresSchema`'s query list by
 * `src/lib/drizzle-store.ts`. Extracted as a vertical slice so the
 * size-ratcheted store module does not grow.
 *
 *  - `skill_matches.provider` / `.model`: run-context provenance on match
 *    rows. Nullable — rule/manual rows never carry them, and rows persisted
 *    by the pinned-era evaluator (llm-matcher-v1) predate provenance; the
 *    LLM_MATCHER_VERSION bump makes those visible to the staleness sweep.
 *  - `skill_match_batch_runs.provider` / `.model`: the FROZEN run context,
 *    persisted at run creation so poll/cancel/download always drive the
 *    submitting provider's adapter (never the live default).
 *  - `skill_match_batch_runs.manifest_json`: the durable per-request
 *    submission manifest (customId → pair identity + submit-time input
 *    hashes); nulled after terminal processing to shed bulk.
 *  - `skill_match_batch_runs.processed_pair_count`: truthful progress for
 *    synchronous fan-out runs.
 *  - `input_file_id` becomes nullable: the neutral batch-v2 surface exposes
 *    no provider file ids, and synchronous runs never had one.
 *  - The in-flight partial index gains `cancelling` (present in the adapter
 *    contract's lifecycle, previously missing, so a cancelling batch fell out
 *    of the in-flight reader). Replaced under a NEW name so the change is a
 *    plain idempotent drop+create-once, not per-boot churn.
 */

type QueryInput = { text: string; values?: unknown[] };

export function skillMatchRunContextDdl(schemaName: string): QueryInput[] {
  const q = schemaName.replaceAll('"', '""');
  return [
    {
      text: `ALTER TABLE "${q}"."skill_matches"
        ADD COLUMN IF NOT EXISTS provider text,
        ADD COLUMN IF NOT EXISTS model text`,
    },
    {
      text: `ALTER TABLE "${q}"."skill_match_batch_runs"
        ADD COLUMN IF NOT EXISTS provider text,
        ADD COLUMN IF NOT EXISTS model text,
        ADD COLUMN IF NOT EXISTS manifest_json text,
        ADD COLUMN IF NOT EXISTS processed_pair_count integer NOT NULL DEFAULT 0,
        ALTER COLUMN input_file_id DROP NOT NULL`,
    },
    {
      text: `DROP INDEX IF EXISTS "${q}"."skill_match_batch_runs_status_idx"`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS skill_match_batch_runs_in_flight_idx ON "${q}"."skill_match_batch_runs" (status) WHERE status IN ('validating', 'in_progress', 'finalizing', 'cancelling')`,
    },
  ];
}
