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
 * SUM() ITSELF. We therefore pass the BASE (non-aggregated) expression and
 * assert the emitted SQL has no nested aggregate (SUM(SUM(...)) or
 * COUNT(SUM(...))). That constraint governs every measure this cube adds.
 *
 * cinatra#2669 — the cost measure no longer coalesces. `coalesce(cost_usd, 0)`
 * turned each unpriced row into a confident zero BEFORE aggregation, so a group
 * of nothing but image calls or knowledge-graph episodes summed to `0` and no
 * consumer could tell "this cost nothing" from "nobody knows what this cost".
 * The measure now sums what is priced (NULL when nothing is) and the new
 * `unknown_cost_count` measure states how many rows any subtotal leaves out.
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
      "unknown_cost_count",
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
  it("emits SUM(cost_usd::double precision) with NO nested aggregate and NO coalesce", async () => {
    const layer = buildLayer();
    const result = await layer.generateSQL(
      "llm_usage",
      { measures: ["llm_usage.total_cost_usd"] },
      { userId: "u1", organizationId: "org_acme", isPlatformAdmin: true },
    );
    const sql = result.sql.toLowerCase().replace(/\s+/g, " ");
    // The base expression casts the nullable numeric to double and nothing else.
    expect(sql).toContain("cost_usd");
    expect(sql).toContain("double precision");
    // cinatra#2669: the zero-fill is GONE. Its presence is the defect — it
    // priced every unpriced row at $0 before the SUM ever ran.
    expect(sql).not.toContain("coalesce");
    // drizzle-cube wraps the type:"sum" measure in SUM(...) itself.
    expect(sql).toMatch(/sum\s*\(/);
    // CRITICAL: no nested aggregate. A wrong `sum(cost_usd)` base would render
    // `SUM(SUM(...))` — a Postgres error.
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

  it("unknown_cost_count counts the rows total_cost_usd could not price", async () => {
    const layer = buildLayer();
    const result = await layer.generateSQL(
      "llm_usage",
      {
        measures: ["llm_usage.total_cost_usd", "llm_usage.unknown_cost_count"],
        dimensions: ["llm_usage.provider"],
      },
      { userId: "u1", organizationId: "org_acme", isPlatformAdmin: true },
    );
    const sql = result.sql.toLowerCase().replace(/\s+/g, " ");
    // COUNT over an EXPRESSION, not COUNT(*): the CASE's implicit ELSE NULL is
    // what narrows the count to unpriced rows, so `COUNT(*)` would report every
    // row in the group instead.
    expect(sql).toMatch(/count\s*\(\s*case when/);
    expect(sql).toMatch(/cost_usd"?\s+is null/);
    expect(sql).not.toMatch(/count\s*\(\s*\*\s*\)/);
    // The same no-nested-aggregate rule the cost measure lives under: a
    // `sum(case … then 1 else 0 end)` base would be wrapped again by
    // drizzle-cube and Postgres would reject it.
    expect(sql).not.toMatch(/count\s*\([^)]*sum\s*\(/);
    expect(sql).not.toMatch(/count\s*\([^)]*count\s*\(/);
    // Both measures survive in ONE query — the pair is the contract, and a
    // consumer that cannot ask for them together learns nothing from either.
    expect(sql).toMatch(/sum\s*\(/);
    expect(sql).toContain("provider");
  });

  it("the descriptor states what the two cost measures mean together", async () => {
    // A measure that silently changed from "always a number" to "null when
    // nothing is priced" would break every consumer that never read this text.
    const description = LLM_USAGE_CUBE_DESCRIPTOR.description ?? "";
    expect(description).toContain("unknown_cost_count");
    expect(description).toMatch(/null|excluded/i);
    const unknownMeasure = LLM_USAGE_CUBE_DESCRIPTOR.measures.find(
      (m) => m.id === "unknown_cost_count",
    );
    expect(unknownMeasure?.type).toBe("count");
    // Not currency — it counts rows, and a "$4.00" here would be nonsense.
    expect(unknownMeasure?.format).toBeUndefined();
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
