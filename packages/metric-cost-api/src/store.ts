import "server-only";
import { sql, eq, desc, and, gte, lte, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, metadataTable } from "./db";
import { usageEvents, legacyCosts, modelPricing, traces } from "./schema";

export async function insertUsageEvent(
  row: typeof usageEvents.$inferInsert,
): Promise<void> {
  await db
    .insert(usageEvents)
    .values(row)
    .onConflictDoNothing({ target: usageEvents.idempotencyKey });
}

// ---------------------------------------------------------------------------
// Dashboard query types
// ---------------------------------------------------------------------------

export type CostSummaryRow = {
  totalAllTime: number | null;
  totalThisMonth: number | null;
  totalThisWeek: number | null;
  eventCount: number;
  nullCostCount: number;
};

export type CostByProviderRow = {
  provider: string;
  model: string | null;
  totalCost: number | null;
  totalInput: number;
  totalOutput: number;
  callCount: number;
};

export type CostByAgentRow = {
  agentLabel: string | null;
  totalCost: number | null;
  callCount: number;
};

export type CostBySkillRow = {
  skillLabel: string | null;
  totalCost: number | null;
  callCount: number;
};

export type CostTimeSeriesRow = {
  day: string;
  provider: string;
  cost: number;
};

export type SubscriptionCosts = {
  apolloMonthlyUsd: number | null;
  apifyMonthlyUsd: number | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALLOWED_DAYS = [7, 30, 90];
function sanitizeDays(days: number): number {
  return ALLOWED_DAYS.includes(days) ? days : 30;
}

const ALLOWED_PROVIDERS = ["openai", "anthropic", "gemini", "apollo"];

// ---------------------------------------------------------------------------
// Dashboard query functions
// ---------------------------------------------------------------------------

export async function readCostSummary(): Promise<CostSummaryRow> {
  const rows = await db.execute(sql`
    SELECT
      SUM(cost_usd)::float AS total_all_time,
      SUM(cost_usd) FILTER (WHERE occurred_at >= date_trunc('month', now() AT TIME ZONE 'UTC'))::float AS total_this_month,
      SUM(cost_usd) FILTER (WHERE occurred_at >= date_trunc('week', now() AT TIME ZONE 'UTC'))::float AS total_this_week,
      COUNT(*)::int AS event_count,
      COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS null_cost_count
    FROM ${usageEvents}
  `);
  const row = rows.rows[0] as Record<string, unknown>;
  return {
    totalAllTime: row.total_all_time as number | null,
    totalThisMonth: row.total_this_month as number | null,
    totalThisWeek: row.total_this_week as number | null,
    eventCount: Number(row.event_count) || 0,
    nullCostCount: Number(row.null_cost_count) || 0,
  };
}

export async function readCostByProvider({ days }: { days: number }): Promise<CostByProviderRow[]> {
  const safeDays = sanitizeDays(days);
  const rows = await db.execute(sql`
    SELECT
      provider,
      model,
      SUM(cost_usd)::float AS "totalCost",
      SUM(input_tokens)::int AS "totalInput",
      SUM(output_tokens)::int AS "totalOutput",
      COUNT(*)::int AS "callCount"
    FROM ${usageEvents}
    WHERE occurred_at >= now() - interval '1 day' * ${safeDays}
    GROUP BY provider, model
    ORDER BY SUM(cost_usd) DESC NULLS LAST
  `);
  return rows.rows as CostByProviderRow[];
}

export async function readCostByAgent({ days }: { days: number }): Promise<CostByAgentRow[]> {
  const safeDays = sanitizeDays(days);
  const rows = await db.execute(sql`
    SELECT
      agent_label AS "agentLabel",
      SUM(cost_usd)::float AS "totalCost",
      COUNT(*)::int AS "callCount"
    FROM ${usageEvents}
    WHERE occurred_at >= now() - interval '1 day' * ${safeDays}
    GROUP BY agent_label
    ORDER BY SUM(cost_usd) DESC NULLS LAST
  `);
  return rows.rows as CostByAgentRow[];
}

export async function readCostBySkill({ days }: { days: number }): Promise<CostBySkillRow[]> {
  const safeDays = sanitizeDays(days);
  const rows = await db.execute(sql`
    SELECT
      skill_label AS "skillLabel",
      SUM(cost_usd)::float AS "totalCost",
      COUNT(*)::int AS "callCount"
    FROM ${usageEvents}
    WHERE occurred_at >= now() - interval '1 day' * ${safeDays}
    GROUP BY skill_label
    ORDER BY SUM(cost_usd) DESC NULLS LAST
  `);
  return rows.rows as CostBySkillRow[];
}

export async function readCostTimeSeries({ days }: { days: number }): Promise<CostTimeSeriesRow[]> {
  const safeDays = sanitizeDays(days);
  // Cross-join date spine × distinct providers so every (day, provider) pair
  // appears in the result — missing days get cost=0 rather than disappearing.
  const rows = await db.execute(sql`
    SELECT
      gs.day::date::text AS day,
      p.provider,
      COALESCE(SUM(ue.cost_usd), 0)::float AS cost
    FROM generate_series(
      (now() AT TIME ZONE 'UTC' - interval '1 day' * (${safeDays} - 1))::date,
      (now() AT TIME ZONE 'UTC')::date,
      '1 day'::interval
    ) AS gs(day)
    CROSS JOIN (
      SELECT DISTINCT provider
      FROM ${usageEvents}
      WHERE provider IS NOT NULL
    ) AS p
    LEFT JOIN ${usageEvents} ue
      ON date_trunc('day', ue.occurred_at AT TIME ZONE 'UTC')::date = gs.day
      AND ue.provider = p.provider
    GROUP BY gs.day, p.provider
    ORDER BY gs.day, p.provider
  `);
  return rows.rows as CostTimeSeriesRow[];
}

// ---------------------------------------------------------------------------
// Chart-oriented timeseries query (metric_cost_timeseries MCP tool)
// ---------------------------------------------------------------------------

export type CostTimeseriesChartResult = {
  days: number;
  groupBy: "provider" | "agent" | "model";
  granularity: "day";
  points: Array<{
    date: string;      // YYYY-MM-DD
    buckets: Record<string, number>;
    total: number;
  }>;
};

/**
 * Returns daily cost time series pivoted by the requested groupBy dimension.
 * The date spine is always dense (every day for the last N days appears even
 * if there were no events) so charting libraries always get contiguous x-values.
 *
 * Security: days is clamped to 1-366 before being interpolated into the SQL.
 */
export async function readCostTimeseriesForChart({
  days,
  groupBy,
}: {
  days: number;
  groupBy: "provider" | "agent" | "model";
}): Promise<CostTimeseriesChartResult> {
  // Clamp days to a safe range independent of sanitizeDays() which only allows [7,30,90].
  const safeDays = Math.min(Math.max(Math.floor(days), 1), 366);

  const bucketExpr =
    groupBy === "provider"
      ? sql`COALESCE(ue.provider, 'unknown')`
      : groupBy === "agent"
      ? sql`COALESCE(ue.agent_label, 'unknown')`
      : sql`COALESCE(ue.model, 'unknown')`;

  const rows = await db.execute(sql`
    SELECT
      gs.day::date::text AS day,
      ${bucketExpr} AS bucket,
      COALESCE(SUM(ue.cost_usd), 0)::float AS cost
    FROM generate_series(
      (now() AT TIME ZONE 'UTC' - interval '1 day' * (${safeDays} - 1))::date,
      (now() AT TIME ZONE 'UTC')::date,
      '1 day'::interval
    ) AS gs(day)
    LEFT JOIN ${usageEvents} ue
      ON date_trunc('day', ue.occurred_at AT TIME ZONE 'UTC')::date = gs.day
    GROUP BY gs.day, ${bucketExpr}
    ORDER BY gs.day, ${bucketExpr}
  `);

  // Pivot rows: day -> { bucketName -> cost, total }
  const byDay = new Map<string, { buckets: Record<string, number>; total: number }>();

  for (const r of rows.rows as Array<{ day: string; bucket: string; cost: number }>) {
    let entry = byDay.get(r.day);
    if (!entry) {
      entry = { buckets: {}, total: 0 };
      byDay.set(r.day, entry);
    }
    entry.buckets[r.bucket] = (entry.buckets[r.bucket] ?? 0) + r.cost;
    entry.total += r.cost;
  }

  const points = Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { buckets, total }]) => ({ date, buckets, total }));

  return { days: safeDays, groupBy, granularity: "day", points };
}

