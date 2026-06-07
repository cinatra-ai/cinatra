/**
 * Integration test fixture for LLM-scope tests.
 *
 * Each test file creates a unique per-test Postgres schema (no mocks, no
 * shared state) and seeds rows with explicit (organization_id, owner_type,
 * owner_id, visibility) tuples. The tests then build an `ActorContext`,
 * splice `buildOwnershipFilter(actor)` into a SELECT against the real
 * schema, and assert the returned IDs match the actor's visibility.
 *
 * This exercises the same SQL path that `src/lib/objects-store.ts`
 * `listObjectsByFilter(actor)` builds — which is the path that
 * `packages/objects/src/mcp/handlers.ts` calls under
 * `withActorContext(...)`. Any regression in `buildOwnershipFilter`
 * semantics surfaces here immediately.
 *
 * Per the project's branch-isolation convention, the connection string
 * comes from `SUPABASE_DB_URL` and the schema is created fresh per test file
 * — never reusing the worktree's shared `cinatra_<slug>` schema.
 */

import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

export type Pg = Client;

/**
 * Connection string used by all integration tests in this directory.
 * Reads `SUPABASE_DB_URL` directly (the env var the rest of the app uses).
 */
export function connectionString(): string {
  const cs = process.env.SUPABASE_DB_URL;
  if (!cs) {
    throw new Error(
      "SUPABASE_DB_URL is not set — run `pnpm cinatra setup branch` from the worktree first.",
    );
  }
  return cs;
}

/**
 * Create a connected pg.Client. Caller owns the lifecycle.
 */
export async function connect(): Promise<Client> {
  const c = new Client({ connectionString: connectionString() });
  await c.connect();
  return c;
}

/**
 * Create a unique per-test schema, run the full DDL chain, return the
 * schema name. Caller stashes the name and passes it to dropSchema in
 * afterAll.
 */
export async function createTestSchema(client: Client): Promise<string> {
  const name = `cinatra_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await client.query(`CREATE SCHEMA "${name}"`);
  // Run only DDL (CREATE/ALTER/DROP/CREATE INDEX) — skip seed INSERT/UPDATE
  // statements which can collide with an empty test schema's lack of FKs.
  const queries = buildCreateStoreSchemaQueries(name);
  for (const q of queries) {
    const head = q.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") {
      continue;
    }
    try {
      await client.query(q.text, q.values ?? []);
    } catch (err) {
      // A handful of statements reference seed dependencies that don't exist
      // in a fresh empty schema — log and continue. The columns that matter
      // for ownership filtering (objects.{owner_type,owner_id,visibility,org_id})
      // are added by simple ALTER TABLE ADD COLUMN IF NOT EXISTS which never
      // fails for an empty table.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist")) {
        // Re-throw genuine schema problems.
        throw err;
      }
    }
  }
  return name;
}

export async function dropSchema(client: Client, schema: string): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

/**
 * Insert a row into <schema>.objects with explicit ownership tuple.
 * Returns the inserted id.
 */
export async function insertObject(
  client: Client,
  schema: string,
  row: {
    id?: string;
    type?: string;
    orgId: string | null;
    ownerType: string;
    ownerId: string;
    visibility: string;
    data?: unknown;
  },
): Promise<string> {
  const id = row.id ?? randomUUID();
  await client.query(
    `INSERT INTO "${schema}"."objects"
       (id, type, data, org_id, owner_type, owner_id, visibility)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
    [
      id,
      row.type ?? "test",
      JSON.stringify(row.data ?? {}),
      row.orgId,
      row.ownerType,
      row.ownerId,
      row.visibility,
    ],
  );
  return id;
}

/**
 * Run a SELECT id against <schema>.objects with the actor's ownership
 * filter spliced in. Mirrors the splice in src/lib/objects-store.ts
 * listObjectsByFilter — pIdx starts at 2 because $1 holds the org filter
 * value (we always pass NULL so the org check is bypassed; the ownership
 * filter is the only authz gate the test exercises).
 *
 * Returns the row IDs, sorted ascending for stable assertions.
 */
export async function selectVisibleIds(
  client: Client,
  schema: string,
  filterFragment: { sql: string; params: unknown[] },
): Promise<string[]> {
  // Use $1 as a placeholder org_id NULL slot, then remap the fragment from
  // $1..$N to $2..$N+1.
  const remapped = filterFragment.sql.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + 1}`);
  const sql = `SELECT id FROM "${schema}"."objects"
               WHERE (org_id = $1 OR $1 IS NULL)
                 AND deleted_at IS NULL
                 AND ${remapped}
               ORDER BY id ASC`;
  const res = await client.query(sql, [null, ...filterFragment.params]);
  return res.rows.map((r) => r.id as string);
}
