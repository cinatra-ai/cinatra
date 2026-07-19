// core__0059 default-artifact floor purge + write guard (owner ruling 2026-07-18;
// epic cinatra#1785 wave A6) — SQL-builder shape + ordering/idempotency/trigger-
// bypass/reachability/guard guards. Mirrors the core-0056 test idiom (assert the
// SQL shape without a live DB; the live cascade is exercised by the
// schema-migration-gate upgrade proof).
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const mod = await import(
  path.join(REPO_ROOT, "migrations", "core", "core__0059_purge-default-artifact-floor.mjs")
);

describe("core__0059 — module shape", () => {
  it("exports up/down + both SQL builders + the cascade/trigger/reachability data", () => {
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
    expect(typeof mod.buildPurgeSql).toBe("function");
    expect(typeof mod.buildGenericWriteGuardSql).toBe("function");
    expect(typeof mod.retiredTypePredicate).toBe("function");
    expect(mod.RETIRED_GENERIC_ARTIFACT_TYPE).toBe("@cinatra-ai/artifact:object");
    expect(Array.isArray(mod.ARTIFACT_ID_REFERENCING_TABLES)).toBe(true);
    expect(Array.isArray(mod.OBJECT_ID_REFERENCING_TABLES)).toBe(true);
    expect(Array.isArray(mod.TRIGGER_GUARDED_DELETES)).toBe(true);
    expect(Array.isArray(mod.REACHABILITY_DELEGATED_TABLES)).toBe(true);
  });

  it("down() THROWS (irreversible clean-break purge)", () => {
    expect(() => mod.down()).toThrow(/clean-break|backup/i);
  });
});

describe("core__0059 — retired-type predicate", () => {
  const pred = mod.retiredTypePredicate();

  it("targets the generic Default-Artifact floor EXACTLY (not a prefix)", () => {
    expect(pred).toBe(`type = '@cinatra-ai/artifact:object'`);
  });

  it("does NOT touch core__0056's separately-purged floor or the per-package umbrellas", () => {
    expect(pred).not.toContain("@cinatra-ai/objects:object");
    expect(pred).not.toContain("@dynamic/types:");
    expect(pred).not.toContain(":artifact'"); // no per-package `:artifact` umbrella
  });
});

