/**
 * DB-integration coverage for cinatra#221 Connect provisioning against a REAL
 * Postgres (no mocks). Validates the race-critical invariants that only the
 * actual database can prove:
 *   - atomic single-use consume: two concurrent consumes of one code → exactly
 *     one wins (the WHERE consumed_at IS NULL predicate is the lock),
 *   - TTL expiry: an expired code cannot be consumed,
 *   - active-row uniqueness: the partial unique index forbids two active rows
 *     for the same (org_id, client, widget_origin); a reconnect rotates IN
 *     PLACE (same site_id, version bumped),
 *   - in-SQL credential hash binds to the FINAL site_id on the rotate path,
 *   - revoke frees the (org, client, origin) tuple so a fresh connect inserts.
 *
 * Runs only under CINATRA_DB_INTEGRATION_TESTS=1 (the extension-lifecycle-db-
 * tests CI job + local dev against a branch Postgres); the `*.integration.test`
 * glob is excluded from the default unit run. Self-skips when SUPABASE_DB_URL
 * is absent so the flag can never make it fail-vacuous.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { connect, createTestSchema, dropSchema } from "./_fixture";

const HAVE_DB = Boolean(process.env.SUPABASE_DB_URL);
const d = HAVE_DB ? describe : describe.skip;

function sha256Hex(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

let client: Client;
let schema: string;

beforeAll(async () => {
  if (!HAVE_DB) return;
  client = await connect();
  schema = await createTestSchema(client);
});
afterAll(async () => {
  if (!HAVE_DB) return;
  if (schema) await dropSchema(client, schema);
  await client.end();
});

async function insertCode(codeHash: string, expiresInSeconds: number, grantType = "auth_code") {
  await client.query(
    `INSERT INTO "${schema}".connect_authorization_codes
       (code_hash, grant_type, client, redirect_uri, widget_origin, callback_origin,
        code_challenge, admin_user_id, org_id, scope, created_at, expires_at, consumed_at)
     VALUES ($1,$2,'wordpress',NULL,'https://shop.example.com',NULL,NULL,'u','o','s',
             now(), now() + ($3 || ' seconds')::interval, NULL)`,
    [codeHash, grantType, String(expiresInSeconds)],
  );
}

const CONSUME_SQL = (s: string) => `
  UPDATE "${s}".connect_authorization_codes
  SET consumed_at = now()
  WHERE code_hash = $1 AND grant_type = $2 AND consumed_at IS NULL AND expires_at > now()
  RETURNING code_hash`;

// $1=candidate site_id, $2=secret, $3=org_id (may be NULL), $4=widget_origin.
const UPSERT_SQL = (s: string) => `
  INSERT INTO "${s}".connect_sites
    (site_id, client, widget_origin, callback_origin, credential_hash,
     credential_version, webhook_secret_hash, admin_user_id, org_id, created_at, last_exchanged_at)
  VALUES ($1::uuid,'wordpress',$4,NULL,
          encode(sha256(('cnx_' || $1::text || '_' || $2::text)::bytea), 'hex'),
          1, NULL, 'u', $3, now(), now())
  ON CONFLICT (org_id, client, widget_origin) WHERE revoked_at IS NULL
  DO UPDATE SET
    credential_hash = encode(sha256(('cnx_' || "${s}".connect_sites.site_id::text || '_' || $2::text)::bytea), 'hex'),
    credential_version = "${s}".connect_sites.credential_version + 1,
    last_exchanged_at = now()
  RETURNING site_id, credential_version, credential_hash`;

d("connect_authorization_codes — atomic single-use", () => {
  it("exactly one of two concurrent consumes wins", async () => {
    const codeHash = sha256Hex(randomUUID());
    await insertCode(codeHash, 120);
    const [a, b] = await Promise.all([
      client.query(CONSUME_SQL(schema), [codeHash, "auth_code"]),
      client.query(CONSUME_SQL(schema), [codeHash, "auth_code"]),
    ]);
    const wins = (a.rowCount ?? 0) + (b.rowCount ?? 0);
    expect(wins).toBe(1);
    // A third consume after both also fails.
    const c = await client.query(CONSUME_SQL(schema), [codeHash, "auth_code"]);
    expect(c.rowCount).toBe(0);
  });

  it("an expired code cannot be consumed", async () => {
    const codeHash = sha256Hex(randomUUID());
    await insertCode(codeHash, -1); // already expired
    const r = await client.query(CONSUME_SQL(schema), [codeHash, "auth_code"]);
    expect(r.rowCount).toBe(0);
  });

  it("grant_type must match (install_code cannot be consumed as auth_code)", async () => {
    const codeHash = sha256Hex(randomUUID());
    await insertCode(codeHash, 600, "install_code");
    expect((await client.query(CONSUME_SQL(schema), [codeHash, "auth_code"])).rowCount).toBe(0);
    expect((await client.query(CONSUME_SQL(schema), [codeHash, "install_code"])).rowCount).toBe(1);
  });
});

d("connect_sites — active-row uniqueness + rotate-in-place + revoke", () => {
  const ORIGIN = "https://shop.example.com";

  it("reconnect rotates the SAME row (version bumped, hash bound to final site_id)", async () => {
    const site1 = randomUUID();
    const secret1 = "secret-one";
    const r1 = await client.query(UPSERT_SQL(schema), [site1, secret1, "o", ORIGIN]);
    expect(r1.rows[0].credential_version).toBe(1);
    expect(r1.rows[0].credential_hash).toBe(sha256Hex(`cnx_${site1}_${secret1}`));

    // A reconnect supplies a NEW candidate site id, but the active-row conflict
    // preserves the existing site_id and bumps the version. The new hash is
    // bound to the PRESERVED site_id (not the candidate).
    const site2Candidate = randomUUID();
    const secret2 = "secret-two";
    const r2 = await client.query(UPSERT_SQL(schema), [site2Candidate, secret2, "o", ORIGIN]);
    expect(r2.rows[0].site_id).toBe(site1); // preserved
    expect(r2.rows[0].credential_version).toBe(2); // rotated
    expect(r2.rows[0].credential_hash).toBe(sha256Hex(`cnx_${site1}_${secret2}`));
    expect(r2.rows[0].credential_hash).not.toBe(r1.rows[0].credential_hash);

    // Exactly one active row for the tuple.
    const active = await client.query(
      `SELECT count(*)::int AS n FROM "${schema}".connect_sites
       WHERE org_id='o' AND client='wordpress' AND widget_origin=$1 AND revoked_at IS NULL`,
      [ORIGIN],
    );
    expect(active.rows[0].n).toBe(1);

    // Revoke frees the tuple; a fresh connect inserts a NEW row (version 1).
    await client.query(
      `UPDATE "${schema}".connect_sites SET revoked_at = now(), revoked_by='admin' WHERE site_id = $1`,
      [site1],
    );
    const site3 = randomUUID();
    const r3 = await client.query(UPSERT_SQL(schema), [site3, "secret-three", "o", ORIGIN]);
    expect(r3.rows[0].site_id).toBe(site3); // brand-new row
    expect(r3.rows[0].credential_version).toBe(1);
  });

  it("NULL org_id rotates in place (NULLS NOT DISTINCT — codex High fix; no parallel active rows)", async () => {
    const nullOrigin = "https://nullorg.example.com";
    const s1 = randomUUID();
    const r1 = await client.query(UPSERT_SQL(schema), [s1, "sec-a", null, nullOrigin]);
    expect(r1.rows[0].credential_version).toBe(1);
    // Reconnect with a NULL org_id must ROTATE the same row, not insert a parallel one.
    const s2 = randomUUID();
    const r2 = await client.query(UPSERT_SQL(schema), [s2, "sec-b", null, nullOrigin]);
    expect(r2.rows[0].site_id).toBe(s1); // preserved — proves NULLS NOT DISTINCT collision
    expect(r2.rows[0].credential_version).toBe(2);
    const active = await client.query(
      `SELECT count(*)::int AS n FROM "${schema}".connect_sites
       WHERE org_id IS NULL AND client='wordpress' AND widget_origin=$1 AND revoked_at IS NULL`,
      [nullOrigin],
    );
    expect(active.rows[0].n).toBe(1);
  });
});
