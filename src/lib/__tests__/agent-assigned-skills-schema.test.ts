// DDL parity for `agent_assigned_skills` (cinatra#2346 S1, epic #2345;
// WIDENED TO SCOPE by cinatra#2813 S1, epic #2812).
//
// The table has THREE homes that must agree: the fresh-install bootstrap DDL
// (`agentAssignedSkillsSchemaQueries`, spread into
// `buildCreateStoreSchemaQueries`), the original operator-upgrade migration
// (`migrations/core/core__0089`), and the widening migration
// (`migrations/core/core__0100`) that carries the scope tuple onto an instance
// that already has the narrow table. A fresh install that gets the wide shape
// while an upgraded instance keeps the narrow one is a silent split-brain:
// every scoped assignment write fails on one and succeeds on the other.
//
// The BEHAVIORAL two-arm proof (fresh bootstrap vs migration, against a real
// Postgres) lives in
// `src/lib/__tests__/agent-assigned-skills.integration.test.ts`;
// this suite pins the SHAPE so a drift is caught without a database.
import { describe, expect, it } from "vitest";

import {
  AGENT_ASSIGNED_SKILLS_POSITION_INDEX,
  AGENT_ASSIGNED_SKILLS_SCOPE_INDEX,
  AGENT_ASSIGNED_SKILLS_SKILL_INDEX,
  AGENT_ASSIGNED_SKILLS_TABLE,
  agentAssignedSkillsSchemaQueries,
} from "@/lib/skill-lifecycle-schema";
import { agentAssignedSkillsDdlSql } from "../../../migrations/core/core__0089_agent-assigned-skills.mjs";
import { perScopeAssignmentDdlSql } from "../../../migrations/core/core__0100_per-scope-assignment-stores.mjs";

const bootstrap = agentAssignedSkillsSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");

/** The bootstrap is born wide; the operator path reaches the same shape by
 *  applying core__0089 and then the core__0100 widening. */
const upgradePath = `${agentAssignedSkillsDdlSql}\n${perScopeAssignmentDdlSql}`;

const BOTH: Array<[string, string]> = [
  ["fresh-install bootstrap", bootstrap],
  ["operator-upgrade path", upgradePath],
];

