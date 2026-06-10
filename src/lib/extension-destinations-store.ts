// Destination credential store read/write helpers — REAL pg connection.
//
// Split out of drizzle-store.ts (cinatra#104): these are the only consumers
// of an actual `pg` Pool / the drizzle node-postgres driver. Keeping the
// `pg` import here (instead of in drizzle-store) keeps drizzle-store — and
// the whole database.ts/postgres-schema-init graph above it — SYNCHRONOUS
// under Turbopack, where `pg` is externalized via dynamic `import()` and
// would otherwise turn every static importer into an async module (see
// src/lib/postgres-config.ts for the mechanism). This module is only ever
// imported by async credential flows, where async modules are harmless.
//
// AAD binding: callers use "destination.<id>.publish-token" /
//   "destination.<id>.read-token" when calling decryptSecret/encryptSecret.
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createStoreTables } from "@/lib/drizzle-store";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";

// Lazy-singleton Pool (mirrors agents/src/db.ts). Stored on globalThis so
// Turbopack HMR module re-evaluation does not leak pools.
declare global {
  var __cinatraDestCredPool: Pool | undefined;
}

function getDestCredPool(): Pool {
  if (globalThis.__cinatraDestCredPool) return globalThis.__cinatraDestCredPool;
  // getPostgresConnectionString (postgres-config) adds the .env.local
  // fallback, matching how every other store resolves SUPABASE_DB_URL.
  const connectionString = getPostgresConnectionString();
  const pool = new Pool({ connectionString });
  pool.on("error", (err) => {
    console.error("[extension-destinations-store] pg pool idle client error:", err.message);
  });
  globalThis.__cinatraDestCredPool = pool;
  return pool;
}

export type ExtensionDestinationRow = {
  id: string;
  label: string;
  registryUrl: string;
  tokenCiphertext: string;
  tokenIv: string;
  tokenAlgo: string;
  readTokenCiphertext: string | null;
  readTokenIv: string | null;
};

/**
 * Reads the destination credential row by id.
 * Returns null when no row matches.
 *
 * Caller MUST run `requireAdminSession()` before calling this function.
 * Caller MUST call `decryptSecret(row, aad: "destination.<id>.publish-token")` on
 * the returned ciphertext.
 */
export async function readDestinationCredential(
  destinationId: string,
): Promise<ExtensionDestinationRow | null> {
  const tables = createStoreTables(postgresSchema);
  const db = drizzle(getDestCredPool(), { schema: {} });
  const rows = await db
    .select()
    .from(tables.extension_destinations)
    .where(eq(tables.extension_destinations.id, destinationId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    registryUrl: row.registryUrl,
    tokenCiphertext: row.tokenCiphertext,
    tokenIv: row.tokenIv,
    tokenAlgo: row.tokenAlgo,
    readTokenCiphertext: row.readTokenCiphertext ?? null,
    readTokenIv: row.readTokenIv ?? null,
  };
}

/**
 * Upserts (insert-or-update) a destination credential row.
 * Token ciphertexts MUST already be encrypted with per-field AAD:
 *   tokenCiphertext → encrypted with aad: "destination.<id>.publish-token"
 *   readTokenCiphertext → encrypted with aad: "destination.<id>.read-token"
 *
 * Caller MUST run `requireAdminSession()` before calling this function.
 */
export async function writeDestinationCredential(input: {
  id: string;
  label: string;
  registryUrl: string;
  tokenCiphertext: string;
  tokenIv: string;
  readTokenCiphertext?: string;
  readTokenIv?: string;
}): Promise<void> {
  const tables = createStoreTables(postgresSchema);
  const db = drizzle(getDestCredPool(), { schema: {} });
  await db
    .insert(tables.extension_destinations)
    .values({
      id: input.id,
      label: input.label,
      registryUrl: input.registryUrl,
      tokenCiphertext: input.tokenCiphertext,
      tokenIv: input.tokenIv,
      tokenAlgo: "aes-256-gcm",
      readTokenCiphertext: input.readTokenCiphertext ?? null,
      readTokenIv: input.readTokenIv ?? null,
    })
    .onConflictDoUpdate({
      target: tables.extension_destinations.id,
      set: {
        label: input.label,
        registryUrl: input.registryUrl,
        tokenCiphertext: input.tokenCiphertext,
        tokenIv: input.tokenIv,
        readTokenCiphertext: input.readTokenCiphertext ?? null,
        readTokenIv: input.readTokenIv ?? null,
        updatedAt: new Date(),
      },
    });
}

