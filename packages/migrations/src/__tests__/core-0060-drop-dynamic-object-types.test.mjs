// core__0060 dynamic-types engine teardown (owner ruling 2026-07-18; epic
// cinatra#1785 entry 95; closes #1793) — SQL-builder shape + guard/idempotency/
// existence-guard assertions. Mirrors the core-0059 test idiom (assert the SQL
// shape without a live DB; the live drop + per-precondition RAISE are exercised
// by the DB-gated integration test
// src/lib/__tests__/integration/drop-dynamic-object-types.test.ts).
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const mod = await import(
  path.join(REPO_ROOT, "migrations", "core", "core__0060_drop-dynamic-object-types.mjs")
);
// The ledger every consumer sees is the manifest.json + manifest.d/ union.
const { readManifestUnion } = await import(
  path.join(REPO_ROOT, "migrations", "manifest-reader.mjs")
);

describe("core__0060 — module shape", () => {
  it("exports up/down + the guard/drop SQL builders + the precondition data", () => {
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
    expect(typeof mod.buildGuardSql).toBe("function");
    expect(typeof mod.buildDropSql).toBe("function");
    expect(mod.DYNAMIC_OBJECT_TYPES_TABLE).toBe("dynamic_object_types");
    expect(Array.isArray(mod.DROP_PRECONDITIONS)).toBe(true);
    expect(mod.DROP_PRECONDITIONS.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("down() THROWS (irreversible clean-break teardown)", () => {
    expect(() => mod.down()).toThrow(/clean-break|backup/i);
  });

  it("ships its append-only ledger fragment (union ledger seq 0060, destructive)", () => {
    const { entries, errors } = readManifestUnion(path.join(REPO_ROOT, "migrations"));
    expect(errors).toEqual([]);
    const entry = entries.find((m) => m.seq === "0060");
    expect(entry).toBeDefined();
    expect(entry?.file).toBe("core/core__0060_drop-dynamic-object-types.mjs");
    expect(entry?.destructive).toBe(true);
    expect(entry?.tables).toEqual(["dynamic_object_types"]);
  });
});

describe("core__0060 — guard statements", () => {
  const guards = mod.buildGuardSql();

  it("emits exactly one guard DO-block per precondition (a),(b),(c)", () => {
    expect(guards).toHaveLength(3);
    expect(guards[0]).toContain("$core0060a$");
    expect(guards[1]).toContain("$core0060b$");
    expect(guards[2]).toContain("$core0060c$");
  });

  it("(a) refuses on non-retired claims referencing a dynamic type", () => {
    const a = guards[0];
    expect(a).toMatch(/FROM artifact_type_claims c/);
    expect(a).toMatch(/c\.status <> 'retired'/);
    expect(a).toMatch(/c\.object_type_id IN \(SELECT type FROM dynamic_object_types\)/);
    expect(a).toMatch(/RAISE EXCEPTION 'core__0060 precondition \(a\) FAILED/);
  });

  it("(b) refuses on UNFINISHED reconcile-queue rows via the denormalized (both-axis) object_type_id", () => {
    const b = guards[1];
    expect(b).toMatch(/FROM artifact_binding_reconcile_queue q/);
    // only unfinished work blocks (a durable 'done' row is harmless history)
    expect(b).toMatch(/q\.status IN \('pending', 'failed'\)/);
    // the queue's NOT-NULL object_type_id covers claim-side AND write-side rows
    expect(b).toMatch(/q\.object_type_id IN \(SELECT type FROM dynamic_object_types\)/);
    expect(b).toMatch(/RAISE EXCEPTION 'core__0060 precondition \(b\) FAILED/);
  });

  it("(c) refuses on UNFINISHED (status <> 'done', incl. 'processing') outbox rows for a dynamic type", () => {
    const c = guards[2];
    expect(c).toMatch(/FROM graphiti_projection_outbox g/);
    expect(c).toMatch(/JOIN objects o ON o\.id = g\.object_id/);
    // <> 'done' INCLUDES the transient 'processing' state (in-flight work)
    expect(c).toMatch(/g\.status <> 'done'/);
    expect(c).not.toMatch(/g\.status IN \('pending', 'failed'\)/);
    expect(c).toMatch(/o\.type IN \(SELECT type FROM dynamic_object_types\)/);
    expect(c).toMatch(/RAISE EXCEPTION 'core__0060 precondition \(c\) FAILED/);
  });

  it("every guard is existence+column guarded (missing table OR missing 'type' column => no-op)", () => {
    for (const g of guards) {
      expect(g).toMatch(/to_regclass\('dynamic_object_types'\) IS NULL/);
      // legacy id/payload-shaped table (no 'type' column) is skipped, then dropped
      expect(g).toMatch(/pg_attribute[\s\S]*attname = 'type'/);
      expect(g).toMatch(/RETURN;/);
    }
  });
});

describe("core__0060 — drop statement", () => {
  it("drops the table with IF EXISTS and no CASCADE (no FKs / triggers)", () => {
    const drop = mod.buildDropSql();
    expect(drop).toHaveLength(1);
    expect(drop[0]).toBe("DROP TABLE IF EXISTS dynamic_object_types");
    expect(drop[0]).not.toMatch(/CASCADE/);
  });
});

describe("core__0060 — schema qualification (integration path)", () => {
  it("qualifies identifiers, regclass literals, and to_regclass args when a schema is given", () => {
    const guards = mod.buildGuardSql("cinatra_wt");
    const joined = guards.join("\n");
    expect(joined).toContain(`"cinatra_wt"."artifact_type_claims"`);
    expect(joined).toContain(`"cinatra_wt"."dynamic_object_types"`);
    expect(joined).toContain(`to_regclass('"cinatra_wt"."dynamic_object_types"')`);
    const drop = mod.buildDropSql("cinatra_wt");
    expect(drop[0]).toBe(`DROP TABLE IF EXISTS "cinatra_wt"."dynamic_object_types"`);
  });
});
