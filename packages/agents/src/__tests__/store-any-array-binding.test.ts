/**
 * Regression guard for the `ANY(${array})` Drizzle pitfall in
 * `readEffectiveExtensionStatusByIdentity`.
 *
 * Background: Drizzle's `sql` tag spreads a JS array `${arr}` as a tuple of
 * positional parameters (`($1, $2, ...)`). Inside `ANY(...)` Postgres parses
 * that as a row-expression and rejects with `42809 op ANY/ALL (array) requires
 * array on right side`. The fix is `ANY(ARRAY[${sql.join(names.map((n) =>
 * sql\`${n}\`), sql\`, \`)}])` — one bind param per element, real Postgres
 * array on the RHS.
 *
 * Two tests:
 *   1. **Behavioral** — render the SQL via `PgDialect().sqlToQuery()` and
 *      assert the actual emitted form (this catches a regression even if
 *      someone refactors the helper or renames it).
 *   2. **Narrow source gate** — ban the two known-broken shapes anywhere
 *      in `packages/agents/src/store.ts` (defense-in-depth — fails
 *      immediately on a copy-paste of the broken pattern, before the
 *      behavioral test even runs).
 */
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { _buildEffectiveStatusByIdentityQuery } from "../store";

describe("readEffectiveExtensionStatusByIdentity — ANY(array) binding (behavioral)", () => {
  const dialect = new PgDialect();

  it("emits `ANY(ARRAY[$1, $2, $3])` and one positional param per name", () => {
    const q = dialect.sqlToQuery(
      _buildEffectiveStatusByIdentityQuery("cinatra", ["a", "b", "c"]),
    );
    expect(q.sql).toMatch(/ANY\(ARRAY\[\s*\$1\s*,\s*\$2\s*,\s*\$3\s*\]\)/);
    expect(q.params).toEqual(["a", "b", "c"]);
  });

  it("never emits the tuple-style `ANY(($1, $2, $3))` that crashes Postgres", () => {
    const q = dialect.sqlToQuery(
      _buildEffectiveStatusByIdentityQuery("cinatra", ["x", "y"]),
    );
    expect(q.sql).not.toMatch(/ANY\(\(\$1[^)]*\)\)/);
  });

  it("never emits the `ANY(${X}::text[])` cast-doesn't-save-you shape", () => {
    const q = dialect.sqlToQuery(
      _buildEffectiveStatusByIdentityQuery("cinatra", ["x"]),
    );
    expect(q.sql).not.toMatch(/ANY\([^)]+::text\[\]\)/);
  });

  it("safely escapes a non-default schema name in the FROM clause", () => {
    // The fix preserves the `sql.raw(...)` schema interpolation path with
    // double-quote escaping. Verify a tricky schema name lands quoted.
    const q = dialect.sqlToQuery(
      _buildEffectiveStatusByIdentityQuery('cin"atra', ["x"]),
    );
    // `"` inside the identifier must be doubled per Postgres identifier rules.
    expect(q.sql).toContain('"cin""atra"."installed_extension"');
  });
});

describe("packages/agents/src/store.ts — narrow source gate for known-broken ANY shapes", () => {
  const SOURCE_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "store.ts",
  );
  const source = readFileSync(SOURCE_PATH, "utf8");

  it("does not contain the bare `ANY(${names})` shape (the original bug)", () => {
    expect(source).not.toMatch(/ANY\(\s*\$\{\s*names\s*\}\s*\)/);
  });

  it("does not contain `ANY(${toPgTextArrayLiteral(...)}::text[])`, which still relies on a spread-before-cast shape", () => {
    expect(source).not.toMatch(
      /ANY\(\s*\$\{[^}]*toPgTextArrayLiteral[^}]*\}\s*::text\[\]\s*\)/,
    );
  });

  it("does not contain a bare `ANY(${X}::text[])` shape for any identifier (Drizzle spreads + cast does NOT save you)", () => {
    // Allow the long-form helper-call form via the more specific `toPg…` test
    // above; this gate catches `ANY(${arr}::text[])` where the JS variable is
    // a bare array identifier, which Drizzle spreads before Postgres sees the
    // cast.
    const banned = source.match(/ANY\(\s*\$\{\s*[A-Za-z_]\w*\s*\}\s*::text\[\]\s*\)/g);
    expect(banned, `Source contains banned bare-array ANY shape(s): ${banned?.join(", ") ?? ""}`).toBeNull();
  });
});
