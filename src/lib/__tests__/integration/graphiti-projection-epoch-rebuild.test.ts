/**
 * cinatra#1427 ACs 4-5 — projection-policy epoch + durable epoch-fenced group
 * rebuild, REAL-DB integration (no mocks on the DDL / SQL path). Executes the
 * projector/rebuild SQL BUILDERS against a fresh per-test schema:
 *
 *   1. epoch bump consumer — draining a claim-change 're-projection' queue
 *      row bumps ONLY groups that actually hold rows of the changed type
 *      (scope-gated), opens the group's single rebuild journal at 'clearing',
 *      and leaves 'binding-reconcile' rows untouched;
 *   2. epoch FOLD — a second bump folds into the one open journal (epoch
 *      advances, foldCount increments, still ONE open journal);
 *   3. replay batch + KILL-RESUME — batches enqueue epoch-STAMPED outbox
 *      items behind the source gate; the checkpoint moves atomically with the
 *      batch, so a re-run continues from the cursor with ZERO duplicate
 *      enqueues, and the exhausted enumeration enqueues nothing (AC-4);
 *   4. stale-epoch FENCE — an outbox item stamped with an epoch older than the
 *      group's current epoch is the one the worker discards (the column +
 *      policy table interact as designed);
 *   5. ROLLBACK — opens a NEW fenced rebuild at a monotonically HIGHER epoch
 *      with rollback provenance (AC-5).
 *
 * Guarded by `describe.skipIf(!HAS_REAL_DB)` like the sibling suites: CI
 * without a reachable Postgres emits zero failures. Fresh schema per file.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import { connect, createTestSchema, dropSchema, insertObject } from "./_fixture";
import {
  buildEpochBumpQuery,
  buildReplayBatchQuery,
  buildOpenRollbackRebuildQuery,
} from "@cinatra-ai/objects/graphiti-rebuild";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");

describe.skipIf(!HAS_REAL_DB)("cinatra#1427 projection-policy epoch + rebuild (real DB)", () => {
  let client: Client;
  let schema: string;

  beforeAll(async () => {
    client = await connect();
    schema = await createTestSchema(client);
  });

  afterAll(async () => {
    if (client && schema) await dropSchema(client, schema);
    await client?.end().catch(() => {});
  });

  async function enqueueReProjection(over: { scope: string; objectTypeId: string; kind?: string }): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO "${schema}"."artifact_binding_reconcile_queue"
         (id, scope, object_type_id, claim_event_id, kind, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [id, over.scope, over.objectTypeId, randomUUID(), over.kind ?? "re-projection"],
    );
    return id;
  }

  async function seedObject(orgId: string, type: string, id: string): Promise<void> {
    await insertObject(client, schema, {
      id,
      type,
      orgId,
      ownerLevel: "organization",
      ownerId: orgId,
      visibility: "organization",
    });
  }

  const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> =>
    (await client.query(text, values)).rows as T[];

  async function runBuilder(builder: { text: string; values?: unknown[] }): Promise<Record<string, unknown>[]> {
    return (await client.query(builder.text, builder.values ?? [])).rows;
  }

  // -------------------------------------------------------------------------

  it("epoch bump: scope-gated, opens one journal, leaves binding-reconcile rows alone", async () => {
    const org = "org-bump";
    const TYPE = `@cinatra-ai/test:${org}`;
    const TYPE_NO_ROWS = `@cinatra-ai/test:${org}-norows`;
    await seedObject(org, TYPE, "obj-bump-1");
    await seedObject(org, TYPE, "obj-bump-2");
    // A claim change over a type with rows, a claim change over a type with NO
    // rows, and a binding-reconcile row that must NOT be consumed here.
    await enqueueReProjection({ scope: "platform", objectTypeId: TYPE });
    await enqueueReProjection({ scope: "platform", objectTypeId: TYPE_NO_ROWS });
    const bindingRow = await enqueueReProjection({ scope: "platform", objectTypeId: TYPE, kind: "binding-reconcile" });

    const [out] = await runBuilder(buildEpochBumpQuery(schema, 200));
    // Both re-projection rows drained; the binding-reconcile row is a different consumer's.
    expect(Number(out.consumed)).toBe(2);
    const bumps = out.bumps as Array<{ groupId: string; toEpoch: number }>;
    // Only the group that actually holds rows of a changed type is bumped.
    expect(bumps).toEqual([{ groupId: `cinatra-org-${org}`, toEpoch: 2 }]);

    const policy = await q<{ epoch: number }>(
      `SELECT epoch FROM "${schema}"."graphiti_projection_policy" WHERE group_id = $1`,
      [`cinatra-org-${org}`],
    );
    expect(Number(policy[0].epoch)).toBe(2);

    const journals = await q<{ phase: string; from_epoch: number; to_epoch: number; reason: Record<string, unknown> }>(
      `SELECT phase, from_epoch, to_epoch, reason FROM "${schema}"."graphiti_rebuild_journal" WHERE group_id = $1`,
      [`cinatra-org-${org}`],
    );
    expect(journals).toHaveLength(1);
    expect(journals[0].phase).toBe("clearing");
    expect(Number(journals[0].from_epoch)).toBe(1);
    expect(Number(journals[0].to_epoch)).toBe(2);
    expect(journals[0].reason.kind).toBe("claim-change");

    // The binding-reconcile row is still pending (not this consumer's work).
    const binding = await q<{ status: string }>(
      `SELECT status FROM "${schema}"."artifact_binding_reconcile_queue" WHERE id = $1`,
      [bindingRow],
    );
    expect(binding[0].status).toBe("pending");
  });

  it("epoch FOLD: a second bump folds into the one open journal (epoch advances, still one open)", async () => {
    const org = "org-fold";
    const TYPE = `@cinatra-ai/test:${org}`;
    await seedObject(org, TYPE, "obj-fold-1");
    await enqueueReProjection({ scope: "platform", objectTypeId: TYPE });
    await runBuilder(buildEpochBumpQuery(schema, 200)); // epoch 1 → 2, journal open

    await enqueueReProjection({ scope: "platform", objectTypeId: TYPE });
    const [out] = await runBuilder(buildEpochBumpQuery(schema, 200)); // epoch 2 → 3, fold
    const bumps = out.bumps as Array<{ groupId: string; toEpoch: number }>;
    expect(bumps).toEqual([{ groupId: `cinatra-org-${org}`, toEpoch: 3 }]);

    const open = await q<{ to_epoch: number; phase: string; reason: Record<string, unknown> }>(
      `SELECT to_epoch, phase, reason FROM "${schema}"."graphiti_rebuild_journal"
       WHERE group_id = $1 AND phase <> 'done'`,
      [`cinatra-org-${org}`],
    );
    expect(open).toHaveLength(1); // still exactly ONE open journal
    expect(Number(open[0].to_epoch)).toBe(3);
    expect(open[0].phase).toBe("clearing"); // fold resets to clearing
    expect(Number(open[0].reason.foldCount)).toBe(1);
  });

  it("replay batch + KILL-RESUME: epoch-stamped enqueues, atomic cursor, zero duplicates", async () => {
    const org = "org-replay";
    const TYPE = `@cinatra-ai/test:${org}`;
    const ids = ["obj-r-01", "obj-r-02", "obj-r-03"];
    for (const id of ids) await seedObject(org, TYPE, id);
    const journalId = randomUUID();
    await client.query(
      `INSERT INTO "${schema}"."graphiti_rebuild_journal"
         (id, group_id, org_id, from_epoch, to_epoch, phase, checkpoint, reason)
       VALUES ($1, $2, $3, 1, 2, 'replaying', jsonb_build_object('lastObjectId', NULL, 'enqueued', 0), '{}'::jsonb)`,
      [journalId, `cinatra-org-${org}`, org],
    );

    // Batch 1 (size 2): enqueues obj-r-01, obj-r-02; cursor → obj-r-02.
    const b1 = buildReplayBatchQuery(schema, { journalId, toEpoch: 2, batchSize: 2 });
    const r1 = await client.query(b1.text, b1.values);
    expect(r1.rowCount).toBeGreaterThan(0);

    const after1 = await q<{ checkpoint: { lastObjectId: string; enqueued: number } }>(
      `SELECT checkpoint FROM "${schema}"."graphiti_rebuild_journal" WHERE id = $1`,
      [journalId],
    );
    expect(after1[0].checkpoint.lastObjectId).toBe("obj-r-02");
    expect(after1[0].checkpoint.enqueued).toBe(2);

    // KILL-RESUME: re-run from the persisted cursor → enqueues ONLY obj-r-03.
    const b2 = buildReplayBatchQuery(schema, { journalId, toEpoch: 2, batchSize: 2 });
    await client.query(b2.text, b2.values);

    // Exhaustion: a third run enqueues nothing (rowCount 0).
    const b3 = buildReplayBatchQuery(schema, { journalId, toEpoch: 2, batchSize: 2 });
    const r3 = await client.query(b3.text, b3.values);
    expect(r3.rowCount).toBe(0);

    // Every object enqueued EXACTLY once, all stamped with the target epoch.
    const outbox = await q<{ object_id: string; projection_epoch: number }>(
      `SELECT object_id, projection_epoch FROM "${schema}"."graphiti_projection_outbox"
       WHERE org_id = $1 ORDER BY object_id`,
      [org],
    );
    expect(outbox.map((r) => r.object_id)).toEqual(ids); // exactly {01,02,03}, no dupes
    expect(outbox.every((r) => Number(r.projection_epoch) === 2)).toBe(true);

    const after3 = await q<{ checkpoint: { enqueued: number } }>(
      `SELECT checkpoint FROM "${schema}"."graphiti_rebuild_journal" WHERE id = $1`,
      [journalId],
    );
    expect(after3[0].checkpoint.enqueued).toBe(3);
  });

  it("replay EXCLUDES non-ambient memory (nested + skip) but KEEPS ambient-scoped memory (#1379)", async () => {
    const org = "org-mem-excl";
    const TYPE = `@cinatra-ai/test:${org}`;
    const MEM = "@cinatra-ai/memory:concept";
    // A normal ambient row + memory rows across every class:
    //  - obj-mem-user   : user-private   → per-user NESTED lane   → EXCLUDE
    //  - obj-mem-team   : team-owned     → per-team NESTED lane   → EXCLUDE
    //  - obj-mem-proj   : org + project  → `-proj-` NESTED lane   → EXCLUDE
    //  - obj-mem-public : public         → terminal SKIP (no episode) → EXCLUDE
    //    (keeping it would inflate `expected` with no matching episode → diverge)
    //  - obj-mem-org    : org-scoped     → the AMBIENT base lane clearGraph DID
    //    clear → must be REPLAYED like any ambient row (excluding it would strand
    //    that episode unprojected — the codex-caught regression).
    await seedObject(org, TYPE, "obj-normal");
    await insertObject(client, schema, {
      id: "obj-mem-user", type: MEM, orgId: org,
      ownerLevel: "user", ownerId: "user-42", visibility: "private",
    });
    await insertObject(client, schema, {
      id: "obj-mem-team", type: MEM, orgId: org,
      ownerLevel: "team", ownerId: "team-7", visibility: "team",
    });
    await insertObject(client, schema, {
      id: "obj-mem-proj", type: MEM, orgId: org,
      ownerLevel: "organization", ownerId: org, visibility: "organization", projectId: "proj-9",
    });
    await insertObject(client, schema, {
      id: "obj-mem-public", type: MEM, orgId: org,
      ownerLevel: "user", ownerId: "user-42", visibility: "public",
    });
    await insertObject(client, schema, {
      id: "obj-mem-org", type: MEM, orgId: org,
      ownerLevel: "organization", ownerId: org, visibility: "organization",
    });
    const journalId = randomUUID();
    await client.query(
      `INSERT INTO "${schema}"."graphiti_rebuild_journal"
         (id, group_id, org_id, from_epoch, to_epoch, phase, checkpoint, reason)
       VALUES ($1, $2, $3, 1, 2, 'replaying', jsonb_build_object('lastObjectId', NULL, 'enqueued', 0), '{}'::jsonb)`,
      [journalId, `cinatra-org-${org}`, org],
    );

    const b = buildReplayBatchQuery(schema, { journalId, toEpoch: 2, batchSize: 50 });
    await client.query(b.text, b.values);
    // A second run reaches exhaustion (rowCount 0) despite the excluded memory
    // rows still existing past the cursor — the exhaustion predicate excludes
    // exactly the same set.
    const b2 = buildReplayBatchQuery(schema, { journalId, toEpoch: 2, batchSize: 50 });
    const r2 = await client.query(b2.text, b2.values);
    expect(r2.rowCount).toBe(0);

    const outbox = await q<{ object_id: string }>(
      `SELECT object_id FROM "${schema}"."graphiti_projection_outbox" WHERE org_id = $1 ORDER BY object_id`,
      [org],
    );
    // Ambient row + ambient-scoped memory replayed; nested + public memory are not.
    expect(outbox.map((r) => r.object_id)).toEqual(["obj-mem-org", "obj-normal"]);
  });

  it("stale-epoch FENCE: only the item stamped below the group's epoch is discarded", async () => {
    const org = "org-fence";
    const group = `cinatra-org-${org}`;
    await client.query(
      `INSERT INTO "${schema}"."graphiti_projection_policy" (group_id, epoch) VALUES ($1, 2)`,
      [group],
    );
    // A stale (epoch 1) item and a current (epoch 2) item, both pending.
    await client.query(
      `INSERT INTO "${schema}"."graphiti_projection_outbox"
         (id, object_id, object_version, org_id, operation, status, projection_epoch)
       VALUES ($1,'o-stale',1,$2,'upsert','pending',1), ($3,'o-current',1,$2,'upsert','pending',2)`,
      [randomUUID(), org, randomUUID()],
    );

    // The worker's fence predicate: discard stamped items below the current epoch.
    await client.query(
      `UPDATE "${schema}"."graphiti_projection_outbox" o
         SET status = 'done', last_error = 'stale-epoch item discarded'
       FROM "${schema}"."graphiti_projection_policy" p
       WHERE p.group_id = $1 AND o.org_id = $2 AND o.status = 'pending'
         AND o.projection_epoch IS NOT NULL AND o.projection_epoch < p.epoch`,
      [group, org],
    );

    const rows = await q<{ object_id: string; status: string }>(
      `SELECT object_id, status FROM "${schema}"."graphiti_projection_outbox" WHERE org_id = $1 ORDER BY object_id`,
      [org],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.object_id, r.status]));
    expect(byId["o-stale"]).toBe("done"); // fenced out
    expect(byId["o-current"]).toBe("pending"); // survives — worker will project it
  });

  it("ROLLBACK: opens a new fenced rebuild at a monotonically higher epoch", async () => {
    const org = "org-rollback";
    const group = `cinatra-org-${org}`;
    // Prior state: group at epoch 2 with a completed (done) journal.
    await client.query(
      `INSERT INTO "${schema}"."graphiti_projection_policy" (group_id, epoch) VALUES ($1, 2)`,
      [group],
    );
    await client.query(
      `INSERT INTO "${schema}"."graphiti_rebuild_journal"
         (id, group_id, org_id, from_epoch, to_epoch, phase, reason)
       VALUES ($1, $2, $3, 1, 2, 'done', '{"kind":"claim-change"}'::jsonb)`,
      [randomUUID(), group, org],
    );

    const [out] = await runBuilder(buildOpenRollbackRebuildQuery(schema, { groupId: group, orgId: org, rolledBackJournalId: "j-old" }));
    expect(Number(out.to_epoch)).toBe(3); // monotonic: 2 → 3, never decremented

    const policy = await q<{ epoch: number }>(
      `SELECT epoch FROM "${schema}"."graphiti_projection_policy" WHERE group_id = $1`,
      [group],
    );
    expect(Number(policy[0].epoch)).toBe(3);

    const openJournal = await q<{ phase: string; to_epoch: number; reason: Record<string, unknown> }>(
      `SELECT phase, to_epoch, reason FROM "${schema}"."graphiti_rebuild_journal"
       WHERE group_id = $1 AND phase <> 'done'`,
      [group],
    );
    expect(openJournal).toHaveLength(1);
    expect(openJournal[0].phase).toBe("clearing");
    expect(Number(openJournal[0].to_epoch)).toBe(3);
    expect(openJournal[0].reason.kind).toBe("rollback");
  });
});
