import "server-only";

import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import {
  deleteOAuthClientByClientId as deleteOAuthClientRow,
  insertOAuthClient as insertOAuthClientRow,
} from "@/lib/better-auth-oauth-client";

// ---------------------------------------------------------------------------
// Module-local Drizzle pool — mirrors src/lib/projects-store.ts pattern.
// Each cinatra-schema store owns its own connection pool — there is no
// shared global database handle in @/lib/database.
// ---------------------------------------------------------------------------
declare global {
  // eslint-disable-next-line no-var
  var __cinatraServiceAccountsPool: Pool | undefined;
}

// Lazy pool + drizzle bootstrap. The pool is created on first use (not at
// module import) so `next build` page-data collection — and any other
// import-time evaluation without SUPABASE_DB_URL — does not throw. `new Pool()`
// never opens a connection until the first query, so deferring creation is free.
//
// The idle-error listener (registered at pool creation) keeps the process alive
// when Supabase drops idle connections: pg.Pool emits 'error' on an unexpected
// backend disconnect, which Node.js otherwise treats as an uncaught exception.
let serviceAccountsPoolInstance: Pool | undefined;
function getServiceAccountsPool(): Pool {
  if (serviceAccountsPoolInstance) return serviceAccountsPoolInstance;
  if (globalThis.__cinatraServiceAccountsPool) {
    return (serviceAccountsPoolInstance = globalThis.__cinatraServiceAccountsPool);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for @/lib/service-accounts");
  }
  const pool = new Pool({ connectionString });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) => {
      console.error("[service-accounts] pg pool idle client error:", err.message);
    });
  }
  serviceAccountsPoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraServiceAccountsPool = pool;
  }
  return pool;
}

function createServiceAccountsDb() {
  return drizzle(getServiceAccountsPool());
}
let serviceAccountsDbInstance: ReturnType<typeof createServiceAccountsDb> | undefined;
function getServiceAccountsDb(): ReturnType<typeof createServiceAccountsDb> {
  return (serviceAccountsDbInstance ??= createServiceAccountsDb());
}

