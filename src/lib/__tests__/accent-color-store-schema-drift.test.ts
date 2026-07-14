import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { getSchema } from "better-auth/db";
import { buildMigrationAuthOptions } from "../../../scripts/better-auth-migrate.mts";

// ---------------------------------------------------------------------------
// Runtime-query ↔ Better Auth user-schema drift guard (cinatra#1497).
//
// `src/lib/accent-color-store.ts` issues raw SQL against `public."user"`
// (`SELECT accent_color ... WHERE id`, `UPDATE ... SET accent_color ...`).
// The `accent_color` column exists ONLY because `src/lib/better-auth-schema.ts`
// declares the `accentColor` additionalField, which Better Auth's migration
// runner provisions. If anyone drops that field (or renames the column) while
// leaving the raw SQL, every authenticated render regresses to logging
// `column "accent_color" does not exist` in Postgres — the exact #1497 bug.
//
// This test asserts, source-level, that every `public."user"` column the store
// references is DECLARED in the Better Auth user schema (the single source of
// truth the bootstrap migration builds from). It intentionally reads the store
// as text rather than importing it — the module is `server-only` and pulls a
// live DB pool. It complements `better-auth-schema.test.ts` (runtime↔migration
// schema parity) by tying the runtime *queries* to that same schema.
// ---------------------------------------------------------------------------

// DB column names Better Auth declares on the `user` table: `fieldName` when
// pinned (e.g. accentColor → accent_color), else the field key. `id` is the
// implicit primary key (not enumerated in `fields`) and is always present.
function declaredUserColumns(): Set<string> {
  const schema = getSchema(buildMigrationAuthOptions()) as Record<
    string,
    { fields?: Record<string, { fieldName?: string }> }
  >;
  const fields = schema.user?.fields ?? {};
  const columns = new Set<string>(["id"]);
  for (const [key, attr] of Object.entries(fields)) {
    columns.add(attr?.fieldName ?? key);
  }
  return columns;
}

// Isolate the raw-SQL template literals that actually target `public."user"`
// (the SELECT and the UPDATE). Statements against other relations — the
// `information_schema` existence probe, the `extension_accent_color` table —
// do NOT contain the `public."user"` token, so scoping here keeps their
// columns (`table_schema`, `extension_id`, ...) out of the assertion.
function userTableStatements(source: string): string[] {
  const statements: string[] = [];
  for (const m of source.matchAll(/`([^`]*)`/g)) {
    if (m[1].includes('public."user"')) statements.push(m[1]);
  }
  return statements;
}

// Pull the `public."user"` column identifiers the store's raw SQL references:
// SELECT-list targets, UPDATE SET targets, and WHERE predicate columns.
function referencedUserColumns(source: string): Set<string> {
  const columns = new Set<string>();

  for (const stmt of userTableStatements(source)) {
    // SELECT <cols> FROM public."user"
    const select = /SELECT\s+([\s\S]+?)\s+FROM\s+public\."user"/i.exec(stmt);
    if (select) {
      for (const raw of select[1].split(",")) {
        const col = raw.trim().replace(/^"|"$/g, "");
        if (/^[a-z_][a-z0-9_]*$/i.test(col)) columns.add(col);
      }
    }

    // UPDATE public."user" SET <col> = ...
    const update = /UPDATE\s+public\."user"\s+SET\s+([a-z_][a-z0-9_]*)/i.exec(
      stmt,
    );
    if (update) columns.add(update[1]);

    // ... WHERE <col> = ...  (predicate columns of this public."user" statement)
    for (const m of stmt.matchAll(/WHERE\s+([a-z_][a-z0-9_]*)\s*=/gi)) {
      columns.add(m[1]);
    }
  }

  return columns;
}

const STORE_SOURCE = readFileSync(
  fileURLToPath(new URL("../accent-color-store.ts", import.meta.url)),
  "utf8",
);

describe("accent-color-store raw SQL ↔ Better Auth user schema (cinatra#1497)", () => {
  it("declares public.\"user\".accent_color in the Better Auth schema", () => {
    // Load-bearing anti-regression assertion: this fails the moment the
    // `accentColor` additionalField is removed from better-auth-schema.ts,
    // which is exactly what left the runtime SELECT referencing a missing
    // column in the first place.
    expect(declaredUserColumns().has("accent_color")).toBe(true);
  });

  it("references only user columns present in the Better Auth schema", () => {
    const declared = declaredUserColumns();
    const referenced = referencedUserColumns(STORE_SOURCE);

    // Sanity: the extractor actually found the columns under test.
    expect(referenced.has("accent_color")).toBe(true);
    expect(referenced.has("id")).toBe(true);

    const missing = [...referenced].filter((col) => !declared.has(col));
    expect(
      missing,
      `accent-color-store.ts references public."user" column(s) not declared ` +
        `in the Better Auth schema: ${missing.join(", ")}. Add the field to ` +
        `cinatraAuthAdditionalUserFields (src/lib/better-auth-schema.ts) or ` +
        `remove/guard the query.`,
    ).toEqual([]);
  });
});
