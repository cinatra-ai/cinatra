/**
 * Proof for the core__0060 guarded dynamic-types ENGINE teardown (owner ruling
 * 2026-07-18; epic cinatra#1785 entry 95; closes #1793):
 *
 *   migrations/core/core__0060_drop-dynamic-object-types.mjs
 *
 * The DB-gated suite runs the REAL migration up() through an owned-connection
 * pgm shim against a seeded schema and proves:
 *
 *   AC#4  boot green on a DB that NEVER had `dynamic_object_types` (no-op) AND
 *         on one MIGRATED from a populated table (dropped); re-run idempotent.
 *   legacy a table with the pre-historic `id`/`payload` shape (no `type` column)
 *         is dropped without the by-type guards erroring.
 *   AC#1  the migration REFUSES on each unmet precondition INDIVIDUALLY —
 *         (a) a non-retired claim over a dynamic type, (b) a pending/failed
 *         reconcile-queue row for a dynamic type, (c) an unfinished (incl.
 *         'processing') projection-outbox row for a dynamic-typed object — and
 *         runs CLEAN when all three pass. Completed history ('retired' claim,
 *         'done' queue/outbox) never blocks.
 *
 * The no-DB shape assertions always run; the DB suite self-skips without a real
 * SUPABASE_DB_URL (same contract as the sibling integration tests).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import path from "node:path";
import type { Client } from "pg";

// the migration module is plain ESM — import the real artifact, no copy
import {
  up as dropUp,
  down as dropDown,
} from "../../../../migrations/core/core__0060_drop-dynamic-object-types.mjs";
// The ledger every consumer sees is the manifest.json + manifest.d/ union.
import { readManifestUnion } from "../../../../migrations/manifest-reader.mjs";
import { connect, createTestSchema, dropSchema, insertObject } from "./_fixture";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused") &&
  !dbUrl.includes("build:build@127.0.0.1:5432/build");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DYNAMIC_TYPE = "@dynamic/types:competitor-profile";

/**
 * Run the migration's up() the way node-pg-migrate does: `pgm.sql(text)` QUEUES
 * a statement (synchronous, returns void); the runner then executes the queue in
 * order inside ONE transaction (all-or-nothing). The shim collects the queued
 * statements; we execute them awaited in a transaction so a guard RAISE rejects
 * (and rolls the whole migration back — the table is never half-dropped).
 */
