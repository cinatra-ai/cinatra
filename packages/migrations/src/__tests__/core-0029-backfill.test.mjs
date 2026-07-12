import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const mod = await import(
  path.join(REPO_ROOT, "migrations", "core", "core__0029_skill-lifecycle.mjs")
);

describe("core__0029 skill-lifecycle migration — shape", () => {
  it("exports up/down + the backfill SQL consts", () => {
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
    for (const k of ["lifecycleDdlSql", "backfillActivateSql", "backfillSeedRevisionsSql", "backfillSetPointerSql"]) {
      expect(typeof mod[k]).toBe("string");
    }
  });
});

describe("core__0029 backfill — idempotent + minimal-touch guards", () => {
  it("(1) activation only touches state-less custom/personal rows", () => {
    const sql = mod.backfillActivateSql;
    expect(sql).toMatch(/SET lifecycle_state = 'active'/);
    expect(sql).toMatch(/WHERE lifecycle_state IS NULL/); // never re-write an existing state
    // custom predicate: canonical custom: marker + the flags
    expect(sql).toMatch(/packageId'\) LIKE 'custom:%'/);
    expect(sql).toMatch(/isCustomSkill/);
    expect(sql).toMatch(/isPersonal/);
  });

  it("(2) seeds a deterministic, idempotent `migration` revision with the stored digest", () => {
    const sql = mod.backfillSeedRevisionsSql;
    expect(sql).toMatch(/INSERT INTO skill_revisions/);
    expect(sql).toMatch(/'migration:' \|\| id/); // deterministic id → re-run safe + same-skill by construction
    expect(sql).toMatch(/'migration'/); // source
    expect(sql).toMatch(/#>> '\{source,revision\}'/); // content_digest from the payload's stored digest
    expect(sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
    expect(sql).toMatch(/active_revision_id IS NULL/);
  });

  it("(3) sets the pointer only when the seeded revision exists AND belongs to the skill", () => {
    const sql = mod.backfillSetPointerSql;
    expect(sql).toMatch(/SET active_revision_id = 'migration:' \|\| id/);
    expect(sql).toMatch(/active_revision_id IS NULL/);
    // composite-FK safety: only point when a matching revision row exists
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM skill_revisions r WHERE r\.id = 'migration:' \|\| skills\.id AND r\.skill_id = skills\.id\)/);
  });

  it("never issues two UPDATEs of the same skills row in one statement", () => {
    // activation and pointer-set are DISTINCT statements (codex-converged) —
    // PostgreSQL does not define updating one row twice in a single statement.
    expect(mod.backfillActivateSql).not.toBe(mod.backfillSetPointerSql);
    expect(mod.backfillActivateSql).not.toMatch(/active_revision_id/);
    expect(mod.backfillSetPointerSql).not.toMatch(/SET lifecycle_state/);
  });
});

describe("core__0029 down() — fully reversible", () => {
  it("drops the trigger FUNCTION, both tables, the constraints, and the columns", () => {
    const calls = [];
    mod.down({ sql: (s) => calls.push(s) });
    const sql = calls.join("\n");
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS fn_skill_revisions_append_only/);
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS trg_skill_revisions_append_only/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS skill_revisions/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS skill_lifecycle_audit/);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS skills_active_revision_fkey/);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS skills_superseded_by_fkey/);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS skills_lifecycle_state_check/);
    expect(sql).toMatch(/DROP COLUMN IF EXISTS lifecycle_state/);
    expect(sql).toMatch(/DROP COLUMN IF EXISTS superseded_by/);
    expect(sql).toMatch(/DROP COLUMN IF EXISTS active_revision_id/);
  });
});
