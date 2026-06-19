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
 * when the model's pricing is absent from both `model_pricing` and the
 * static `LLM_PRICING` map, by design so gaps are detectable). The
 * `total_cost_usd` measure coalesces it to 0 so the SUM stays non-null.
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
    "the SQL predicate layer). Cost is reported in USD; rows with no " +
    "known pricing contribute 0 to total_cost_usd.",
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
      // drizzle-cube emits `SUM(coalesce(cost_usd, 0)::double precision)`.
      // The coalesce handles the NULLABLE cost_usd column (NULL pricing
      // gaps contribute 0); the ::double precision cast returns a JS number
      // rather than a numeric string.
      total_cost_usd: sql`coalesce(${columns.costUsd}, 0)::double precision`,
      // Token sums are NOT NULL int columns — pass the raw column; the
      // type:"sum" wrap emits SUM(input_tokens) etc.
      input_tokens: columns.inputTokens,
      output_tokens: columns.outputTokens,
      cached_input_tokens: columns.cachedInputTokens,
      reasoning_output_tokens: columns.reasoningOutputTokens,
      // event_count is type:"count" → COUNT(id).
      event_count: columns.id,
    },
  });
}