// Lazy value-export proxies preserve the `serviceAccountsPool` /
// `serviceAccountsDb` import contract while deferring pool creation to first
// use. Method access is bound to the real target.
export const serviceAccountsPool: Pool = new Proxy({} as Pool, {
  get(_t, prop) {
    const target: any = getServiceAccountsPool();
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export const serviceAccountsDb: ReturnType<typeof createServiceAccountsDb> = new Proxy(
  {} as ReturnType<typeof createServiceAccountsDb>,
  {
    get(_t, prop) {
      const target: any = getServiceAccountsDb();
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  },
);

const SCHEMA = process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra";
const TABLE = sql.raw(`"${SCHEMA.replaceAll('"', '""')}"."service_accounts"`);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceAccountRecord = {
  id: string;
  name: string;
  orgId: string | null;
  clientId: string;
  scopes: string;
  revokedAt: Date | null;
  rotatedAt: Date | null;
  previousClientId: string | null;
  gracePeriodSeconds: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateServiceAccountResult = {
  id: string;
  name: string;
  orgId: string | null;
  clientId: string;
  clientSecret: string;
  scopes: string;
};

const DEFAULT_GRACE_PERIOD_SECONDS = 900;

// ---------------------------------------------------------------------------
// Helpers — public."oauthClient" CRUD (Better Auth's oauth-provider table)
//
// The raw INSERT / DELETE SQL lives in `@/lib/better-auth-oauth-client`
// (single source of truth for app-runtime TS callers). This file owns the
// service-account-specific shape: `id = serviceAccountId`, no `userId`
// (service accounts are not user-linked — they identify a non-user actor),
// and `metadata.allowedScopes` mirrors the service_accounts.scopes column
// for audit visibility.
// ---------------------------------------------------------------------------

async function insertOAuthClient(
  clientId: string,
  clientSecret: string,
  name: string,
  ownerId: string,
  scopeCeiling?: string,
): Promise<void> {
  await insertOAuthClientRow({
    id: ownerId,
    userId: null,
    clientId,
    clientSecret,
    name,
    metadata: scopeCeiling ? { allowedScopes: scopeCeiling } : undefined,
  });
}

async function deleteOAuthClientByClientId(clientId: string): Promise<void> {
  await deleteOAuthClientRow(clientId);
}

// ---------------------------------------------------------------------------
// Row → Record mapper
// ---------------------------------------------------------------------------

function rowToRecord(row: Record<string, unknown>): ServiceAccountRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    orgId: row.org_id === null || row.org_id === undefined ? null : String(row.org_id),
    clientId: String(row.client_id),
    scopes: String(row.scopes ?? ""),
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
    rotatedAt: row.rotated_at ? new Date(String(row.rotated_at)) : null,
    previousClientId:
      row.previous_client_id === null || row.previous_client_id === undefined
        ? null
        : String(row.previous_client_id),
    gracePeriodSeconds: Number(row.grace_period_seconds ?? DEFAULT_GRACE_PERIOD_SECONDS),
    createdBy:
      row.created_by === null || row.created_by === undefined ? null : String(row.created_by),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

// ---------------------------------------------------------------------------
// createServiceAccount
// ---------------------------------------------------------------------------

export async function createServiceAccount(params: {
  name: string;
  scopes: string; // space-separated Permission strings
  orgId?: string | null;
  gracePeriodSeconds?: number;
  createdBy?: string | null;
}): Promise<CreateServiceAccountResult> {
  const id = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  // Use a 256-bit CSPRNG secret with a scannable prefix. The `cinatra_a2a_`
  // prefix lets leaked-secret scanners identify provenance in code/log
  // searches without fingerprinting any structural property of the digest.
  const clientSecret = `cinatra_a2a_${randomBytes(32).toString("base64url")}`;
  const grace = params.gracePeriodSeconds ?? DEFAULT_GRACE_PERIOD_SECONDS;
  const orgId = params.orgId ?? null;
  const createdBy = params.createdBy ?? null;

  // 1. OAuth client first — if this fails, no orphan service_account row
  await insertOAuthClient(clientId, clientSecret, `service-account-${params.name}`, id, params.scopes);

  // 2. cinatra.service_accounts row
  const db = serviceAccountsDb;
  await db.execute(sql`
    INSERT INTO ${TABLE}
      (id, name, org_id, client_id, scopes, grace_period_seconds, created_by, created_at, updated_at)
    VALUES (${id}, ${params.name}, ${orgId}, ${clientId}, ${params.scopes}, ${grace}, ${createdBy}, now(), now())
  `);

  return { id, name: params.name, orgId, clientId, clientSecret, scopes: params.scopes };
}

// ---------------------------------------------------------------------------
// listServiceAccounts
// ---------------------------------------------------------------------------

export async function listServiceAccounts(): Promise<ServiceAccountRecord[]> {
  const db = serviceAccountsDb;
  const result = await db.execute(sql`
    SELECT id, name, org_id, client_id, scopes, revoked_at, rotated_at, previous_client_id,
           grace_period_seconds, created_by, created_at, updated_at
    FROM ${TABLE}
    ORDER BY created_at DESC
  `);
  const rows = (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
  return rows.map(rowToRecord);
}

// ---------------------------------------------------------------------------
// readServiceAccount
// ---------------------------------------------------------------------------

export async function readServiceAccount(id: string): Promise<ServiceAccountRecord | null> {
  const db = serviceAccountsDb;
  const result = await db.execute(sql`
    SELECT id, name, org_id, client_id, scopes, revoked_at, rotated_at, previous_client_id,
           grace_period_seconds, created_by, created_at, updated_at
    FROM ${TABLE}
    WHERE id = ${id}
    LIMIT 1
  `);
  const rows = (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
  return rows.length > 0 ? rowToRecord(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// readServiceAccountByClientId — honors rotation grace-period window
// ---------------------------------------------------------------------------

export async function readServiceAccountByClientId(
  clientId: string,
): Promise<ServiceAccountRecord | null> {
  const db = serviceAccountsDb;
  // Match current clientId OR previousClientId still within grace window.
  const result = await db.execute(sql`
    SELECT id, name, org_id, client_id, scopes, revoked_at, rotated_at, previous_client_id,
           grace_period_seconds, created_by, created_at, updated_at
    FROM ${TABLE}
    WHERE client_id = ${clientId}
       OR (previous_client_id = ${clientId}
           AND rotated_at IS NOT NULL
           AND rotated_at + (grace_period_seconds * INTERVAL '1 second') > now())
    LIMIT 1
  `);
  const rows = (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
  return rows.length > 0 ? rowToRecord(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// revokeServiceAccount — sets revoked_at; does NOT delete oauthClient
// ---------------------------------------------------------------------------

export async function revokeServiceAccount(id: string): Promise<void> {
  const db = serviceAccountsDb;
  await db.execute(sql`
    UPDATE ${TABLE} SET revoked_at = now(), updated_at = now() WHERE id = ${id}
  `);
  // NOTE: do NOT delete the oauthClient row — already-issued tokens must
  // hit the revocation check on every request via cinatra.service_accounts.revoked_at.
}

// ---------------------------------------------------------------------------
// rotateServiceAccount — generates new clientId/clientSecret pair, stores
// previousClientId + rotatedAt for grace-period window
// ---------------------------------------------------------------------------

export async function rotateServiceAccount(
  id: string,
): Promise<{ clientId: string; clientSecret: string }> {
  const account = await readServiceAccount(id);
  if (!account) throw new Error(`service account not found: ${id}`);

  const newClientId = crypto.randomUUID();
  // Use the same 256-bit CSPRNG secret and `cinatra_a2a_` prefix on rotation
  // so rotated secrets carry the same entropy and prefix conventions as
  // freshly issued ones.
  const newClientSecret = `cinatra_a2a_${randomBytes(32).toString("base64url")}`;
  const oldClientId = account.clientId;

  await deleteOAuthClientByClientId(oldClientId);
  await insertOAuthClient(newClientId, newClientSecret, `service-account-${account.name}`, id, account.scopes);

  const db = serviceAccountsDb;
  await db.execute(sql`
    UPDATE ${TABLE}
       SET client_id = ${newClientId},
           previous_client_id = ${oldClientId},
           rotated_at = now(),
           updated_at = now()
     WHERE id = ${id}
  `);

  return { clientId: newClientId, clientSecret: newClientSecret };
}

// ---------------------------------------------------------------------------
// deleteServiceAccount — removes both Cinatra row AND oauthClient row(s)
// ---------------------------------------------------------------------------

export async function deleteServiceAccount(id: string): Promise<void> {
  const account = await readServiceAccount(id);
  if (!account) return;

  await deleteOAuthClientByClientId(account.clientId);
  if (account.previousClientId) {
    await deleteOAuthClientByClientId(account.previousClientId);
  }

  const db = serviceAccountsDb;
  await db.execute(sql`DELETE FROM ${TABLE} WHERE id = ${id}`);
}
