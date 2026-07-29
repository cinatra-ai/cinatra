// Byte-shape guard for the `enqueue_agent_owner_move` relocation trigger SQL
// (cinatra#550).
//
// `agent_templates.package_name` stores the npm-SCOPED name
// (e.g. "@cinatra-ai/author-agent"), but the skill-store disk layout is
// UNSCOPED ("~agents/cinatra-ai/author-agent/..."). The trigger previously
// composed the relocation path from the raw scoped value, emitting
// "~agents/@cinatra-ai/..." — a directory that never exists on disk, so every
// owner-move relocation for a scoped agent targeted the wrong subtree.
//
// The resolver side of the same bug (resolveSkillDir / loadSlugMap in
// packages/skills/src/skill-paths.ts) is fixed separately by stripping the
// "@<scope>/" marker via agentPackageNameToPath(). This file asserts the SQL
// trigger applies the SAME normalization, and exercises the regex semantics
// (Postgres POSIX `regexp_replace` and the JS `agentPackageNameToPath` regex
// agree on `^@(scope)/(rest)$` → `scope/rest`, non-matching unchanged).
//
// Matches against the joined production query batch (NOT a snapshot file —
// those rot on whitespace). Mirrors member-dedup-migration-shape.test.ts.

import { describe, expect, it } from "vitest";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

function triggerSql(): string {
  const sql = buildCreateStoreSchemaQueries("cinatra_test")
    .map((q) => q.text)
    .join("\n");
  const start = sql.indexOf("enqueue_agent_owner_move() RETURNS trigger");
  const end = sql.indexOf("$body$", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("enqueue_agent_owner_move scope-stripping SQL shape (cinatra#550)", () => {
  const fn = triggerSql();

  it("declares a pkg_path normalization variable", () => {
    expect(fn).toMatch(/\bpkg_path text;/);
  });

  it("strips the leading npm @scope marker via regexp_replace", () => {
    // The leading "@<scope>/" is rewritten to "<scope>/"; non-scoped names are
    // left unchanged (no leading-@ match). \1/\2 are POSIX backreferences.
    expect(fn).toMatch(
      /pkg_path := regexp_replace\(NEW\.package_name, '\^@\(\[\^\/\]\+\)\/\(\.\+\)\$', '\\1\/\\2'\)/,
    );
  });

  it("composes both relocation paths from the normalized pkg_path", () => {
    expect(fn).toMatch(/old_p := old_prefix \|\| '\/~agents\/' \|\| pkg_path;/);
    expect(fn).toMatch(/new_p := new_prefix \|\| '\/~agents\/' \|\| pkg_path;/);
  });

  it("no longer composes the path from the raw scoped package_name", () => {
    expect(fn).not.toMatch(/'\/~agents\/' \|\| NEW\.package_name/);
  });
});

describe("enqueue_agent_owner_move degrade-with-diagnostic on an unresolvable owner (cinatra#1703)", () => {
  const fn = triggerSql();

  it("skips the relocation with a sanitized WARNING (never a boot-aborting EXCEPTION) when a prefix is NULL", () => {
    // cinatra#1703: an orphaned/ephemeral row (a run-token / deleted-user /
    // deleted-org owner) resolves to a NULL on-disk prefix. The boot-time owner
    // backfill UPDATEs such rows and fires this trigger; it USED to
    // `RAISE EXCEPTION 'cannot resolve owner paths'`, aborting the WHOLE boot.
    // It must now DEGRADE-WITH-DIAGNOSTIC — WARNING + RETURN NEW (skip) —
    // whether the CURRENT owner OR the move target is the unresolvable side.
    expect(fn).not.toMatch(/cannot resolve owner paths/);
    expect(fn).toMatch(
      /IF old_prefix IS NULL OR new_prefix IS NULL THEN[\s\S]*?RAISE WARNING 'enqueue_agent_owner_move: skipping relocation for template %[\s\S]*?RETURN NEW;\s*END IF;/,
    );
  });

  it("emits only the template id in the diagnostic, never the owner value (sanitized)", () => {
    // The WARNING interpolates `NEW.id` and describes the owner as unresolvable
    // WITHOUT echoing owner_level/owner_id (no principal value leaks to logs).
    expect(fn).toMatch(
      /RAISE WARNING 'enqueue_agent_owner_move: skipping relocation for template %[^']*', NEW\.id;/,
    );
    expect(fn).not.toMatch(/RAISE WARNING[^;]*NEW\.owner_id/);
    expect(fn).not.toMatch(/RAISE WARNING[^;]*OLD\.owner_id/);
  });

  it("keeps the fail-closed guard for a missing package_name (unchanged, out of #1703 scope)", () => {
    expect(fn).toMatch(
      /RAISE EXCEPTION 'enqueue_agent_owner_move: template % has no package_name'/,
    );
  });
});

describe("scope-strip regex semantics (mirror of agentPackageNameToPath)", () => {
  // Same pattern Postgres POSIX regexp_replace applies inside the trigger.
  const RE = /^@([^/]+)\/(.+)$/;
  const strip = (pkg: string): string => {
    const m = RE.exec(pkg);
    return m ? `${m[1]}/${m[2]}` : pkg;
  };

  it.each([
    ["@cinatra-ai/author-agent", "cinatra-ai/author-agent"],
    ["@cinatra-ai/blog-draft-writer-agent", "cinatra-ai/blog-draft-writer-agent"],
    ["@marcushorndt-local/page-summarizer-agent", "marcushorndt-local/page-summarizer-agent"],
    ["@cinatra/system-scrape", "cinatra/system-scrape"],
    // nested path: only the leading @scope/ marker is removed
    ["@scope/a/b", "scope/a/b"],
    // non-scoped legacy names pass through unchanged
    ["cinatra/blog-draft-writer-agent", "cinatra/blog-draft-writer-agent"],
    ["cinatra-ai/author-agent", "cinatra-ai/author-agent"],
  ])("strip(%s) === %s", (input, want) => {
    expect(strip(input)).toBe(want);
  });

  it("yields an unscoped on-disk relocation path for a real scoped package", () => {
    const composed = `organization/acme/~agents/${strip("@cinatra-ai/author-agent")}`;
    expect(composed).toBe("organization/acme/~agents/cinatra-ai/author-agent");
    expect(composed).not.toContain("@");
  });
});
