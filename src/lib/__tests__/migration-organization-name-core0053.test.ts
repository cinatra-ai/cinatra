// Contract test for the organization.name NOT NULL convergence migration
// (migrations/core/core__0053_organization-name-not-null.mjs, cinatra#1737
// Stage C). Scripted pgm.db mock (no DB), mirroring the core__0015 test:
// pins the smallest-free-N assignment (gaps fill first, strict canonical
// matcher), the createdAt-ordered backfill scan, the rolling-deploy table
// lock, the guarded SET NOT NULL, and down()'s constraint-only revert.

import { describe, it, expect } from "vitest";

import {
  up,
  down,
  assignSequentialNames,
  SEQUENTIAL_NAME_RE,
} from "../../../migrations/core/core__0053_organization-name-not-null.mjs";

describe("assignSequentialNames (smallest free N)", () => {
  it("fills gaps first instead of max+1", () => {
    expect(
      assignSequentialNames(["Organization (1)", "Organization (3)", "Organization (7)"], 3),
    ).toEqual(["Organization (2)", "Organization (4)", "Organization (5)"]);
  });

  it("starts at 1 on an instance with no canonical names", () => {
    expect(assignSequentialNames(["Acme", "Beta GmbH"], 2)).toEqual([
      "Organization (1)",
      "Organization (2)",
    ]);
  });

  it("does NOT let non-canonical variants reserve a slot", () => {
    // "(01)"/"(0)" are not canonical positive integers; casing and
    // surrounding text must not match either.
    const taken = [
      "Organization (01)",
      "Organization (0)",
      "organization (1)",
      "Organization (2) old",
      "An Organization (3)",
    ];
    expect(assignSequentialNames(taken, 2)).toEqual(["Organization (1)", "Organization (2)"]);
  });

  it("accounts for its own assignments within one run", () => {
    expect(assignSequentialNames([], 3)).toEqual([
      "Organization (1)",
      "Organization (2)",
      "Organization (3)",
    ]);
  });

  it("matcher accepts only the exact canonical shape", () => {
    expect("Organization (12)").toMatch(SEQUENTIAL_NAME_RE);
    expect("Organization (1)").toMatch(SEQUENTIAL_NAME_RE);
    expect("Organization (01)").not.toMatch(SEQUENTIAL_NAME_RE);
    expect("Organization (0)").not.toMatch(SEQUENTIAL_NAME_RE);
    expect("Organization ()").not.toMatch(SEQUENTIAL_NAME_RE);
    expect(" Organization (1)").not.toMatch(SEQUENTIAL_NAME_RE);
  });
});

type Call = { sql: string; params?: unknown[] };

function mockPgm(opts: { nullRowIds?: string[]; namedRows?: string[] }) {
  const calls: Call[] = [];
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/WHERE name IS NULL/.test(sql)) {
        return { rows: (opts.nullRowIds ?? []).map((id) => ({ id })) };
      }
      if (/WHERE name IS NOT NULL/.test(sql)) {
        return { rows: (opts.namedRows ?? []).map((name) => ({ name })) };
      }
      return { rows: [] };
    },
  };
  return { pgm: { db } as never, calls };
}

describe("core__0053 up()", () => {
  it("locks the table BEFORE scanning (rolling-deploy writer guard)", async () => {
    const { pgm, calls } = mockPgm({ nullRowIds: [] });
    await up(pgm);
    expect(calls[0].sql).toMatch(/LOCK TABLE public\."organization" IN SHARE ROW EXCLUSIVE MODE/);
  });

  it("backfills null rows in scan order with smallest-free-N names", async () => {
    const { pgm, calls } = mockPgm({
      nullRowIds: ["org-b", "org-a"],
      namedRows: ["Organization (1)", "Acme"],
    });
    await up(pgm);
    const updates = calls.filter((c) => /UPDATE public\."organization" SET name/.test(c.sql));
    expect(updates.map((c) => c.params)).toEqual([
      ["Organization (2)", "org-b"],
      ["Organization (3)", "org-a"],
    ]);
  });

  it("scan orders by createdAt ASC NULLS LAST with id tiebreak", async () => {
    const { pgm, calls } = mockPgm({ nullRowIds: [] });
    await up(pgm);
    const scan = calls.find((c) => /WHERE name IS NULL/.test(c.sql));
    expect(scan?.sql).toMatch(/ORDER BY "createdAt" ASC NULLS LAST, id ASC/);
  });

  it("skips UPDATEs when no null rows exist but still runs the guarded constraint step", async () => {
    const { pgm, calls } = mockPgm({ nullRowIds: [] });
    await up(pgm);
    expect(calls.some((c) => /UPDATE public\."organization"/.test(c.sql))).toBe(false);
    const ddl = calls.find((c) => /SET NOT NULL/.test(c.sql));
    // The DO block re-checks pg_attribute so a fresh/already-converged
    // schema is a no-op (idempotent, lineage-tolerant).
    expect(ddl?.sql).toMatch(/attnotnull/);
    expect(ddl?.sql).toMatch(/ALTER TABLE public\."organization" ALTER COLUMN name SET NOT NULL/);
  });
});

describe("core__0053 down()", () => {
  it("drops the constraint only — backfilled names stay", async () => {
    const { pgm, calls } = mockPgm({});
    await down(pgm);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/ALTER COLUMN name DROP NOT NULL/);
    expect(calls[0].sql).not.toMatch(/UPDATE/);
  });
});