export async function readRecentEvents({ limit, provider }: { limit: number; provider?: string }) {
  const safeProvider = provider && ALLOWED_PROVIDERS.includes(provider) ? provider : undefined;
  const rows = await db.execute(
    safeProvider
      ? sql`
          SELECT * FROM ${usageEvents}
          WHERE provider = ${safeProvider}
          ORDER BY occurred_at DESC
          LIMIT ${limit}
        `
      : sql`
          SELECT * FROM ${usageEvents}
          ORDER BY occurred_at DESC
          LIMIT ${limit}
        `
  );
  return rows.rows;
}

const SUBSCRIPTION_COSTS_KEY = "metrics_cost:subscription_costs";

export async function readSubscriptionCosts(): Promise<SubscriptionCosts> {
  const rows = await db
    .select({ value: metadataTable.value })
    .from(metadataTable)
    .where(eq(metadataTable.key, SUBSCRIPTION_COSTS_KEY))
    .limit(1);
  if (!rows[0]) return { apolloMonthlyUsd: null, apifyMonthlyUsd: null };
  const parsed = JSON.parse(rows[0].value) as Partial<SubscriptionCosts>;
  return {
    apolloMonthlyUsd: parsed.apolloMonthlyUsd ?? null,
    apifyMonthlyUsd: parsed.apifyMonthlyUsd ?? null,
  };
}

