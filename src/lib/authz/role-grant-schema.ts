/**
 * `role_grant` per-scope grant table.
 *
 * Schema lives next to the authz kernel because the grant is a kernel
 * concept (resolves into `actor.roles[]` at session-build time). The DDL
 * is authored in `src/lib/drizzle-store.ts` (`buildCreateStoreSchemaQueries`)
 * to stay alongside every other tenant-schema table.
 *
 * Subject is always a user; agent principals are not grant subjects.
 * Roles are developer / release_manager / customer. Scope is one of
 * (user, team, organization, workspace, project). The PK plus database
 * constraints ensure no duplicate role grants.
 */
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";

const cinatraSchema = pgSchema(process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra");

export const roleGrant = cinatraSchema.table("role_grant", {
  subjectUserId: text("subject_user_id").notNull(),
  role:          text("role").notNull(),             // developer | release_manager | customer
  scopeLevel:    text("scope_level").notNull(),      // user | team | organization | workspace | project
  scopeRecordId: text("scope_record_id").notNull(),
  orgId:         text("org_id").notNull(),           // denormalized for cross-tenant filtering
  grantedBy:     text("granted_by").notNull(),
  grantedAt:     timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt:     timestamp("expires_at", { withTimezone: true }),
});

export type RoleGrantRow = typeof roleGrant.$inferSelect;
export type RoleGrantInsert = typeof roleGrant.$inferInsert;
