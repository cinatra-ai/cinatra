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
  /** Unpriced rows over ALL time — the summary cards' own footnote. */
  nullCostCount: number;
  /**
   * Unpriced rows inside the CURRENT CALENDAR MONTH (cinatra#2669).
   *
   * `nullCostCount` is all-time, so it cannot qualify a monthly figure: a ledger
   * carrying a hundred unpriced rows from March says nothing about whether
   * THIS month's total is complete. The budget alert compares
   * {@link CostSummaryRow.totalThisMonth} against the configured budget, so the
   * count that qualifies it has to be measured over the SAME window — which is
   * why this counter exists next to the amount rather than being derived from
   * the all-time one.
   *
   * Both are produced by one shared window expression in {@link readCostSummary},
   * so the amount and its qualifier cannot drift apart.
   */
  nullCostCountThisMonth: number;
};

export type CostByProviderRow = {
  provider: string;
  /**
   * Which producer the rows came from — "llm", "apollo", "graphiti"
   * (cinatra#2582). Carried so the breakdown can say what a row COUNTS: a
   * graphiti row counts episodes handed to the knowledge-graph indexer, each of
   * which fans out to an unknown number of provider requests, and its cost is
   * unknown rather than zero.
   */
  source: string;
  model: string | null;
  totalCost: number | null;
  totalInput: number;
  totalOutput: number;
  callCount: number;
  /** @see {@link UnknownCostCount} */
  unknownCostCount: UnknownCostCount;
};

/**
 * How many rows in this group carry NO price (cinatra#2641).
 *
 * `SUM(cost_usd)` IGNORES NULLs, so a group holding one priced row and one
 * unpriced row answers with a number — a PARTIAL total that renders exactly like
 * a complete one. NULL only survives aggregation when EVERY row in the group is
 * unpriced, which is why "the dashboard already shows unknown costs" was true
 * only for groups that happen to be pure.
 *
 * cinatra#2641 makes mixed groups ordinary: an image call is unpriced by design
 * and can share a provider, an agent or a skill with priced work. So each
 * breakdown row now carries the count of its unpriced rows and states it next to
 * the subtotal ("$1.2345 + 2 unknown") rather than dropping it. Counting is
 * preferred over collapsing the whole group to "unknown": a real subtotal plus
 * an explicit remainder tells an operator more than a blank.
 *
 * cinatra#2669 carries the same counter onto every remaining aggregation: the
 * day/provider time series, the chart-shaped time series, and the monthly budget
 * window. Wherever a `SUM(cost_usd)` is reported, the number of rows that sum
 * silently skipped is reported beside it.
 */
type UnknownCostCount = number;

export type CostByAgentRow = {
  agentLabel: string | null;
  totalCost: number | null;
  callCount: number;
  /** @see {@link UnknownCostCount} */
  unknownCostCount: UnknownCostCount;
};

export type CostBySkillRow = {
  skillLabel: string | null;
  totalCost: number | null;
  callCount: number;
  /** @see {@link UnknownCostCount} */
  unknownCostCount: UnknownCostCount;
};

/**
 * One (day, provider) bucket of the Daily Cost chart (cinatra#2669).
 *
 * FOUR bucket states have to stay apart, and `COALESCE(SUM(cost_usd), 0)`
 * collapsed three of them onto the same `0`:
 *
 *   | state          | `cost`   | `unknownCostCount` |
 *   |----------------|----------|--------------------|
 *   | empty (spine)  | `null`   | `0`                |
 *   | measured zero  | `0`      | `0`                |
 *   | unpriced only  | `null`   | `> 0`              |
 *   | mixed          | a number | `> 0`              |
 *
 * `cost` is the KNOWN subtotal and nothing else: `null` means "no priced row in
 * this bucket", never "zero dollars". A day whose only activity was an image
 * call or a knowledge-graph episode is a day whose cost is UNKNOWN, and drawing
 * it at the same height as a day that genuinely cost nothing is the quiet
 * overstatement this counter exists to remove.
 */