export async function writeSubscriptionCosts(costs: SubscriptionCosts): Promise<void> {
  await db
    .insert(metadataTable)
    .values({ key: SUBSCRIPTION_COSTS_KEY, value: JSON.stringify(costs) })
    .onConflictDoUpdate({
      target: metadataTable.key,
      set: { value: JSON.stringify(costs) },
    });
}

// ---------------------------------------------------------------------------
// Budget config
// ---------------------------------------------------------------------------

export type BudgetConfig = {
  monthlyBudgetUsd: number | null;
};

const BUDGET_CONFIG_KEY = "metrics_cost:budget_config";

export async function readBudgetConfig(): Promise<BudgetConfig> {
  const rows = await db
    .select({ value: metadataTable.value })
    .from(metadataTable)
    .where(eq(metadataTable.key, BUDGET_CONFIG_KEY))
    .limit(1);
  if (!rows[0]) return { monthlyBudgetUsd: null };
  return JSON.parse(rows[0].value) as BudgetConfig;
}

export async function writeBudgetConfig(config: BudgetConfig): Promise<void> {
  await db
    .insert(metadataTable)
    .values({ key: BUDGET_CONFIG_KEY, value: JSON.stringify(config) })
    .onConflictDoUpdate({
      target: metadataTable.key,
      set: { value: JSON.stringify(config) },
    });
}

// ---------------------------------------------------------------------------
// Legacy cost entries
// ---------------------------------------------------------------------------

export type LegacyCostEntry = {
  id: string;
  provider: string;
  description: string;
  costUsd: string;           // numeric returns string from pg driver — callers MUST parseFloat()
  frequency: string;         // "once" | "monthly" | "yearly" — default "once" for backward compat
  costType: string;          // "legacy" | "subscription" — default "legacy" for backward compat
  startDate: string | null;  // "YYYY-MM-DD" or null
  endDate: string | null;    // "YYYY-MM-DD" or null
  createdAt: Date;
};

export async function readLegacyCosts(): Promise<LegacyCostEntry[]> {
  const rows = await db.execute(sql`
    SELECT id, provider, description, cost_usd, frequency, cost_type, start_date, end_date, created_at
    FROM ${legacyCosts}
    ORDER BY created_at DESC
  `);
  return rows.rows.map((r) => ({
    id:          r.id as string,
    provider:    r.provider as string,
    description: r.description as string,
    costUsd:     r.cost_usd as string,
    frequency:   (r.frequency as string) ?? "once",
    costType:    (r.cost_type as string) ?? "legacy",
    startDate:   r.start_date as string | null,
    endDate:     r.end_date as string | null,
    createdAt:   r.created_at as Date,
  }));
}

export async function insertLegacyCostEntry(entry: {
  provider: string;
  description: string;
  costUsd: number;
  frequency: string;
  costType: string;
  startDate: string | null;
  endDate: string | null;
}): Promise<void> {
  await db.insert(legacyCosts).values({
    id: randomUUID(),
    provider: entry.provider,
    description: entry.description,
    costUsd: entry.costUsd.toFixed(8),
    frequency: entry.frequency,
    costType: entry.costType,
    startDate: entry.startDate ?? null,
    endDate: entry.endDate ?? null,
  });
}

export async function updateLegacyCostEntry(entry: {
  id: string;
  provider: string;
  description: string;
  costUsd: number;
  frequency: string;
  costType: string;
  startDate: string | null;
  endDate: string | null;
}): Promise<void> {
  await db
    .update(legacyCosts)
    .set({
      provider: entry.provider,
      description: entry.description,
      costUsd: entry.costUsd.toFixed(8),
      frequency: entry.frequency,
      costType: entry.costType,
      startDate: entry.startDate ?? null,
      endDate: entry.endDate ?? null,
    })
    .where(eq(legacyCosts.id, entry.id));
}

