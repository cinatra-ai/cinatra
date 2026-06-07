/**
 * Regression guard for the `ANY(${array})` Drizzle pitfall in
 * `packages/skills/src/skill-paths.ts:loadSlugMap`.
 *
 * Background: Drizzle's `sql` tag spreads a JS array `${arr}` as a tuple of
 * positional parameters (`($1, $2, ...)`). Inside `ANY(...)` Postgres rejects
 * that as `42809 op ANY/ALL (array) requires array on right side`. Adding a
 * `::text[]` cast does NOT save you — records can't be cast to arrays.
 *
 * Sibling of `packages/agents/src/__tests__/store-any-array-binding.test.ts`
 * (same Drizzle pitfall, different package). Five call sites in `loadSlugMap`
 * (users, teams, organizations, projects, agent_templates) all route through
 * a file-local `buildTextArraySql(ids)` helper that emits
 * `ARRAY[${sql.join(ids.map((id) => sql\`${id}\`), sql\`, \`)}]`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skill-paths.ts",
);
const source = readFileSync(SOURCE_PATH, "utf8");

describe("packages/skills/src/skill-paths.ts — narrow source gate for known-broken ANY shapes", () => {
  it("does not contain a bare `ANY(${X}::text[])` shape for any identifier (Drizzle spreads + cast does NOT save you)", () => {
    const banned = source.match(/ANY\(\s*\$\{\s*[A-Za-z_]\w*\s*\}\s*::text\[\]\s*\)/g);
    expect(
      banned,
      `Source contains banned bare-array ANY shape(s): ${banned?.join(", ") ?? ""}`,
    ).toBeNull();
  });

  it("does not contain `ANY(${userIds}::text[])` / `${teamIds}` / `${orgIds}` / `${projectIds}` / `${agentTemplateIds}` (the original 5 broken sites)", () => {
    for (const ident of ["userIds", "teamIds", "orgIds", "projectIds", "agentTemplateIds"]) {
      const re = new RegExp(`ANY\\(\\s*\\$\\{\\s*${ident}\\s*\\}\\s*::text\\[\\]\\s*\\)`);
      expect(source).not.toMatch(re);
    }
  });
});

describe("packages/skills/src/skill-paths.ts — all 5 sites route ids through buildTextArraySql()", () => {
  it("defines buildTextArraySql with the converged ARRAY[sql.join(...)] shape", () => {
    expect(source).toMatch(/function\s+buildTextArraySql\s*\(/);
    // Confirm the helper produces ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]
    expect(source).toMatch(
      /sql`ARRAY\[\$\{sql\.join\(\s*ids\.map\(\(id\)\s*=>\s*sql`\$\{id\}`\)\s*,\s*sql`,\s`\s*,?\s*\)\}\]`/,
    );
  });

  it.each([
    "userIds",
    "teamIds",
    "orgIds",
    "projectIds",
    "agentTemplateIds",
  ])("routes %s through buildTextArraySql in an ANY(...) clause", (ident) => {
    const re = new RegExp(`ANY\\(\\$\\{buildTextArraySql\\(${ident}\\)\\}\\)`);
    expect(source).toMatch(re);
  });
});
