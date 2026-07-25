/**
 * core__0083 retire the persisted `@chatgpt` handle — REAL-Postgres integration
 * proof (owner ruling 2026-07-21 M2/M5; epic cinatra#1873 W6).
 *
 * Drives the migration's exported SQL builders (`buildUpSql(schema)`) against a
 * fresh per-file schema built from the canonical DDL, seeded with:
 *   - an assistant_handles row handle='chatgpt' that MUST be deleted;
 *   - an assistant_tag_alias row alias='chatgpt' that MUST be deleted;
 *   - a control handle='openai' that MUST survive (only the retired flat token
 *     is removed — the OpenAI assistant is @openai);
 *   - the immutable builtin alias='cinatra' that MUST survive.
 * Then proves idempotency (a second run is a no-op) and a NO-OP on a clean DB
 * that never had a `chatgpt` row.
 *
 * Gated by CINATRA_DB_INTEGRATION_TESTS=1 + a live SUPABASE_DB_URL (same
 * contract as the sibling integration/** suites; excluded from the default run).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connect, createTestSchema, dropSchema } from "./_fixture";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

type Mod = {
  buildUpSql: (schema?: string) => string[];
  buildPostconditionSql: (schema?: string) => string;
  RETIRED_HANDLE: string;
};

let mod: Mod;
let client: Client;
let schema: string;

async function seedHandle(sch: string, userId: string, handle: string): Promise<void> {
  await client.query(
    `INSERT INTO "${sch}"."assistant_handles" (assistant_user_id, handle, origin)
     VALUES ($1, $2, 'standalone')`,
    [userId, handle],
  );
}

async function seedAlias(sch: string, alias: string, source: string): Promise<void> {
  await client.query(
    `INSERT INTO "${sch}"."assistant_tag_alias" (alias, package_name, source)
     VALUES ($1, $2, $3)`,
    [alias, `@cinatra-ai/${alias}-assistant`, source],
  );
}

async function handleCount(sch: string, handle: string): Promise<number> {
  const r = await client.query(
    `SELECT count(*)::int AS n FROM "${sch}"."assistant_handles" WHERE handle = $1`,
    [handle],
  );
  return r.rows[0].n as number;
}

async function aliasCount(sch: string, alias: string): Promise<number> {
  const r = await client.query(
    `SELECT count(*)::int AS n FROM "${sch}"."assistant_tag_alias" WHERE alias = $1`,
    [alias],
  );
  return r.rows[0].n as number;
}

/** Apply the migration's queued statements inside ONE transaction (mirrors the
 *  node-pg-migrate single-transaction wrap). Throws on any statement error
 *  after ROLLBACK — the fail-loud-on-partial-apply contract. */
async function applyMigration(sch: string): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const sql of mod.buildUpSql(sch)) {
      await client.query(sql);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

beforeAll(async () => {
  mod = (await import(
    path.join(REPO_ROOT, "migrations", "core", "core__0083_retire-chatgpt-handle.mjs")
  )) as unknown as Mod;

  client = await connect();
  schema = await createTestSchema(client);

  // A persisted chatgpt handle + alias (the retired flat token), plus controls.
  await seedHandle(schema, "user-chatgpt", "chatgpt");
  await seedHandle(schema, "user-openai", "openai");
  await seedAlias(schema, "chatgpt", "admin");
  await seedAlias(schema, "cinatra", "builtin");

  await applyMigration(schema);
}, 60_000);

afterAll(async () => {
  if (client && schema) await dropSchema(client, schema);
  if (client) await client.end();
});

describe("core__0083 — the retired chatgpt token is removed", () => {
  it("exports the retired token as `chatgpt`", () => {
    expect(mod.RETIRED_HANDLE).toBe("chatgpt");
  });

  it("deletes the assistant_handles row handle='chatgpt'", async () => {
    expect(await handleCount(schema, "chatgpt")).toBe(0);
  });

  it("deletes the assistant_tag_alias row alias='chatgpt'", async () => {
    expect(await aliasCount(schema, "chatgpt")).toBe(0);
  });
});

describe("core__0083 — controls that MUST survive", () => {
  it("leaves the control handle='openai' untouched", async () => {
    expect(await handleCount(schema, "openai")).toBe(1);
  });

  it("leaves the immutable builtin alias='cinatra' untouched", async () => {
    expect(await aliasCount(schema, "cinatra")).toBe(1);
  });
});

describe("core__0083 — idempotency", () => {
  it("a second run is a no-op (no chatgpt rows, controls unchanged)", async () => {
    await applyMigration(schema);
    expect(await handleCount(schema, "chatgpt")).toBe(0);
    expect(await aliasCount(schema, "chatgpt")).toBe(0);
    expect(await handleCount(schema, "openai")).toBe(1);
    expect(await aliasCount(schema, "cinatra")).toBe(1);
  });
});

describe("core__0083 — clean-DB no-op", () => {
  it("runs cleanly on a schema that never had a chatgpt row (controls only)", async () => {
    const clean = await createTestSchema(client);
    try {
      await seedHandle(clean, "user-openai", "openai");
      await seedAlias(clean, "cinatra", "builtin");
      // Must not throw (the postcondition passes: zero chatgpt rows).
      await applyMigration(clean);
      expect(await handleCount(clean, "chatgpt")).toBe(0);
      expect(await aliasCount(clean, "chatgpt")).toBe(0);
      // Controls untouched.
      expect(await handleCount(clean, "openai")).toBe(1);
      expect(await aliasCount(clean, "cinatra")).toBe(1);
    } finally {
      await dropSchema(client, clean);
    }
  });
});
