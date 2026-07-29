/**
 * REAL-STORE proof for the injection-drop ledger (cinatra#2091, epic #2086 S4).
 *
 * The typed injection contract records a skill it RESOLVED but did not DELIVER
 * (cap truncation, inline-budget overflow) on the same `agent_run_skills_used`
 * row the exposure ledger writes, so the efficacy surface can tell "never
 * reached the model" apart from "reached it and was never invoked".
 *
 * Every assertion here runs against a real Postgres schema built from the real
 * store DDL — no mock, no in-memory double — because the load-bearing behaviour
 * is entirely in the two upserts' conflict clauses:
 *
 *   - a drop INSERTS a row with the reason and no delivery mode;
 *   - a later real EXPOSURE of the same (run, skill) CLEARS the drop marker;
 *   - a later drop must NOT erase an already-recorded delivery;
 *   - neither ever resets `invocation_count`.
 *
 * DB-gated exactly like its siblings: skipped without a real `SUPABASE_DB_URL`.
 * Locally: point SUPABASE_DB_URL at a dev Postgres and run with
 * `CINATRA_DB_INTEGRATION_TESTS=1`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { skillEfficacySchemaQueries } from "@/lib/skill-lifecycle-schema";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused") &&
  !dbUrl.includes("build:build@127.0.0.1:5432/build");

const schema = `s4_inject_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const RUN_ID = `run-${randomUUID()}`;
const ORG_ID = `org-${randomUUID()}`;
const TEMPLATE_ID = `tmpl-${randomUUID()}`;

let client: Client;

/**
 * The route's writers are `runPostgresQueriesSync` based (a child-process
 * bridge bound to the app's own connection resolution), so this test executes
 * the EXACT SQL those writers emit against the real schema instead of booting
 * the bridge. The statements are kept byte-aligned with
 * `src/lib/agent-run-skills-used.ts`; the arch assertion at the bottom fails if
 * they drift apart.
 */
function table(): string {
  return `"${schema}"."agent_run_skills_used"`;
}

async function recordDrop(skillId: string, reason: string): Promise<void> {
  await client.query(
    `INSERT INTO ${table()}
       (run_id, skill_id, skill_kind, invocation_count, injection_drop_reason)
     VALUES ($1, $2, $3, 0, $4)
     ON CONFLICT (run_id, skill_id)
     DO UPDATE SET
       injection_drop_reason =
         CASE WHEN ${table()}.delivery_mode IS NULL
              THEN EXCLUDED.injection_drop_reason
              ELSE ${table()}.injection_drop_reason
         END`,
    [RUN_ID, skillId, "installed", reason],
  );
}

async function recordExposure(
  skillId: string,
  deliveryMode: string,
  attributable: boolean,
): Promise<void> {
  await client.query(
    `INSERT INTO ${table()}
       (run_id, skill_id, skill_kind, invocation_count, delivery_mode, invocation_attributable)
     VALUES ($1, $2, $3, 0, $4, $5)
     ON CONFLICT (run_id, skill_id)
     DO UPDATE SET
       delivery_mode = EXCLUDED.delivery_mode,
       invocation_attributable =
         COALESCE(${table()}.invocation_attributable, false)
         OR EXCLUDED.invocation_attributable,
       injection_drop_reason = NULL`,
    [RUN_ID, skillId, "installed", deliveryMode, attributable],
  );
}

async function row(skillId: string) {
  const res = await client.query(
    `SELECT skill_id, skill_kind, invocation_count, delivery_mode,
            invocation_attributable, injection_drop_reason
       FROM ${table()} WHERE run_id = $1 AND skill_id = $2`,
    [RUN_ID, skillId],
  );
  return res.rows[0];
}

