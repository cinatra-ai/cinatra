/**
 * Regression guard for the `ANY(${array})` Drizzle pitfall in
 * `scope-dashboards-service.ts:resolveEntityLabels` (cinatra#1897 B4).
 *
 * Background: Drizzle's `sql` tag spreads a JS array `${[...ids]}` as a tuple of
 * positional parameters — `ANY(($1, $2, $3))`. Postgres parses that as a
 * row-expression and rejects it at runtime (`42809 op ANY/ALL (array) requires
 * array on right side`; a single-element set degrades to `ANY($1)` scalar →
 * `malformed array literal`). The escaped bug was an unhandled 500 on the team /
 * organization label resolve (the Dashboards tab's Listed rows AND the
 * add-picker's home labels). The fix routes both ids sets through
 * `buildTextArraySql`, emitting `ANY(ARRAY[$1, $2, ...])` — one bind param per
 * element, a real Postgres array on the RHS.
 *
 * This is the FAST, always-on guard (rendered SQL, no live pg). The live
 * node-postgres betterAuthDb round-trip is proven by
 * `resolve-entity-labels.integration.test.ts`. Sibling of
 * `packages/agents/src/__tests__/store-any-array-binding.test.ts` and
 * `packages/skills/src/__tests__/skill-paths-any-array-binding.test.ts` — the
 * same pitfall, the same converged remedy.
 */
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  _orgNamesQuery,
  _teamNamesQuery,
} from "@/lib/dashboards/scope-dashboards-service";

const dialect = new PgDialect();

describe("resolveEntityLabels — ANY(array) binding (behavioral)", () => {
  it("the team-name query emits `ANY(ARRAY[$1, $2, $3])` with one param per id", () => {
    const q = dialect.sqlToQuery(_teamNamesQuery(["t1", "t2", "t3"]));
    expect(q.sql).toContain('FROM public."team"');
    expect(q.sql).toMatch(/ANY\(ARRAY\[\s*\$1\s*,\s*\$2\s*,\s*\$3\s*\]\)/);
    expect(q.params).toEqual(["t1", "t2", "t3"]);
  });

  it("the organization-name query emits `ANY(ARRAY[$1, $2])` with one param per id", () => {
    const q = dialect.sqlToQuery(_orgNamesQuery(["o1", "o2"]));
    expect(q.sql).toContain('FROM public."organization"');
    expect(q.sql).toMatch(/ANY\(ARRAY\[\s*\$1\s*,\s*\$2\s*\]\)/);
    expect(q.params).toEqual(["o1", "o2"]);
  });

  it("never emits the tuple-spread `ANY(($1, $2, ...))` that crashes Postgres", () => {
    for (const q of [
      dialect.sqlToQuery(_teamNamesQuery(["a", "b", "c"])),
      dialect.sqlToQuery(_orgNamesQuery(["a", "b", "c"])),
    ]) {
      expect(q.sql).not.toMatch(/ANY\(\(\$1[^)]*\)\)/);
    }
  });

  it("never emits the bare-scalar `ANY($1)` shape (single-id `malformed array literal`)", () => {
    for (const q of [
      dialect.sqlToQuery(_teamNamesQuery(["only"])),
      dialect.sqlToQuery(_orgNamesQuery(["only"])),
    ]) {
      // A single id still routes through ARRAY[...] — `ANY(ARRAY[$1])`, never a
      // bare `ANY($1)` scalar.
      expect(q.sql).toMatch(/ANY\(ARRAY\[\s*\$1\s*\]\)/);
      expect(q.sql).not.toMatch(/ANY\(\$1\)/);
    }
  });

  it("never emits the `ANY(${X}::text[])` cast-doesn't-save-you shape", () => {
    for (const q of [
      dialect.sqlToQuery(_teamNamesQuery(["a", "b"])),
      dialect.sqlToQuery(_orgNamesQuery(["a", "b"])),
    ]) {
      expect(q.sql).not.toMatch(/ANY\([^)]+::text\[\]\)/);
    }
  });
});

describe("scope-dashboards-service.ts — narrow source gate for known-broken ANY shapes", () => {
  const SOURCE_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "scope-dashboards-service.ts",
  );
  const source = readFileSync(SOURCE_PATH, "utf8");

  it("does not contain a bare `ANY(${[...ids]})` spread over any id set (the original bug)", () => {
    // The two original broken sites: `ANY(${[...teamIds]})` / `ANY(${[...orgIds]})`.
    const banned = source.match(/ANY\(\s*\$\{\s*\[\.\.\.[A-Za-z_]\w*\s*\]\s*\}\s*\)/g);
    expect(
      banned,
      `Source contains banned spread-array ANY shape(s): ${banned?.join(", ") ?? ""}`,
    ).toBeNull();
  });

  it("does not contain a bare `ANY(${X}::text[])` shape for any identifier (Drizzle spreads + cast does NOT save you)", () => {
    const banned = source.match(/ANY\(\s*\$\{\s*[A-Za-z_]\w*\s*\}\s*::text\[\]\s*\)/g);
    expect(
      banned,
      `Source contains banned bare-array ANY shape(s): ${banned?.join(", ") ?? ""}`,
    ).toBeNull();
  });

  it("routes both id sets through buildTextArraySql in an ANY(...) clause", () => {
    expect(source).toMatch(/function\s+buildTextArraySql\s*\(/);
    expect(source).toMatch(/ANY\(\$\{buildTextArraySql\(ids\)\}\)/);
  });
});
