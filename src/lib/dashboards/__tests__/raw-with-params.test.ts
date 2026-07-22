// Bridge contract tests for `rawWithParams` (cinatra#1894, epic #1883 §D7 / B1b).
//
// Two axes:
//   1. SQL-AWARENESS (delta D1 — the codex-r2 REBUT fix): a `$n` is spliced as a
//      parameter ONLY outside single-quoted literals, dollar-quoted bodies, and
//      `--`/`/* */` comments; repeated params, `$10`-vs-`$1` longest-run, and
//      `::casts` are preserved. Each case is rendered DB-free through
//      `PgDialect.sqlToQuery` and asserted for exact SQL + param multiset.
//   2. REAL-BUILDER ROUND-TRIP (drift guard): the actual host substrate builder
//      the twin reuses verbatim (`buildBindingReconcileQueries`) is round-tripped
//      so a future change to its `{ text, values }` shape that the bridge could
//      mis-splice fails CI here.
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Keep the real-builder import light + hermetic (no Postgres): the builder
// FUNCTION is pure, but its module pulls the postgres config/init/sync trio.
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: vi.fn() }));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));

import { rawWithParams } from "@/lib/dashboards/raw-with-params";
import { buildBindingReconcileQueries } from "@/lib/objects/binding-write-path";

const dialect = new PgDialect();

/** Render a bridged SQL to its final `{ sql, params }` without a DB. */
function render(text: string, values: readonly unknown[]): { sql: string; params: unknown[] } {
  const built: SQL = rawWithParams(text, values);
  const { sql, params } = dialect.sqlToQuery(built);
  return { sql, params };
}

describe("rawWithParams — SQL-aware placeholder splicing (D1)", () => {
  it("does NOT splice a $n inside a single-quoted literal, but does the real $1", () => {
    // The codex-r2 failing input: a naive /\$(\d+)/g binds inside '$1'.
    const { sql, params } = render("SELECT '$1', $1::int", ["x"]);
    expect(sql).toBe("SELECT '$1', $1::int");
    expect(params).toEqual(["x"]);
  });

  it("treats '' as an embedded-quote escape (literal stays literal)", () => {
    const { sql, params } = render("SELECT 'it''s $1 here', $1", ["v"]);
    expect(sql).toBe("SELECT 'it''s $1 here', $1");
    expect(params).toEqual(["v"]);
  });

  it("does NOT splice a $n inside a dollar-quoted body ($$…$$)", () => {
    const { sql, params } = render("SELECT $$ $1 body $$, $1::text", ["y"]);
    expect(sql).toBe("SELECT $$ $1 body $$, $1::text");
    expect(params).toEqual(["y"]);
  });

  it("does NOT splice a $n inside a tagged dollar-quoted body ($tag$…$tag$)", () => {
    const { sql, params } = render("SELECT $body$ $1 $2 $body$, $1", ["z"]);
    expect(sql).toBe("SELECT $body$ $1 $2 $body$, $1");
    expect(params).toEqual(["z"]);
  });

  it("does NOT splice a $n inside a line comment (-- …)", () => {
    const { sql, params } = render("SELECT 1 -- $1 comment\n, $1", ["c"]);
    expect(sql).toBe("SELECT 1 -- $1 comment\n, $1");
    expect(params).toEqual(["c"]);
  });

  it("does NOT splice a $n inside a block comment (/* … */)", () => {
    const { sql, params } = render("SELECT /* $1 */ $2, $1", ["a", "b"]);
    // Drizzle re-numbers by occurrence: real $2 → $1 ("b"), real $1 → $2 ("a").
    expect(sql).toBe("SELECT /* $1 */ $1, $2");
    expect(params).toEqual(["b", "a"]);
  });

  it("handles nested block comments", () => {
    const { sql, params } = render("A /* x /* $1 */ y */ $1", ["n"]);
    expect(sql).toBe("A /* x /* $1 */ y */ $1");
    expect(params).toEqual(["n"]);
  });

  it("collapses REPEATED params onto ONE placeholder (preserves param identity)", () => {
    const { sql, params } = render("$1 = $1 AND b = $2", ["v", "w"]);
    // Both occurrences of $1 render to the SAME placeholder $1 — so a
    // `$n IS NULL` occurrence keeps the type its typed sibling establishes
    // (no 42P18). The builder's original numbering is reproduced verbatim.
    expect(sql).toBe("$1 = $1 AND b = $2");
    expect(params).toEqual(["v", "w"]);
  });

  it("collapses a repeated param even in an $n IS NULL position (42P18 guard)", () => {
    // The buildSoftDeleteObjectQuery shape: a nullable param used both typed and
    // as a bare IS NULL. Both $2 render to ONE placeholder so Postgres can infer
    // its type from `org_id = $2`.
    const { sql, params } = render("(org_id = $2 OR $2 IS NULL)", ["org", "o1"]);
    expect(sql).toBe("(org_id = $1 OR $1 IS NULL)");
    expect(params).toEqual(["o1"]);
  });

  it("longest-digit-run: $10 is parameter 10, not $1 then 0", () => {
    const values = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "TEN"];
    const { sql, params } = render("$10, $1", values);
    expect(sql).toBe("$1, $2");
    expect(params).toEqual(["TEN", "1"]);
  });

  it("preserves ::casts adjacent to a placeholder (repeat collapses to $1)", () => {
    const { sql, params } = render("VALUES ($1::text, $2::jsonb, $1::text)", ["p", "q"]);
    expect(sql).toBe("VALUES ($1::text, $2::jsonb, $1::text)");
    expect(params).toEqual(["p", "q"]);
  });

  it("empty text yields an empty SQL", () => {
    const { sql, params } = render("", []);
    expect(sql).toBe("");
    expect(params).toEqual([]);
  });

  it("throws when a referenced placeholder has no bound value", () => {
    expect(() => rawWithParams("SELECT $3", ["only-one"])).toThrow(/placeholder \$3 has no bound value/);
  });
});

