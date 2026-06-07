/**
 * Authorization kernel — audit_events Drizzle table.
 *
 * Pure schema definition. No I/O, no server-only guard (consumed by the
 * audit.ts pool/db bootstrap, which IS the server-only entrypoint).
 *
 * Defines the full audit column set now, with all fields nullable except
 * `id` (PK) and `createdAt`, to avoid migration debt later.
 *
 * Per CLAUDE.md: must use cinatraSchema.table() rather than the bare
 * Drizzle constructor so the SUPABASE_SCHEMA env var is honored.
 * camelCase property → snake_case column name via the column
 * constructor's first argument.
 */
import { pgSchema, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

const cinatraSchema = pgSchema(process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra");

export const auditEvents = cinatraSchema.table("audit_events",
  {
    id:                  text("id").primaryKey(),
    organizationId:      text("organization_id"),
    actorPrincipalId:    text("actor_principal_id"),
    actorPrincipalType:  text("actor_principal_type"),
    authSource:          text("auth_source"),
    delegatedBy:         text("delegated_by"),
    impersonatedUserId:  text("impersonated_user_id"),
    resourceType:        text("resource_type"),
    resourceId:          text("resource_id"),
    operation:           text("operation"),
    decision:            text("decision"),
    policyVersion:       text("policy_version"),
    requestId:           text("request_id"),
    runId:               text("run_id"),
    a2aTaskId:           text("a2a_task_id"),
    ip:                  text("ip"),
    metadata:            jsonb("metadata"),
    createdAt:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    actorPrincipalIdIdx: index("audit_events_actor_principal_id_idx").on(t.actorPrincipalId),
    resourceIdx:         index("audit_events_resource_idx").on(t.resourceType, t.resourceId),
    // DESC matches the DDL in drizzle-store.ts. This codebase uses raw SQL
    // migrations (not drizzle-kit), so the Drizzle index is advisory only;
    // kept in sync to avoid confusion during future migration reviews.
    createdAtIdx:        index("audit_events_created_at_idx").on(t.createdAt.desc()),
  }),
);

export type AuditEventRecord = typeof auditEvents.$inferSelect;
export type NewAuditEventRecord = typeof auditEvents.$inferInsert;