export type CostTimeSeriesRow = {
  day: string;
  provider: string;
  /** The bucket's KNOWN-cost subtotal; `null` when nothing in it is priced. */
  cost: number | null;
  /** @see {@link UnknownCostCount} */
  unknownCostCount: UnknownCostCount;
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

/**
 * The CURRENT calendar month, stated ONCE (cinatra#2669).
 *
 * `readCostSummary` reports a monthly amount and, next to it, how many rows that
 * amount could not price. Those two numbers only mean anything together if they
 * are measured over the identical window, so the window is a single expression
 * embedded twice rather than two hand-copied predicates that can drift.
 *
 * Two things the previous month predicate got wrong, both of which the budget
 * alert's new "at least" claim depends on:
 *
 *   - BOUNDARY TYPE. `date_trunc('month', now() AT TIME ZONE 'UTC')` is a
 *     `timestamp WITHOUT time zone`. Comparing it against the `timestamptz`
 *     `occurred_at` makes Postgres read it in the SESSION's timezone, so on any
 *     non-UTC session the month started at the wrong instant and rows near the
 *     boundary fell on the wrong side. Casting back with `AT TIME ZONE 'UTC'`
 *     makes the boundary the UTC instant the name already claimed.
 *   - NO UPPER BOUND. A row dated in a LATER month (clock skew on a producer)
 *     counted toward "this month". The bound closes the calendar month, and
 *     deliberately NOT at `now()`: the figure is labelled "This Month" on the
 *     card that displays it, and capping it at the current instant would
 *     redefine that number — and only that one, since its All Time / This Week
 *     siblings stay uncapped. So a row dated later TODAY still counts; a row
 *     dated next month no longer does.
 */
const CURRENT_MONTH_WINDOW = sql`
  occurred_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
  AND occurred_at < ((date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC')`;

// ---------------------------------------------------------------------------
// Dashboard query functions
// ---------------------------------------------------------------------------

// The week's lower boundary casts back to timestamptz, same as
// CURRENT_MONTH_WINDOW above (cinatra#2691): a bare `date_trunc('week', ...)`
// is a timestamp WITHOUT time zone, so comparing it against occurred_at
// (timestamptz) reads it in the SESSION's timezone rather than UTC. Unlike the
// month, the week stays uncapped (cinatra#2673) — no upper bound is added.
export async function readCostSummary(): Promise<CostSummaryRow> {
  const rows = await db.execute(sql`
    SELECT
      SUM(cost_usd)::float AS total_all_time,
      SUM(cost_usd) FILTER (WHERE ${CURRENT_MONTH_WINDOW} )::float AS total_this_month,
      SUM(cost_usd) FILTER (WHERE occurred_at >= (date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))::float AS total_this_week,
      COUNT(*)::int AS event_count,
      COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS null_cost_count,
      COUNT(*) FILTER (WHERE cost_usd IS NULL AND ${CURRENT_MONTH_WINDOW} )::int AS null_cost_count_this_month
    FROM ${usageEvents}
  `);
  const row = rows.rows[0] as Record<string, unknown>;
  return {
    totalAllTime: row.total_all_time as number | null,
    totalThisMonth: row.total_this_month as number | null,
    totalThisWeek: row.total_this_week as number | null,
    eventCount: Number(row.event_count) || 0,
    nullCostCount: Number(row.null_cost_count) || 0,
    nullCostCountThisMonth: Number(row.null_cost_count_this_month) || 0,
  };
}

export async function readCostByProvider({ days }: { days: number }): Promise<CostByProviderRow[]> {
  const safeDays = sanitizeDays(days);
  const rows = await db.execute(sql`
    SELECT
      provider,
      source,
      model,
      SUM(cost_usd)::float AS "totalCost",
      SUM(input_tokens)::int AS "totalInput",
      SUM(output_tokens)::int AS "totalOutput",
      COUNT(*)::int AS "callCount",
      COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS "unknownCostCount"
    FROM ${usageEvents}
    WHERE occurred_at >= now() - interval '1 day' * ${safeDays}
    GROUP BY provider, source, model
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
      COUNT(*)::int AS "callCount",
      COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS "unknownCostCount"
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
      COUNT(*)::int AS "callCount",
      COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS "unknownCostCount"
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
  // appears in the result — a day with no events still gets a row rather than
  // disappearing from the chart's x-axis.
  //
  // The subtotal is DELIBERATELY not coalesced (cinatra#2669). `SUM(cost_usd)`
  // skips NULLs, so coalescing its answer to 0 made an unpriced-only bucket
  // arrive looking exactly like a bucket that genuinely cost nothing. The
  // companion count says how many rows the SUM skipped:
  //
  //   COUNT(ue.id) FILTER (…)  — NOT COUNT(*). On the outer-join's spine-only
  //   rows every `ue.*` column is NULL, so `cost_usd IS NULL` is TRUE and
  //   `COUNT(*)` would report ONE unpriced row for every EMPTY bucket. Counting
  //   `ue.id` (the primary key, NULL only when nothing joined) counts real rows
  //   and nothing else.
  const rows = await db.execute(sql`
    SELECT
      gs.day::date::text AS day,
      p.provider,
      SUM(ue.cost_usd)::float AS cost,
      COUNT(ue.id) FILTER (WHERE ue.cost_usd IS NULL)::int AS "unknownCostCount"
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
    /**
     * KNOWN-cost subtotal per bucket. `null` means the bucket holds rows but
     * none of them is priced — never "zero dollars" (cinatra#2669).
     */
    buckets: Record<string, number | null>;
    /**
     * Rows in each bucket the subtotal could not price, keyed by the SAME
     * bucket name. A bucket appears here whenever it appears in `buckets`, so
     * `buckets[b] === null && unknownCostCounts[b] > 0` reads as "unknown", and
     * `buckets[b] === 0 && unknownCostCounts[b] === 0` reads as "measured zero".
     */
    unknownCostCounts: Record<string, number>;
    /**
     * The day's KNOWN-cost total. `null` ONLY when the day HELD rows and none
     * of them was priced; a day with no events at all keeps reporting `0`,
     * because "nothing happened" has a known cost and `buckets: {}` already
     * says which case it is.
     */
    total: number | null;
    /** Rows across the whole day that the day's total could not price. */
    unknownCostCount: number;
  }>;
};

/**
 * Returns daily cost time series pivoted by the requested groupBy dimension.
 * The date spine is always dense (every day for the last N days appears even
 * if there were no events) so charting libraries always get contiguous x-values.
 *
 * cinatra#2669 — WHAT A BUCKET'S NUMBER MEANS. The subtotal is no longer
 * coalesced to 0: `SUM(cost_usd)` skips unpriced rows, so a bucket holding only
 * image calls or knowledge-graph episodes used to arrive as a confident `0`.
 * Each bucket now reports its known subtotal (possibly `null`) AND the number of
 * rows that subtotal excludes, and so does each day's total.
 *
 * The dense spine is produced by an OUTER join, which fabricates one all-NULL
 * row per EMPTY day. That row used to be pivoted into a real-looking bucket
 * named "unknown" holding `0` — harmless while every bucket was a number,
 * indistinguishable from a genuine `agent = NULL` bucket now that a bucket
 * carries an unpriced-row count. The query therefore reports each group's real
 * `rowCount` and the pivot drops the fabricated rows while STILL emitting the
 * day, so the spine stays dense and an empty day is an empty bucket map.
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
      COUNT(ue.id)::int AS "rowCount",
      SUM(ue.cost_usd)::float AS cost,
      COUNT(ue.id) FILTER (WHERE ue.cost_usd IS NULL)::int AS "unknownCostCount"
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

  // Pivot rows: day -> { bucket -> known subtotal, bucket -> unpriced rows, … }
  //
  // Buckets accumulate in MAPS, not in `{}` object literals. Bucket names are
  // database values — an agent or a model may legitimately be called
  // `constructor`, `toString` or `__proto__`, and on a plain object those read
  // back through `Object.prototype`: `buckets["constructor"] ?? 0` starts from
  // the Object constructor rather than from 0, and `"constructor" in buckets`
  // is true before anything was ever written, which would silently DROP such a
  // bucket. `Object.fromEntries` materialises the plain records the result type
  // promises only once the arithmetic is done.
  type DayEntry = {
    buckets: Map<string, number | null>;
    unknownCostCounts: Map<string, number>;
    knownTotal: number | null;
    unknownCostCount: number;
    /** Whether ANY real event landed on this day (vs. a spine-only day). */
    hasRows: boolean;
  };
  const byDay = new Map<string, DayEntry>();

  for (const r of rows.rows as Array<{
    day: string;
    bucket: string;
    rowCount: number;
    cost: number | null;
    unknownCostCount: number;
  }>) {
    let entry = byDay.get(r.day);
    if (!entry) {
      // Created for EVERY day the spine returned, including the fabricated
      // ones — that is what keeps the date spine dense.
      entry = {
        buckets: new Map(),
        unknownCostCounts: new Map(),
        knownTotal: null,
        unknownCostCount: 0,
        hasRows: false,
      };
      byDay.set(r.day, entry);
    }
    // A spine-only group: the outer join fabricated it, no event is behind it.
    // The DAY stays; the phantom bucket does not.
    if (Number(r.rowCount) === 0) continue;
    entry.hasRows = true;

    const cost = r.cost === null || r.cost === undefined ? null : Number(r.cost);
    const unknown = Number(r.unknownCostCount) || 0;
    if (cost !== null) {
      entry.buckets.set(r.bucket, (entry.buckets.get(r.bucket) ?? 0) + cost);
      entry.knownTotal = (entry.knownTotal ?? 0) + cost;
    } else if (!entry.buckets.has(r.bucket)) {
      // Unpriced-only bucket: present, with no subtotal to state.
      entry.buckets.set(r.bucket, null);
    }
    entry.unknownCostCounts.set(r.bucket, (entry.unknownCostCounts.get(r.bucket) ?? 0) + unknown);
    entry.unknownCostCount += unknown;
  }

  const points = Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entry]) => ({
      date,
      buckets: Object.fromEntries(entry.buckets),
      unknownCostCounts: Object.fromEntries(entry.unknownCostCounts),
      // A day with no events has a KNOWN total of zero — nothing happened.
      // `null` is reserved for the day that held rows nobody could price.
      total: entry.hasRows ? entry.knownTotal : 0,
      unknownCostCount: entry.unknownCostCount,
    }));

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
