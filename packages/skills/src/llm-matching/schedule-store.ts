import "server-only";

/**
 * Single-row read/write for the `skill_match_schedule` table.
 *
 * The table is a singleton keyed by `id = 'default'` (one optional cron per
 * deployment). When the row is absent, `readSchedule()` returns a sensible
 * default with `enabled = false` so boot-time registration becomes a no-op.
 * Boot-time DB read failure must not crash the app.
 *
 * Writes use `INSERT ... ON CONFLICT (id) DO UPDATE`. The DDL for this table
 * lives in `src/lib/drizzle-store.ts`.
 */

import { getPostgresConnectionString, postgresSchema } from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
// Defense-in-depth cron validation at the persistence boundary. The MCP
// handler validates first (and returns a clean PrimitiveInvocationError), but
// if any other call path reaches writeSchedule directly the store-side guard
// still rejects garbage before it lands in DB.
import { isValidCronExpression } from "./cron-validate";

export type SkillMatchSchedule = {
  id: "default";
  enabled: boolean;
  cronExpression: string | null;
  timezone: string;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  updatedAt: Date;
  /**
   * Production drift sampler enable flag. Disabled by default. When `true`,
   * the boot-time registration in `drift-sampler-boot.ts` registers a BullMQ
   * scheduler `skill-match-drift-sampler` at the configured
   * `driftSamplerCron` (or `SKILL_MATCH_DRIFT_DEFAULT_CRON` when null).
   * Independent of `enabled` (the existing batch scheduler flag) — both can
   * be turned on or off separately so an operator can sample drift without
   * ever running the batch reprocessor.
   */
  driftSamplerEnabled: boolean;
  /**
   * Cron pattern for the drift sampler. When null, the boot hook falls back
   * to `SKILL_MATCH_DRIFT_DEFAULT_CRON` (`0 3 * * *`, 03:00 UTC daily).
   * Validated by `isValidCronExpression()` in `writeSchedule()` exactly like
   * the batch `cronExpression` field.
   */
  driftSamplerCron: string | null;
};

const SCHEDULE_ID = "default" as const;

const DEFAULT_SCHEDULE: SkillMatchSchedule = {
  id: SCHEDULE_ID,
  enabled: false,
  cronExpression: null,
  timezone: "UTC",
  lastRunAt: null,
  lastRunStatus: null,
  updatedAt: new Date(0),
  // The drift sampler is opt-in and disabled by default.
  driftSamplerEnabled: false,
  driftSamplerCron: null,
};

function quotedSchema(): string {
  return `"${postgresSchema.replaceAll('"', '""')}"`;
}

function rowToSchedule(raw: Record<string, unknown>): SkillMatchSchedule {
  return {
    id: SCHEDULE_ID,
    enabled: Boolean(raw.enabled),
    cronExpression: raw.cron_expression == null ? null : String(raw.cron_expression),
    timezone: raw.timezone == null ? "UTC" : String(raw.timezone),
    lastRunAt: raw.last_run_at == null ? null : new Date(raw.last_run_at as string | number | Date),
    lastRunStatus: raw.last_run_status == null ? null : String(raw.last_run_status),
    updatedAt: new Date(raw.updated_at as string | number | Date),
    // Guard against rows where the drift sampler columns may be absent. The
    // DDL ALTER is idempotent, but a fresh schema migration may not have run
    // yet on an existing deployment.
    driftSamplerEnabled:
      raw.drift_sampler_enabled === undefined ? false : Boolean(raw.drift_sampler_enabled),
    driftSamplerCron:
      raw.drift_sampler_cron == null ? null : String(raw.drift_sampler_cron),
  };
}

export async function readSchedule(): Promise<SkillMatchSchedule> {
  const connectionString = getPostgresConnectionString();
  const schema = quotedSchema();
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT id, enabled, cron_expression, timezone, last_run_at, last_run_status, updated_at, drift_sampler_enabled, drift_sampler_cron FROM ${schema}."skill_match_schedule" WHERE id = $1 LIMIT 1`,
        values: [SCHEDULE_ID],
      },
    ],
  });
  if (!result.rows || result.rows.length === 0) return DEFAULT_SCHEDULE;
  return rowToSchedule(result.rows[0]);
}

export async function writeSchedule(
  updates: Partial<Omit<SkillMatchSchedule, "id" | "updatedAt">>,
): Promise<SkillMatchSchedule> {
  const current = await readSchedule();
  const merged: SkillMatchSchedule = {
    ...current,
    ...updates,
    id: SCHEDULE_ID,
    updatedAt: new Date(),
  };

  // Defense-in-depth cron validation.
  // When the schedule is being enabled, the cron expression MUST be a valid
  // 5- or 6-field pattern. The MCP handler is the primary call site and
  // validates first (returning a clean PrimitiveInvocationError); this
  // guard exists for direct callers and to guarantee no malformed row
  // can survive a future refactor of the handler layer.
  //
  // When `enabled === false` the cronExpression can be null or any string
  // (it will be ignored by the scheduler boot path). Validation only fires
  // when the schedule is actively being turned on.
  if (merged.enabled) {
    if (!isValidCronExpression(merged.cronExpression)) {
      throw new Error(
        `invalid_cron_expression: cron expression "${merged.cronExpression ?? "<null>"}" is not a valid 5- or 6-field cron pattern`,
      );
    }
  }

  // Same defense-in-depth for the drift sampler cron. When
  // `driftSamplerEnabled === true` and an explicit driftSamplerCron is
  // provided, validate it; an explicit-null is acceptable (the boot hook
  // will fall back to SKILL_MATCH_DRIFT_DEFAULT_CRON which is a static valid
  // pattern). Disabled drift samplers can carry any value (ignored at boot).
  if (merged.driftSamplerEnabled && merged.driftSamplerCron !== null) {
    if (!isValidCronExpression(merged.driftSamplerCron)) {
      throw new Error(
        `invalid_cron_expression: drift sampler cron expression "${merged.driftSamplerCron}" is not a valid 5- or 6-field cron pattern`,
      );
    }
  }

  const connectionString = getPostgresConnectionString();
  const schema = quotedSchema();
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `
          INSERT INTO ${schema}."skill_match_schedule" (
            id, enabled, cron_expression, timezone, last_run_at, last_run_status, updated_at,
            drift_sampler_enabled, drift_sampler_cron
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO UPDATE SET
            enabled = EXCLUDED.enabled,
            cron_expression = EXCLUDED.cron_expression,
            timezone = EXCLUDED.timezone,
            last_run_at = EXCLUDED.last_run_at,
            last_run_status = EXCLUDED.last_run_status,
            updated_at = EXCLUDED.updated_at,
            drift_sampler_enabled = EXCLUDED.drift_sampler_enabled,
            drift_sampler_cron = EXCLUDED.drift_sampler_cron
        `,
        values: [
          merged.id,
          merged.enabled,
          merged.cronExpression,
          merged.timezone,
          merged.lastRunAt ? merged.lastRunAt.toISOString() : null,
          merged.lastRunStatus,
          merged.updatedAt.toISOString(),
          merged.driftSamplerEnabled,
          merged.driftSamplerCron,
        ],
      },
    ],
  });

  return merged;
}
