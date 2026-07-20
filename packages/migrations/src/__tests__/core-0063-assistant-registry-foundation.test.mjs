// core__0063 assistant registry-foundation (cinatra#1874 Epic #1873 W1) —
// SQL-builder shape + idempotency/existence-guard/parity assertions (no live DB;
// the live apply + backfill are exercised by the DB-gated integration test).
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const mod = await import(
  path.join(REPO_ROOT, "migrations", "core", "core__0063_assistant-registry-foundation.mjs")
);
const { readManifestUnion } = await import(
  path.join(REPO_ROOT, "migrations", "manifest-reader.mjs")
);

describe("core__0063 — module shape", () => {
  it("exports up/down + the SQL builders + the vocabulary data", () => {
    for (const fn of [
      "up",
      "down",
      "buildUpSql",
      "buildDownSql",
      "buildInstalledExtensionAssistantDeclarationSql",
      "buildAssistantAudienceSql",
      "buildAssistantHandlesOriginSql",
      "buildAssistantTagAliasSql",
    ]) {
      expect(typeof mod[fn]).toBe("function");
    }
    expect(mod.ASSISTANT_AUDIENCE_SUBJECT_KINDS).toEqual([
      "workspace",
      "admin",
      "organization",
      "team",
      "project",
    ]);
    expect(mod.ASSISTANT_TAG_ALIAS_SOURCES).toEqual(["builtin", "manifest", "admin"]);
    expect(mod.BUILTIN_ASSISTANT_ALIAS).toEqual({
      alias: "cinatra",
      packageName: "@cinatra-ai/cinatra-assistant",
      source: "builtin",
    });
  });

  it("ships its append-only ledger fragment (union ledger seq 0063, non-destructive)", () => {
    const { entries, errors } = readManifestUnion(path.join(REPO_ROOT, "migrations"));
    expect(errors).toEqual([]);
    const entry = entries.find((m) => m.seq === "0063");
    expect(entry).toBeDefined();
    expect(entry?.file).toBe("core/core__0063_assistant-registry-foundation.mjs");
    expect(entry?.destructive).toBe(false);
    expect(entry?.tables).toEqual([
      "installed_extension",
      "assistant_audience",
      "assistant_handles",
      "assistant_tag_alias",
    ]);
  });
});

describe("core__0063 — up SQL shape", () => {
  const up = mod.buildUpSql().join("\n;;\n");

  it("adds installed_extension.assistant_declaration FIRST (backfill reads it)", () => {
    const decl = mod.buildUpSql().findIndex((s) => /installed_extension.*assistant_declaration jsonb/s.test(s));
    const handleBackfill = mod.buildUpSql().findIndex((s) => /ie\.assistant_declaration IS NOT NULL/.test(s));
    expect(decl).toBeGreaterThanOrEqual(0);
    expect(handleBackfill).toBeGreaterThan(decl);
  });

  it("is idempotent — every additive statement is IF NOT EXISTS / guarded", () => {
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS assistant_declaration jsonb/);
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS assistant_audience/);
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS assistant_tag_alias/);
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS origin text/);
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS package_name text/);
    // CHECK/constraint adds are wrapped in information_schema existence guards
    expect(up).toMatch(/assistant_audience_subject_kind_check/);
    expect(up).toMatch(/assistant_handles_origin_check/);
    expect(up).toMatch(/assistant_tag_alias_source_check/);
  });

  it("existence-guards the backfill on all three referenced tables", () => {
    const bf = mod.buildAssistantHandlesOriginSql().find((s) => s.includes("core0063bf"));
    expect(bf).toBeDefined();
    expect(bf).toMatch(/to_regclass\('assistant_handles'\) IS NULL/);
    expect(bf).toMatch(/to_regclass\('agent_templates'\) IS NULL/);
    expect(bf).toMatch(/to_regclass\('installed_extension'\) IS NULL/);
    expect(bf).toMatch(/RETURN;/);
  });

  it("backfills origin='extension' only for active|locked installs with a declaration", () => {
    const bf = mod.buildAssistantHandlesOriginSql().find((s) => s.includes("core0063bf"));
    expect(bf).toMatch(/ie\.assistant_declaration IS NOT NULL/);
    expect(bf).toMatch(/ie\.status IN \('active', 'locked'\)/);
    expect(bf).toMatch(/THEN 'extension'/);
    expect(bf).toMatch(/ELSE 'standalone'/);
  });

  it("enforces NOT NULL + default 'standalone' on origin after backfill", () => {
    expect(up).toMatch(/ALTER COLUMN origin SET DEFAULT 'standalone'/);
    expect(up).toMatch(/ALTER COLUMN origin SET NOT NULL/);
  });

  it("seeds the immutable builtin alias with ON CONFLICT DO NOTHING", () => {
    expect(up).toMatch(/INSERT INTO assistant_tag_alias[\s\S]*'cinatra', '@cinatra-ai\/cinatra-assistant', 'builtin'/);
    expect(up).toMatch(/ON CONFLICT \(alias\) DO NOTHING/);
  });

  it("qualifies identifiers when a schema is supplied (integration path)", () => {
    const qualified = mod.buildUpSql("app").join("\n");
    expect(qualified).toMatch(/"app"\."assistant_audience"/);
    expect(qualified).toMatch(/"app"\."assistant_tag_alias"/);
    expect(qualified).toMatch(/"app"\."assistant_handles"/);
    expect(qualified).toMatch(/"app"\."installed_extension"/);
  });
});

describe("core__0063 — down SQL", () => {
  it("drops the two NET-NEW tables and the added columns/constraints", () => {
    const down = mod.buildDownSql().join("\n");
    expect(down).toMatch(/DROP TABLE IF EXISTS assistant_tag_alias/);
    expect(down).toMatch(/DROP TABLE IF EXISTS assistant_audience/);
    expect(down).toMatch(/DROP CONSTRAINT IF EXISTS assistant_handles_origin_check/);
    expect(down).toMatch(/DROP COLUMN IF EXISTS origin/);
    expect(down).toMatch(/DROP COLUMN IF EXISTS package_name/);
    expect(down).toMatch(/installed_extension.*DROP COLUMN IF EXISTS assistant_declaration/);
  });
});