export async function deleteLegacyCostEntry(id: string): Promise<void> {
  await db.delete(legacyCosts).where(eq(legacyCosts.id, id));
}

// ---------------------------------------------------------------------------
// Model pricing
// ---------------------------------------------------------------------------

export type ModelPricingRow = {
  id: string;
  provider: string;
  modelName: string;
  inputCostPerMillion: string;   // numeric returns string from pg driver
  outputCostPerMillion: string;
  cacheReadPerMillion: string | null;
  source: string;                // 'litellm' | 'manual'
  updatedAt: Date;
};

export async function readModelPricing(): Promise<ModelPricingRow[]> {
  const rows = await db.execute(sql`
    SELECT id, provider, model_name, input_cost_per_million, output_cost_per_million,
           cache_read_per_million, source, updated_at
    FROM ${modelPricing}
    ORDER BY provider, model_name
  `);
  return rows.rows.map((r) => ({
    id:                   r.id as string,
    provider:             r.provider as string,
    modelName:            r.model_name as string,
    inputCostPerMillion:  r.input_cost_per_million as string,
    outputCostPerMillion: r.output_cost_per_million as string,
    cacheReadPerMillion:  r.cache_read_per_million as string | null,
    source:               r.source as string,
    updatedAt:            r.updated_at as Date,
  }));
}

export async function readModelPricingByModel(modelName: string): Promise<ModelPricingRow | null> {
  const rows = await db
    .select()
    .from(modelPricing)
    .where(eq(modelPricing.modelName, modelName))
    .limit(1);
  if (!rows[0]) return null;
  return {
    id:                   rows[0].id,
    provider:             rows[0].provider,
    modelName:            rows[0].modelName,
    inputCostPerMillion:  rows[0].inputCostPerMillion as string,
    outputCostPerMillion: rows[0].outputCostPerMillion as string,
    cacheReadPerMillion:  rows[0].cacheReadPerMillion as (string | null),
    source:               rows[0].source,
    updatedAt:            rows[0].updatedAt,
  };
}

export async function upsertModelPricingRows(rows: Array<{
  id: string;
  provider: string;
  modelName: string;
  inputCostPerMillion: string;
  outputCostPerMillion: string;
  cacheReadPerMillion: string | null;
  source: string;
}>): Promise<{ inserted: number; updated: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0 };

  // Deduplicate by (provider, modelName) — last occurrence wins (LiteLLM can have dupes)
  const deduped = Array.from(
    new Map(rows.map((r) => [`${r.provider}::${r.modelName}`, r])).values(),
  );

  // Pass 1: SELECT existing (provider, modelName) pairs to classify inserts vs updates
  const existingRows = await db.execute(sql`
    SELECT provider, model_name FROM ${modelPricing}
  `);
  const existing = new Set(
    existingRows.rows.map((r) => `${r.provider}::${r.model_name}`),
  );

  let inserted = 0;
  let updated = 0;

  // Pass 2: Upsert in batches — same onConflictDoUpdate with setWhere guard
  const BATCH_SIZE = 100;
  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    const batch = deduped.slice(i, i + BATCH_SIZE);

    // Count before upsert (setWhere may cause some updates to be skipped)
    for (const row of batch) {
      const key = `${row.provider}::${row.modelName}`;
      if (existing.has(key)) {
        updated++;
      } else {
        inserted++;
      }
    }

    await db
      .insert(modelPricing)
      .values(batch)
      .onConflictDoUpdate({
        target: [modelPricing.provider, modelPricing.modelName],
        set: {
          inputCostPerMillion:  sql`excluded.input_cost_per_million`,
          outputCostPerMillion: sql`excluded.output_cost_per_million`,
          cacheReadPerMillion:  sql`excluded.cache_read_per_million`,
          source:               sql`excluded.source`,
          updatedAt:            sql`now()`,
        },
        setWhere: eq(modelPricing.source, "litellm"),
      });
  }

  return { inserted, updated };
}

export async function updateModelPricingRow(
  id: string,
  rates: {
    inputCostPerMillion: string;
    outputCostPerMillion: string;
    cacheReadPerMillion: string | null;
  },
): Promise<void> {
  await db
    .update(modelPricing)
    .set({
      inputCostPerMillion:  rates.inputCostPerMillion,
      outputCostPerMillion: rates.outputCostPerMillion,
      cacheReadPerMillion:  rates.cacheReadPerMillion,
      source:               "manual",
      updatedAt:            sql`now()`,
    })
    .where(eq(modelPricing.id, id));
}

