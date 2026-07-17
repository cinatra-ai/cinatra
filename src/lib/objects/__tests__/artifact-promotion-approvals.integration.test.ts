/**
 * cinatra#1437 — artifact row-scope promotion through the approvals area,
 * REAL-DB integration proof (AC-1 + the seeded-fixture halves of AC-2/AC-3).
 * Guarded by `describe.skipIf(!HAS_REAL_DB)` like the sibling artifact
 * integration suites: CI without a reachable Postgres emits zero failures and
 * zero noise; against the live verify stack it drives the WHOLE promotion
 * path over the real DDL with NO deps injection:
 *
 *   request surface (`requestArtifactPromotion`: actor-gated `getArtifact` +
 *   CAS-anchored request store INSERT) → the SHARED promotion ApprovalSource
 *   (`promotionRequestsSource.fetchInbox` — the same envelope the
 *   /notifications feed and `approvals_list` serve) → the shared source's
 *   `actions.decide` (the same dispatch the UI server action and
 *   `approvals_decide` call) → the production decide ladder → the REAL
 *   `historyAwareUpsert` widen (objects CAS write + `object_change_event`
 *   audit + `graphiti_projection_outbox` re-projection enqueue, one
 *   transaction).
 *
 * Proven here:
 *   AC-1  private artifact → promotion request → approvals inbox → approve →
 *         row widened + re-projection enqueued + audit row.
 *   AC-2  edit-after-request supersedes on the live CAS anchor; a rejection
 *         leaves the row untouched (and requires a reason at the shared
 *         source); the fail-closed secret scan refuses a SEEDED secret before
 *         any state is claimed.
 *   AC-3  never-narrow refused at REQUEST time against the live row.
 *   Plus the request-surface authz gate: a non-owner member cannot even
 *   OBSERVE a private row through the request surface (`not_found`, no probe
 *   oracle).
 *
 * ISOLATION (the #1430 snapshot suite's pattern): a FRESH schema provisioned
 * from the CANONICAL `buildCreateStoreSchemaQueries` DDL; every app module is
 * dynamically imported in `beforeAll` AFTER the env is set (postgresSchema is
 * a module-load const).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

// The root vitest config aliases @/lib/database to a stub without the named
// exports the artifact/objects graph needs; rebind the real sync-leaf-backed
// primitives (lazily, so postgres-config binds the isolated schema).
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
// The schema is provisioned below from the canonical DDL builder;
// short-circuit the app bootstrap (the #1490 binding-write-path pattern).
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const TEST_SCHEMA = "cinatra_test_artifact_promotion_1437";
const ORG = "org-promo-1437";
const OWNER = "u-owner-1437";
const ADMIN = "u-admin-1437";
const OTHER = "u-other-1437";

let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

// Dynamically-bound app modules (assigned in beforeAll AFTER env set).
let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let requestMod: typeof import("@/lib/artifacts/artifact-promotion-request");
let sourceMod: typeof import("@/app/configuration/approvals/sources/promotion-requests");
let artifactTypeMod: typeof import("@cinatra-ai/artifacts");
type ActorContext = import("@/lib/authz/actor-context").ActorContext;
type ApprovalViewer = import("@/app/configuration/approvals/sources/types").ApprovalViewer;

const S = () => TEST_SCHEMA;

function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

/** Seed a PRIVATE user-owned artifact row (the canonical artifact object
 *  type), version 1 — the AC-1 starting state. */
