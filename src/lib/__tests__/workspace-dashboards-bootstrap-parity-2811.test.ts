// THE TWO HALVES OF `core__0108` (cinatra#2811, per-scope surfaces S5).
//
// A migration alone is not a fresh install. Setup ledger-fakes the whole
// migration chain, so a schema created by the bootstrap DDL never runs
// `core__0108` and would simply lack everything it adds. A bootstrap alone is
// not an upgrade either: a running instance never re-runs the bootstrap DDL.
// There are therefore TWO copies of the same twelve statements: the migration
// under `migrations/core/` and the bootstrap in `src/lib/drizzle-store.ts`.
// This suite is what keeps them from drifting.
//
// ── IT COMPARES WHAT RUNS, NOT WHAT IS WRITTEN ─────────────────────────────
// Both sides are taken from their own EXECUTION ENTRY POINT, never from the
// file text:
//   - the migration's, by calling `up()` with a recording builder, so a second
//     `pgm.sql(…)` call is seen even if it names no exported constant;
//   - the bootstrap's, by calling `buildCreateStoreSchemaQueries()`, so a twin
//     that is present in the file but commented out, in any comment form,
//     cannot satisfy a lookup, and a statement that is genuinely executed
//     cannot be missed.
// A text search over either file would prove neither.
//
// ── ONE COMPARABLE FORM, AND WHAT IT MAY NOT TOUCH ─────────────────────────
// The two halves differ systematically in two ways and no others: the bootstrap
// qualifies every table with the runtime schema name, and it quotes its
// identifiers. `canonical` removes exactly those, then makes whitespace
// insignificant the way SQL does, but never INSIDE a string literal, which is
// masked first. Normalizing inside a literal could make two predicates that
// accept different values compare equal, which is the one thing this suite must
// not do.

import { describe, expect, it } from "vitest";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

import {
  up as migrationUp,
  WORKSPACE_ENTITY_ID,
} from "../../../migrations/core/core__0108_workspace-dashboards.mjs";

/** A schema name no identifier in either half can collide with. */
const SCHEMA = "parity_probe_2811";

/**
 * One comparable form. Strips the bootstrap's schema qualification and its
 * identifier quoting, then collapses whitespace and the spacing around SQL
 * punctuation, with every single-quoted literal MASKED, so no normalization
 * step can reach inside one. `''` is SQL's own escape for a quote in a literal.
 */
function canonical(sql: string): string {
  // ONE literal in either half legitimately carries a schema-qualified table
  // name: the `::regclass` lookup. It is normalized FIRST, by its exact shape,
  // because no VALUE literal can take that shape, and because everything after
  // this line must leave literals alone.
  const deregclassed = sql.replace(
    new RegExp(`'"${SCHEMA}"\\."([A-Za-z_][A-Za-z0-9_]*)"'`, "g"),
    "'$1'",
  );

  // Mask every remaining literal BEFORE any other rewrite. Unqualifying or
  // unquoting first would reach inside one, and could make two predicates that
  // accept DIFFERENT values compare equal: for instance `'workspace'` and
  // `'"workspace"'`, or `'__workspace__'` and `'<schema>.__workspace__'`.
  const literals: string[] = [];
  const masked = deregclassed.replace(/'(?:[^']|'')*'/g, (match) => {
    literals.push(match);
    return `\u0000${literals.length - 1}\u0000`;
  });

  return masked
    .replaceAll(`"${SCHEMA}".`, "")
    .replaceAll(`${SCHEMA}.`, "")
    // Quoted IDENTIFIERS only, outside a literal, which is now masked.
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),;])\s*/g, "$1")
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => literals[Number(i)]!);
}


/** Split SQL into statements, honouring `$$ … $$` bodies (which hold `;`). */
function statements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let inDollar = false;
  for (let i = 0; i < sql.length; i += 1) {
    if (sql.startsWith("$$", i)) {
      inDollar = !inDollar;
      current += "$$";
      i += 1;
      continue;
    }
    if (sql[i] === ";" && !inDollar) {
      out.push(current);
      current = "";
      continue;
    }
    current += sql[i];
  }
  out.push(current);
  return out.map(canonical).filter((s) => s.length > 0);
}

/** Every SQL text the migration's `up` actually hands the runner. */
const migrationSql: string[] = (() => {
  const captured: string[] = [];
  (migrationUp as (pgm: { sql: (text: string) => void }) => void)({
    sql: (text) => captured.push(String(text)),
  });
  return captured;
})();