describe("core__0059 — purge statements", () => {
  const sql = mod.buildPurgeSql();
  const joined = sql.join("\n;\n");
  const idx = (re) => sql.findIndex((s) => re.test(s));

  it("captures retired object ids and their change_sets into temp tables FIRST", () => {
    expect(sql[0]).toMatch(/CREATE TEMP TABLE _purge_obj ON COMMIT DROP/);
    expect(sql[0]).toMatch(/WHERE type = '@cinatra-ai\/artifact:object'/);
    expect(sql[1]).toMatch(/CREATE TEMP TABLE _purge_cs ON COMMIT DROP/);
    expect(sql[1]).toMatch(/FROM object_change_event/);
  });

  it("sweeps every artifact_id-keyed child (== objects.id)", () => {
    for (const tbl of mod.ARTIFACT_ID_REFERENCING_TABLES) {
      expect(joined).toMatch(
        new RegExp(`DELETE FROM ${tbl} WHERE artifact_id IN \\(SELECT id FROM _purge_obj\\)`),
      );
    }
  });

  it("sweeps every object_id-keyed child (the core__0056 set)", () => {
    for (const tbl of mod.OBJECT_ID_REFERENCING_TABLES) {
      expect(joined).toMatch(
        new RegExp(`DELETE FROM ${tbl} WHERE object_id IN \\(SELECT id FROM _purge_obj\\)`),
      );
    }
  });

  it("DISABLEs each delete-rejection trigger before its delete and RE-ENABLEs after (existence-guarded)", () => {
    for (const { table, trigger, column } of mod.TRIGGER_GUARDED_DELETES) {
      const disableIdx = idx(new RegExp(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`));
      const deleteIdx = idx(new RegExp(`DELETE FROM ${table} WHERE ${column} IN`));
      const enableIdx = idx(new RegExp(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`));
      expect(disableIdx).toBeGreaterThanOrEqual(0);
      expect(deleteIdx).toBeGreaterThan(disableIdx);
      expect(enableIdx).toBeGreaterThan(deleteIdx);
      // existence-guarded so it is a no-op where the trigger is absent
      const disableStmt = sql[disableIdx];
      expect(disableStmt).toMatch(/IF EXISTS \(SELECT 1 FROM pg_trigger/);
      expect(disableStmt).toContain(`tgrelid = '${table}'::regclass`);
      expect(disableStmt).toContain(`tgname = '${trigger}'`);
    }
  });

  it("captures purge-touched uninstall operations BEFORE deleting their assertions", () => {
    const capIdx = idx(/CREATE TEMP TABLE _purge_uop ON COMMIT DROP/);
    const cap = sql[capIdx];
    expect(capIdx).toBeGreaterThanOrEqual(0);
    expect(cap).toMatch(/operation_id AS id[\s\S]*artifact_uninstall_operation_assertions[\s\S]*artifact_id IN \(SELECT id FROM _purge_obj\)/);
    const assertionDeleteIdx = idx(/DELETE FROM artifact_uninstall_operation_assertions WHERE artifact_id IN/);
    expect(assertionDeleteIdx).toBeGreaterThan(capIdx);
  });

  it("orphan-sweeps ONLY purge-touched uninstall operations that now have zero assertions (never blanket by count)", () => {
    const op = sql.find((s) => /DELETE FROM artifact_uninstall_operations op/.test(s));
    expect(op).toBeDefined();
    // scoped to the captured operation ids — an unrelated zero-assertion op is NOT swept
    expect(op).toMatch(/op\.id IN \(SELECT id FROM _purge_uop\)/);
    expect(op).toMatch(/NOT EXISTS[\s\S]*artifact_uninstall_operation_assertions/);
  });

  it("deletes remote_effect_attempts BEFORE the object_change_event rows they reference", () => {
    const reIdx = idx(/DELETE FROM remote_effect_attempts/);
    const eventIdx = idx(/DELETE FROM object_change_event WHERE object_id/);
    expect(reIdx).toBeGreaterThanOrEqual(0);
    expect(eventIdx).toBeGreaterThan(reIdx);
  });

  it("orphan-sweeps only change_sets with NO remaining events (mixed sets survive)", () => {
    const cs = sql.find((s) => /DELETE FROM change_set/.test(s));
    expect(cs).toMatch(/id IN \(SELECT id FROM _purge_cs\)/);
    expect(cs).toMatch(/NOT EXISTS[\s\S]*object_change_event/);
  });

  it("NULLs dangling parent refs on SURVIVING objects (never deletes a survivor)", () => {
    const upd = sql.find((s) => /UPDATE objects SET parent_id = NULL/.test(s));
    expect(upd).toBeDefined();
    expect(upd).toMatch(/parent_id IN \(SELECT id FROM _purge_obj\) AND id NOT IN \(SELECT id FROM _purge_obj\)/);
  });

  it("deletes the object rows LAST (before the trigger re-enables)", () => {
    const objDeleteIdx = idx(/DELETE FROM objects WHERE id IN \(SELECT id FROM _purge_obj\)/);
    expect(objDeleteIdx).toBeGreaterThanOrEqual(0);
    // every child DELETE precedes the objects DELETE
    for (const tbl of [...mod.ARTIFACT_ID_REFERENCING_TABLES, ...mod.OBJECT_ID_REFERENCING_TABLES]) {
      expect(idx(new RegExp(`DELETE FROM ${tbl} WHERE`))).toBeLessThan(objDeleteIdx);
    }
  });

  it("NEVER blanket-deletes a content-addressed / shared physical-storage table (reachability delegated)", () => {
    for (const tbl of mod.REACHABILITY_DELEGATED_TABLES) {
      expect(joined).not.toMatch(new RegExp(`DELETE FROM ${tbl}\\b`));
    }
  });

  it("qualifies identifiers when a schema is given (integration path)", () => {
    const schemaSql = mod.buildPurgeSql("cinatra_wt").join("\n");
    expect(schemaSql).toContain(`"cinatra_wt"."objects"`);
    expect(schemaSql).toContain(`"cinatra_wt"."representation"`);
    expect(schemaSql).toContain(`'"cinatra_wt"."representation"'::regclass`);
  });
});

describe("core__0059 — generic-write guard", () => {
  const guard = mod.buildGenericWriteGuardSql();
  const joined = guard.join("\n");

  it("creates a BEFORE INSERT OR UPDATE trigger on objects that rejects the retired type", () => {
    expect(joined).toMatch(/CREATE OR REPLACE FUNCTION fn_objects_reject_retired_generic_type/);
    expect(joined).toMatch(/IF NEW\.type = '@cinatra-ai\/artifact:object' THEN/);
    expect(joined).toMatch(/RAISE EXCEPTION/);
    expect(joined).toMatch(
      /CREATE TRIGGER trg_objects_reject_retired_generic_type BEFORE INSERT OR UPDATE ON objects/,
    );
  });

  it("is idempotent (CREATE OR REPLACE fn + DROP TRIGGER IF EXISTS before CREATE)", () => {
    expect(joined).toMatch(/DROP TRIGGER IF EXISTS trg_objects_reject_retired_generic_type ON objects/);
  });

  it("qualifies the function + trigger target when a schema is given", () => {
    const schemaGuard = mod.buildGenericWriteGuardSql("cinatra_wt").join("\n");
    expect(schemaGuard).toContain(`"cinatra_wt"."fn_objects_reject_retired_generic_type"`);
    expect(schemaGuard).toContain(`ON "cinatra_wt"."objects"`);
  });
});
