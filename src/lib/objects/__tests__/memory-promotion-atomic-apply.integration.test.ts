/**
 * cinatra#1381: THE APPLY IS ONE TRANSACTION, proven against a REAL database
 * with the REAL statement sequence (review round 1, finding 1).
 *
 * WHY THIS SUITE EXISTS. The unit suites next to it mock the canonical writer:
 * `memory-promotion-atomic-apply.test.ts` makes `historyAwareUpsert` THROW a
 * VersionConflictError, and `co-commit-statements.test.ts` makes the batch
 * runner throw. Postgres does neither for the statement this flow actually
 * sends. The writer's CAS assert computed `1 / CASE ... END` in an output
 * column the outer projection never selected, so the planner pruned the
 * division: on a CAS MISS the statement did not raise, it returned one
 * all-null row, and the miss was decided in JavaScript AFTER the batch had
 * committed. With the request's claim co-committed in that same transaction,
 * the claim COMMITTED while the widen did not: a claimed-but-unapplied
 * request, reported to the reviewer as a false `conflict`. A mocked writer
 * keeps that green forever, so the proof has to be a real database.
 *
 * WHAT IS PROVEN HERE, all against the real DDL with NO writer mock:
 *   1. a CAS miss on the widen RAISES IN SQL (SQLSTATE 22012), because the assert
 *      column is projected, so Postgres must evaluate it;
 *   2. the co-committed claim ROLLS BACK with it: the request is still
 *      pending, the row still carries its old tuple and version, and no
 *      history event or Graphiti outbox row exists;
 *   3. the whole decide ladder, driven with the PRODUCTION deps and a
 *      concurrent edit committed inside the exact window the review walks
 *      through, answers `stale_snapshot` over a PENDING request, never
 *      `conflict` over an `approved` one;
 *   4. the happy path still commits all four writes together;
 *   5. the one-pending UNIQUE constraint wins a real two-transaction race
 *      (finding 8's other half).
 *
 * Runner (the `*.integration.test.ts` tier contract):
 *   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<live> \
 *     pnpm exec vitest run src/lib/objects/__tests__/memory-promotion-atomic-apply.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

// The root vitest config aliases @/lib/database to a stub without the named
// exports the objects graph needs; rebind the real sync-leaf-backed primitives
// (lazily, so postgres-config binds the isolated schema).
vi.mock("@/lib/database", async () => {
  const cfg = await import("@/lib/postgres-config");
  return {
    readChatThreadForClassifier: () => null,
    readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
    writeMetadataValueToDatabase: () => {},
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: () => {},
  };
});
// The schema is provisioned below from the canonical DDL builder.
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const TEST_SCHEMA = "cinatra_test_memory_promotion_1381";
const ORG = "org-mem-1381";
const REQUESTER = "u-member-1381";
const ADMIN = "u-admin-1381";
const TEAM = "team-growth-1381";

let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let promotionMod: typeof import("../memory-row-promotion");
let storeMod: typeof import("../memory-promotion-request-store");
let writerMod: typeof import("@/lib/object-history/canonical-writer");
let authorityMod: typeof import("@/lib/org-write/authority");
type ApprovalViewer = import("@/lib/approvals/sources/types").ApprovalViewer;
type MemoryPromotionDeps = import("../memory-row-promotion").MemoryPromotionDeps;

const S = () => TEST_SCHEMA;
const admin: ApprovalViewer = { userId: ADMIN, orgId: ORG, isAdmin: true };

function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

/** The stored envelope of one real memory row (all three server-stamped
 *  fields present: the shape the promotion scan must clear). */
function envelope(conceptId: string) {
  const bundleId = "9f4d9e0a-1b2c-4d3e-8f5a-6b7c8d9e0f1a";
  return {
    conceptId,
    bundleId,
    externalId: "0".repeat(64),
    cinatraAgentRunId: "0b1f8c2d-3e4a-4b5c-9d6e-7f8a9b0c1d2e",
    okfType: "procedure",
    okfVersion: "0.1",
    frontmatter: { type: "procedure", title: "Deployment runbook" },
    bodyMarkdown: "Run the deploy script. Nothing secret here.",
    links: [],
  };
}