describe("agent_assigned_skills — DDL parity between the two homes", () => {
  it.each(BOTH)("%s creates the table idempotently", (_name, sql) => {
    expect(sql).toMatch(
      new RegExp(`CREATE TABLE IF NOT EXISTS[^(]*${AGENT_ASSIGNED_SKILLS_TABLE}`),
    );
  });

  it.each(BOTH)("%s declares the exact column set", (_name, sql) => {
    expect(sql).toMatch(/agent_package_name text NOT NULL/);
    expect(sql).toMatch(/skill_id text NOT NULL/);
    expect(sql).toMatch(/"position" integer NOT NULL/);
    // created_by is NOT NULL by decision (issue scope item 6): the surface
    // records WHO assigned. It is not an audit-retention surface — a completed
    // uninstall deletes the row.
    expect(sql).toMatch(/created_by text NOT NULL/);
    expect(sql).toMatch(/created_at timestamptz NOT NULL DEFAULT now\(\)/);
  });

  it.each(BOTH)("%s carries the scope tuple", (_name, sql) => {
    expect(sql).toMatch(/scope_kind text NOT NULL|ALTER COLUMN scope_kind SET NOT NULL/);
    expect(sql).toMatch(/scope_id text NOT NULL|ALTER COLUMN scope_id SET NOT NULL/);
  });

  it.each(BOTH)("%s carries the provenance columns", (_name, sql) => {
    // `source` says whether a person picked this skill or the recommender did;
    // `origin_run_id` is forward-looking — the run a recommendation came from,
    // which loses its pointer rather than its row when the run is deleted.
    // The two arms state NOT NULL differently — the bootstrap declares the
    // column, the operator path adds it to an existing table and then
    // constrains it — so the assertion names the FACT and admits both grammars.
    expect(sql).toMatch(/source text NOT NULL|ALTER COLUMN source SET NOT NULL/);
    expect(sql).toMatch(/origin_run_id text/);
    // The FK is NAMED, and named as the operator migration names it — an
    // auto-named bootstrap constraint would make core__0100 add a duplicate.
    expect(sql).toMatch(/CONSTRAINT agent_assigned_skills_origin_run_fk/);
    expect(sql).toMatch(/ON DELETE SET NULL/);
    expect(sql).toMatch(/source IN \('manual', 'recommended'\)/);
  });

  it.each(BOTH)("%s keys the table on the FULL scope tuple", (_name, sql) => {
    expect(sql).toMatch(
      /PRIMARY KEY \(agent_package_name, skill_id, scope_kind, scope_id\)/,
    );
  });

  it.each(BOTH)("%s backs the cap with UNIQUE (package, scope, position)", (_name, sql) => {
    expect(sql).toMatch(
      new RegExp(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${AGENT_ASSIGNED_SKILLS_POSITION_INDEX}[\\s\\S]*\\(agent_package_name, scope_kind, scope_id, "position"\\)`,
      ),
    );
  });

  it.each(BOTH)("%s pins the workspace sentinel with a CHECK", (_name, sql) => {
    expect(sql).toContain("scope_kind = 'workspace' AND scope_id = '__workspace__'");
    expect(sql).toContain("scope_id <> '__workspace__'");
  });

  it.each(BOTH)("%s enumerates the five scope kinds with a CHECK", (_name, sql) => {
    for (const kind of ["workspace", "organization", "team", "project", "user"]) {
      expect(sql).toContain(`'${kind}'`);
    }
  });

  it.each(BOTH)("%s indexes the scope tuple for the per-scope read", (_name, sql) => {
    expect(sql).toContain(AGENT_ASSIGNED_SKILLS_SCOPE_INDEX);
  });

  it.each(BOTH)("%s indexes skill_id for the teardown lookup", (_name, sql) => {
    expect(sql).toMatch(
      new RegExp(`CREATE INDEX IF NOT EXISTS ${AGENT_ASSIGNED_SKILLS_SKILL_INDEX}[\\s\\S]*\\(skill_id\\)`),
    );
  });

  it.each(BOTH)("%s QUOTES the `position` column everywhere (keyword shadowing)", (_name, sql) => {
    // A bare `position` would be shadowed by the position() function in some
    // grammatical positions. Assert no unquoted occurrence outside a comment.
    const bare = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .match(/(?<!")\bposition\b(?!")/g);
    expect(bare).toBeNull();
  });

  it.each(BOTH)("%s carries NO OWNER tuple (the actor-independence invariant)", (_name, sql) => {
    // The scope tuple says WHICH SCOPE a row applies to; it is not an owner
    // predicate, and the read stays actor-independent so an actor-less worker
    // run sees exactly what the settings page wrote for its scopes.
    expect(sql).not.toMatch(/owner_type/);
    expect(sql).not.toMatch(/owner_id/);
  });

  it("the bootstrap emits plain { text } objects (the sync worker structured-clones them)", () => {
    for (const q of agentAssignedSkillsSchemaQueries("cinatra")) {
      expect(Object.keys(q)).toEqual(["text"]);
      expect(typeof q.text).toBe("string");
    }
  });

  it("the bootstrap quotes an adversarial schema name", () => {
    const sql = agentAssignedSkillsSchemaQueries('we"ird')
      .map((q) => q.text)
      .join("\n");
    expect(sql).toContain('"we""ird"');
  });
});

describe("agent_assigned_skills — bootstrap is wired into the store schema builder", () => {
  it("buildCreateStoreSchemaQueries includes the table (a fresh install gets it)", async () => {
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    const all = buildCreateStoreSchemaQueries("cinatra")
      .map((q) => (q as { text: string }).text)
      .join("\n");
    expect(all).toContain('"cinatra"."agent_assigned_skills"');
    expect(all).toMatch(
      /PRIMARY KEY \(agent_package_name, skill_id, scope_kind, scope_id\)/,
    );
  });

  it("a fresh install also gets the artifact twin, keyed on the same tuple rule", async () => {
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    const all = buildCreateStoreSchemaQueries("cinatra")
      .map((q) => (q as { text: string }).text)
      .join("\n");
    expect(all).toContain('"cinatra"."agent_assigned_context"');
    expect(all).toMatch(
      /PRIMARY KEY \(agent_package_name, slot_id, artifact_id, scope_kind, scope_id\)/,
    );
    // The artifact FK is what makes a deleted artifact take its attachments
    // with it, rather than leaving an agent pointing at nothing.
    expect(all).toMatch(/artifact_id text NOT NULL REFERENCES[^,]*ON DELETE CASCADE/);
  });

  it("declares the context table AFTER the resource table its FK references", async () => {
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    const texts = buildCreateStoreSchemaQueries("cinatra").map((q) => (q as { text: string }).text);
    const resource = texts.findIndex((t) =>
      t.includes('CREATE TABLE IF NOT EXISTS "cinatra"."resource"'),
    );
    const context = texts.findIndex((t) =>
      t.includes('CREATE TABLE IF NOT EXISTS "cinatra"."agent_assigned_context"'),
    );
    expect(resource).toBeGreaterThanOrEqual(0);
    expect(context).toBeGreaterThan(resource);
  });

  it("is declared BESIDE custom_skill_assignments, not inside it", async () => {
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    const texts = buildCreateStoreSchemaQueries("cinatra").map((q) => (q as { text: string }).text);
    const custom = texts.findIndex((t) =>
      t.includes('CREATE TABLE IF NOT EXISTS "cinatra"."custom_skill_assignments"'),
    );
    const assigned = texts.findIndex((t) =>
      t.includes('CREATE TABLE IF NOT EXISTS "cinatra"."agent_assigned_skills"'),
    );
    expect(custom).toBeGreaterThanOrEqual(0);
    expect(assigned).toBeGreaterThan(custom);
  });
});

describe("core__0089 — the original migration is untouched by the widening", () => {
  it("is unqualified (it runs with the schema on the search_path)", () => {
    expect(agentAssignedSkillsDdlSql).not.toContain('"cinatra".');
  });

  it("is reversible in the same file", async () => {
    const mod = await import("../../../migrations/core/core__0089_agent-assigned-skills.mjs");
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
    const statements: string[] = [];
    mod.down({ sql: (s: string) => statements.push(s) } as never);
    expect(statements.join("\n")).toMatch(
      new RegExp(`DROP TABLE IF EXISTS ${AGENT_ASSIGNED_SKILLS_TABLE}`),
    );
  });

  it("up() emits exactly the shared DDL string (no hand-copied drift)", async () => {
    const mod = await import("../../../migrations/core/core__0089_agent-assigned-skills.mjs");
    const statements: string[] = [];
    mod.up({ sql: (s: string) => statements.push(s) } as never);
    expect(statements).toEqual([agentAssignedSkillsDdlSql]);
  });
});

describe("core__0100 — the widening migration", () => {
  it("is unqualified (it runs with the schema on the search_path)", () => {
    expect(perScopeAssignmentDdlSql).not.toContain('"cinatra".');
  });

  it("is reversible in the same file", async () => {
    const mod = await import("../../../migrations/core/core__0100_per-scope-assignment-stores.mjs");
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
    const statements: string[] = [];
    mod.down({ sql: (s: string) => statements.push(s) } as never);
    const down = statements.join("\n");
    expect(down).toMatch(/DROP TABLE IF EXISTS agent_assigned_context/);
    expect(down).toMatch(/PRIMARY KEY \(agent_package_name, skill_id\)/);
    // The honest cost, asserted rather than only described: the narrow key
    // cannot hold two scoped rows for one (package, skill), so the revert keeps
    // the tier that existed before this migration and drops the rest.
    expect(down).toMatch(/DELETE FROM agent_assigned_skills WHERE scope_kind <> 'workspace'/);
  });

  it("up() emits exactly the shared DDL string (no hand-copied drift)", async () => {
    const mod = await import("../../../migrations/core/core__0100_per-scope-assignment-stores.mjs");
    const statements: string[] = [];
    mod.up({ sql: (s: string) => statements.push(s) } as never);
    expect(statements).toEqual([perScopeAssignmentDdlSql]);
  });

  it("replaces the position index under a NEW name rather than trying to redefine it", () => {
    // A CREATE ... IF NOT EXISTS under the OLD name would silently keep the
    // package-wide index, which then refuses a second scope's first assignment.
    expect(perScopeAssignmentDdlSql).toMatch(
      /DROP INDEX IF EXISTS agent_assigned_skills_agent_position_key/,
    );
    expect(perScopeAssignmentDdlSql).toContain(AGENT_ASSIGNED_SKILLS_POSITION_INDEX);
  });

  it("carries the snapshot column onto BOTH creation surfaces", () => {
    expect(perScopeAssignmentDdlSql).toMatch(
      /ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS assignment_scope_snapshot jsonb/,
    );
    expect(perScopeAssignmentDdlSql).toMatch(
      /ALTER TABLE assistant_threads ADD COLUMN IF NOT EXISTS assignment_scope_snapshot jsonb/,
    );
  });

  it("backfills every pre-existing row to the WORKSPACE tier and nothing else", () => {
    // A package-global assignment is by definition one that applied everywhere,
    // and workspace is the tier that still means that. Nothing is invented.
    expect(perScopeAssignmentDdlSql).toMatch(
      /UPDATE agent_assigned_skills SET scope_kind = 'workspace' WHERE scope_kind IS NULL/,
    );
    expect(perScopeAssignmentDdlSql).toMatch(
      /UPDATE agent_assigned_skills SET source = 'manual' WHERE source IS NULL/,
    );
  });
});

describe("migration manifest fragments", () => {
  it("core__0089 declares the seq, the runner file and the table, and is NON-destructive", async () => {
    const fragment = (
      await import("../../../migrations/manifest.d/core__0089_agent-assigned-skills.json", {
        with: { type: "json" },
      })
    ).default as { seq: string; file: string; destructive: boolean; tables: string[] };
    expect(fragment.seq).toBe("0089");
    expect(fragment.file).toBe("core/core__0089_agent-assigned-skills.mjs");
    expect(fragment.destructive).toBe(false);
    expect(fragment.tables).toEqual(["agent_assigned_skills"]);
  });

  it("core__0100 declares its seq, runner file and every table it touches", async () => {
    const fragment = (
      await import("../../../migrations/manifest.d/core__0100_per-scope-assignment-stores.json", {
        with: { type: "json" },
      })
    ).default as { seq: string; file: string; destructive: boolean; tables: string[] };
    expect(fragment.seq).toBe("0100");
    expect(fragment.file).toBe("core/core__0100_per-scope-assignment-stores.mjs");
    // A PRIMARY KEY change and an index replacement: the convention's
    // classifier calls that destructive, and that classification is not argued
    // with here even though the forward migration deletes no row.
    expect(fragment.destructive).toBe(true);
    expect(fragment.tables).toEqual([
      "agent_assigned_skills",
      "agent_assigned_context",
      "agent_runs",
      "assistant_threads",
    ]);
  });
});
