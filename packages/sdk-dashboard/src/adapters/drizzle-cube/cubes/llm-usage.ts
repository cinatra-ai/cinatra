/**
 * `llm_usage` cube.
 *
 * Exposes LLM cost/token usage from `cinatra.usage_events` as a dashboard
 * cube so agents (and users) can build cost/usage widgets. Mirrors the
 * no-join `artifacts.ts` template — a single FROM table, no JOINs.
 *
 * AUTHZ (fail-closed): `usage_events` carries NO `org_id` / `user_id`
 * column, so this cube CANNOT per-org filter its rows. Cost/usage data is
 * platform-wide operational data. The cube therefore gates visibility on a
 * single boolean — `SecurityContext.isPlatformAdmin` — at the SQL predicate
 * layer:
 *
 *   where = isPlatformAdmin ? sql`true` : sql`false`
 *
 * This mirrors the artifacts cube's fail-closed shape (`visible === null →
 * sql\`false\``): a non-admin caller sees ZERO rows because the predicate is
 * a constant `false`, never a post-filter in JS. The host decorates the
 * SecurityContext with `isPlatformAdmin` at every transport boundary (HTTP
 * route + MCP shared helper); when the flag is missing/false the cube fails
 * closed.
 *
 * The host supplies the canonical `cinatra.usage_events` table reference at
 * registration time via a narrow Drizzle binding (`usageEventsForCube` in
 * `packages/dashboards/src/cubes/dashboard-cube-bindings.ts`) so the cube
 * layer never imports the metric-cost-api schema directly.
 */
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { BaseQueryDefinition, QueryContext } from "drizzle-cube/server";

import type { CubeDescriptor } from "../../../types/cube";
import type { RegisteredCube } from "../types";
import { defineCinatraCube } from "../define-cube";

/**
 * Minimum column shape the host's `usage_events` Drizzle binding must
 * satisfy. The host passes the full narrow projection; this documents the
 * columns the cube actually references.
 *
 * `costUsd` is the only NULLABLE column read here (`numeric(12,8)` — NULL
 * when the row could not be priced: no rate card for the model, an image
 * call that reports no usage, a knowledge-graph episode whose fan-out the
 * indexer never reports back. NULL by design, so gaps stay detectable).
 * `total_cost_usd` sums it WITHOUT coalescing, and `unknown_cost_count`
 * counts the rows that sum left out — see the measure block below.
 */
export type UsageEventsTable = {
  readonly id: AnyColumn;
  readonly costUsd: AnyColumn;
  readonly inputTokens: AnyColumn;
  readonly outputTokens: AnyColumn;
  readonly cachedInputTokens: AnyColumn;
  readonly reasoningOutputTokens: AnyColumn;
  readonly model: AnyColumn;
  readonly provider: AnyColumn;
  readonly agentLabel: AnyColumn;
  readonly skillLabel: AnyColumn;
  readonly operation: AnyColumn;
  readonly occurredAt: AnyColumn;
};

export type CreateLlmUsageCubeOptions = {
  readonly tableRef: unknown;
  readonly columns: UsageEventsTable;
};

export const LLM_USAGE_CUBE_DESCRIPTOR: CubeDescriptor = {
  id: "llm_usage",
  version: "1.0.0",
  displayName: "LLM Usage",
  description:
    "LLM cost and token usage from usage_events. Platform-wide " +
    "operational data with no per-organization owner column, so " +
    "visibility is gated on SecurityContext.isPlatformAdmin: platform " +
    "admins see all rows, every other caller sees zero (fail-closed at " +
    "the SQL predicate layer). Cost is reported in USD. total_cost_usd is " +
    "the KNOWN-cost subtotal only and is NULLABLE: rows the ledger could " +
    "not price (no rate card, image calls, knowledge-graph episodes) carry " +
    "a NULL cost and are EXCLUDED from the sum, so the measure is null for " +
    "a group with nothing priced — never 0, which would claim the group was " +
    "free — and 0 only for a group that really cost nothing. A group MIXING " +
    "priced and unpriced rows still reports a number, and that number is " +
    "PARTIAL: unknown_cost_count is the only way to detect it, because a " +
    "partial subtotal is indistinguishable from a complete one on its own. " +
    "Read the two measures together.",
  dimensions: [
    { id: "model", displayName: "Model", type: "string" },
    { id: "provider", displayName: "Provider", type: "string" },
    { id: "agent_label", displayName: "Agent", type: "string" },
    { id: "skill_label", displayName: "Skill", type: "string" },
    { id: "operation", displayName: "Operation", type: "string" },
    { id: "occurred_at", displayName: "Occurred at", type: "date" },
  ],
  measures: [
    {
      id: "total_cost_usd",
      displayName: "Total cost (USD)",
      type: "sum",
      format: "currency",
    },
    { id: "input_tokens", displayName: "Input tokens", type: "sum" },
    { id: "output_tokens", displayName: "Output tokens", type: "sum" },
    {
      id: "cached_input_tokens",
      displayName: "Cached input tokens",
      type: "sum",
    },
    {
      id: "reasoning_output_tokens",
      displayName: "Reasoning output tokens",
      type: "sum",
    },
    { id: "event_count", displayName: "Event count", type: "count" },
    {
      id: "unknown_cost_count",
      displayName: "Rows with unknown cost",
      type: "count",
    },
  ],
};

