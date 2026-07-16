/**
 * cinatra#1703 — an orphaned/ephemeral `agent_templates` row must never abort
 * boot.
 *
 * The agent-mount projection / re-install re-homes a template by UPDATEing its
 * `(owner_level, owner_id)`; the `enqueue_agent_owner_move` relocation trigger
 * fires on that UPDATE and derives the on-disk `~agents` relocation paths via
 * `compute_owner_path_prefix`. When the row's CURRENT owner (or the move target)
 * can't be resolved to a path prefix — `compute_owner_path_prefix(...) => NULL`
 * for a run-token / deleted-user principal — the trigger USED to
 * `RAISE EXCEPTION 'cannot resolve owner paths for template %'`, which aborted
 * the WHOLE boot: databases carrying orphaned ephemeral templates could not
 * start until the rows were hand-deleted.
 *
 * It now DEGRADES-WITH-DIAGNOSTIC (matching the skip-with-diagnostic boot
 * already applies to a malformed extension manifest): an unresolvable owner path
 * has no materialized `~agents` path to relocate, so the trigger skips the
 * relocation enqueue, emits a sanitized WARNING (template id only), and lets the
 * UPDATE proceed — boot continues to ready.
 *
 * The no-DB SQL-shape assertions always run. The DB-gated suite seeds a real
 * Postgres (per-test app schema + the committed Better-Auth public schema),
 * seeds an orphaned-owner `agent_templates` row, performs the owner-move UPDATE,
 * and asserts it succeeds WITHOUT raising and enqueues NO `path_relocations` row
 * — while a resolvable->resolvable move STILL enqueues one (the relocation happy
 * path is intact). The suite self-skips without a real `SUPABASE_DB_URL` (same
 * contract as the sibling integration tests). Locally:
 *
 *   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<live> \
 *     pnpm exec vitest run \
 *       src/lib/__tests__/integration/agent-owner-move-orphaned-owner.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused") &&
  !dbUrl.includes("build:build@127.0.0.1:5432/build");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const PUBLIC_SCHEMA_SQL = path.join(REPO_ROOT, "tests/e2e/rbac/fixtures/public-schema.sql");

function triggerSql(): string {
  const sql = buildCreateStoreSchemaQueries("cinatra_test")
    .map((q) => q.text)
    .join("\n");
  const start = sql.indexOf("enqueue_agent_owner_move() RETURNS trigger");
  const end = sql.indexOf("$body$", start);
  return sql.slice(start, end);
}

async function applyStoreDdl(client: Client, schema: string): Promise<void> {
  for (const q of buildCreateStoreSchemaQueries(schema)) {
    const head = q.text.trim().slice(0, 6).toUpperCase();
    if (
      head !== "CREATE" &&
      head !== "ALTER " &&
      head !== "DROP T" &&
      head !== "DROP S" &&
      head !== "DELETE" &&
      head !== "UPDATE" &&
      !head.startsWith("DO $$")
    ) {
      continue;
    }
    await client.query(q.text);
  }
}

describe("enqueue_agent_owner_move degrade-with-diagnostic (SQL shape, no DB needed)", () => {
  const fn = triggerSql();

  it("emits a WARNING + RETURN NEW (skip), never a RAISE EXCEPTION, on an unresolvable owner path", () => {
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).not.toMatch(/cannot resolve owner paths/);
    expect(fn).toMatch(
      /IF old_prefix IS NULL OR new_prefix IS NULL THEN[\s\S]*?RAISE WARNING 'enqueue_agent_owner_move: skipping relocation for template %[\s\S]*?RETURN NEW;\s*END IF;/,
    );
  });

  it("keeps the resolvable->resolvable relocation enqueue (happy path unchanged)", () => {
    expect(fn).toMatch(/INSERT INTO[\s\S]*?"path_relocations"/);
    expect(fn).toMatch(/old_p := old_prefix \|\| '\/~agents\/' \|\| pkg_path;/);
    expect(fn).toMatch(/new_p := new_prefix \|\| '\/~agents\/' \|\| pkg_path;/);
  });
});

describe.skipIf(!hasDb)(
  "enqueue_agent_owner_move on an orphaned owner (real Postgres, DB-gated)",
  () => {
    let client: Client;
    let schema: string;
    const t = randomUUID().replace(/-/g, "").slice(0, 10);

    // Resolvable org (unique id; public schema is shared across parallel files).
    const O1 = `org1703_${t}`;
    // A NON-EMPTY principal that resolves to NULL (no such organization row) —
    // exactly the shape of a deleted-org / run-token owner that aborted boot.
    const GHOST = `ghost1703_${t}`;

    const insertTemplate = async (
      id: string,
      ownerLevel: string | null,
      ownerId: string | null,
      pkg: string,
      orgId: string | null = null,
    ): Promise<void> => {
      await client.query(
        `INSERT INTO "${schema}"."agent_templates"
           (id, name, source_nl, compiled_plan, input_schema, approval_policy,
            status, package_name, owner_level, owner_id, org_id)
         VALUES ($1, $2, '', '[]', '{}', '{"steps":[]}', 'active', $3, $4, $5, $6)`,
        [id, `tpl ${id}`, pkg, ownerLevel, ownerId, orgId],
      );
    };

    const moveOwner = (
      id: string,
      ownerLevel: string,
      ownerId: string | null,
    ): Promise<unknown> =>
      client.query(
        `UPDATE "${schema}"."agent_templates" SET owner_level = $2, owner_id = $3 WHERE id = $1`,
        [id, ownerLevel, ownerId],
      );

    const ownerOf = async (id: string): Promise<{ level: string | null; ownerId: string | null }> => {
      const r = await client.query(
        `SELECT owner_level, owner_id FROM "${schema}"."agent_templates" WHERE id = $1`,
        [id],
      );
      return { level: r.rows[0]?.owner_level ?? null, ownerId: r.rows[0]?.owner_id ?? null };
    };

    const relocationCount = async (subjectId: string): Promise<number> => {
      const r = await client.query(
        `SELECT count(*)::int AS n FROM "${schema}"."path_relocations"
          WHERE subject_kind = 'agent_template' AND subject_id = $1`,
        [subjectId],
      );
      return r.rows[0].n as number;
    };

    beforeAll(async () => {
      client = new Client({ connectionString: dbUrl });
      await client.connect();
      // The store DDL carries cross-schema FKs / lookups to public.* (Better-Auth
      // owned) — provision it first, same pattern as the sibling integration tests.
      await client.query(readFileSync(PUBLIC_SCHEMA_SQL, "utf8"));

      schema = `cinatra_1703_${t}`;
      await client.query(`CREATE SCHEMA "${schema}"`);
      await applyStoreDdl(client, schema);

      // One resolvable organization (deleted in afterAll).
      await client.query(
        `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now())`,
        [O1, `Org ${O1}`, O1],
      );
    });

    afterAll(async () => {
      if (schema) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.query(`DELETE FROM public."organization" WHERE id = $1`, [O1]);
      await client.end();
    });

    it("AC1/AC2 — the boot owner-backfill on an orphaned (owner_level NULL, unresolvable org_id) row no longer aborts", async () => {
      // The FAITHFUL boot repro: an orphaned/ephemeral row landed with
      // owner_level NULL and an org_id that points at a now-deleted org. On boot
      // the store DDL runs the un-tiered owner backfill, which UPDATEs
      // (owner_level, owner_id) and fires the relocation trigger with a target
      // prefix that resolves to NULL. Pre-#1703 this RAISEd and aborted boot.
      const id = `tpl_boot_orphan_${t}`;
      await insertTemplate(id, null, null, `@cinatra-ai/boot-orphan-${t}-agent`, GHOST);

      // Byte-for-byte the boot backfill statement (drizzle-store.ts).
      await expect(
        client.query(
          `UPDATE "${schema}"."agent_templates"
             SET owner_level = 'organization', owner_id = COALESCE(org_id, '')
           WHERE owner_level IS NULL`,
        ),
      ).resolves.toBeDefined();

      // Row was re-tiered to the (unresolvable) org; boot proceeds, no relocation.
      expect(await ownerOf(id)).toEqual({ level: "organization", ownerId: GHOST });
      expect(await relocationCount(id)).toBe(0);
    });

    it("re-homes an ORPHANED-owner row (unresolvable -> resolvable) without aborting and enqueues no relocation", async () => {
      // A stale row whose CURRENT owner no longer resolves is re-homed to a real
      // org by a projection / re-install: old_prefix is NULL, so nothing to
      // relocate FROM — skip, don't abort.
      const id = `tpl_orphan_${t}`;
      await insertTemplate(id, "organization", GHOST, `@cinatra-ai/orphan-${t}-agent`);

      await expect(moveOwner(id, "organization", O1)).resolves.toBeDefined();

      expect(await ownerOf(id)).toEqual({ level: "organization", ownerId: O1 });
      // Orphaned source had no materialized ~agents path — nothing to relocate.
      expect(await relocationCount(id)).toBe(0);
    });

    it("degrades on an UNRESOLVABLE move target (resolvable -> unresolvable): no abort, no relocation", async () => {
      const id = `tpl_bogus_target_${t}`;
      await insertTemplate(id, "organization", O1, `@cinatra-ai/bogus-target-${t}-agent`);

      await expect(moveOwner(id, "organization", GHOST)).resolves.toBeDefined();

      expect(await ownerOf(id)).toEqual({ level: "organization", ownerId: GHOST });
      expect(await relocationCount(id)).toBe(0);
    });

    it("STILL enqueues a relocation for a resolvable->resolvable owner move (happy path intact)", async () => {
      // workspace resolves to the constant 'workspace' prefix (no principal
      // lookup); the move to the real org resolves to 'organization/<slug>'.
      const id = `tpl_happy_${t}`;
      await insertTemplate(id, "workspace", null, `@cinatra-ai/happy-${t}-agent`);

      await expect(moveOwner(id, "organization", O1)).resolves.toBeDefined();

      expect(await ownerOf(id)).toEqual({ level: "organization", ownerId: O1 });
      expect(await relocationCount(id)).toBe(1);
    });
  },
);
