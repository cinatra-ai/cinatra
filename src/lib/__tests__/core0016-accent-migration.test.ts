/**
 * Emitted-SQL shape guard for core__0016 (accent-palette reconciliation,
 * cinatra#988 item 7).
 *
 * The full transformation was proven against a live Postgres (remap +
 * CHECK swap on both surfaces, idempotent re-run, down() round-trip,
 * missing-table no-op — see the PR record). This unit pins the emitted
 * statements so a future edit cannot silently reorder the steps (the old
 * CHECK must be GONE before the remap writes values outside its union —
 * the exact bug the live proof caught) or drift the remap/CHECK sets away
 * from `EXTENSION_ACCENTS`.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";

import { EXTENSION_ACCENTS } from "@/lib/extension-accent";

const MIGRATION = path.join(
  __dirname,
  "../../../migrations/core/core__0016_accent-palette-spec-categorical.mjs",
);

type MigrationFn = (pgm: { sql: (s: string) => void }) => void;

async function emitted(fn: "up" | "down"): Promise<string[]> {
  const mod = (await import(MIGRATION)) as Record<string, MigrationFn>;
  const stmts: string[] = [];
  mod[fn]({ sql: (s) => stmts.push(s) });
  return stmts;
}

describe("core__0016 accent-palette migration — emitted SQL shape", () => {
  it("up() reconciles both persisted surfaces", async () => {
    const stmts = await emitted("up");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('public."user"');
    expect(stmts[0]).toContain("user_accent_color_check");
    expect(stmts[1]).toContain("extension_accent_color");
    expect(stmts[1]).toContain("current_schema()");
    expect(stmts[1]).toContain("extension_accent_color_accent_color_check");
  });

  it("up() orders drop-old-CHECK before remap before add-new-CHECK", async () => {
    for (const sql of await emitted("up")) {
      const drop = sql.indexOf("DROP CONSTRAINT");
      const remap = sql.indexOf("UPDATE ");
      const add = sql.indexOf("ADD CONSTRAINT");
      expect(drop).toBeGreaterThan(-1);
      expect(remap).toBeGreaterThan(drop);
      expect(add).toBeGreaterThan(remap);
    }
  });

  it("up() CHECK array is exactly EXTENSION_ACCENTS and never a retired value", async () => {
    for (const sql of await emitted("up")) {
      const check = sql.match(/ANY \(ARRAY\[(.*?)\]\)/)?.[1] ?? "";
      const values = [...check.matchAll(/'([a-z]+)'::text/g)].map((m) => m[1]);
      expect(values).toHaveLength(EXTENSION_ACCENTS.length);
      expect(new Set(values)).toEqual(new Set(EXTENSION_ACCENTS));
      for (const retired of ["indigo", "mustard", "slate"]) {
        expect(values).not.toContain(retired);
      }
    }
  });

  it("up() remaps every retired value into the new union", async () => {
    for (const sql of await emitted("up")) {
      expect(sql).toContain("WHEN 'indigo' THEN 'plum'");
      expect(sql).toContain("WHEN 'slate' THEN 'plum'");
      expect(sql).toContain("WHEN 'mustard' THEN 'rust'");
      expect(sql).toContain("accent_color IN ('indigo', 'slate', 'mustard')");
    }
  });

  it("up() guards the never-provisioned lineage (missing column = no-op)", async () => {
    for (const sql of await emitted("up")) {
      expect(sql).toContain("information_schema.columns");
      expect(sql).toContain("RETURN; -- surface never provisioned");
    }
  });

  it("down() remaps the four new values back and restores the legacy union", async () => {
    const stmts = await emitted("down");
    expect(stmts).toHaveLength(2);
    for (const sql of stmts) {
      expect(sql).toContain("WHEN 'rust' THEN 'mustard'");
      expect(sql).toContain("WHEN 'olive' THEN 'green'");
      expect(sql).toContain("WHEN 'plum' THEN 'indigo'");
      expect(sql).toContain("WHEN 'clay' THEN 'red'");
      const check = sql.match(/ANY \(ARRAY\[(.*?)\]\)/)?.[1] ?? "";
      const values = [...check.matchAll(/'([a-z]+)'::text/g)].map((m) => m[1]);
      expect(new Set(values)).toEqual(
        new Set(["red", "burgundy", "indigo", "green", "mustard", "slate"]),
      );
    }
  });
});
