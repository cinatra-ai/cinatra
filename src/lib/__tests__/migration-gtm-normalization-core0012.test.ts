// Contract test for the cinatra-ai/engineering#309 cleanup: the removal of the
// legacy GTM-era normalization from the hot core-store path
// (src/lib/database.ts) and its replacement by the one-time data migration
// migrations/core/core__0012_drop-gtm-normalization.mjs.
//
// The migration module is imported by RELATIVE PATH (not via `@/lib/database`,
// which vitest stubs) so the real token map and SQL generator are exercised.
//
// This is a pure unit test (no DB): it proves the migration's token map is
// byte-equivalent to the removed runtime normalization, that the generated SQL
// rewrites + gates on every token, that the rewrite is idempotent, and — the
// regression check the acceptance criteria require — that the runtime
// normalization is GONE from src/lib/database.ts so no live writer can emit a
// GTM-era value anymore. The real-Postgres execution of the chain is covered by
// the repo's upgrade-proof (scripts/ci/upgrade-proof.sh) which runs the
// candidate migration chain against a populated, non-fresh schema.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildGtmLikePredicate,
  buildGtmReplaceExpr,
  buildMigrationSql,
  gtmLikeTokens,
  gtmTokenRewrites,
  rewriteGtmString,
} from "../../../migrations/core/core__0012_drop-gtm-normalization.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const DATABASE_TS = path.join(REPO_ROOT, "src", "lib", "database.ts");

/**
 * Independent reimplementation of the ORIGINAL `normalizePersistedString` chain
 * that lived in src/lib/database.ts before #309 — copied verbatim from git
 * history. The migration's `rewriteGtmString` must produce the identical result
 * for any input, so the at-rest rewrite is byte-for-byte what the old
 * read/write normalization produced.
 */
function originalNormalizePersistedString(value: string): string {
  return value
    .replaceAll("@gtm-central/", "@cinatra/")
    .replaceAll("@gtm/", "@cinatra/")
    .replaceAll("GTM Central", "Cinatra")
    .replaceAll("GTM Center", "Cinatra")
    .replaceAll("gtm-central/openai-local-shell:latest", "cinatra/skill-shell:latest")
    .replaceAll("gtm/openai-local-shell:latest", "cinatra/skill-shell:latest")
    .replaceAll("cinatra/openai-local-shell:latest", "cinatra/skill-shell:latest")
    .replaceAll("gtm_central_", "cinatra_")
    .replaceAll("gtm_center_", "cinatra_")
    .replaceAll("gtm_central", "cinatra")
    .replaceAll("gtmcentral.app", "cinatra.app")
    .replaceAll("gtm.center", "cinatra.app");
}

const SAMPLE_VALUES = [
  '{"img":"gtm-central/openai-local-shell:latest"}',
  '{"name":"GTM Central","center":"GTM Center"}',
  '{"pkg":"@gtm-central/foo","pkg2":"@gtm/bar"}',
  '{"gtm_central_key":1,"gtm_center_key":2,"bare":"gtm_central"}',
  '{"host":"gtmcentral.app","alt":"gtm.center"}',
  '{"img2":"gtm/openai-local-shell:latest","img3":"cinatra/openai-local-shell:latest"}',
  "no legacy tokens at all",
  "",
  // A value where an earlier rewrite produces a substring a later rule keys on
  // (cinatra/openai-local-shell:latest is reachable from @gtm-central/ + path):
  '{"deep":"@gtm-central/openai-local-shell:latest"}',
];