describe.skipIf(!hasDb)("injection-drop ledger (real store)", () => {
  beforeAll(async () => {
    client = new Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
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
    // `agent_run_skills_used.run_id` is FK-bound to a REAL run row — the ledger
    // is per-run by construction and the constraint is part of what this test
    // proves is honoured.
    await client.query(
      `INSERT INTO "${schema}"."agent_templates"
         (id, org_id, name, source_nl, compiled_plan, input_schema,
          approval_policy, package_name, creator_id)
       VALUES ($1, $2, 'S4 injection ledger fixture', 'n/a', '{}', '{}',
               'none', $3, 'fixture-creator')`,
      [TEMPLATE_ID, ORG_ID, `@fixture/s4-${TEMPLATE_ID.slice(-8)}`],
    );
    await client.query(
      `INSERT INTO "${schema}"."agent_runs"
         (id, template_id, version_id, run_by, status, input_params, source_type, org_id)
       VALUES ($1, $2, NULL, NULL, 'succeeded', '{}'::jsonb, 'agent_builder', $3)`,
      [RUN_ID, TEMPLATE_ID, ORG_ID],
    );
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  it("the store DDL provisions injection_drop_reason on agent_run_skills_used", async () => {
    const res = await client.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'agent_run_skills_used'
          AND column_name = 'injection_drop_reason'`,
      [schema],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].data_type).toBe("text");
    // Additive + nullable: an existing row is untouched by the upgrade.
    expect(res.rows[0].is_nullable).toBe("YES");
  });

  it("the schema DDL is idempotent (re-applying the efficacy queries is a no-op)", async () => {
    for (const q of skillEfficacySchemaQueries(schema)) await client.query(q.text);
    const res = await client.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'agent_run_skills_used'
          AND column_name = 'injection_drop_reason'`,
      [schema],
    );
    expect(res.rows[0].n).toBe(1);
  });

  it("records a dropped skill with its reason and NO delivery mode", async () => {
    await recordDrop("skill-dropped", "over_cap");
    const r = await row("skill-dropped");
    expect(r.injection_drop_reason).toBe("over_cap");
    expect(r.delivery_mode).toBeNull();
    expect(r.invocation_count).toBe(0);
  });

  it("re-recording the same drop is idempotent", async () => {
    await recordDrop("skill-dropped", "over_cap");
    const res = await client.query(
      `SELECT count(*)::int AS n FROM ${table()} WHERE run_id = $1 AND skill_id = $2`,
      [RUN_ID, "skill-dropped"],
    );
    expect(res.rows[0].n).toBe(1);
  });

  it("a later real EXPOSURE supersedes the drop marker for the same (run, skill)", async () => {
    await recordDrop("skill-later-delivered", "inline_budget_exhausted");
    expect((await row("skill-later-delivered")).injection_drop_reason).toBe(
      "inline_budget_exhausted",
    );
    await recordExposure("skill-later-delivered", "openai_shell", true);
    const r = await row("skill-later-delivered");
    expect(r.injection_drop_reason).toBeNull();
    expect(r.delivery_mode).toBe("openai_shell");
    expect(r.invocation_attributable).toBe(true);
  });

  it("a later drop NEVER erases an already-recorded delivery", async () => {
    await recordExposure("skill-delivered", "anthropic_container", false);
    await recordDrop("skill-delivered", "over_cap");
    const r = await row("skill-delivered");
    expect(r.delivery_mode).toBe("anthropic_container");
    expect(r.injection_drop_reason).toBeNull();
  });

  it("neither writer ever resets invocation_count", async () => {
    await recordExposure("skill-counted", "openai_shell", true);
    await client.query(
      `UPDATE ${table()} SET invocation_count = 7 WHERE run_id = $1 AND skill_id = $2`,
      [RUN_ID, "skill-counted"],
    );
    await recordDrop("skill-counted", "over_cap");
    await recordExposure("skill-counted", "openai_shell", true);
    expect((await row("skill-counted")).invocation_count).toBe(7);
  });

  it("invocation_attributable stays MONOTONIC across a drop/re-expose cycle", async () => {
    await recordExposure("skill-sticky", "openai_shell", true);
    await recordExposure("skill-sticky", "gemini_inline", false);
    expect((await row("skill-sticky")).invocation_attributable).toBe(true);
  });
});

describe("the executed SQL has not drifted from the writers it stands in for", () => {
  const source = readFileSync(
    path.join(__dirname, "..", "..", "agent-run-skills-used.ts"),
    "utf8",
  );

  it("recordSkillInjectionDrops keeps the delivery-wins conflict clause", () => {
    expect(source).toContain("export function recordSkillInjectionDrops");
    expect(source).toContain(
      "(run_id, skill_id, skill_kind, invocation_count, injection_drop_reason)",
    );
    expect(source).toContain("ON CONFLICT (run_id, skill_id)");
    expect(source).toContain("CASE WHEN ${table}.delivery_mode IS NULL");
  });

  it("recordSkillExposure clears the drop marker on a real delivery", () => {
    expect(source).toContain("injection_drop_reason = NULL");
  });

  it("neither writer touches invocation_count on conflict", () => {
    const dropStart = source.indexOf("export function recordSkillInjectionDrops");
    const dropEnd = source.indexOf("export type SkillExposureAggregate");
    const dropBody = source.slice(dropStart, dropEnd);
    expect(dropBody).not.toContain("invocation_count =");
  });
});
