import "server-only";
import { BATCH_STATUS_IN_FLIGHT } from "./constants";

/**
 * Reads + writes for `skill_match_batch_runs`.
 *
 * One row per matching run — a provider batch submission OR a synchronous
 * fan-out run on a batch-less provider (batch_id prefixed `sync-`). The
 * persisted status lifecycle (validating → in_progress → finalizing/cancelling
 * → completed | failed | expired | cancelled) is the STABLE vocabulary;
 * provider-neutral batch-v2 states are mapped onto it at the poll seam
 * (`mapBatchV2StatusToPersisted`).
 *
 * Setup-flow S6 additions:
 *   - `provider` / `model` — the FROZEN run context, persisted at run creation
 *     so polling/cancel/download always drive the adapter the batch was
 *     submitted to (never the live default, which can change mid-run).
 *   - `manifestJson` — the durable per-request submission manifest (keyed by
 *     customId, carrying submit-time input hashes). Nulled after terminal
 *     processing to shed bulk.
 *   - `processedPairCount` — truthful progress for synchronous fan-out runs.
 *   - `inputFileId` became nullable: the neutral batch-v2 surface exposes no
 *     provider file ids, and synchronous runs never had one.
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
import type { SkillMatchSubmissionManifestEntry } from "./types";

export type SkillMatchBatchRun = {
  batchId: string;
  submittedBy: string;
  submittedAt: Date;
  pairCount: number;
  inputFileId: string | null;
  outputFileId: string | null;
  errorFileId: string | null;
  status: string;
  lastPolledAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  evaluatorVersion: string;
  /** Frozen run context (null on rows persisted before S6). */
  provider: string | null;
  model: string | null;
  /** Durable submission manifest; null before S6 or after terminal cleanup. */
  manifest: SkillMatchSubmissionManifestEntry[] | null;
  /** Pairs processed so far (synchronous fan-out progress; 0 for batch runs). */
  processedPairCount: number;
};

function quotedSchema(): string {
  return `"${postgresSchema.replaceAll('"', '""')}"`;
}

function parseManifest(raw: unknown): SkillMatchSubmissionManifestEntry[] | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return null;
    const entries: SkillMatchSubmissionManifestEntry[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) return null;
      const e = entry as Record<string, unknown>;
      if (
        typeof e.customId !== "string" ||
        typeof e.agentId !== "string" ||
        typeof e.skillId !== "string" ||
        typeof e.agentInputHash !== "string" ||
        typeof e.skillInputHash !== "string"
      ) {
        return null;
      }
      entries.push({
        customId: e.customId,
        agentId: e.agentId,
        skillId: e.skillId,
        agentInputHash: e.agentInputHash,
        skillInputHash: e.skillInputHash,
      });
    }
    return entries;
  } catch {
    // A corrupted manifest cell must not crash the poll chain; the poll
    // handler treats a null manifest as "unmappable" and reports it.
    return null;
  }
}

function rowToBatchRun(raw: Record<string, unknown>): SkillMatchBatchRun {
  return {
    batchId: String(raw.batch_id),
    submittedBy: String(raw.submitted_by),
    submittedAt: new Date(raw.submitted_at as string | number | Date),
    pairCount: Number(raw.pair_count),
    inputFileId: raw.input_file_id == null ? null : String(raw.input_file_id),
    outputFileId: raw.output_file_id == null ? null : String(raw.output_file_id),
    errorFileId: raw.error_file_id == null ? null : String(raw.error_file_id),
    status: String(raw.status),
    lastPolledAt:
      raw.last_polled_at == null ? null : new Date(raw.last_polled_at as string | number | Date),
    completedAt:
      raw.completed_at == null ? null : new Date(raw.completed_at as string | number | Date),
    errorMessage: raw.error_message == null ? null : String(raw.error_message),
    evaluatorVersion: String(raw.evaluator_version),
    provider: raw.provider == null ? null : String(raw.provider),
    model: raw.model == null ? null : String(raw.model),
    manifest: parseManifest(raw.manifest_json),
    processedPairCount:
      raw.processed_pair_count == null ? 0 : Number(raw.processed_pair_count),
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
            error_message, evaluator_version, provider, model, manifest_json,
            processed_pair_count
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
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
          row.provider,
          row.model,
          row.manifest === null ? null : JSON.stringify(row.manifest),
          row.processedPairCount,
        ],
      },
    ],
  });
}

export type UpdateBatchRunInput = Partial<
  Omit<
    SkillMatchBatchRun,
    | "batchId"
    | "submittedAt"
    | "submittedBy"
    | "pairCount"
    | "inputFileId"
    | "evaluatorVersion"
    | "provider"
    | "model"
  >
>;

/**
 * Dynamic UPDATE — only the fields present on `updates` are written. Mirrors
 * the dynamic-update pattern used elsewhere in the codebase. No-op when
 * `updates` is empty. The frozen run-context columns (provider/model) and the
 * submit-time identity columns are deliberately NOT updatable — the run
 * context is immutable by construction.
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
  if ("manifest" in updates)
    addClause(
      "manifest_json",
      updates.manifest === null || updates.manifest === undefined
        ? null
        : JSON.stringify(updates.manifest),
    );
  if ("processedPairCount" in updates && updates.processedPairCount !== undefined)
    addClause("processed_pair_count", updates.processedPairCount);

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
