// DDL parity for `agent_assigned_skills` (cinatra#2346 S1, epic #2345).
//
// The table has TWO homes that must agree: the fresh-install bootstrap DDL
// (`agentAssignedSkillsSchemaQueries`, spread into
// `buildCreateStoreSchemaQueries`) and the operator-upgrade migration
// (`migrations/core/core__0089`). A fresh install that gets the table while an
// upgraded instance does not — or the reverse — is a silent split-brain: every
// assignment write fails on one and succeeds on the other.
//
// The BEHAVIORAL two-arm proof (fresh bootstrap vs migration, against a real
// Postgres) lives in
// `src/lib/__tests__/integration/agent-assigned-skills.integration.test.ts`;
// this suite pins the SHAPE so a drift is caught without a database.
import { describe, expect, it } from "vitest";

import {
  AGENT_ASSIGNED_SKILLS_POSITION_INDEX,
  AGENT_ASSIGNED_SKILLS_SKILL_INDEX,
  AGENT_ASSIGNED_SKILLS_TABLE,
  agentAssignedSkillsSchemaQueries,
} from "@/lib/agent-assigned-skills-schema";
import { agentAssignedSkillsDdlSql } from "../../../migrations/core/core__0089_agent-assigned-skills.mjs";

const bootstrap = agentAssignedSkillsSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");

const BOTH: Array<[string, string]> = [
  ["fresh-install bootstrap", bootstrap],
  ["operator-upgrade migration", agentAssignedSkillsDdlSql],
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

  it.each(BOTH)("%s keys the table on (agent_package_name, skill_id)", (_name, sql) => {
    expect(sql).toMatch(/PRIMARY KEY \(agent_package_name, skill_id\)/);
  });

  it.each(BOTH)("%s backs the cap with UNIQUE (agent_package_name, position)", (_name, sql) => {
    expect(sql).toMatch(
      new RegExp(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${AGENT_ASSIGNED_SKILLS_POSITION_INDEX}[\\s\\S]*\\(agent_package_name, "position"\\)`,
      ),
    );
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

  it.each(BOTH)("%s carries NO owner tuple (the actor-independence invariant)", (_name, sql) => {
    // `custom_skill_assignments` is owner-scoped and therefore invisible to
    // actor-less worker runs. This table must never grow that shape by accident.
    expect(sql).not.toMatch(/owner_type/);
    expect(sql).not.toMatch(/owner_id/);
    expect(sql).not.toMatch(/organization_id/);
  });

  it("the bootstrap emits plain { text } objects (the sync worker structured-clones them)", () => {
    for (const q of agentAssignedSkillsSchemaQueries("cinatra")) {
      expect(Object.keys(q)).toEqual(["text"]);
      expect(typeof q.text).toBe("string");
    }
  });

  it("the bootstrap schema-qualifies and quotes the schema name", () => {
    const odd = agentAssignedSkillsSchemaQueries('we"ird').map((q) => q.text).join("\n");
    expect(odd).toContain('"we""ird"."agent_assigned_skills"');
  });

  it("the migration is unqualified (it runs with the schema on the search_path)", () => {
    expect(agentAssignedSkillsDdlSql).not.toContain('"cinatra".');
  });

  it("the migration is reversible in the same file", async () => {
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

describe("agent_assigned_skills — bootstrap is wired into the store schema builder", () => {
  it("buildCreateStoreSchemaQueries includes the table (a fresh install gets it)", async () => {
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    const all = buildCreateStoreSchemaQueries("cinatra")
      .map((q) => (q as { text: string }).text)
      .join("\n");
    expect(all).toContain('"cinatra"."agent_assigned_skills"');
    expect(all).toMatch(/PRIMARY KEY \(agent_package_name, skill_id\)/);
  });

  it("is declared BESIDE custom_skill_assignments, not inside it", async () => {
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    const texts = buildCreateStoreSchemaQueries("cinatra").map((q) => (q as { text: string }).text);
    const custom = texts.findIndex((t) => t.includes('CREATE TABLE IF NOT EXISTS "cinatra"."custom_skill_assignments"'));
    const assigned = texts.findIndex((t) => t.includes('CREATE TABLE IF NOT EXISTS "cinatra"."agent_assigned_skills"'));
    expect(custom).toBeGreaterThanOrEqual(0);
    expect(assigned).toBeGreaterThan(custom);
  });
});

describe("migration manifest fragment", () => {
  it("declares the seq, the runner file and the table, and is NON-destructive", async () => {
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
});
