/**
 * Narrow Drizzle bindings used ONLY by the dashboards-cube wiring
 * in `platform-singleton.ts`. Two reasons these live here instead of the
 * canonical schema directories:
 *
 *   - **`objectsForCube`** — `packages/objects/src/schema.ts` deliberately
 *     does NOT bind the `cinatra.objects` table. Per its doctrine comment,
 *     a partial Drizzle binding alongside the raw-SQL `objects-store.ts`
 *     would be incomplete (only the cube needs columns) and misleading
 *     for other readers. We scope the cube's projection here and keep the
 *     canonical access path unchanged.
 *
 *   - **`projectsForCube`** — the canonical `src/lib/projects-store.ts`
 *     binding has no `archived_at` column on the Drizzle type (the column
 *     exists in the DB but lives outside the binding because the projects
 *     page reads it via raw SQL). The cube needs an `archivedAt` column
 *     reference for the `WHERE archived_at IS NULL` predicate (the
 *     "Archived projects hidden by default" requirement), so we rebind
 *     the narrow projection here.
 *
 * Both bindings reference the same Postgres tables as the canonical
 * stores; rebinding here only widens the Drizzle TYPE surface, never the
 * underlying table. The runtime schema migrations remain the source of
 * truth.
 */
import "server-only";
import { pgSchema, pgTable, text, timestamp, jsonb, integer, numeric } from "drizzle-orm/pg-core";

const cinatraSchema = pgSchema(
  process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra",
);

/**
 * Narrow projection of `cinatra.objects`, sized for the artifacts cube.
 * Carries id, type, org_id, data (jsonb), created_at, deleted_at — the
 * minimum the cube needs to filter, project the name/context dimensions
 * out of the jsonb, and hide tombstoned rows.
 */
export const objectsForCube = cinatraSchema.table("objects", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  orgId: text("org_id"),
  data: jsonb("data"),
  createdAt: timestamp("created_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/**
 * Narrow projection of `cinatra.projects`, sized for the projects cube.
 * Extends the canonical binding in `src/lib/projects-store.ts` with
 * `archived_at` so the cube can predicate on it.
 */
export const projectsForCube = cinatraSchema.table("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  organizationId: text("organization_id"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

/**
 * Better Auth `public."organization"` projection (the canonical
 * `betterAuthOrganizations` binding at `src/lib/better-auth-db.ts:111`
 * has the same shape; we rebind here to avoid a cross-package import
 * from `packages/dashboards` into the cinatra-app `src/lib/`).
 */
export const organizationsForCube = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug"),
  createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }),
});

/**
 * Better Auth `public."team"` projection — same rationale as
 * `organizationsForCube`.
 */
export const teamsForCube = pgTable("team", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  organizationId: text("organizationId").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }),
});

/**
 * Better Auth `public."member"` projection — same rationale.
 */
export const membersForCube = pgTable("member", {
  organizationId: text("organizationId").notNull(),
  userId: text("userId").notNull(),
  role: text("role"),
});

/**
 * Narrow projection of `cinatra.usage_events`, sized for the llm_usage cube.
 * Carries the cost/token measures (cost_usd, *_tokens), the grouping
 * dimensions (model, provider, agent_label, skill_label, operation,
 * occurred_at), and id (for the event_count COUNT). The canonical Drizzle
 * binding for usage_events lives in
 * `packages/metric-cost-api/src/schema.ts`; we rebind a narrow projection
 * here so the dashboards package never imports the metric-cost-api schema
 * (keeps the cube wiring self-contained, same pattern as `objectsForCube`).
 * Same underlying Postgres table — this only widens the Drizzle TYPE
 * surface, never the runtime schema.
 */
export const usageEventsForCube = cinatraSchema.table("usage_events", {
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
