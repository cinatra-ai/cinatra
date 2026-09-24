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
import { beforeAll, describe, expect, it } from "vitest";

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

// ---------------------------------------------------------------------------
// cinatra#3649 — the bootstrap over a table that already exists NARROW.
//
// Measured: a checkout bootstrap replayed statement by statement stopped at
// statement 641 of 920, the scope position index, with `column "scope_kind"
// does not exist`, and the table it left behind had exactly the five columns
// core__0089 creates. The list's first statement on this table is the WIDE
// `CREATE TABLE IF NOT EXISTS`, which is a no-op over a table that already
// exists, and nothing after it added the scope columns. The boot and the CLI's
// setup both run this bootstrap BEFORE the versioned chain, so core__0100 never
// got the chance to widen the table either.
//
// The replay below walks the REAL statement list and tracks, from each
// statement's text, which columns the table has when that statement runs:
// once from an empty schema, once from the narrow table core__0089 creates.
// The bootstrap now adds the four columns with core__0100's own first
// statement. The rest of core__0100 (backfill, NOT NULL, key, checks, foreign
// key, position-index swap) is destructive, so it stays in the migration,
// which the chain applies right after the bootstrap.
// ---------------------------------------------------------------------------

/** Removes `--` line comments (none of these texts has `--` inside a literal). */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** The top-level statements of a script: split on `;` outside a string
 *  literal and outside a `$$ … $$` body. */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inLiteral = false;
  let inBody = false;
  for (let i = 0; i < sql.length; i++) {
    if (!inLiteral && sql.startsWith("$$", i)) {
      inBody = !inBody;
      current += "$$";
      i++;
      continue;
    }
    const ch = sql[i];
    if (!inBody && ch === "'") inLiteral = !inLiteral;
    if (!inLiteral && !inBody && ch === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/** One spelling for two layouts of the same statement. */
function normalizeSql(sql: string): string {
  return stripSqlComments(sql)
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim()
    .replace(/;$/, "");
}

/** The column names a CREATE TABLE body declares; table constraints skipped. */
function createTableColumns(statement: string): string[] {
  const sql = stripSqlComments(statement);
  const body = sql.slice(sql.indexOf("(") + 1, sql.lastIndexOf(")"));
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items
    .map((item) => item.trim())
    .filter(
      (item) =>
        item.length > 0 && !/^(PRIMARY KEY|CONSTRAINT|UNIQUE|CHECK|FOREIGN KEY)\b/i.test(item),
    )
    .map((item) => item.split(/\s+/)[0].replaceAll('"', ""));
}

const SCHEMA = "cinatra";

const NARROW_COLUMNS = createTableColumns(
  splitSqlStatements(stripSqlComments(agentAssignedSkillsDdlSql)).find((sql) =>
    /^CREATE TABLE\b/i.test(sql),
  ) ?? "",
);

const WIDE_COLUMNS = createTableColumns(agentAssignedSkillsSchemaQueries(SCHEMA)[0].text);

/** Replays every statement of `texts` that names the table and reports each
 *  statement that needs a column the table does not have at that point — the
 *  error the field replay hit — plus the columns the table ends with. */
function replayAssignedSkillsColumns(
  texts: readonly string[],
  start: readonly string[] | null,
): { columns: string[] | null; findings: string[] } {
  const vocabulary = [...new Set([...NARROW_COLUMNS, ...WIDE_COLUMNS])];
  let columns: Set<string> | null = start === null ? null : new Set(start);
  const findings: string[] = [];
  for (const [index, text] of texts.entries()) {
    if (!text.includes(AGENT_ASSIGNED_SKILLS_TABLE)) continue;
    const at = `statement ${index + 1}/${texts.length}`;
    const sql = stripSqlComments(text);
    if (/^\s*CREATE TABLE IF NOT EXISTS\b/i.test(sql)) {
      // Over an existing table this is a no-op: its column list is never read.
      if (columns === null) columns = new Set(createTableColumns(sql));
      continue;
    }
    if (columns === null) {
      findings.push(`${at} touches the table before any statement creates it`);
      continue;
    }
    const added = [...sql.matchAll(/ADD COLUMN IF NOT EXISTS\s+"?(\w+)"?/gi)].map((m) => m[1]);
    for (const name of vocabulary) {
      if (added.includes(name) || columns.has(name)) continue;
      if (new RegExp(`\\b${name}\\b`).test(sql)) {
        findings.push(
          `${at} needs column "${name}", which the table does not have there: ${normalizeSql(sql).slice(0, 110)}`,
        );
      }
    }
    for (const name of added) columns.add(name);
  }
  return { columns: columns === null ? null : [...columns].sort(), findings };
}

/** The bootstrap's schema-qualified spelling, read the way the migration
 *  spells it with the schema on the search_path. */
function unqualify(sql: string): string {
  return sql
    .replaceAll(`"${SCHEMA}".`, "")
    .replaceAll(`"${AGENT_ASSIGNED_SKILLS_TABLE}"`, AGENT_ASSIGNED_SKILLS_TABLE);
}

describe("agent_assigned_skills — the bootstrap over a table that already exists narrow (cinatra#3649)", () => {
  let texts: string[] = [];

  beforeAll(async () => {
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    texts = buildCreateStoreSchemaQueries(SCHEMA).map((q) => (q as { text: string }).text);
  });

  it("reads the two shapes the replay starts from", () => {
    expect(NARROW_COLUMNS).toEqual([
      "agent_package_name",
      "skill_id",
      "position",
      "created_by",
      "created_at",
    ]);
    expect([...WIDE_COLUMNS].sort()).toEqual([
      "agent_package_name",
      "created_at",
      "created_by",
      "origin_run_id",
      "position",
      "scope_id",
      "scope_kind",
      "skill_id",
      "source",
    ]);
  });

  it("from an EMPTY schema the list creates the table wide and no statement misses a column", () => {
    const replay = replayAssignedSkillsColumns(texts, null);
    expect(replay.findings).toEqual([]);
    expect(replay.columns).toEqual([...WIDE_COLUMNS].sort());
  });

  it("from the NARROW core__0089 table the list adds the four columns before any statement needs them", () => {
    const replay = replayAssignedSkillsColumns(texts, NARROW_COLUMNS);
    expect(replay.findings).toEqual([]);
    expect(replay.columns).toEqual([...WIDE_COLUMNS].sort());
  });

  it("adds them with core__0100's own first statement and carries none of its destructive steps", () => {
    const createsSomething = (sql: string) => /^CREATE (TABLE|UNIQUE INDEX|INDEX)\b/i.test(sql);
    // What core__0100 does to this table besides creating indexes, in order:
    // the additive ADD COLUMN, then the destructive widening.
    const migration = splitSqlStatements(stripSqlComments(perScopeAssignmentDdlSql))
      .map(normalizeSql)
      .filter((sql) => sql.includes(AGENT_ASSIGNED_SKILLS_TABLE) && !createsSomething(sql));
    const bootstrapOwn = agentAssignedSkillsSchemaQueries(SCHEMA)
      .map((q) => normalizeSql(unqualify(q.text)))
      .filter((sql) => !createsSomething(sql));
    expect(migration[0]).toMatch(
      /^ALTER TABLE agent_assigned_skills ADD COLUMN IF NOT EXISTS scope_kind text,/,
    );
    expect(migration.length).toBeGreaterThan(1);
    expect(bootstrapOwn).toEqual([migration[0]]);
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