// ---------------------------------------------------------------------------
// Token usage queries
// ---------------------------------------------------------------------------

export type TokenTimeSeriesRow = {
  day: string;
  totalInput: number;
  totalOutput: number;
};

export async function readTokenTimeSeries({ days }: { days: number }): Promise<TokenTimeSeriesRow[]> {
  const safeDays = sanitizeDays(days);
  const rows = await db.execute(sql`
    SELECT
      gs.day::date::text AS day,
      COALESCE(SUM(ue.input_tokens), 0)::int AS "totalInput",
      COALESCE(SUM(ue.output_tokens), 0)::int AS "totalOutput"
    FROM generate_series(
      (now() AT TIME ZONE 'UTC' - interval '1 day' * (${safeDays} - 1))::date,
      (now() AT TIME ZONE 'UTC')::date,
      '1 day'::interval
    ) AS gs(day)
    LEFT JOIN ${usageEvents} ue
      ON date_trunc('day', ue.occurred_at AT TIME ZONE 'UTC')::date = gs.day
      AND ue.source = 'llm'
    GROUP BY gs.day
    ORDER BY gs.day
  `);
  return rows.rows as TokenTimeSeriesRow[];
}

export type TokenByProviderRow = {
  provider: string;
  totalInput: number;
  totalOutput: number;
  callCount: number;
};

export async function readTokenByProvider({ days }: { days: number }): Promise<TokenByProviderRow[]> {
  const safeDays = sanitizeDays(days);
  const rows = await db.execute(sql`
    SELECT
      provider,
      SUM(input_tokens)::int AS "totalInput",
      SUM(output_tokens)::int AS "totalOutput",
      COUNT(*)::int AS "callCount"
    FROM ${usageEvents}
    WHERE occurred_at >= now() - interval '1 day' * ${safeDays}
      AND source = 'llm'
    GROUP BY provider
    ORDER BY SUM(input_tokens + output_tokens) DESC
  `);
  return rows.rows as TokenByProviderRow[];
}

// ---------------------------------------------------------------------------
// Trace queries for the admin Traces screen.
// readRecentTraces: flat list of the most recent 200 spans (all runs).
// readTracesByRunId: all spans for a single agent run, ordered chronologically
// so the UI can build a tree from parent_span_id.
// ---------------------------------------------------------------------------

export type TraceSpanRow = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  service: string;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  status: string;         // "unset" | "ok" | "error"
  attributes: Record<string, unknown>;
  events: unknown[];
  agentRunId: string | null;
};

export async function readRecentTraces(
  opts: { limit?: number; from?: Date; to?: Date; service?: string } = {},
): Promise<TraceSpanRow[]> {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  // Server-side filters (#491). Range on startedAt — it is the indexed
  // (traces_started_at_idx DESC) and displayed column; `service` filters the
  // per-span column. Conditions are ANDed; absent filters are omitted.
  const conditions: SQL[] = [];
  if (opts.from) conditions.push(gte(traces.startedAt, opts.from));
  if (opts.to) conditions.push(lte(traces.startedAt, opts.to));
  if (opts.service) conditions.push(eq(traces.service, opts.service));
  const rows = await db
    .select()
    .from(traces)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(traces.startedAt))
    .limit(limit);
  return rows.map(deserializeTraceRow);
}

// Distinct span services, for the /analytics/api service filter dropdown (#491).
export async function readTraceServices(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ service: traces.service })
    .from(traces)
    .orderBy(traces.service);
  return rows.map((r) => r.service).filter(Boolean);
}

export async function readTracesByRunId(runId: string): Promise<TraceSpanRow[]> {
  if (!runId) return [];
  const rows = await db
    .select()
    .from(traces)
    .where(eq(traces.agentRunId, runId))
    .orderBy(traces.startedAt)
    .limit(5000);
  return rows.map(deserializeTraceRow);
}

function deserializeTraceRow(
  row: typeof traces.$inferSelect,
): TraceSpanRow {
  return {
    traceId:      row.traceId,
    spanId:       row.spanId,
    parentSpanId: row.parentSpanId ?? null,
    name:         row.name,
    service:      row.service,
    startedAt:    row.startedAt,
    endedAt:      row.endedAt ?? null,
    durationMs:   row.durationMs ?? null,
    status:       row.status,
    attributes:   (row.attributes ?? {}) as Record<string, unknown>,
    events:       (row.events ?? []) as unknown[],
    agentRunId:   row.agentRunId ?? null,
  };
}
