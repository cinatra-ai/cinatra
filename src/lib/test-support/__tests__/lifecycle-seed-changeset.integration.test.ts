/**
 * cinatra#2683 (epic #2564 S8f) — the seed path produces a REAL CLOSED,
 * RESTORABLE `change_set` WITH MEMBER EVENTS, against real DDL.
 *
 * WHY THIS SUITE IS THE ONE THAT MATTERS FOR V13. An earlier wave of this slice
 * refused to photograph the undo chip, because the chip's gate is satisfied by a
 * `change_set` row with NO member events at all — `bool_and(restore_eligible)`
 * over zero rows is `null`, not `false`, so the close would have computed
 * `restorable = true` and the chip would have deep-linked to the restore of
 * nothing. A seed that writes rows is therefore not enough; the rows have to come
 * out of the shipped writers with real events under them. That is what is
 * asserted here, on real Postgres, with no injected fakes below the driver.
 *
 * DB-gated like its sibling artifact suites: `describe.skipIf(!HAS_REAL_DB)`, so
 * CI without a reachable Postgres emits zero failures and zero noise. Run with:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
 *     npx vitest run --config vitest.config.ts \
 *     src/lib/test-support/__tests__/lifecycle-seed-changeset.integration.test.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

// The root config aliases @/lib/database to a stub without the named exports the
// object-history graph needs; rebind the real sync-leaf-backed primitives
// (lazily, so postgres-config binds the isolated schema). Same shape the #1437
// artifact suite uses.
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
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

// WHAT IS STOOD IN FOR HERE, AND IT IS NEVER A WRITER: the SUBJECT
// AUTHORIZATION. This isolated schema is provisioned from the canonical store
// DDL and carries no better-auth membership rows, no agent run and no installed
// extensions, so the live membership read, the run read and the artifact-type
// resolver have nothing to answer from. None of them is what this suite proves —
// the mocked-sequence suite next door pins that the seed asks for every one of
// them, in that order, and refuses when any says no. What THIS suite proves is
// the ROWS the writers produce, and every writer below the driver is real.
//
// The org-write AUTHORITY itself is still the REAL mint with a real role, so the
// org-write kernel's capability rules run exactly as they do in the app.
vi.mock("@/lib/org-write/authority", async () => {
  const real = await import("@/lib/org-write/authority");
  return {
    ...real,
    verifySessionAuthority: async (_userId: string, orgId: string) =>
      real.sessionAuthorityFromResolvedRole(orgId, "org_owner"),
  };
});
vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentRunById: async (id: string) => ({ id, orgId: ORG, runBy: ACTOR }),
}));
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: async () => ({ ok: true }),
}));
vi.mock("@/lib/auth-session", () => ({
  resolveActorGrantsForUserInOrg: async () => ({
    orgRole: "org_owner",
    teamIds: [],
    projectGrants: [],
  }),
}));
vi.mock("@/lib/lifecycle/widget-lifecycle-frame-actor", () => ({
  buildWidgetLifecycleRoleHints: (input: { orgRole?: string }) => ({
    platformRole: "member",
    orgRole: input.orgRole,
  }),
}));

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const TEST_SCHEMA = "cinatra_test_lifecycle_seed_2683";
const ORG = "org-seed-2683";
const ACTOR = "u-reader-2683";
const RUN = "run-seed-2683";
const OBJECT_TYPE = "@cinatra-ai/document-artifact:document";

// The fixture's object type is PINNED in the driver, resolved through the upload
// route's MIME map — which reads the in-memory installed-extension registry. This
// isolated schema has no installed extensions, so the resolver is stood in for
// with a fixed type. It is not what this suite proves (the mocked-sequence suite
// next door pins that the driver asks it and refuses an unresolvable MIME); what
// this suite proves is the ROWS the writers produce.
vi.mock("@/lib/artifacts/upload-artifact-type-map", () => ({
  resolveUploadArtifactType: () => ({ ok: true, objectTypeId: OBJECT_TYPE }),
}));

let seedRestorableChangeSet: typeof import("../lifecycle-seed-drivers").seedRestorableChangeSet;
let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let listChangeSets: typeof import("@/lib/object-history").listChangeSets;
let loadChangeSet: typeof import("@/lib/object-history").loadChangeSet;

function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  // MUST precede every app-module import (postgresSchema is a module-load const).
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.CINATRA_ARTIFACT_DATA_ROOT = mkdtempSync(path.join(tmpdir(), "cin-2683-"));

  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    await client.query(qy.text, (qy.values ?? []) as unknown[]);
  }
  // The ORG ROW IS REAL AND IT LIVES IN `public`. The org-write kernel every
  // canonical write goes through reads the org's LIFECYCLE STATE from
  // `public."organization"` — an org that is absent or archived refuses
  // `content.write` outright — and that table is deliberately NOT part of the
  // per-schema store DDL. So the fixture org is inserted here (and removed in
  // afterAll) rather than the kernel's refusal being stubbed out: the ONE fence
  // that decides whether this write may happen at all stays live.
  await client.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt")
     VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG, "S8f seed fixture org", `s8f-seed-fixture-${Date.now()}`],
  );
  await client.end();

  ({ runPostgresQueriesSync } = await import("@/lib/postgres-sync"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  ({ listChangeSets, loadChangeSet } = await import("@/lib/object-history"));
  ({ seedRestorableChangeSet } = await import("../lifecycle-seed-drivers"));
}, 180_000);

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await client.query(`DELETE FROM public."organization" WHERE id = $1`, [ORG]);
  await client.end();
}, 60_000);

describe.skipIf(!HAS_REAL_DB)(
  "the seed path writes a REAL closed change_set with member events",
  () => {
    it("closes a restorable set over a real object write", async () => {
      const result = await seedRestorableChangeSet({
        orgId: ORG,
        actorId: ACTOR,
        runId: RUN,
      });

      // THE SET IS REAL AND CLOSED.
      const csRow = sql(
        `SELECT id, org_id, run_id, actor_id, closed_at, restorable, effect_rollup
           FROM "${TEST_SCHEMA}"."change_set" WHERE id = $1`,
        [result.changeSetId],
      ).rows?.[0] as Record<string, unknown> | undefined;
      expect(csRow, "the change_set row must exist").toBeTruthy();
      expect(csRow?.closed_at, "a chip only ever offers a CLOSED set").not.toBeNull();
      expect(csRow?.restorable).toBe(true);
      expect(csRow?.effect_rollup).toBe("reversible-internal");
      expect(csRow?.run_id).toBe(RUN);
      expect(csRow?.org_id).toBe(ORG);
      expect(csRow?.actor_id).toBe(ACTOR);

      // AND IT HAS MEMBER EVENTS — the whole point.
      const events = sql(
        `SELECT id, object_id, operation, history_effect, restore_eligible, restore_ineligible_reason
           FROM "${TEST_SCHEMA}"."object_change_event" WHERE change_set_id = $1`,
        [result.changeSetId],
      ).rows as Array<Record<string, unknown>>;
      expect(events.length, "an event-less set is the row this slice refused").toBe(1);
      expect(events[0].object_id).toBe(result.objectId);
      expect(events[0].operation).toBe("create");
      expect(events[0].restore_eligible).toBe(true);
      expect(events[0].restore_ineligible_reason).toBeNull();
      expect(result.memberEventCount).toBe(1);

      // THE OBJECT IS REAL, owned by the reader the fixture named.
      const obj = sql(
        `SELECT id, type, org_id, owner_level, owner_id, visibility, version, run_id
           FROM "${TEST_SCHEMA}"."objects" WHERE id = $1`,
        [result.objectId],
      ).rows?.[0] as Record<string, unknown> | undefined;
      expect(obj?.type).toBe(OBJECT_TYPE);
      expect(obj?.owner_id).toBe(ACTOR);
      expect(obj?.visibility).toBe("private");
      expect(obj?.version).toBe(1);
      expect(obj?.run_id).toBe(RUN);
    });

    it("is found by the chip's OWN read filters — run, restorable, and the five-minute window", async () => {
      const result = await seedRestorableChangeSet({
        orgId: ORG,
        actorId: ACTOR,
        runId: `${RUN}-window`,
      });

      // The exact filter `recentUndoableChangeSetFor` applies before it runs the
      // per-event authorization (which `changeset-restore-access.test.ts` owns).
      const found = listChangeSets({
        orgId: ORG,
        runId: `${RUN}-window`,
        closedAtAfter: new Date(Date.now() - 5 * 60_000).toISOString(),
        restorable: true,
        limit: 1,
      });
      expect(found.map((c) => c.id)).toEqual([result.changeSetId]);

      // NEGATIVE CONTROL: the same set, asked for outside the window, is gone —
      // so the match above is the window's doing and not an unfiltered read.
      const stale = listChangeSets({
        orgId: ORG,
        runId: `${RUN}-window`,
        closedAtAfter: new Date(Date.now() + 60_000).toISOString(),
        restorable: true,
        limit: 1,
      });
      expect(stale).toEqual([]);

      // NEGATIVE CONTROL: another org sees nothing.
      expect(
        listChangeSets({ orgId: "org-somebody-else", runId: `${RUN}-window`, limit: 1 }),
      ).toEqual([]);

      // And the loader the eligibility gate uses returns the set WITH its events.
      const loaded = loadChangeSet(result.changeSetId, { orgId: ORG });
      expect(loaded?.events).toHaveLength(1);
      expect(loaded?.changeSet.restorable).toBe(true);
    });
  },
);