/** Every statement the bootstrap actually executes on a fresh schema. */
const bootstrapStatements: string[] = buildCreateStoreSchemaQueries(SCHEMA).map(
  (q: { text: string }) => canonical(q.text),
);
const bootstrap = bootstrapStatements.join("\n");

/**
 * The precondition block is the one statement that adds no catalog object: it
 * counts rows an upgrade might already hold and refuses loudly. A fresh schema
 * holds none, so it has no bootstrap twin by design, and a test below PROVES
 * it creates nothing rather than assuming it.
 */
const isPrecondition = (statement: string) => statement.includes("RAISE EXCEPTION");

const allUpStatements: string[] = migrationSql.flatMap(statements);
const migrationStatements: string[] = allUpStatements.filter((s) => !isPrecondition(s));

/** Find the one statement that carries a named artifact. */
function statementFor(name: string): string {
  const found = migrationStatements.filter((s) => s.includes(name));
  expect(found, `the migration carries exactly one statement for ${name}`).toHaveLength(1);
  return found[0]!;
}

const CHECK_NAMES = [
  "dashboards_workspace_entity_org_check",
  "dashboards_workspace_entity_shape_check",
  "dashboard_entity_links_workspace_scope_check",
  "dashboard_entity_links_workspace_grant_check",
];
const INDEX_NAMES = [
  "dashboards_workspace_entity_idx",
  "dashboards_workspace_entity_default_uniq",
  "dashboards_workspace_entity_name_uniq",
];
const GRANT_COLUMNS = [
  "workspace_read_granted",
  "workspace_read_granted_by",
  "workspace_read_granted_at",
];

