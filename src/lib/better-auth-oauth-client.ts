import "server-only";

import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";

import { betterAuthDb } from "@/lib/better-auth-db";

// Single source of truth (app-runtime TS) for INSERTs/DELETEs against
// public."oauthClient" — the Better Auth oauth-provider table. The CLI
// (packages/cli/src/index.mjs) issues raw pg queries against the same
// table and is intentionally out of scope here; it owns its own
// connection pool and a larger column set (skipConsent, requirePKCE,
// scopes, etc.) than the runtime callers need. Keep this module narrow
// to the runtime use cases (service accounts + assistant users) so the
// helper does not balloon into a config-laden "kitchen sink."

// Mirror of @better-auth/oauth-provider/utils.defaultHasher — SHA-256
// digest, base64url-encoded, with the trailing `=` padding stripped.
// Better Auth verifies a presented client secret by hashing it with this
// same function and constant-time-comparing the digest with the stored
// value. Storing the raw plaintext would make every confidential client
// permanently `invalid_client` at verify time.
export function hashClientSecret(secret: string): string {
  return createHash("sha256")
    .update(secret)
    .digest("base64url")
    .replace(/=+$/, "");
}

// Minimal structural type for a Drizzle "executor" — either the top-level
// `betterAuthDb` or a transaction object passed by `betterAuthDb.transaction(tx => …)`.
// Avoids importing the full Drizzle PgTransaction generic stack.
type OAuthClientExecutor = {
  execute: (query: SQL) => Promise<unknown>;
};

export type InsertOAuthClientInput = {
  /**
   * Primary key for the oauthClient row. Convention: for service accounts
   * this is the service-account row's id; for assistant users this is the
   * assistant user's id.
   */
  id: string;
  /**
   * Optional FK to public."user".id (oauthClient.userId references
   * user(id) ON DELETE CASCADE). Service accounts pass `null` — they have
   * no user-row link. Assistant users pass the assistant user's id, so
   * deleting the user row cascades the oauth client.
   */
  userId?: string | null;
  /** OAuth client_id (UUID). */
  clientId: string;
  /**
   * Raw client_secret. Hashed via {@link hashClientSecret} before storage;
   * the plaintext is returned to the caller once (at creation time) and
   * not persisted.
   */
  clientSecret: string;
  /** Human-readable name (audit/log surface). */
  name: string;
  /** Optional metadata object — serialized to JSONB. Defaults to `{}`. */
  metadata?: Record<string, unknown>;
};

async function insertOAuthClientImpl(
  executor: OAuthClientExecutor,
  input: InsertOAuthClientInput,
): Promise<void> {
  const now = new Date();
  const storedSecret = hashClientSecret(input.clientSecret);
  const metadataJson = JSON.stringify(input.metadata ?? {});
  const userIdValue = input.userId ?? null;

  // redirectUris is `jsonb NOT NULL` per the live oauth-provider schema
  // (see tests/e2e/rbac/fixtures/public-schema.sql). Defaulted to an
  // empty array — the built-in assistant + service-account clients do
  // not use authorization-code redirects.
  await executor.execute(sql`
    INSERT INTO public."oauthClient"
      (id, name, "clientId", "clientSecret", "redirectUris", metadata,
       "userId", "createdAt", "updatedAt", disabled)
    VALUES (
      ${input.id},
      ${input.name},
      ${input.clientId},
      ${storedSecret},
      '[]'::jsonb,
      ${metadataJson}::jsonb,
      ${userIdValue},
      ${now},
      ${now},
      false
    )
    ON CONFLICT DO NOTHING
  `);
}

/** INSERT against the top-level betterAuthDb. */
export async function insertOAuthClient(
  input: InsertOAuthClientInput,
): Promise<void> {
  await insertOAuthClientImpl(betterAuthDb, input);
}

/** INSERT against a transaction-bound executor (e.g. inside `betterAuthDb.transaction`). */
export async function insertOAuthClientWithTx(
  tx: OAuthClientExecutor,
  input: InsertOAuthClientInput,
): Promise<void> {
  await insertOAuthClientImpl(tx, input);
}

export async function deleteOAuthClientByClientId(clientId: string): Promise<void> {
  await betterAuthDb.execute(sql`
    DELETE FROM public."oauthClient" WHERE "clientId" = ${clientId}
  `);
}
