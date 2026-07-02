// Drizzle table definitions for the webhook facility (cinatra#340).
//
// The typed read/write surface for the two webhook tables. The DDL OF RECORD is
// the migration (migrations/core/core__0008/0009) + the idempotent bootstrap
// DDL (src/lib/drizzle-store.ts buildCreateStoreSchemaQueries) — exactly like
// every other core table, these drizzle defs MIRROR that DDL and never own it.
//
// Schema-bound through a factory (`createWebhookTables(schemaName)`) so the
// package stays host-neutral: it imports no env and no `server-only`; the host
// binds the live `SUPABASE_SCHEMA` when it wires the package at boot.

import {
  pgSchema,
  text,
  uuid,
  integer,
  boolean,
  bigserial,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Build the schema-bound webhook tables.
 *
 * `webhook_idempotency` — the leased dedupe ledger (one row per
 *   (scope, site_id, message_id)); `scope` is `"<vendor>/<slug>/<hook>"`.
 * `webhook_secret_bindings` — per-(vendor,slug,hook,site) secret material,
 *   encrypted via the host secretsCodec; carries the bounded dual-secret
 *   rotation window. `site_id` lives in the `connect_sites.site_id` uuid
 *   identity space (a webhook arrives from a connected site).
 */
export function createWebhookTables(schemaName: string) {
  const schema = pgSchema(schemaName);

  const webhookIdempotency = schema.table(
    "webhook_idempotency",
    {
      id: bigserial("id", { mode: "bigint" }).primaryKey(),
      // "<vendor>/<slug>/<hook>" — the declared-hook scope of the message.
      scope: text("scope").notNull(),
      // Connected-site identity (connect_sites.site_id space).
      siteId: uuid("site_id").notNull(),
      // Standard-Webhooks webhook-id — the per-(scope,site) idempotency key.
      messageId: text("message_id").notNull(),
      // Leased state machine: processing | done | failed.
      status: text("status").notNull().default("processing"),
      // Lease expiry for an in-flight (processing) row; a crashed holder's lease
      // expires and a retry re-claims.
      leaseUntil: timestamp("lease_until", { withTimezone: true }),
      // Monotonic attempt counter — the finalize fence (a stale holder cannot
      // finalize over a newer attempt's claim).
      attemptCount: integer("attempt_count").notNull().default(1),
      receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
      finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    },
    (t) => ({
      // All three key columns NOT NULL — a nullable column in the unique key
      // would admit duplicate NULL rows and break idempotency.
      keyUniq: uniqueIndex("webhook_idempotency_key_uniq").on(t.scope, t.siteId, t.messageId),
    }),
  );

  const webhookSecretBindings = schema.table(
    "webhook_secret_bindings",
    {
      // Server-issued opaque id — the ONLY thing the inbound URL carries; the
      // route resolves the secret + site identity from this, never the payload.
      bindingId: text("binding_id").primaryKey(),
      vendor: text("vendor").notNull(),
      slug: text("slug").notNull(),
      hook: text("hook").notNull(),
      // connect_sites.site_id space (uuid).
      siteId: uuid("site_id").notNull(),
      // The ENCRYPTED current secret (host secretsCodec blob), not a "ref".
      currentSecretCiphertext: text("current_secret_ciphertext").notNull(),
      currentSecretIv: text("current_secret_iv").notNull(),
      // The encrypted PREVIOUS secret during a bounded rotation window (nullable
      // outside a window).
      previousSecretCiphertext: text("previous_secret_ciphertext"),
      previousSecretIv: text("previous_secret_iv"),
      previousExpiresAt: timestamp("previous_expires_at", { withTimezone: true }),
      rotatedAt: timestamp("rotated_at", { withTimezone: true }),
      // The #343 legacy single-shared-secret bridge: when legacy_enabled, the
      // in-field sender keeps its bespoke `sha256=<hex>` HMAC and the shared
      // secret is stored ENCRYPTED here (host secretsCodec blob, AAD field
      // "legacy") — null for a Standard-Webhooks binding.
      legacyEnabled: boolean("legacy_enabled").notNull().default(false),
      legacySecretCiphertext: text("legacy_secret_ciphertext"),
      legacySecretIv: text("legacy_secret_iv"),
      revokedAt: timestamp("revoked_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => ({
      siteIdx: index("webhook_secret_bindings_site_idx").on(t.siteId),
      // The partial-unique active-row index is enforced by the DDL of record
      // (WHERE revoked_at IS NULL); declared advisory here.
      tupleIdx: index("webhook_secret_bindings_tuple_idx").on(t.vendor, t.slug, t.hook, t.siteId),
    }),
  );

  return { webhookIdempotency, webhookSecretBindings };
}

export type WebhookTables = ReturnType<typeof createWebhookTables>;
export type WebhookIdempotencyRow = WebhookTables["webhookIdempotency"]["$inferSelect"];
export type WebhookSecretBindingRow = WebhookTables["webhookSecretBindings"]["$inferSelect"];
