/**
 * Local Drizzle schema for `cinatra.audit_events`. The actual DDL lives in
 * `src/lib/drizzle-store.ts`; the existing schema export at
 * `packages/agents/src/schema.ts` does not match the DB because it exposes
 * reviewTaskId/eventType fields.
 *
 * This file mirrors the current DDL exactly. Only the dashboards mutation
 * service is allowed to write through it — the rg/AST regression gate verifies
 * no other writer references this module.
 */
import { jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

const SCHEMA_NAME = process.env.SUPABASE_SCHEMA ?? "cinatra";
const cinatraSchema = pgSchema(SCHEMA_NAME);

export const auditEvents = cinatraSchema.table("audit_events", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id"),
  actorPrincipalId: text("actor_principal_id"),
  actorPrincipalType: text("actor_principal_type"),
  authSource: text("auth_source"),
  delegatedBy: text("delegated_by"),
  impersonatedUserId: text("impersonated_user_id"),
  resourceType: text("resource_type"),
  resourceId: text("resource_id"),
  operation: text("operation"),
  decision: text("decision"),
  policyVersion: text("policy_version"),
  requestId: text("request_id"),
  runId: text("run_id"),
  a2aTaskId: text("a2a_task_id"),
  ip: text("ip"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;