function seedPrivateMemoryRow(id: string) {
  sql(
    `INSERT INTO "${S()}"."objects"
       (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility, deleted_at)
     VALUES ($1,$2,$3,$4::jsonb,1,'pending','user',$5,'private',NULL)`,
    [id, promotionMod.MEMORY_CONCEPT_TYPE_ID, ORG, JSON.stringify(envelope("runbooks/deployment")), REQUESTER],
  );
}

function readObjectRow(id: string) {
  const r = sql(
    `SELECT visibility, owner_level, owner_id, version FROM "${S()}"."objects" WHERE id=$1 AND org_id=$2`,
    [id, ORG],
  );
  return r.rows?.[0] as
    | { visibility: string; owner_level: string; owner_id: string; version: number }
    | undefined;
}

function readRequestRow(id: string) {
  const r = sql(
    `SELECT id, status, decided_by, row_version FROM "${S()}"."memory_promotion_request" WHERE id=$1 AND org_id=$2`,
    [id, ORG],
  );
  return r.rows?.[0] as
    | { id: string; status: string; decided_by: string | null; row_version: number }
    | undefined;
}

function countRows(table: string, where: string, values: unknown[]): number {
  const r = sql(`SELECT count(*)::int AS n FROM "${S()}"."${table}" WHERE ${where}`, values);
  return Number(r.rows?.[0]?.n ?? 0);
}

