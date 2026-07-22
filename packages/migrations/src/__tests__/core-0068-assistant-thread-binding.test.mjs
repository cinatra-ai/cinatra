// core__0068 assistant-thread binding columns (cinatra#1875 Epic #1873 W2, AC#4)
// — SQL-builder shape + idempotency/reversibility/parity assertions (no live DB).
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const mod = await import(
  path.join(REPO_ROOT, "migrations", "core", "core__0068_assistant-thread-binding.mjs")
);
const { readManifestUnion } = await import(
  path.join(REPO_ROOT, "migrations", "manifest-reader.mjs")
);

describe("core__0068 — module shape", () => {
  it("exports up/down + the SQL builders", () => {
    for (const fn of ["up", "down", "buildUpSql", "buildDownSql", "buildAssistantThreadBindingSql"]) {
      expect(typeof mod[fn]).toBe("function");
    }
    expect(mod.ASSISTANT_THREADS_TABLE).toBe("assistant_threads");
  });

  it("ships its append-only ledger fragment (union ledger seq 0068, non-destructive)", () => {
    const { entries, errors } = readManifestUnion(path.join(REPO_ROOT, "migrations"));
    expect(errors).toEqual([]);
    const entry = entries.find((m) => m.seq === "0068");
    expect(entry).toBeDefined();
    expect(entry?.file).toBe("core/core__0068_assistant-thread-binding.mjs");
    expect(entry?.destructive).toBe(false);
    expect(entry?.tables).toEqual(["assistant_threads"]);
  });
});

describe("core__0068 — up SQL shape", () => {
  const up = mod.buildUpSql().join("\n;;\n");

  it("adds BOTH binding columns, additive + idempotent (ADD COLUMN IF NOT EXISTS)", () => {
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS assistant_package text/);
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS instance_id text/);
    // Only additive column adds — no data mutation, no table create/drop on up.
    expect(up).not.toMatch(/DROP/i);
    expect(up).not.toMatch(/UPDATE|DELETE/i);
  });

  it("targets the assistant_threads table", () => {
    expect(up).toMatch(/ALTER TABLE assistant_threads/);
  });

  it("qualifies identifiers when a schema is supplied (integration path)", () => {
    const qualified = mod.buildUpSql("app").join("\n");
    expect(qualified).toMatch(/"app"\."assistant_threads"/);
  });
});

describe("core__0068 — down SQL (reversible)", () => {
  it("drops BOTH added columns (true reverse of up)", () => {
    const down = mod.buildDownSql().join("\n");
    expect(down).toMatch(/DROP COLUMN IF EXISTS instance_id/);
    expect(down).toMatch(/DROP COLUMN IF EXISTS assistant_package/);
    // Reverse touches ONLY the columns up added — it must not drop the table.
    expect(down).not.toMatch(/DROP TABLE/i);
  });

  it("qualifies identifiers when a schema is supplied", () => {
    const down = mod.buildDownSql("app").join("\n");
    expect(down).toMatch(/"app"\."assistant_threads"/);
  });
});