function seedPrivateArtifact(id: string, data: unknown) {
  sql(
    `INSERT INTO "${S()}"."objects"
       (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility, deleted_at)
     VALUES ($1,$2,$3,$4::jsonb,1,'pending','user',$5,'private',NULL)`,
    [id, artifactTypeMod.SEMANTIC_ARTIFACT_OBJECT_TYPE, ORG, JSON.stringify(data), OWNER],
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

function readRequestRow(objectId: string) {
  const r = sql(
    `SELECT id, status, decided_by, decision_note, row_version FROM "${S()}"."artifact_promotion_request"
     WHERE object_id=$1 AND org_id=$2 ORDER BY created_at DESC`,
    [objectId, ORG],
  );
  return r.rows?.[0] as
    | { id: string; status: string; decided_by: string | null; decision_note: string | null; row_version: number }
    | undefined;
}

function countRows(table: string, where: string, values: unknown[]): number {
  const r = sql(`SELECT count(*)::int AS n FROM "${S()}"."${table}" WHERE ${where}`, values);
  return Number(r.rows?.[0]?.n ?? 0);
}

const ownerActor: ActorContext = {
  principalType: "HumanUser",
  principalId: OWNER,
  organizationId: ORG,
  orgRole: "member",
  authSource: "mcp",
  policyVersion: "v2",
};
const otherActor: ActorContext = { ...ownerActor, principalId: OTHER };
const adminViewer: ApprovalViewer = { userId: ADMIN, orgId: ORG, isAdmin: true };

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  // MUST precede every app-module import (module-load schema const).
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.CINATRA_ARTIFACT_DATA_ROOT = mkdtempSync(path.join(tmpdir(), "cin-1437-"));

  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  // Provision from the CANONICAL DDL builder (anti-drift: never hand-rolled) —
  // includes the artifact_promotion_request DDL under test.
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    try {
      await client.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      // Same tolerance as the sibling suites: a handful of statements
      // reference seed/DO-block dependencies absent in a fresh empty schema.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist")) throw err;
    }
  }
  // Better Auth team tables (public schema) for the team-target path — the
  // production readTeamInOrgSync joins public."team" + public."teamMember".
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
  await client.query(`DELETE FROM public."teamMember"`);
  await client.query(`DELETE FROM public."team"`);
  await client.query(
    `INSERT INTO public."team" (id, name, slug, "organizationId") VALUES
       ('team-growth-1437', 'Growth', 'growth-1437', $1),
       ('team-foreign-1437', 'Foreign', 'foreign-1437', 'org-OTHER')`,
    [ORG],
  );
  await client.query(
    `INSERT INTO public."teamMember" (id, "teamId", "userId") VALUES
       ('tm-1437-1', 'team-growth-1437', $1)`,
    [OWNER],
  );
  await client.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  ({ runPostgresQueriesSync } = await import("@/lib/postgres-sync"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  requestMod = await import("@/lib/artifacts/artifact-promotion-request");
  sourceMod = await import("@/app/configuration/approvals/sources/promotion-requests");
  artifactTypeMod = await import("@cinatra-ai/artifacts");
});

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end().catch(() => {});
  const root = process.env.CINATRA_ARTIFACT_DATA_ROOT;
  if (root) rmSync(root, { recursive: true, force: true });
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)("cinatra#1437 artifact row-scope promotion via approvals (real DB)", () => {
  it("AC-1: private artifact → request → approvals inbox → approve → widened + re-projection enqueued + audit row", async () => {
    const objectId = nextId("obj-ac1");
    seedPrivateArtifact(objectId, { title: "Quarterly insight", body: "nothing secret here" });

    // A NON-owner member cannot even observe the private row through the
    // request surface (404-hidden refusal, no create).
    const denied = await requestMod.requestArtifactPromotion({
      orgId: ORG,
      artifactId: objectId,
      requestedBy: OTHER,
      toVisibility: "organization",
      actor: otherActor,
    });
    expect(denied).toMatchObject({ ok: false, code: "not_found" });

    // The OWNER opens the request (actor-gated read + CAS anchor capture).
    const requested = await requestMod.requestArtifactPromotion({
      orgId: ORG,
      artifactId: objectId,
      requestedBy: OWNER,
      toVisibility: "organization",
      actor: ownerActor,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    expect(requested.request.status).toBe("pending");
    expect(requested.request.rowVersion).toBe(1);

    // A second in-flight request for the same row conflicts (one-pending index).
    const dup = await requestMod.requestArtifactPromotion({
      orgId: ORG,
      artifactId: objectId,
      requestedBy: OWNER,
      toVisibility: "organization",
      actor: ownerActor,
    });
    expect(dup).toMatchObject({ ok: false, code: "conflict" });

    // The ADMIN's approvals inbox (the same envelope /notifications and
    // approvals_list serve) carries the row, CAS token included.
    const inbox = await sourceMod.promotionRequestsSource.fetchInbox(adminViewer);
    expect(inbox.availability).toBe("ready");
    const row = inbox.rows.find((r) => r.id === `artifact:${requested.request.id}`);
    expect(row).toBeDefined();
    expect(row!.title).toBe("Quarterly insight");
    expect(row!.version).toBe("1");

    // Approve through the shared source's decide — the same dispatch the UI
    // server action and approvals_decide MCP tool call.
    const decided = await sourceMod.promotionRequestsSource.actions.decide(
      { rowId: row!.id, action: "approve", expectedVersion: row!.version },
      adminViewer,
    );
    expect(decided).toEqual({ ok: true });

    // Row widened (visibility + ownership axes), version bumped by the CAS write.
    expect(readObjectRow(objectId)).toEqual({
      visibility: "organization",
      owner_level: "organization",
      owner_id: ORG,
      version: 2,
    });
    // Durable re-projection enqueued + immutable audit row appended.
    expect(countRows("graphiti_projection_outbox", "object_id=$1", [objectId])).toBeGreaterThan(0);
    expect(countRows("object_change_event", "object_id=$1 AND result_version=2", [objectId])).toBe(1);
    // Request row decided by the admin.
    expect(readRequestRow(objectId)).toMatchObject({ status: "approved", decided_by: ADMIN });
  });

  it("AC-2: an edit after the request supersedes it on the live CAS anchor; the row is never widened", async () => {
    const objectId = nextId("obj-supersede");
    seedPrivateArtifact(objectId, { title: "Draft", body: "work in progress" });
    const requested = await requestMod.requestArtifactPromotion({
      orgId: ORG,
      artifactId: objectId,
      requestedBy: OWNER,
      toVisibility: "organization",
      actor: ownerActor,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    // Concurrent EDIT moves the live row past the captured CAS anchor.
    sql(`UPDATE "${S()}"."objects" SET version = version + 1 WHERE id=$1`, [objectId]);

    const decided = await sourceMod.promotionRequestsSource.actions.decide(
      { rowId: `artifact:${requested.request.id}`, action: "approve", expectedVersion: "1" },
      adminViewer,
    );
    expect(decided).toMatchObject({ ok: false, code: "stale_snapshot" });
    expect(readRequestRow(objectId)).toMatchObject({ status: "superseded" });
    expect(readObjectRow(objectId)).toMatchObject({ visibility: "private", owner_level: "user" });
  });

  it("AC-2: a rejection requires a reason and leaves the row untouched", async () => {
    const objectId = nextId("obj-reject");
    seedPrivateArtifact(objectId, { title: "Notes", body: "team notes" });
    const requested = await requestMod.requestArtifactPromotion({
      orgId: ORG,
      artifactId: objectId,
      requestedBy: OWNER,
      toVisibility: "organization",
      actor: ownerActor,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    const rowId = `artifact:${requested.request.id}`;

    // The shared source enforces the reject reason before any backend runs.
    const noReason = await sourceMod.promotionRequestsSource.actions.decide(
      { rowId, action: "reject" },
      adminViewer,
    );
    expect(noReason).toMatchObject({ ok: false, code: "reason_required" });

    const rejected = await sourceMod.promotionRequestsSource.actions.decide(
      { rowId, action: "reject", reason: "not ready" },
      adminViewer,
    );
    expect(rejected).toEqual({ ok: true });
    expect(readRequestRow(objectId)).toMatchObject({
      status: "rejected",
      decided_by: ADMIN,
      decision_note: "not ready",
    });
    expect(readObjectRow(objectId)).toMatchObject({ visibility: "private", version: 1 });
  });

  it("AC-2: the fail-closed secret scan refuses a SEEDED secret before any state is claimed", async () => {
    const objectId = nextId("obj-secret");
    seedPrivateArtifact(objectId, { title: "leak", body: "token sk-ABCDEFGH1234567890abcd here" });
    const requested = await requestMod.requestArtifactPromotion({
      orgId: ORG,
      artifactId: objectId,
      requestedBy: OWNER,
      toVisibility: "organization",
      actor: ownerActor,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const decided = await sourceMod.promotionRequestsSource.actions.decide(
      { rowId: `artifact:${requested.request.id}`, action: "approve", expectedVersion: "1" },
      adminViewer,
    );
    expect(decided).toMatchObject({ ok: false, code: "secret_scan" });
    // Fail-closed and re-decidable after the content is cleaned: still pending,
    // and the row was never widened.
    expect(readRequestRow(objectId)).toMatchObject({ status: "pending" });
    expect(readObjectRow(objectId)).toMatchObject({ visibility: "private", version: 1 });
  });

  it("team target: tenant-validated + member-gated at request time; approve widens to the team and reviewers see the destination", async () => {
    const objectId = nextId("obj-team");
    seedPrivateArtifact(objectId, { title: "Team doc", body: "for the growth team" });

    // A foreign org's team id is refused with ONE indistinguishable message.
    const foreign = await requestMod.requestArtifactPromotion({
      orgId: ORG,
      artifactId: objectId,
      requestedBy: OWNER,
      toVisibility: "team",
      targetTeamId: "team-foreign-1437",
      actor: ownerActor,
    });
    expect(foreign).toMatchObject({ ok: false, code: "invalid_state" });

    // A nonexistent team id is refused identically.
    const missing = await requestMod.requestArtifactPromotion({
      orgId: ORG,
      artifactId: objectId,
      requestedBy: OWNER,
      toVisibility: "team",
      targetTeamId: "team-nope",
      actor: ownerActor,
    });
    expect(missing).toMatchObject({ ok: false, code: "invalid_state" });

    // The requester's own org team works; the display label is snapshotted.
    const requested = await requestMod.requestArtifactPromotion({
      orgId: ORG,
      artifactId: objectId,
      requestedBy: OWNER,
      toVisibility: "team",
      targetTeamId: "team-growth-1437",
      actor: ownerActor,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    // Reviewers see the ACTUAL destination team, not a bare "Team".
    const inbox = await sourceMod.promotionRequestsSource.fetchInbox(adminViewer);
    const row = inbox.rows.find((r) => r.id === `artifact:${requested.request.id}`);
    expect(row).toBeDefined();
    expect((row!.raw as { detail?: { toScope?: string } }).detail?.toScope).toBe(
      "Team: Growth [team-growth-1437]",
    );

    const decided = await sourceMod.promotionRequestsSource.actions.decide(
      { rowId: row!.id, action: "approve", expectedVersion: row!.version },
      adminViewer,
    );
    expect(decided).toEqual({ ok: true });
    expect(readObjectRow(objectId)).toEqual({
      visibility: "team",
      owner_level: "team",
      owner_id: "team-growth-1437",
      version: 2,
    });
  });

  it("AC-3: never-narrow is refused at REQUEST time against the live row", async () => {
    const objectId = nextId("obj-narrow");
    seedPrivateArtifact(objectId, { title: "Org-wide already", body: "x" });
    sql(
      `UPDATE "${S()}"."objects" SET visibility='organization', owner_level='organization', owner_id=$2 WHERE id=$1`,
      [objectId, ORG],
    );
    const narrowing = await requestMod.requestArtifactPromotion({
      orgId: ORG,
      artifactId: objectId,
      requestedBy: OWNER,
      toVisibility: "organization",
      actor: ownerActor,
    });
    expect(narrowing).toMatchObject({ ok: false, code: "narrowing" });
  });
});