describe("core__0012 GTM token map mirrors the removed runtime normalization", () => {
  it("rewriteGtmString is byte-equivalent to the original normalizePersistedString", () => {
    for (const v of SAMPLE_VALUES) {
      expect(rewriteGtmString(v)).toBe(originalNormalizePersistedString(v));
    }
  });

  it("the from-token list equals the rewrite keys, in order", () => {
    expect(gtmLikeTokens).toEqual(gtmTokenRewrites.map(([from]) => from));
  });

  it("the rewrite is idempotent (applying twice == applying once)", () => {
    for (const v of SAMPLE_VALUES) {
      const once = rewriteGtmString(v);
      expect(rewriteGtmString(once)).toBe(once);
    }
  });

  it("no rewrite output still contains any GTM-era from-token", () => {
    for (const v of SAMPLE_VALUES) {
      const out = rewriteGtmString(v);
      for (const [from] of gtmTokenRewrites) {
        // The only legacy `from` token that is also a SUBSTRING of a Cinatra
        // target is none — every `to` is GTM-free — so a fully-rewritten value
        // carries no remaining from-token.
        expect(out.includes(from)).toBe(false);
      }
    }
  });
});

describe("core__0012 generated SQL", () => {
  it("nests a replace() per rewrite, in order, around the column", () => {
    const expr = buildGtmReplaceExpr("value");
    // 12 rewrites -> 12 nested replace( calls.
    expect(expr.match(/replace\(/g)?.length).toBe(gtmTokenRewrites.length);
    // Innermost arg is the bare column.
    expect(expr).toContain("(value, '@gtm-central/', '@cinatra/')");
    // Outermost rewrite is the last token.
    expect(expr.startsWith("replace(")).toBe(true);
    expect(expr).toContain("'gtm.center', 'cinatra.app')");
  });

  it("gates the UPDATE on the column EXACTLY containing at least one token", () => {
    const predicate = buildGtmLikePredicate("payload");
    for (const [from] of gtmTokenRewrites) {
      // position() is an EXACT substring test — NOT LIKE — because several
      // tokens carry `_`, a LIKE single-char wildcard (codex convergence).
      expect(predicate).toContain(`position('${from}' in payload) > 0`);
    }
    // No LIKE — the `_` in gtm_central_/gtm_center_/gtm_central must not become
    // a wildcard.
    expect(predicate).not.toContain("LIKE");
    // OR-joined disjunction (one fewer OR than tokens).
    expect(predicate.match(/ OR /g)?.length).toBe(gtmTokenRewrites.length - 1);
  });

  it("the DO block rewrites metadata.value and discovers payload tables", () => {
    const sql = buildMigrationSql();
    expect(sql).toContain("DO $migrate_gtm$");
    expect(sql).toContain("UPDATE metadata SET value =");
    expect(sql).toContain("information_schema.columns");
    expect(sql).toContain("column_name = 'payload'");
    // The dynamic per-table UPDATE quotes the table name via %I (no injection).
    expect(sql).toContain("EXECUTE format('UPDATE %I SET payload =");
    // Dollar-quoted block is balanced.
    expect(sql.match(/\$migrate_gtm\$/g)?.length).toBe(2);
  });
});

describe("core__0012 regression: runtime GTM normalization is removed", () => {
  const databaseSrc = readFileSync(DATABASE_TS, "utf8");

  it("src/lib/database.ts no longer defines normalizePersistedString/Value", () => {
    expect(databaseSrc).not.toMatch(/function\s+normalizePersistedString/);
    expect(databaseSrc).not.toMatch(/function\s+normalizePersistedValue/);
  });

  it("src/lib/database.ts no longer calls the removed normalizers", () => {
    expect(databaseSrc).not.toMatch(/normalizePersistedValue\s*\(/);
    expect(databaseSrc).not.toMatch(/normalizePersistedString\s*\(/);
  });

  it("no live writer emits a GTM-era token literal in src/lib/database.ts", () => {
    // The removed normalization carried the only GTM-era literals in the core
    // store path. Assert none of the legacy `from` tokens reappear as a string
    // literal a live writer could persist.
    for (const [from] of gtmTokenRewrites) {
      // Skip pure-Cinatra tokens (the `cinatra/openai-local-shell:latest` from
      // value is not GTM-era — it is the already-rebranded variant the chain
      // collapsed; its substring 'cinatra' legitimately appears everywhere).
      if (!/gtm/i.test(from)) continue;
      expect(databaseSrc.includes(`"${from}"`)).toBe(false);
      expect(databaseSrc.includes(`'${from}'`)).toBe(false);
    }
  });
});