describe("rawWithParams — real-builder round-trip parity (drift guard)", () => {
  // The twin reuses buildBindingReconcileQueries VERBATIM. Round-trip each of its
  // two statements (different param arities) and assert the bridged param multiset
  // equals the textual-order values the builder declared.
  const [archive, insert] = buildBindingReconcileQueries("cinatra", {
    orgId: "org-1",
    artifactId: "art-1",
    newBindingId: "bind-new",
  });

  /** The DISTINCT param values in first-occurrence order — what the deduping
   *  bridge emits (these builders number params in ascending first-occurrence
   *  order, so this equals `[orgId, artifactId, …]`). */
  function distinctTextualParams(text: string, values: readonly unknown[]): unknown[] {
    const seen = new Set<number>();
    const out: unknown[] = [];
    for (const m of text.matchAll(/\$(\d+)/g)) {
      const idx = Number(m[1]);
      if (seen.has(idx)) continue;
      seen.add(idx);
      out.push(values[idx - 1]);
    }
    return out;
  }

  it("round-trips the archive statement VERBATIM (values = [orgId, artifactId])", () => {
    const { sql, params } = render(archive.text, archive.values);
    // The dedup bridge reproduces the builder's SQL byte-for-byte (its params are
    // numbered in ascending first-occurrence order) — the strongest verbatim-reuse
    // invariant. Params collapse to the distinct values.
    expect(sql).toBe(archive.text);
    expect(params).toEqual(distinctTextualParams(archive.text, archive.values));
    expect(params).toEqual(["org-1", "art-1"]);
  });

  it("round-trips the insert statement VERBATIM (values = [orgId, artifactId, newBindingId])", () => {
    const { sql, params } = render(insert.text, insert.values);
    expect(sql).toBe(insert.text);
    expect(params).toEqual(distinctTextualParams(insert.text, insert.values));
    expect(params).toEqual(["org-1", "art-1", "bind-new"]);
  });

  it("the bridged param COUNT equals the builder's DISTINCT placeholder count", () => {
    for (const q of [archive, insert]) {
      const distinctCount = new Set(
        [...q.text.matchAll(/\$(\d+)/g)].map((m) => m[1]),
      ).size;
      const { params } = render(q.text, q.values);
      expect(params.length).toBe(distinctCount);
    }
  });
});