/**
 * Reads `SecurityContext.isPlatformAdmin` back from drizzle-cube's opaque
 * `[k]: unknown` SecurityContext. Treated as the SOLE gate for row
 * visibility: any non-`true` value (missing, false, malformed) fails
 * closed to zero rows.
 */
function readIsPlatformAdmin(ctx: QueryContext): boolean {
  return ctx.securityContext?.isPlatformAdmin === true;
}

export function createLlmUsageCube(opts: CreateLlmUsageCubeOptions): RegisteredCube {
  const { tableRef, columns } = opts;
  return defineCinatraCube(LLM_USAGE_CUBE_DESCRIPTOR, {
    buildSql: (ctx): BaseQueryDefinition => {
      // Fail-closed visibility predicate. Mirrors the artifacts cube's
      // `visible === null → sql\`false\`` shape: a non-admin caller's
      // query carries a constant `false` predicate, so the cube returns
      // zero rows at the SQL layer — never a JS post-filter.
      const visibilityPredicate: SQL<unknown> = readIsPlatformAdmin(ctx)
        ? sql`true`
        : sql`false`;
      return {
        from: tableRef as unknown as BaseQueryDefinition["from"],
        where: visibilityPredicate,
      };
    },
    dimensionSql: {
      model: columns.model,
      provider: columns.provider,
      agent_label: columns.agentLabel,
      skill_label: columns.skillLabel,
      operation: columns.operation,
      occurred_at: columns.occurredAt,
    },
    measureSql: {
      // `total_cost_usd` is a `type: "sum"` measure. drizzle-cube wraps
      // sum measures in SUM() itself (buildMeasureExpression: `case "sum":
      // return w(a)`), so we pass the BASE (non-aggregated) expression.
      // drizzle-cube emits `SUM(cost_usd::double precision)`. The
      // ::double precision cast returns a JS number rather than a numeric
      // string.
      //
      // NO COALESCE (cinatra#2669). `coalesce(cost_usd, 0)` turned every row
      // the ledger could not price into a confident zero BEFORE aggregation,
      // so a group of nothing but image calls summed to `0` — a measure
      // reporting "this cost nothing" about spend nobody has measured, with
      // no way for a widget to tell the two apart. Without it `SUM` behaves
      // as SQL intends: unpriced rows are SKIPPED, the measure is NULL for a
      // group with nothing priced, and `unknown_cost_count` below says how
      // many rows any given subtotal excludes.
      total_cost_usd: sql`${columns.costUsd}::double precision`,
      // Token sums are NOT NULL int columns — pass the raw column; the
      // type:"sum" wrap emits SUM(input_tokens) etc.
      input_tokens: columns.inputTokens,
      output_tokens: columns.outputTokens,
      cached_input_tokens: columns.cachedInputTokens,
      reasoning_output_tokens: columns.reasoningOutputTokens,
      // event_count is type:"count" → COUNT(id).
      event_count: columns.id,
      // How many rows in the group `total_cost_usd` could NOT price
      // (cinatra#2669). Also type:"count", so drizzle-cube emits
      // `COUNT(case when cost_usd is null then id end)` — COUNT over an
      // expression skips NULLs, so the CASE's implicit ELSE NULL is what
      // narrows the count to unpriced rows. It is a plain expression, NOT a
      // pre-aggregated one: a `sum(case … then 1 else 0 end)` base would be
      // wrapped again into a nested aggregate and Postgres would reject it
      // (pinned in llm-usage-sql.test.ts).
      unknown_cost_count: sql`case when ${columns.costUsd} is null then ${columns.id} end`,
    },
  });
}
