import "server-only";

import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";

import type { ExternalMcpOAuthClient } from "@cinatra-ai/sdk-extensions";
import { betterAuthDb } from "@/lib/better-auth-db";

// Single source of truth (app-runtime TS) for INSERTs/DELETEs against
// public."oauthClient" — the Better Auth oauth-provider table. The CLI
// (the published @cinatra-ai/cinatra) issues raw pg queries against the same
// table and is intentionally out of scope here; it owns its own
// connection pool and a larger column set (skipConsent, requirePKCE,
// scopes, etc.) than the runtime callers need. Keep this module narrow
// to the runtime use cases (service accounts + assistant users + the
// external MCP-client surface below) so the helper does not balloon
// into a config-laden "kitchen sink."

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

// ---------------------------------------------------------------------------
// External MCP-client surface. The host owns this read (it backs both the
// /connectors readiness probe and the SDK MCP OAuth-client store the
// mcp-client connector consumes) so the connector package never imports
// `@/lib/*` host modules for it.
// ---------------------------------------------------------------------------

type ExternalMcpClientRow = {
  id: string;
  clientId: string;
  name: string | null;
  redirectUris: unknown;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

function parseRedirectURLs(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseDate(value: Date | string | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Boundary predicate for EXTERNAL MCP OAuth clients — everything Cinatra
// itself registered is internal: the app's self-client, the per-LLM-provider
// clients, assistant users (matched by `user."userType"`, not just the
// `assistant-` name prefix — the built-in assistant client is named
// `cinatra-built-in`), and service accounts (host-controlled
// `service-account-` name prefix; their rows are not user-linked). ONE shared
// fragment for the list and the delete below so the two can never drift: a
// client the setup page will not list can also never be deleted through the
// connector's disconnect action.
const externalMcpOAuthClientPredicate = sql`
  COALESCE(disabled, false) = false
  AND "clientId" <> 'cinatra-app-mcp-client'
  AND "clientId" NOT LIKE 'cinatra-llm-%'
  AND COALESCE(name, '') NOT LIKE 'assistant-%'
  AND COALESCE(name, '') NOT LIKE 'service-account-%'
  AND NOT EXISTS (
    SELECT 1 FROM public."user" u
    WHERE u.id = "oauthClient"."userId"
      AND u."userType" = 'assistant'
  )
`;

/**
 * Every externally-registered MCP OAuth client (Claude Desktop, Claude.ai,
 * ChatGPT, any other MCP-compatible client), newest first. Deliberately
 * generic — no client-name filtering; internal clients are excluded by
 * {@link externalMcpOAuthClientPredicate}.
 */
export async function listExternalMcpOAuthClients(): Promise<ExternalMcpOAuthClient[]> {
  const result = await betterAuthDb.execute<ExternalMcpClientRow>(sql`
    SELECT id, "clientId", name, "redirectUris", "createdAt", "updatedAt"
    FROM public."oauthClient"
    WHERE ${externalMcpOAuthClientPredicate}
    ORDER BY "createdAt" DESC NULLS LAST
  `);
  const rows = (result.rows ?? []) as ExternalMcpClientRow[];
  return rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    redirectURLs: parseRedirectURLs(row.redirectUris),
    createdAt: parseDate(row.createdAt),
    updatedAt: parseDate(row.updatedAt),
  }));
}

/** Count of externally-registered MCP OAuth clients (the /connectors readiness probe). */
export async function countExternalMcpOAuthClients(): Promise<number> {
  const clients = await listExternalMcpOAuthClients();
  return clients.length;
}

/**
 * Delete one EXTERNAL MCP OAuth client. Scoped by the same predicate as the
 * list above, so internal clients (self-client, LLM clients, assistants,
 * service accounts) can never be deleted through this surface even with a
 * forged clientId — use {@link deleteOAuthClientByClientId} for the internal
 * lifecycles that own those rows.
 */
export async function deleteExternalMcpOAuthClient(clientId: string): Promise<void> {
  await betterAuthDb.execute(sql`
    DELETE FROM public."oauthClient"
    WHERE "clientId" = ${clientId} AND ${externalMcpOAuthClientPredicate}
  `);
}