describe("core__0108's bootstrap twin", () => {
  it("reads both halves from the code that RUNS them", () => {
    // A guard on the guard: a capture that silently yielded nothing would make
    // every assertion below vacuously true.
    expect(migrationSql.length).toBeGreaterThan(0);
    expect(bootstrapStatements.length).toBeGreaterThan(100);
    expect(allUpStatements).toHaveLength(13);
    expect(migrationStatements).toHaveLength(12);
  });

  it("holds the splitter's and the normalizer's assumptions as CHECKED facts", () => {
    const migrationText = migrationSql.join("\n");
    // The splitter understands untagged `$$` bodies only, and the normalizer
    // unquotes identifier-shaped spans. Both are safe here because neither half
    // uses a tagged dollar quote, a dash comment, or a quoted span that is not
    // an identifier. That is asserted rather than assumed, so a future edit that
    // introduces one fails HERE instead of comparing two statements the
    // normalizer quietly made equal.
    expect(migrationText).not.toMatch(/\$[A-Za-z_]\w*\$/);
    expect(migrationText).not.toContain("--");
    expect(migrationText).not.toContain('"');
    // On the bootstrap side every remaining quote must have been an identifier:
    // after canonicalization none may survive, in a literal or anywhere else.
    const dashboardsDdl = bootstrapStatements.filter((s) => s.includes("dashboard"));
    expect(dashboardsDdl.length).toBeGreaterThan(0);
    expect(dashboardsDdl.filter((s) => s.includes('"'))).toEqual([]);
  });

  it("keeps two statements apart when they differ only inside a literal", () => {
    // The normalizer's own kill-test. Masking is what makes these three pairs
    // stay distinct; rewriting before masking would collapse each one.
    const a = canonical(`CHECK (entity_type = 'workspace')`);
    const b = canonical(`CHECK (entity_type = '"workspace"')`);
    const c = canonical(`CHECK (entity_id = '${SCHEMA}.__workspace__')`);
    const d = canonical(`CHECK (entity_id = '__workspace__')`);
    const e = canonical(`CHECK (name = 'a, b')`);
    const f = canonical(`CHECK (name = 'a,b')`);
    expect(a).not.toBe(b);
    expect(c).not.toBe(d);
    expect(e).not.toBe(f);
    // …while the difference it IS there to remove still collapses.
    expect(canonical(`ALTER TABLE  "${SCHEMA}"."dashboards"   ADD x`)).toBe(
      canonical("ALTER TABLE dashboards ADD x"),
    );
  });

  it("escapes a schema name for BOTH the identifier and the literal it sits in", () => {
    // The `::regclass` lookup is the one place the bootstrap nests a schema
    // name inside a single-quoted literal, so it needs the literal's own escape
    // as well as the identifier's. Without it a schema name carrying an
    // apostrophe builds SQL that cannot parse, and the cold boot fails.
    const awkward = `wei'rd"schema`;
    const built = buildCreateStoreSchemaQueries(awkward)
      .map((q: { text: string }) => q.text)
      .filter((t) => t.includes("::regclass") && t.includes("dashboard_entity_links"));
    expect(built).toHaveLength(1);
    // BOTH escapes: the apostrophe doubled for the enclosing literal, the
    // double quote doubled for the identifier inside it.
    expect(built[0]).toContain(`'"wei''rd""schema"."dashboard_entity_links"'::regclass`);
  });

  it("excludes only the precondition, and proves it creates no catalog object", () => {
    const precondition = allUpStatements.filter(isPrecondition);
    expect(precondition).toHaveLength(1);
    // A fresh schema has no rows to refuse, so this one statement is the only
    // thing a fresh install may legitimately lack. It may therefore not create
    // or alter a catalog object. If it ever did, the twin would owe it.
    // Case-insensitive: a lowercase `alter table` creates just as much.
    expect(precondition[0]).not.toMatch(
      /\b(ALTER\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|ADD\s+CONSTRAINT|CREATE\s+TABLE|DROP\s+)/i,
    );
  });

  it("drops NOT NULL from the dashboards tenant column in both halves", () => {
    const statement = statementFor("DROP NOT NULL");
    expect(statement).toContain("ALTER TABLE dashboards ALTER COLUMN organization_id DROP NOT NULL");
    expect(bootstrap).toContain(statement);
  });

  it.each(CHECK_NAMES)("carries the CHECK %s with the migration's own definition", (name) => {
    const statement = statementFor(name);
    // The whole statement, so the CHECK's BODY travels with its name: a twin
    // guarding a different predicate under the same name is exactly the drift
    // this suite exists to catch.
    expect(statement).toContain("CHECK(");
    expect(bootstrap).toContain(statement);
  });

  it.each(INDEX_NAMES)("carries the index %s with its partial predicate", (name) => {
    const statement = statementFor(name);
    expect(bootstrap).toContain(statement);
    // The partial predicate is what keeps the twin apart from the org-keyed
    // original: without `organization_id IS NULL` the twin could collide with
    // an organization row.
    expect(statement).toContain("entity_type IS NOT NULL");
    expect(statement).toMatch(/WHERE .*organization_id IS NULL$/);
  });

  it.each(GRANT_COLUMNS)("carries the grant column %s additively", (column) => {
    const statement = statementFor(`ADD COLUMN IF NOT EXISTS ${column} `);
    expect(bootstrap).toContain(statement);
  });

  it("widens the links CHECK to admit workspace, and replaces it only while it lacks the word", () => {
    const statement = statementFor("LIKE '%workspace%'");
    expect(statement).toContain("CHECK(entity_type IN('team','organization','project','workspace'))");
    // The guard is part of the twin: without it a bootstrap re-run would drop
    // and re-add a constraint the schema already holds.
    expect(bootstrap).toContain(statement);
  });

  it("names the same workspace entity id on both sides", () => {
    expect(WORKSPACE_ENTITY_ID).toBe("__workspace__");
    expect(bootstrap).toContain(`entity_id IS NOT DISTINCT FROM '${WORKSPACE_ENTITY_ID}'`);
    expect(bootstrap).toContain(
      `entity_type <> 'workspace' OR entity_id = '${WORKSPACE_ENTITY_ID}'`,
    );
  });

  it("gives EVERY migration statement a bootstrap twin: the complete-set assertion", () => {
    // The tests above say WHICH artifact drifted; this one guarantees the
    // roster is complete, so a statement added to the migration tomorrow cannot
    // pass merely by being on no test's list.
    const missing = migrationStatements.filter(
      (statement) => !bootstrapStatements.some((b) => b.includes(statement)),
    );
    expect(missing).toEqual([]);
  });

  it("covers every named artifact with a statement: the roster is the migration's", () => {
    // Each key identifies its statement uniquely: a bare column name also
    // appears inside the grant CHECK, so the columns are keyed on their own
    // ADD COLUMN clause.
    const keys = [
      "DROP NOT NULL",
      ...CHECK_NAMES,
      ...INDEX_NAMES,
      ...GRANT_COLUMNS.map((c) => `ADD COLUMN IF NOT EXISTS ${c} `),
      "LIKE '%workspace%'",
    ];
    for (const key of keys) expect(statementFor(key)).toBeTruthy();
    // Twelve statements: one nullability change, four CHECKs, three indexes,
    // three grant columns, and the links CHECK widening.
    expect(keys).toHaveLength(12);
  });
});
