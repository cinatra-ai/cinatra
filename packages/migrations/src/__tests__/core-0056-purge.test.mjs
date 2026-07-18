// core__0056 retired-type object-row purge (eng#548 entry 95; epic cinatra#1785;
// #1792) — SQL-builder shape + ordering/idempotency guards. Mirrors the
// core-0051 test idiom (assert the SQL shape without a live DB; the live cascade
// is exercised by the schema-migration-gate upgrade proof).
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const mod = await import(
  path.join(REPO_ROOT, "migrations", "core", "core__0056_purge-retired-object-types.mjs")
);

describe("core__0056 — module shape", () => {
  it("exports up/down + the SQL builder + the retired-type data", () => {
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
    expect(typeof mod.buildPurgeSql).toBe("function");
    expect(typeof mod.retiredTypePredicate).toBe("function");
    expect(Array.isArray(mod.RETIRED_TYPE_PREDICATE_PARTS)).toBe(true);
    expect(Array.isArray(mod.OBJECT_ID_REFERENCING_TABLES)).toBe(true);
  });

  it("down() THROWS (irreversible clean-break purge)", () => {
    expect(() => mod.down()).toThrow(/clean-break|backup/i);
  });
});

describe("core__0056 — retired-type predicate", () => {
  const pred = mod.retiredTypePredicate();

  it("targets the generic floor exactly", () => {
    expect(pred).toContain(`type = '@cinatra-ai/objects:object'`);
  });

  it("targets BOTH tombstoned dynamic namespaces prefix-exact", () => {
    expect(pred).toContain(`type LIKE '@dynamic/types:%'`);
    expect(pred).toContain(`type LIKE '@cinatra-ai/dynamic:%'`);
  });

  it("does NOT purge the per-package `:artifact` descriptor umbrellas (kept as explicit defs)", () => {
    expect(pred).not.toContain(":artifact");
  });

  it("is a parenthesized OR of the declared parts", () => {
    expect(pred).toBe(`(${mod.RETIRED_TYPE_PREDICATE_PARTS.join(" OR ")})`);
  });
});

describe("core__0056 — purge statements", () => {
  const sql = mod.buildPurgeSql();
  const joined = sql.join("\n;\n");

  it("captures retired object ids and their change_sets into temp tables FIRST", () => {
    expect(sql[0]).toMatch(/CREATE TEMP TABLE _purge_obj ON COMMIT DROP/);
    expect(sql[1]).toMatch(/CREATE TEMP TABLE _purge_cs ON COMMIT DROP/);
    // _purge_cs must be captured from object_change_event before events are deleted.
    expect(sql[1]).toMatch(/FROM object_change_event/);
  });

  it("sweeps every object_id-referencing table", () => {
    for (const tbl of mod.OBJECT_ID_REFERENCING_TABLES) {
      expect(joined).toMatch(
        new RegExp(`DELETE FROM ${tbl} WHERE object_id IN \\(SELECT id FROM _purge_obj\\)`),
      );
    }
  });

  it("deletes remote_effect_attempts BEFORE the object_change_event rows they reference", () => {
    const reIdx = sql.findIndex((s) => /DELETE FROM remote_effect_attempts/.test(s));
    const eventIdx = sql.findIndex((s) =>
      /DELETE FROM object_change_event WHERE object_id/.test(s),
    );
    expect(reIdx).toBeGreaterThanOrEqual(0);
    expect(eventIdx).toBeGreaterThan(reIdx);
  });

  it("orphan-sweeps only change_sets with NO remaining events (mixed sets survive)", () => {
    const cs = sql.find((s) => /DELETE FROM change_set/.test(s));
    expect(cs).toMatch(/id IN \(SELECT id FROM _purge_cs\)/);
    expect(cs).toMatch(/NOT EXISTS[\s\S]*object_change_event/);
  });

  it("deletes the object rows LAST", () => {
    const last = sql[sql.length - 1];
    expect(last).toMatch(/DELETE FROM objects WHERE id IN \(SELECT id FROM _purge_obj\)/);
  });

  it("qualifies identifiers when a schema is given (integration path)", () => {
    const schemaSql = mod.buildPurgeSql("cinatra_wt").join("\n");
    expect(schemaSql).toContain(`"cinatra_wt"."objects"`);
    expect(schemaSql).toContain(`"cinatra_wt"."object_change_event"`);
  });
});
