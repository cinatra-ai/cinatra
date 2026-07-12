import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const mod = await import(
  path.join(REPO_ROOT, "migrations", "core", "core__0031_skill-content-authority.mjs")
);

describe("core__0031 content-authority migration — shape", () => {
  it("exports up/down + the DDL/backfill SQL consts", () => {
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
    for (const k of ["contentAuthorityDdlSql", "backfillSeedBlobsSql", "assertTruthfulHeadsResolveSql"]) {
      expect(typeof mod[k]).toBe("string");
    }
  });
});

describe("core__0031 DDL — content-addressable blobs + rollback provenance", () => {
  it("creates skill_revision_contents with DB-enforced blob integrity + append-only", () => {
    const sql = mod.contentAuthorityDdlSql;
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS skill_revision_contents/);
    expect(sql).toMatch(/content_digest text PRIMARY KEY/);
    // a wrong blob can never be stored — the digest must equal sha256(content)
    expect(sql).toContain("CHECK (content_digest = encode(sha256(convert_to(content, 'UTF8')), 'hex'))");
    expect(sql).toContain("CHECK (byte_length = octet_length(content))");
    expect(sql).toMatch(/CREATE TRIGGER trg_skill_revision_contents_append_only BEFORE UPDATE OR DELETE ON skill_revision_contents/);
  });

  it("adds restores_revision_id, widens the source CHECK to 'rollback' via DROP+ADD, and binds the biconditional + self-FK", () => {
    const sql = mod.contentAuthorityDdlSql;
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS restores_revision_id text/);
    // widening a CHECK IN-list needs DROP+ADD (guarded add-if-absent can't change it)
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS skill_revisions_source_check/);
    expect(sql).toMatch(/source IN \('manual','autosave','hitl','chat-capture','migration','rollback'\)/);
    expect(sql).toContain("CHECK ((source = 'rollback') = (restores_revision_id IS NOT NULL))");
    expect(sql).toMatch(/skill_revisions_restores_fk\s+FOREIGN KEY \(restores_revision_id, skill_id\) REFERENCES skill_revisions\(id, skill_id\)/);
  });
});

describe("core__0031 backfill — integrity-checked, idempotent, custom-scoped", () => {
  it("seeds blobs from CURRENT content keyed by sha256(content), only for custom/personal skills", () => {
    const sql = mod.backfillSeedBlobsSql;
    expect(sql).toMatch(/INSERT INTO skill_revision_contents \(content_digest, content, byte_length\)/);
    expect(sql).toMatch(/encode\(sha256\(convert_to\(c, 'UTF8'\)\), 'hex'\)/); // digest = sha256(content)
    expect(sql).toMatch(/packageId'\) LIKE 'custom:%'/);
    expect(sql).toMatch(/isCustomSkill/);
    expect(sql).toMatch(/isPersonal/);
    expect(sql).toMatch(/ON CONFLICT \(content_digest\) DO NOTHING/); // dedup + re-run safe
  });

  it("fail-closed postcondition PROVES every truthful head resolved to a blob", () => {
    const sql = mod.assertTruthfulHeadsResolveSql;
    expect(sql).toMatch(/RAISE EXCEPTION 'core__0031 content-authority backfill incomplete/);
    // only TRUTHFUL heads (recorded digest matches content) are required to resolve
    expect(sql).toMatch(/r\.content_digest = encode\(sha256\(convert_to\(s\.payload::jsonb ->> 'content', 'UTF8'\)\), 'hex'\)/);
    expect(sql).toMatch(/NOT EXISTS/);
  });
});

describe("core__0031 down() — guarded + reversible when unexercised", () => {
  it("FAILS CLOSED before any DDL if a rollback revision exists (immutable history)", () => {
    const calls = [];
    mod.down({ sql: (s) => calls.push(s) });
    const guard = calls[0];
    expect(guard).toMatch(/count\(\*\)[\s\S]*FROM skill_revisions WHERE source = 'rollback'/);
    expect(guard).toMatch(/RAISE EXCEPTION 'core__0031 down\(\) unsupported/);
    // the guard is the FIRST statement — checked before any schema change
    expect(calls.findIndex((s) => /DROP TABLE IF EXISTS skill_revision_contents/.test(s))).toBeGreaterThan(0);
  });

  it("reverses the A2 additions: drops the constraints/column, narrows the CHECK to the A1 five, drops the content table", () => {
    const calls = [];
    mod.down({ sql: (s) => calls.push(s) });
    const sql = calls.join("\n");
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS skill_revisions_restores_fk/);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS skill_revisions_rollback_provenance_check/);
    expect(sql).toMatch(/source IN \('manual','autosave','hitl','chat-capture','migration'\)/); // narrowed back
    expect(sql).toMatch(/DROP COLUMN IF EXISTS restores_revision_id/);
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS fn_skill_revision_contents_append_only/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS skill_revision_contents/);
  });
});