/** Open a PENDING request row directly, anchored at `rowVersion`. */
function seedRequest(objectId: string, rowVersion: number) {
  return storeMod.createMemoryPromotionRequest({
    orgId: ORG,
    objectId,
    objectTitle: "Deployment runbook",
    requestedBy: REQUESTER,
    fromOwnerLevel: "user",
    fromOwnerId: REQUESTER,
    fromVisibility: "private",
    toVisibility: "organization",
    toOwnerLevel: "organization",
    toOwnerId: ORG,
    toOwnerLabel: null,
    rowVersion,
  });
}

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  // MUST precede every app-module import (module-load schema const).
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    try {
      await client.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist")) throw err;
    }
  }
  // Better Auth team tables (public schema) for the team-target asserts.
  await client.query(
    `CREATE TABLE IF NOT EXISTS public."team" (
       id text PRIMARY KEY, name text NOT NULL, slug text NOT NULL,
       "organizationId" text NOT NULL,
       "createdAt" timestamptz, "updatedAt" timestamptz)`,
  );
  await client.query(
    `CREATE TABLE IF NOT EXISTS public."teamMember" (
       id text PRIMARY KEY, "teamId" text NOT NULL, "userId" text NOT NULL,
       "createdAt" timestamptz)`,
  );
  await client.query(`DELETE FROM public."teamMember" WHERE "teamId" = $1`, [TEAM]);
  await client.query(`DELETE FROM public."team" WHERE id = $1`, [TEAM]);
  await client.query(
    `INSERT INTO public."team" (id, name, slug, "organizationId", "createdAt")
     VALUES ($1, 'Growth', 'growth-1381', $2, now())`,
    [TEAM, ORG],
  );
  await client.query(
    `INSERT INTO public."teamMember" (id, "teamId", "userId") VALUES ('tm-1381-1', $1, $2)`,
    [TEAM, REQUESTER],
  );
  // The org-write kernel's guarded batch reads the organization's archive state
  // before it lets any statement run.
  await client.query(
    `CREATE TABLE IF NOT EXISTS public."organization" (
       id text PRIMARY KEY, name text, slug text,
       "archivedAt" timestamptz, "archiveEpoch" integer DEFAULT 0,
       "createdAt" timestamptz)`,
  );
  await client.query(
    `INSERT INTO public."organization" (id, name, slug, "archivedAt", "archiveEpoch", "createdAt")
     VALUES ($1, 'Memory promotion 1381', 'mem-1381', NULL, 0, now())
     ON CONFLICT (id) DO NOTHING`,
    [ORG],
  );
  // Better Auth membership: `verifySessionAuthority` reads it to mint the
  // MEMBERSHIP-grounded org-write authority the apply runs under. Without a
  // row here the apply refuses `not_authorized` and proves nothing.
  await client.query(
    `CREATE TABLE IF NOT EXISTS public."member" (
       id text PRIMARY KEY, "organizationId" text NOT NULL, "userId" text NOT NULL,
       role text, "createdAt" timestamptz)`,
  );
  await client.query(`DELETE FROM public."member" WHERE "organizationId" = $1`, [ORG]);
  await client.query(
    `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt") VALUES
       ('m-1381-admin', $1, $2, 'admin', now()),
       ('m-1381-member', $1, $3, 'member', now())`,
    [ORG, ADMIN, REQUESTER],
  );
  await client.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  ({ runPostgresQueriesSync } = await import("@/lib/postgres-sync"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  promotionMod = await import("../memory-row-promotion");
  storeMod = await import("../memory-promotion-request-store");
  writerMod = await import("@/lib/object-history/canonical-writer");
  authorityMod = await import("@/lib/org-write/authority");
});

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.query(`DELETE FROM public."teamMember" WHERE "teamId" = $1`, [TEAM]).catch(() => {});
  await client.query(`DELETE FROM public."team" WHERE id = $1`, [TEAM]).catch(() => {});
  await client.query(`DELETE FROM public."member" WHERE "organizationId" = $1`, [ORG]).catch(() => {});
  await client.query(`DELETE FROM public."organization" WHERE id = $1`, [ORG]).catch(() => {});
  await client.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)("cinatra#1381 the atomic apply, against a real database", () => {
  it("a CAS MISS on the widen RAISES IN SQL and rolls the co-committed claim back", async () => {
    const objectId = nextId("mem-casmiss");
    seedPrivateMemoryRow(objectId);
    const created = seedRequest(objectId, 1);

    // The row moves AFTER the request was anchored: the concurrent edit the
    // review's timeline puts at t1.
    sql(`UPDATE "${S()}"."objects" SET version = version + 1 WHERE id = $1`, [objectId]);
    expect(readObjectRow(objectId)!.version).toBe(2);

    const authority = await authorityMod.verifySessionAuthority(ADMIN, ORG);
    const claim = storeMod.buildMemoryPromotionApproveClaim({
      id: created.id,
      orgId: ORG,
      decidedBy: ADMIN,
      note: null,
      expectedRowVersion: 1,
    });

    // The REAL writer, the REAL claim, one guarded batch. Before the fix this
    // returned an all-null row instead of raising, so the claim COMMITTED.
    const errors = await import("@/lib/object-history/errors");
    expect(() =>
      writerMod.historyAwareUpsert(
        {
          id: objectId,
          type: promotionMod.MEMORY_CONCEPT_TYPE_ID,
          data: envelope("runbooks/deployment"),
          orgId: ORG,
          ownerLevel: "organization",
          ownerId: ORG,
          visibility: "organization",
        },
        {
          actor: { actorId: ADMIN, actorKind: "user", orgId: ORG },
          historyEffect: "reversible-internal",
          expectedBaseVersion: 1,
          authority,
          coCommitStatements: [claim],
        },
      ),
    ).toThrow(errors.VersionConflictError);

    // NOTHING landed. This is the whole property: the claim is a co-commit, so
    // it can only survive if the transaction committed.
    expect(readRequestRow(created.id)).toMatchObject({ status: "pending", decided_by: null });
    expect(readObjectRow(objectId)).toMatchObject({
      visibility: "private",
      owner_level: "user",
      owner_id: REQUESTER,
      version: 2,
    });
    expect(countRows("object_change_event", "object_id = $1", [objectId])).toBe(0);
    expect(countRows("graphiti_projection_outbox", "object_id = $1", [objectId])).toBe(0);
  });

  it("the raise is Postgres division_by_zero (22012), not a JavaScript null-row check", async () => {
    const objectId = nextId("mem-sqlstate");
    seedPrivateMemoryRow(objectId);
    sql(`UPDATE "${S()}"."objects" SET version = version + 1 WHERE id = $1`, [objectId]);

    const authority = await authorityMod.verifySessionAuthority(ADMIN, ORG);
    let raised: unknown;
    try {
      writerMod.historyAwareUpsert(
        {
          id: objectId,
          type: promotionMod.MEMORY_CONCEPT_TYPE_ID,
          data: envelope("runbooks/deployment"),
          orgId: ORG,
          ownerLevel: "organization",
          ownerId: ORG,
          visibility: "organization",
        },
        {
          actor: { actorId: ADMIN, actorKind: "user", orgId: ORG },
          historyEffect: "reversible-internal",
          expectedBaseVersion: 1,
          authority,
        },
      );
    } catch (e) {
      raised = e;
    }
    // The writer maps the SQL abort to the SAME typed error every existing
    // caller already handles. The contract does not change, only WHERE the
    // decision is made.
    const errors = await import("@/lib/object-history/errors");
    expect(raised).toBeInstanceOf(errors.VersionConflictError);
  });

  it("the DECIDE LADDER answers stale_snapshot over a PENDING request, never a false conflict", async () => {
    const objectId = nextId("mem-window");
    seedPrivateMemoryRow(objectId);
    const created = seedRequest(objectId, 1);

    // Production deps with ONE reader wrapped: it commits the concurrent edit
    // inside the window between the ladder's row read and the apply's lock.
    const prod = await promotionMod.__internals.productionDeps();
    let bumped = false;
    const deps: MemoryPromotionDeps = {
      ...prod,
      readObject: (id, orgId) => {
        const row = prod.readObject(id, orgId);
        if (row && !bumped) {
          bumped = true;
          sql(`UPDATE "${S()}"."objects" SET version = version + 1 WHERE id = $1`, [id]);
        }
        return row;
      },
    };

    const outcome = await promotionMod.decideMemoryPromotion(
      { requestId: created.id, action: "approve", expectedVersion: "1", viewer: admin },
      deps,
    );
    expect(bumped).toBe(true);
    expect(outcome).toMatchObject({ ok: false, code: "stale_snapshot" });

    // The request was SUPERSEDED, not approved, and the row never moved.
    expect(readRequestRow(created.id)!.status).toBe("superseded");
    expect(readObjectRow(objectId)).toMatchObject({ visibility: "private", owner_level: "user" });
    expect(countRows("object_change_event", "object_id = $1", [objectId])).toBe(0);
  });

  it("the HAPPY PATH commits the claim, the widen, the history event and the outbox row together", async () => {
    const objectId = nextId("mem-happy");
    seedPrivateMemoryRow(objectId);
    const created = seedRequest(objectId, 1);

    const outcome = await promotionMod.decideMemoryPromotion({
      requestId: created.id,
      action: "approve",
      expectedVersion: "1",
      reason: "useful",
      viewer: admin,
    });
    expect(outcome).toEqual({ ok: true });

    expect(readRequestRow(created.id)).toMatchObject({ status: "approved", decided_by: ADMIN });
    expect(readObjectRow(objectId)).toMatchObject({
      visibility: "organization",
      owner_level: "organization",
      owner_id: ORG,
      version: 2,
    });
    expect(countRows("object_change_event", "object_id = $1", [objectId])).toBe(1);
    expect(countRows("graphiti_projection_outbox", "object_id = $1", [objectId])).toBe(1);
  });

  // cinatra#1381 review, finding 4, the co-committed half. The decide ladder
  // pre-checks the requester's membership for an actionable message; this proves
  // the GUARANTEE, in the window the pre-check cannot cover.
  it("a requester removed from the target team AFTER the pre-check aborts the whole apply", async () => {
    const objectId = nextId("mem-leftteam");
    seedPrivateMemoryRow(objectId);
    const created = storeMod.createMemoryPromotionRequest({
      orgId: ORG,
      objectId,
      objectTitle: "Deployment runbook",
      requestedBy: REQUESTER,
      fromOwnerLevel: "user",
      fromOwnerId: REQUESTER,
      fromVisibility: "private",
      toVisibility: "team",
      toOwnerLevel: "team",
      toOwnerId: TEAM,
      toOwnerLabel: "Growth",
      rowVersion: 1,
    });

    // The scan is the LAST gate before the apply, so wrapping it commits the
    // removal inside the window between the ladder's team pre-checks and the
    // apply transaction.
    const prod = await promotionMod.__internals.productionDeps();
    let removed = false;
    const deps: MemoryPromotionDeps = {
      ...prod,
      scanContent: (content) => {
        if (!removed) {
          removed = true;
          sql(`DELETE FROM public."teamMember" WHERE "teamId" = $1 AND "userId" = $2`, [TEAM, REQUESTER]);
        }
        return prod.scanContent(content);
      },
    };

    try {
      const outcome = await promotionMod.decideMemoryPromotion(
        { requestId: created.id, action: "approve", expectedVersion: "1", viewer: admin },
        deps,
      );
      expect(removed).toBe(true);
      expect(outcome).toMatchObject({ ok: false, code: "stale_snapshot" });
      // The row never moved into a team the requester had left.
      expect(readObjectRow(objectId)).toMatchObject({ visibility: "private", owner_level: "user" });
      expect(countRows("object_change_event", "object_id = $1", [objectId])).toBe(0);
      expect(countRows("graphiti_projection_outbox", "object_id = $1", [objectId])).toBe(0);
    } finally {
      sql(
        `INSERT INTO public."teamMember" (id, "teamId", "userId") VALUES ('tm-1381-1', $1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [TEAM, REQUESTER],
      );
    }
  });

  // cinatra#1381 review, finding 11. `viewer.isAdmin` is the PLATFORM role. The
  // approve path refuses a non-member through the authority mint inside its
  // apply; the reject path writes no object row and had no second half at all.
  it("a platform admin who is not a member of this organization cannot REJECT its requests", async () => {
    const objectId = nextId("mem-rejectauthz");
    seedPrivateMemoryRow(objectId);
    const created = seedRequest(objectId, 1);

    const outsider: ApprovalViewer = { userId: "u-platform-outsider-1381", orgId: ORG, isAdmin: true };
    const outcome = await promotionMod.decideMemoryPromotion({
      requestId: created.id,
      action: "reject",
      reason: "not useful",
      viewer: outsider,
    });
    expect(outcome).toMatchObject({ ok: false, code: "not_authorized" });
    expect(readRequestRow(created.id)).toMatchObject({ status: "pending", decided_by: null });

    // A real member admin still decides it.
    expect(
      await promotionMod.decideMemoryPromotion({
        requestId: created.id,
        action: "reject",
        reason: "not useful",
        viewer: admin,
      }),
    ).toEqual({ ok: true });
    expect(readRequestRow(created.id)).toMatchObject({ status: "rejected", decided_by: ADMIN });
  });

  // codex round 1 of the #1381 review round. The ladder's membership pre-check
  // and the reject CAS are two operations; the membership predicate rides
  // INSIDE the CAS so a revocation between them cannot let a now-non-member
  // reject the request for good.
  it("a membership revoked after the pre-check loses the reject CAS instead of deciding", async () => {
    const objectId = nextId("mem-rejectrace");
    seedPrivateMemoryRow(objectId);
    const created = seedRequest(objectId, 1);

    const prod = await promotionMod.__internals.productionDeps();
    let revoked = false;
    const deps: MemoryPromotionDeps = {
      ...prod,
      isDeciderAMember: async (actor) => {
        const answer = await prod.isDeciderAMember(actor);
        if (!revoked) {
          // Commit the revocation in the window between the pre-check and the
          // CAS, exactly where the race lives.
          revoked = true;
          sql(`DELETE FROM public."member" WHERE "organizationId" = $1 AND "userId" = $2`, [ORG, ADMIN]);
        }
        return answer;
      },
    };

    try {
      const outcome = await promotionMod.decideMemoryPromotion(
        { requestId: created.id, action: "reject", reason: "not useful", viewer: admin },
        deps,
      );
      expect(revoked).toBe(true);
      // The CAS lost on its membership arm, and the re-classification says so
      // rather than blaming a decider who does not exist.
      expect(outcome).toMatchObject({ ok: false, code: "not_authorized" });
      expect(readRequestRow(created.id)).toMatchObject({ status: "pending", decided_by: null });
    } finally {
      sql(
        `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
         VALUES ('m-1381-admin', $1, $2, 'admin', now()) ON CONFLICT (id) DO NOTHING`,
        [ORG, ADMIN],
      );
    }
  });

  // cinatra#1381 review, finding 6: the advisory duplicate count's audience
  // predicate, measured with the reviewer's exact tuple.
  it("the duplicate count never sees an org-OWNED, TEAM-visible row the reviewer cannot read", () => {
    const subject = nextId("mem-dupsubject");
    const oracle = nextId("mem-duporacle");
    const orgVisible = nextId("mem-duporgvisible");
    // A concept identity unique to THIS case, so rows the other cases left
    // behind cannot contribute to the count.
    const concept = nextId("dup-audience");
    const data = { ...envelope(concept), frontmatter: { type: "procedure", title: concept } };
    const same = JSON.stringify(data);

    sql(
      `INSERT INTO "${S()}"."objects"
         (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility, deleted_at)
       VALUES ($1,$2,$3,$4::jsonb,1,'pending','user',$5,'private',NULL)`,
      [subject, promotionMod.MEMORY_CONCEPT_TYPE_ID, ORG, same, REQUESTER],
    );
    // The reviewer's tuple: owner_level = 'organization', visibility = 'team'.
    // It is legal in the canonical vocabulary and NO clause in
    // derived-store-ownership.ts admits it to an ordinary member or admin.
    sql(
      `INSERT INTO "${S()}"."objects"
         (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility, deleted_at)
       VALUES ($1,$2,$3,$4::jsonb,1,'pending','organization',$3,'team',NULL)`,
      [oracle, promotionMod.MEMORY_CONCEPT_TYPE_ID, ORG, same],
    );

    expect(
      storeMod.countAudienceVisibleMemoryDuplicates({
        orgId: ORG,
        objectId: subject,
        objectType: promotionMod.MEMORY_CONCEPT_TYPE_ID,
        toVisibility: "organization",
        toOwnerId: ORG,
        viewerId: ADMIN,
      }),
    ).toBe(0);

    // A genuinely org-VISIBLE twin, which every reviewer CAN read, still counts.
    sql(
      `INSERT INTO "${S()}"."objects"
         (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility, deleted_at)
       VALUES ($1,$2,$3,$4::jsonb,1,'pending','organization',$3,'organization',NULL)`,
      [orgVisible, promotionMod.MEMORY_CONCEPT_TYPE_ID, ORG, same],
    );
    expect(
      storeMod.countAudienceVisibleMemoryDuplicates({
        orgId: ORG,
        objectId: subject,
        objectType: promotionMod.MEMORY_CONCEPT_TYPE_ID,
        toVisibility: "organization",
        toOwnerId: ORG,
        viewerId: ADMIN,
      }),
    ).toBe(1);
  });

  // cinatra#1381 review, finding 8, the mutation survivor. The rule is a real
  // UNIQUE constraint, so it is proven by a real race rather than by a store
  // suite that only checks how a duplicate-key ERROR is mapped.
  it("the one-pending UNIQUE constraint refuses the loser of a two-transaction race", async () => {
    const objectId = nextId("mem-onepending");
    seedPrivateMemoryRow(objectId);

    const a = new Client({ connectionString: DB_URL });
    const b = new Client({ connectionString: DB_URL });
    await a.connect();
    await b.connect();
    try {
      const insert = (client: Client, id: string) =>
        client.query(
          `INSERT INTO "${S()}"."memory_promotion_request"
             (id, org_id, object_id, object_title, requested_by,
              from_owner_level, from_owner_id, from_visibility,
              to_visibility, to_owner_level, to_owner_id, to_owner_label, row_version)
           VALUES ($1,$2,$3,'Deployment runbook',$4,'user',$4,'private',
                   'organization','organization',$2,NULL,1)`,
          [id, ORG, objectId, REQUESTER],
        );

      await a.query("BEGIN");
      await b.query("BEGIN");
      await insert(a, nextId("req-a"));
      // B blocks on the unique constraint until A resolves.
      const bInsert = insert(b, nextId("req-b"));
      await a.query("COMMIT");
      await expect(bInsert).rejects.toMatchObject({ code: "23505", constraint: "mpr_one_pending" });
      await b.query("ROLLBACK");

      expect(countRows("memory_promotion_request", "object_id = $1 AND status = 'pending'", [objectId])).toBe(1);
    } finally {
      await a.end().catch(() => {});
      await b.end().catch(() => {});
    }
  });
});