async function runUp(client: Client, schema: string): Promise<void> {
  const stmts: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dropUp({ sql: (text: string) => stmts.push(text) } as any);
  await client.query(`SET search_path TO "${schema}"`);
  try {
    await client.query("BEGIN");
    try {
      for (const s of stmts) await client.query(s);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    await client.query(`SET search_path TO public`);
  }
}

async function tableExists(client: Client, schema: string): Promise<boolean> {
  const res = await client.query(`SELECT to_regclass($1) AS reg`, [`"${schema}"."dynamic_object_types"`]);
  return res.rows[0].reg != null;
}

/** CREATE the modern (post-bootstrap) `dynamic_object_types` shape + a row. */
async function createModernDynamicTable(client: Client, schema: string): Promise<void> {
  await client.query(`CREATE TABLE "${schema}"."dynamic_object_types" (
    type              text PRIMARY KEY,
    display_name      text NOT NULL,
    inferred_category text NOT NULL,
    slug              text,
    json_schema       jsonb,
    source            text,
    confidence        text,
    status            text NOT NULL DEFAULT 'proposed',
    created_at        timestamptz NOT NULL DEFAULT now(),
    created_by        text,
    promoted_to_type  text,
    identity_key      text,
    origin_context    jsonb
  )`);
  await client.query(
    `INSERT INTO "${schema}"."dynamic_object_types" (type, display_name, inferred_category, status)
       VALUES ($1, 'Competitor profile', 'profile', 'active')`,
    [DYNAMIC_TYPE],
  );
}

async function insertClaim(client: Client, schema: string, status: string): Promise<void> {
  await client.query(
    `INSERT INTO "${schema}"."artifact_type_claims"
       (id, scope, object_type_id, claim_kind, extension_package, extension_version, status)
     VALUES ('claim-1', 'org:org-1', $1, 'default', '@vendor/dyn-artifact', '1.0.0', $2)`,
    [DYNAMIC_TYPE, status],
  );
}

async function insertQueueRow(client: Client, schema: string, status: string): Promise<void> {
  // Claim-side row (kind 'binding-reconcile' requires claim_event_id per the
  // shape CHECK); object_type_id carries the dynamic type on BOTH axes.
  await client.query(
    `INSERT INTO "${schema}"."artifact_binding_reconcile_queue"
       (id, scope, object_type_id, claim_event_id, kind, status)
     VALUES ('q-1', 'org:org-1', $1, 'ce-1', 'binding-reconcile', $2)`,
    [DYNAMIC_TYPE, status],
  );
}

async function insertOutboxRow(client: Client, schema: string, objectId: string, status: string): Promise<void> {
  await client.query(
    `INSERT INTO "${schema}"."graphiti_projection_outbox"
       (id, object_id, object_version, operation, status)
     VALUES ('outbox-1', $1, 1, 'upsert', $2)`,
    [objectId, status],
  );
}

// ---------------------------------------------------------------------------
// Shape assertions (no DB needed).
// ---------------------------------------------------------------------------
describe("core__0060 — teardown shape (no DB)", () => {
  it("exports up() + a refusing down() (one-shot clean-break teardown)", async () => {
    expect(typeof dropUp).toBe("function");
    expect(typeof dropDown).toBe("function");
    expect(() => dropDown()).toThrow(/clean-break|backup/i);
  });

  it("ships its append-only ledger fragment (union ledger seq 0060, destructive)", () => {
    const { entries, errors } = readManifestUnion(path.join(REPO_ROOT, "migrations")) as {
      entries: Array<{ seq: string; file: string; destructive: boolean; tables: string[] }>;
      errors: string[];
    };
    expect(errors).toEqual([]);
    const entry = entries.find((m) => m.seq === "0060");
    expect(entry).toBeDefined();
    expect(entry?.file).toBe("core/core__0060_drop-dynamic-object-types.mjs");
    expect(entry?.destructive).toBe(true);
    expect(entry?.tables).toEqual(["dynamic_object_types"]);
  });
});

// ---------------------------------------------------------------------------
// DB-gated behavioral proof.
// ---------------------------------------------------------------------------
describe.skipIf(!hasDb)("core__0060 — real Postgres (DB-gated)", () => {
  let client: Client;
  let schema: string;

  beforeAll(async () => {
    client = await connect();
    schema = await createTestSchema(client);
  }, 30_000);

  afterAll(async () => {
    if (client && schema) await dropSchema(client, schema);
    if (client) await client.end();
  });

  // Clean slate before each case: drop the (possibly re-created) engine table
  // and clear the coupling tables the guards read.
  beforeEach(async () => {
    await client.query(`DROP TABLE IF EXISTS "${schema}"."dynamic_object_types"`);
    await client.query(`DELETE FROM "${schema}"."artifact_binding_reconcile_queue"`);
    await client.query(`DELETE FROM "${schema}"."artifact_type_claims"`);
    await client.query(`DELETE FROM "${schema}"."graphiti_projection_outbox"`);
    await client.query(`DELETE FROM "${schema}"."objects"`);
  });

  it("AC#4: a DB that NEVER had the table — up() is a clean no-op", async () => {
    expect(await tableExists(client, schema)).toBe(false);
    await expect(runUp(client, schema)).resolves.toBeUndefined();
    expect(await tableExists(client, schema)).toBe(false);
  });

  it("legacy id/payload-shaped table (no `type` column) — dropped without the by-type guards erroring", async () => {
    await client.query(`CREATE TABLE "${schema}"."dynamic_object_types" (id text PRIMARY KEY, payload jsonb)`);
    // A claim over the dynamic type exists, but the legacy table cannot be
    // referenced by type, so the guard is skipped and the drop proceeds.
    await insertClaim(client, schema, "active");
    await expect(runUp(client, schema)).resolves.toBeUndefined();
    expect(await tableExists(client, schema)).toBe(false);
  });

  it("AC#4: a populated table with all preconditions clear — dropped; re-run idempotent", async () => {
    await createModernDynamicTable(client, schema);
    expect(await tableExists(client, schema)).toBe(true);
    await runUp(client, schema);
    expect(await tableExists(client, schema)).toBe(false);
    // Second run: to_regclass is NULL — the guard is skipped, DROP IF EXISTS no-op.
    await expect(runUp(client, schema)).resolves.toBeUndefined();
  });

  it("AC#1(a): a NON-retired claim over a dynamic type REFUSES; the table survives", async () => {
    await createModernDynamicTable(client, schema);
    await insertClaim(client, schema, "active");
    await expect(runUp(client, schema)).rejects.toThrow(/precondition \(a\)/);
    expect(await tableExists(client, schema)).toBe(true);
  });

  it("AC#1(a): a RETIRED claim does NOT block — the table drops", async () => {
    await createModernDynamicTable(client, schema);
    await insertClaim(client, schema, "retired");
    await expect(runUp(client, schema)).resolves.toBeUndefined();
    expect(await tableExists(client, schema)).toBe(false);
  });

  it("AC#1(b): a PENDING reconcile-queue row for a dynamic type REFUSES", async () => {
    await createModernDynamicTable(client, schema);
    await insertQueueRow(client, schema, "pending");
    await expect(runUp(client, schema)).rejects.toThrow(/precondition \(b\)/);
    expect(await tableExists(client, schema)).toBe(true);
  });

  it("AC#1(b): a DONE queue row does NOT block — the table drops", async () => {
    await createModernDynamicTable(client, schema);
    await insertQueueRow(client, schema, "done");
    await expect(runUp(client, schema)).resolves.toBeUndefined();
    expect(await tableExists(client, schema)).toBe(false);
  });

  it("AC#1(c): a PROCESSING (in-flight) outbox row for a dynamic-typed object REFUSES", async () => {
    await createModernDynamicTable(client, schema);
    const objId = await insertObject(client, schema, {
      type: DYNAMIC_TYPE,
      orgId: "org-1",
      ownerLevel: "organization",
      ownerId: "org-1",
      visibility: "organization",
    });
    await insertOutboxRow(client, schema, objId, "processing");
    await expect(runUp(client, schema)).rejects.toThrow(/precondition \(c\)/);
    expect(await tableExists(client, schema)).toBe(true);
  });

  it("AC#1(c): a DONE outbox row does NOT block — the table drops", async () => {
    await createModernDynamicTable(client, schema);
    const objId = await insertObject(client, schema, {
      type: DYNAMIC_TYPE,
      orgId: "org-1",
      ownerLevel: "organization",
      ownerId: "org-1",
      visibility: "organization",
    });
    await insertOutboxRow(client, schema, objId, "done");
    await expect(runUp(client, schema)).resolves.toBeUndefined();
    expect(await tableExists(client, schema)).toBe(false);
  });

  it("AC#1: all preconditions satisfiable together (completed history only) — runs CLEAN", async () => {
    await createModernDynamicTable(client, schema);
    await insertClaim(client, schema, "retired");
    await insertQueueRow(client, schema, "done");
    const objId = await insertObject(client, schema, {
      type: DYNAMIC_TYPE,
      orgId: "org-1",
      ownerLevel: "organization",
      ownerId: "org-1",
      visibility: "organization",
    });
    await insertOutboxRow(client, schema, objId, "done");
    await expect(runUp(client, schema)).resolves.toBeUndefined();
    expect(await tableExists(client, schema)).toBe(false);
  });
});
