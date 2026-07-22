// core__0069 assistant-thread title-slug column + container unique index
// (cinatra#1878 Epic #1873 W3, AC#2) — SQL-builder shape + idempotency /
// reversibility / parity assertions (no live DB).
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const mod = await import(
  path.join(REPO_ROOT, "migrations", "core", "core__0069_assistant-thread-title-slug.mjs")
);
const { readManifestUnion } = await import(
  path.join(REPO_ROOT, "migrations", "manifest-reader.mjs")
);

describe("core__0069 — module shape", () => {
  it("exports up/down + the SQL builders", () => {
    for (const fn of ["up", "down", "buildUpSql", "buildDownSql", "buildAssistantThreadTitleSlugSql"]) {
      expect(typeof mod[fn]).toBe("function");
    }
    expect(mod.ASSISTANT_THREADS_TABLE).toBe("assistant_threads");
    expect(mod.CONTAINER_SLUG_UNIQUE_INDEX).toBe("assistant_threads_container_slug_uniq");
  });

  it("ships its append-only ledger fragment (union ledger seq 0069, non-destructive)", () => {
    const { entries, errors } = readManifestUnion(path.join(REPO_ROOT, "migrations"));
    expect(errors).toEqual([]);
    const entry = entries.find((m) => m.seq === "0069");
    expect(entry).toBeDefined();
    expect(entry?.file).toBe("core/core__0069_assistant-thread-title-slug.mjs");
    expect(entry?.destructive).toBe(false);
    expect(entry?.tables).toEqual(["assistant_threads"]);
  });
});

describe("core__0069 — up SQL shape", () => {
  const up = mod.buildUpSql().join("\n;;\n");

  it("adds the title_slug column, additive + idempotent (ADD COLUMN IF NOT EXISTS)", () => {
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS title_slug text/);
  });

  it("creates the container-scoped PARTIAL UNIQUE index idempotently", () => {
    expect(up).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS assistant_threads_container_slug_uniq/);
    expect(up).toMatch(/COALESCE\(assistant_package, ''\), COALESCE\(instance_id, ''\), title_slug/);
    expect(up).toMatch(/WHERE title_slug IS NOT NULL/);
  });

  it("is non-destructive on up (no data mutation, no table drop)", () => {
    expect(up).not.toMatch(/DROP/i);
    expect(up).not.toMatch(/UPDATE|DELETE/i);
    expect(up).toMatch(/ALTER TABLE assistant_threads/);
  });

  it("qualifies identifiers when a schema is supplied (integration path)", () => {
    const qualified = mod.buildUpSql("app").join("\n");
    expect(qualified).toMatch(/"app"\."assistant_threads"/);
  });
});

describe("core__0069 — down SQL (reversible)", () => {
  const down = mod.buildDownSql().join("\n");

  it("drops the index then the added column (true reverse of up)", () => {
    expect(down).toMatch(/DROP INDEX IF EXISTS assistant_threads_container_slug_uniq/);
    expect(down).toMatch(/DROP COLUMN IF EXISTS title_slug/);
    // Reverse touches ONLY what up added — it must not drop the table.
    expect(down).not.toMatch(/DROP TABLE/i);
    // Order: index before column (a unique index on the column can't survive the
    // column drop, and IF EXISTS keeps it a no-op either way).
    expect(down.indexOf("DROP INDEX")).toBeLessThan(down.indexOf("DROP COLUMN"));
  });

  it("qualifies identifiers when a schema is supplied", () => {
    const q = mod.buildDownSql("app").join("\n");
    expect(q).toMatch(/"app"\."assistant_threads"/);
    expect(q).toMatch(/"app"\."assistant_threads_container_slug_uniq"/);
  });
});
