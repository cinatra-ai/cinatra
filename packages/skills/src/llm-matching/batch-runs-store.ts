import "server-only";
import { BATCH_STATUS_IN_FLIGHT } from "./constants";

/**
 * Reads + writes for `skill_match_batch_runs`.
 *
 * One row per OpenAI batch submission. The batch lifecycle (validating →
 * in_progress → finalizing → completed | failed | expired | cancelled) is
 * mirrored verbatim in the `status` column. The poll handler stamps
 * `last_polled_at` on every retrieve and `completed_at` only when the
 * batch reaches a terminal state.
 *
 * Every write to `error_message` MUST be wrapped with the
 * `redactErrorMessage()` helper from `./upsert.ts` BEFORE reaching this
 * module. This module performs unconditional INSERT/UPDATE — caller is
 * responsible for redaction. The DB column is `text` (not capped) so the
 * 1 KiB cap is enforced application-side before writes reach this module.
 *
 * The DDL for this table lives in `src/lib/drizzle-store.ts`.
 */

import { getPostgresConnectionString, postgresSchema } from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

export type SkillMatchBatchRun = {
  batchId: string;
  submittedBy: string;
  submittedAt: Date;
  pairCount: number;
  inputFileId: string;
  outputFileId: string | null;
  errorFileId: string | null;
  status: string;
  lastPolledAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  evaluatorVersion: string;
};

function quotedSchema(): string {
  return `"${postgresSchema.replaceAll('"', '""')}"`;
}

function rowToBatchRun(raw: Record<string, unknown>): SkillMatchBatchRun {
  return {
    batchId: String(raw.batch_id),
    submittedBy: String(raw.submitted_by),
    submittedAt: new Date(raw.submitted_at as string | number | Date),
    pairCount: Number(raw.pair_count),
    inputFileId: String(raw.input_file_id),
    outputFileId: raw.output_file_id == null ? null : String(raw.output_file_id),
    errorFileId: raw.error_file_id == null ? null : String(raw.error_file_id),
    status: String(raw.status),
    lastPolledAt:
      raw.last_polled_at == null ? null : new Date(raw.last_polled_at as string | number | Date),
    completedAt:
      raw.completed_at == null ? null : new Date(raw.completed_at as string | number | Date),
    errorMessage: raw.error_message == null ? null : String(raw.error_message),
    evaluatorVersion: String(raw.evaluator_version),
  };
}

export async function insertBatchRun(row: SkillMatchBatchRun): Promise<void> {
  const connectionString = getPostgresConnectionString();
  const schema = quotedSchema();
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `
          INSERT INTO ${schema}."skill_match_batch_runs" (
            batch_id, submitted_by, submitted_at, pair_count, input_file_id,
            output_file_id, error_file_id, status, last_polled_at, completed_at,
            error_message, evaluator_version
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `,
        values: [
          row.batchId,
          row.submittedBy,
          row.submittedAt.toISOString(),
          row.pairCount,
          row.inputFileId,
          row.outputFileId,
          row.errorFileId,
          row.status,
          row.lastPolledAt ? row.lastPolledAt.toISOString() : null,
          row.completedAt ? row.completedAt.toISOString() : null,
          row.errorMessage,
          row.evaluatorVersion,
        ],
      },
    ],
  });
}

export type UpdateBatchRunInput = Partial<
  Omit<
    SkillMatchBatchRun,
    "batchId" | "submittedAt" | "submittedBy" | "pairCount" | "inputFileId" | "evaluatorVersion"
  >
>;

/**
 * Dynamic UPDATE — only the fields present on `updates` are written. Mirrors
 * the dynamic-update pattern used elsewhere in the codebase. No-op when
 * `updates` is empty.
 */
export async function updateBatchRun(batchId: string, updates: UpdateBatchRunInput): Promise<void> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  function addClause(column: string, value: unknown) {
    setClauses.push(`${column} = $${paramIdx}`);
    values.push(value);
    paramIdx += 1;
  }

  if ("outputFileId" in updates) addClause("output_file_id", updates.outputFileId ?? null);
  if ("errorFileId" in updates) addClause("error_file_id", updates.errorFileId ?? null);
  if ("status" in updates && updates.status !== undefined) addClause("status", updates.status);
  if ("lastPolledAt" in updates)
    addClause("last_polled_at", updates.lastPolledAt ? updates.lastPolledAt.toISOString() : null);
  if ("completedAt" in updates)
    addClause("completed_at", updates.completedAt ? updates.completedAt.toISOString() : null);
  if ("errorMessage" in updates) addClause("error_message", updates.errorMessage ?? null);

  if (setClauses.length === 0) return;

  // batchId param goes last.
  values.push(batchId);
  const whereParam = paramIdx;

  const connectionString = getPostgresConnectionString();
  const schema = quotedSchema();
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `UPDATE ${schema}."skill_match_batch_runs" SET ${setClauses.join(", ")} WHERE batch_id = $${whereParam}`,
        values,
      },
    ],
  });
}

export async function readBatchRun(batchId: string): Promise<SkillMatchBatchRun | null> {
  const connectionString = getPostgresConnectionString();
  const schema = quotedSchema();
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT * FROM ${schema}."skill_match_batch_runs" WHERE batch_id = $1`,
        values: [batchId],
      },
    ],
  });
  if (!result.rows || result.rows.length === 0) return null;
  return rowToBatchRun(result.rows[0]);
}

export async function readLatestBatchRun(): Promise<SkillMatchBatchRun | null> {
  const connectionString = getPostgresConnectionString();
  const schema = quotedSchema();
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT * FROM ${schema}."skill_match_batch_runs" ORDER BY submitted_at DESC LIMIT 1`,
        values: [],
      },
    ],
  });
  if (!result.rows || result.rows.length === 0) return null;
  return rowToBatchRun(result.rows[0]);
}

export async function readInFlightBatchRuns(): Promise<SkillMatchBatchRun[]> {
  // Build the IN (...) clause from BATCH_STATUS_IN_FLIGHT so the constants
  // module is the single source of truth for "what statuses count as
  // in-flight" across jobs.ts, the status panel, and this store reader.
  const statuses = Array.from(BATCH_STATUS_IN_FLIGHT);
  const placeholders = statuses.map((_, i) => `$${i + 1}`).join(", ");
  const connectionString = getPostgresConnectionString();
  const schema = quotedSchema();
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT * FROM ${schema}."skill_match_batch_runs" WHERE status IN (${placeholders}) ORDER BY submitted_at DESC`,
        values: statuses,
      },
    ],
  });
  return (result.rows ?? []).map(rowToBatchRun);
}
