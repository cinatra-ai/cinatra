import { pgSchema, text, integer, numeric, timestamp, date, index, uniqueIndex, jsonb, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const cinatraSchema = pgSchema(process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra");


export const usageEvents = cinatraSchema.table("usage_events", {
  id:                    text("id").primaryKey(),
  occurredAt:            timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt:             timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  source:                text("source").notNull(),
  provider:              text("provider").notNull(),
  requestedProvider:     text("requested_provider"),
  effectiveProvider:     text("effective_provider"),
  model:                 text("model"),
  operation:             text("operation"),
  agentLabel:            text("agent_label"),
  skillLabel:            text("skill_label"),
  inputTokens:           integer("input_tokens").notNull().default(0),
  outputTokens:          integer("output_tokens").notNull().default(0),
  cachedInputTokens:     integer("cached_input_tokens").notNull().default(0),
  reasoningOutputTokens: integer("reasoning_output_tokens").notNull().default(0),
  creditsConsumed:       integer("credits_consumed").notNull().default(0),
  costUsd:               numeric("cost_usd", { precision: 12, scale: 8 }),
  idempotencyKey:        text("idempotency_key").notNull(),
}, (t) => ({
  idempotencyKeyIdx:       uniqueIndex("usage_events_idempotency_key_idx").on(t.idempotencyKey),
  occurredAtIdx:           index("usage_events_occurred_at_idx").on(t.occurredAt),
  providerOccurredAtIdx:   index("usage_events_provider_occurred_at_idx").on(t.provider, t.occurredAt),
  agentLabelOccurredAtIdx: index("usage_events_agent_label_occurred_at_idx").on(t.agentLabel, t.occurredAt),
  skillLabelOccurredAtIdx: index("usage_events_skill_label_occurred_at_idx").on(t.skillLabel, t.occurredAt),
}));

export const legacyCosts = cinatraSchema.table("legacy_costs", {
  id:          text("id").primaryKey(),
  provider:    text("provider").notNull(),
  description: text("description").notNull(),
  costUsd:     numeric("cost_usd", { precision: 12, scale: 8 }).notNull(),
  frequency:   text("frequency").notNull().default("once"),
  costType:    text("cost_type").notNull().default("legacy"),
  startDate:   date("start_date"),
  endDate:     date("end_date"),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  createdAtIdx: index("legacy_costs_created_at_idx").on(t.createdAt),
}));

export const modelPricing = cinatraSchema.table("model_pricing", {
  id:                   text("id").primaryKey(),
  provider:             text("provider").notNull(),
  modelName:            text("model_name").notNull(),
  inputCostPerMillion:  numeric("input_cost_per_million", { precision: 20, scale: 8 }).notNull(),
  outputCostPerMillion: numeric("output_cost_per_million", { precision: 20, scale: 8 }).notNull(),
  cacheReadPerMillion:  numeric("cache_read_per_million", { precision: 20, scale: 8 }),
  source:               text("source").notNull().default("litellm"),
  updatedAt:            timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  providerModelUniq: uniqueIndex("model_pricing_provider_model_idx").on(t.provider, t.modelName),
}));

// ---------------------------------------------------------------------------
// OTel span storage. Written to by packages/metric-cost-api/src/span-exporter.ts.
// Read by packages/metric-cost-api/src/store.ts trace queries.
// Composite PK (trace_id, span_id). Indexes: by trace (tree reconstruction),
// by agent_run (admin "View trace" link resolution), by started_at (recent list).
// Migration: see src/lib/drizzle-store.ts traces table entry.
// ---------------------------------------------------------------------------
export const traces = cinatraSchema.table(
  "traces",
  {
    traceId:      text("trace_id").notNull(),
    spanId:       text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
    name:         text("name").notNull(),
    service:      text("service").notNull(),
    startedAt:    timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt:      timestamp("ended_at", { withTimezone: true }),
    durationMs:   integer("duration_ms"),
    status:       text("status").notNull().default("unset"),       // "unset" | "ok" | "error"
    attributes:   jsonb("attributes").notNull().default({}),
    events:       jsonb("events").notNull().default([]),
    agentRunId:   text("agent_run_id"),
    createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk:             primaryKey({ columns: [t.traceId, t.spanId] }),
    traceIdIdx:     index("traces_trace_id_idx").on(t.traceId),
    agentRunIdIdx:  index("traces_agent_run_id_idx")
                      .on(t.agentRunId)
                      .where(sql`${t.agentRunId} IS NOT NULL`),
    startedAtIdx:   index("traces_started_at_idx").on(sql`${t.startedAt} DESC`),
  }),
);
