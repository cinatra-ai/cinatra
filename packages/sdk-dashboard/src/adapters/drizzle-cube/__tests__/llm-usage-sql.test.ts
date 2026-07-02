import { describe, expect, it } from "vitest";
import { integer, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { createDrizzleSemanticLayer } from "drizzle-cube/server";

import {
  createLlmUsageCube,
  LLM_USAGE_CUBE_DESCRIPTOR,
} from "../cubes/llm-usage";

/**
 * The llm_usage cube exposes platform-wide LLM cost/token usage. Because
 * `usage_events` has no per-org owner column, the cube gates ALL row
 * visibility on `SecurityContext.isPlatformAdmin`:
 *   - admin (true)  → `where true`  → rows
 *   - non-admin     → `where false` → zero rows (fail-closed)
 *
 * The `total_cost_usd` measure is `type: "sum"`, which drizzle-cube wraps in
 * SUM() ITSELF. We therefore pass the BASE (non-aggregated) coalesce
 * expression and assert the emitted SQL has SUM(coalesce(...)) with NO
 * nested aggregate (SUM(SUM(...)) or SUM(coalesce(SUM(...)))).
 *
 * `generateSQL()` renders the SQL string without executing it — no live DB.
 */
const fakeUsageEvents = pgTable("usage_events", {
  id: text("id").primaryKey(),
  costUsd: numeric("cost_usd", { precision: 12, scale: 8 }),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
  reasoningOutputTokens: integer("reasoning_output_tokens").notNull().default(0),
  model: text("model"),
  provider: text("provider").notNull(),
  agentLabel: text("agent_label"),
  skillLabel: text("skill_label"),
  operation: text("operation"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
});

function buildLayer() {
  const layer = createDrizzleSemanticLayer({
    drizzle: drizzle({} as never) as never,
    schema: { usageEventsForCube: fakeUsageEvents },
  });
  const cube = createLlmUsageCube({
    tableRef: fakeUsageEvents,
    columns: {
      id: fakeUsageEvents.id,
      costUsd: fakeUsageEvents.costUsd,
      inputTokens: fakeUsageEvents.inputTokens,
      outputTokens: fakeUsageEvents.outputTokens,
      cachedInputTokens: fakeUsageEvents.cachedInputTokens,
      reasoningOutputTokens: fakeUsageEvents.reasoningOutputTokens,
      model: fakeUsageEvents.model,
      provider: fakeUsageEvents.provider,
      agentLabel: fakeUsageEvents.agentLabel,
      skillLabel: fakeUsageEvents.skillLabel,
      operation: fakeUsageEvents.operation,
      occurredAt: fakeUsageEvents.occurredAt,
    },
  });
  layer.registerCube(cube.dcCube);
  return layer;
}

describe("llm_usage cube — descriptor parity", () => {
  it("defineCinatraCube accepts every descriptor dimension + measure", () => {
    // createLlmUsageCube goes through defineCinatraCube, which THROWS at
    // registration if any descriptor member lacks a matching SQL entry.
    // Reaching here means dimension/measure parity holds.
    expect(() => buildLayer()).not.toThrow();
    expect(LLM_USAGE_CUBE_DESCRIPTOR.id).toBe("llm_usage");
    expect(LLM_USAGE_CUBE_DESCRIPTOR.measures.map((m) => m.id)).toEqual([
      "total_cost_usd",
      "input_tokens",
      "output_tokens",
      "cached_input_tokens",
      "reasoning_output_tokens",
      "event_count",
    ]);
    expect(LLM_USAGE_CUBE_DESCRIPTOR.dimensions.map((d) => d.id)).toEqual([
      "model",
      "provider",
      "agent_label",
      "skill_label",
      "operation",
      "occurred_at",
    ]);
  });
});

describe("llm_usage cube — fail-closed visibility predicate", () => {
  it("emits a `false` predicate for a non-admin caller (zero rows)", async () => {
    const layer = buildLayer();
    const result = await layer.generateSQL(
      "llm_usage",
      { measures: ["llm_usage.total_cost_usd"] },
      { userId: "u1", organizationId: "org_acme" },
    );
    // Non-admin: the cube's WHERE is the constant `false`. drizzle renders it
    // literally (no params). Assert the SQL carries `false` and NOT `true`.
    expect(result.sql.toLowerCase()).toContain("false");
    expect(result.sql.toLowerCase()).not.toContain("where true");
  });

  it("emits a `true` predicate for a platform-admin caller", async () => {
    const layer = buildLayer();
    const result = await layer.generateSQL(
      "llm_usage",
      { measures: ["llm_usage.total_cost_usd"] },
      { userId: "u1", organizationId: "org_acme", isPlatformAdmin: true },
    );
    expect(result.sql.toLowerCase()).toContain("true");
  });

  it("fails closed when isPlatformAdmin is anything other than `true`", async () => {
    const layer = buildLayer();
    for (const bad of [undefined, false, "true", 1, null]) {
      const result = await layer.generateSQL(
        "llm_usage",
        { measures: ["llm_usage.event_count"] },
        { userId: "u1", organizationId: "org_acme", isPlatformAdmin: bad },
      );
      expect(result.sql.toLowerCase()).toContain("false");
    }
  });
});

describe("llm_usage cube — SUM measure SQL (no nested aggregate)", () => {
  it("emits SUM(coalesce(cost_usd, 0)::double precision) with NO nested aggregate", async () => {
    const layer = buildLayer();
    const result = await layer.generateSQL(
      "llm_usage",
      { measures: ["llm_usage.total_cost_usd"] },
      { userId: "u1", organizationId: "org_acme", isPlatformAdmin: true },
    );
    const sql = result.sql.toLowerCase().replace(/\s+/g, " ");
    // The base expression coalesces the nullable numeric and casts to double.
    expect(sql).toContain("coalesce");
    expect(sql).toContain("cost_usd");
    expect(sql).toContain("double precision");
    // drizzle-cube wraps the type:"sum" measure in SUM(...) itself.
    expect(sql).toMatch(/sum\s*\(/);
    // CRITICAL: no nested aggregate. A wrong `coalesce(sum(cost_usd),0)` base
    // would render `SUM(coalesce(SUM(...)))` — a Postgres error. Assert there
    // is no `sum(` appearing inside another `sum(` and no `sum(coalesce(sum`.
    expect(sql).not.toContain("sum(coalesce(sum");
    expect(sql).not.toMatch(/sum\s*\([^)]*sum\s*\(/);
  });

  it("emits SUM() over the raw token columns (notNull ints, no coalesce needed)", async () => {
    const layer = buildLayer();
    const result = await layer.generateSQL(
      "llm_usage",
      {
        measures: [
          "llm_usage.input_tokens",
          "llm_usage.output_tokens",
          "llm_usage.cached_input_tokens",
          "llm_usage.reasoning_output_tokens",
        ],
      },
      { userId: "u1", organizationId: "org_acme", isPlatformAdmin: true },
    );
    const sql = result.sql.toLowerCase();
    expect(sql).toContain("input_tokens");
    expect(sql).toContain("output_tokens");
    expect(sql).toContain("cached_input_tokens");
    expect(sql).toContain("reasoning_output_tokens");
    expect(sql).toMatch(/sum\s*\(/);
    // No nested aggregate on the token sums either.
    expect(sql).not.toMatch(/sum\s*\([^)]*sum\s*\(/);
  });

  it("event_count emits COUNT(id), grouped by dimensions", async () => {
    const layer = buildLayer();
    const result = await layer.generateSQL(
      "llm_usage",
      {
        measures: ["llm_usage.event_count"],
        dimensions: ["llm_usage.model", "llm_usage.occurred_at"],
      },
      { userId: "u1", organizationId: "org_acme", isPlatformAdmin: true },
    );
    const sql = result.sql.toLowerCase();
    expect(sql).toMatch(/count\s*\(/);
    expect(sql).toContain("model");
    expect(sql).toContain("occurred_at");
  });
});
