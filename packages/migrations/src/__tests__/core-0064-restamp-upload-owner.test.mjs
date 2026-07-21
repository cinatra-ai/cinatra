// core__0064 re-stamp organization-wide UPLOAD rows to their uploader
// (epic cinatra#1883 C3, issue #1887) — SQL-builder shape + predicate +
// idempotency-by-predicate + down guards. Mirrors the core-0059-purge test
// idiom: assert the SQL shape without a live DB; the live re-stamp is exercised
// by src/lib/__tests__/integration/restamp-upload-owner-core0064.integration.test.ts.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const mod = await import(
  path.join(
    REPO_ROOT,
    "migrations",
    "core",
    "core__0064_restamp-upload-rows-uploader-owned.mjs",
  )
);

describe("core__0064 — module shape", () => {
  it("exports up/down + the SQL builders + the upload-origin constant", () => {
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
    expect(typeof mod.buildRestampSql).toBe("function");
    expect(typeof mod.buildPostconditionSql).toBe("function");
    expect(typeof mod.buildUpSql).toBe("function");
    expect(mod.UPLOAD_ORIGIN_KIND).toBe("upload");
  });

  it("buildUpSql = [restamp, postcondition] in order", () => {
    const up = mod.buildUpSql();
    expect(up).toHaveLength(2);
    expect(up[0]).toBe(mod.buildRestampSql());
    expect(up[1]).toBe(mod.buildPostconditionSql());
  });

  it("down() THROWS (irreversible re-stamp)", () => {
    expect(() => mod.down()).toThrow(/one-shot|indistinguishable|backup/i);
  });
});

describe("core__0064 — re-stamp UPDATE", () => {
  const sql = mod.buildRestampSql();

  it("re-derives owner to the UPLOADER exactly as C1 writes (user / created_by / private)", () => {
    expect(sql).toMatch(/UPDATE\s+objects\s+o/i);
    expect(sql).toMatch(/owner_level\s*=\s*'user'/);
    expect(sql).toMatch(/owner_id\s*=\s*o\.created_by/);
    expect(sql).toMatch(/visibility\s*=\s*'private'/);
  });

  it("NEVER writes project_id (the project refinement is kept untouched)", () => {
    expect(sql).not.toMatch(/SET[\s\S]*project_id\s*=/i);
  });

  it("targets ONLY upload-origin, organization-VISIBLE, uploader-present rows", () => {
    expect(sql).toMatch(/data->>'originKind'\s*=\s*'upload'/);
    expect(sql).toMatch(/o\.visibility\s*=\s*'organization'/);
    expect(sql).toMatch(/o\.created_by\s+IS\s+NOT\s+NULL/i);
  });

  it("EXCLUDES rows explicitly promoted to org (approved org promotion ledger row)", () => {
    expect(sql).toMatch(/id\s+NOT\s+IN/i);
    expect(sql).toMatch(/artifact_promotion_request/);
    expect(sql).toMatch(/status\s*=\s*'approved'/);
    expect(sql).toMatch(/to_visibility\s*=\s*'organization'/);
  });
});

describe("core__0064 — idempotency by predicate", () => {
  it("keys the UPDATE on visibility='organization', so a re-stamped (private) row cannot re-match", () => {
    // A re-stamped row reads visibility='private'; the predicate demands
    // 'organization', so a second run matches zero rows — the idempotency proof
    // at the predicate level (the live no-op is pinned by the integration test).
    const sql = mod.buildRestampSql();
    expect(sql).toMatch(/o\.visibility\s*=\s*'organization'/);
    expect(sql).not.toMatch(/o\.visibility\s*=\s*'private'/);
  });
});

describe("core__0064 — fail-loud postcondition", () => {
  const post = mod.buildPostconditionSql();

  it("RAISEs when any upload-origin org-visible non-promoted row survives", () => {
    expect(post).toMatch(/RAISE\s+EXCEPTION/i);
    expect(post).toMatch(/count\(\*\)/i);
    expect(post).toMatch(/data->>'originKind'\s*=\s*'upload'/);
    expect(post).toMatch(/visibility\s*=\s*'organization'/);
    expect(post).toMatch(/artifact_promotion_request/);
  });

  it("mentions core__0064 in the raised message (operator-actionable)", () => {
    expect(post).toMatch(/core__0064/);
  });
});

describe("core__0064 — schema qualification (integration path)", () => {
  it("qualifies objects + artifact_promotion_request when a schema is given", () => {
    const sql = mod.buildRestampSql("cinatra_wt").concat("\n", mod.buildPostconditionSql("cinatra_wt"));
    expect(sql).toContain(`"cinatra_wt"."objects"`);
    expect(sql).toContain(`"cinatra_wt"."artifact_promotion_request"`);
  });

  it("escapes a doublequote in the schema name", () => {
    const sql = mod.buildRestampSql('a"b');
    expect(sql).toContain(`"a""b"."objects"`);
  });
});
