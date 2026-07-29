// cinatra#1942 (archive program S6 — the empty-name rider) —
// `ensureOrganizationNameNotBlank`, the app-owned guarded DDL that backfills
// legacy blank/whitespace-only `public."organization"."name"` values and then
// arms a `CHECK (btrim(name) <> '')`. Better Auth's `name.required` rejects
// null/empty but NOT a whitespace-only string, and the third-party
// create-organization dialog bypasses the first-party trim — so blank names
// can exist; core__0053 handled NULL names only.
//
// Driven against a scripted fake pg pool (no live Postgres): the contract here
// is WHICH statements run in WHICH branch, that the whole
// probe -> LOCK -> backfill -> ADD CONSTRAINT unit is serialized (BEGIN + a
// constant-key advisory xact-lock BEFORE the probe), that the backfill runs
// BEFORE the constraint is armed (so the ADD validates cleanly), that the
// blank predicate + id-derived placeholder are exactly as designed, that the
// CHECK definition is validated (contype/convalidated/pg_get_constraintdef — a
// same-named wrong/NOT-VALID constraint is replaced), and that ANY failure
// rolls back and rethrows (a table whose guard cannot be armed must stop the
// deployment, never be silently skipped).

import { describe, it, expect, vi } from "vitest";
import type pg from "pg";

import { ensureOrganizationNameNotBlank } from "../../../scripts/better-auth-migrate.mts";

type FakeResult = { rows: unknown[]; rowCount: number };
type Handler = (sql: string) => Partial<FakeResult> | Error;

function makeFakePool(handler: Handler) {
  const clientQueries: string[] = [];
  const run = async (sql: string): Promise<FakeResult> => {
    clientQueries.push(sql);
    const out = handler(sql);
    if (out instanceof Error) throw out;
    return { rows: out.rows ?? [], rowCount: out.rowCount ?? 0 };
  };
  const client = {
    query: vi.fn((sql: string) => run(sql)),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn((sql: string) => run(sql)),
    connect: vi.fn(async () => client),
  };
  return { pool: pool as unknown as pg.Pool, raw: pool, client, clientQueries };
}

// The canonical form Postgres stores for `CHECK (btrim(name) <> '')`.
const VALID_NAME_CHECK_DEF = `CHECK ((btrim(name) <> ''::text))`;

/** Handler presets keyed by probe results. */
function scripted(opts: {
  tableExists: boolean;
  constraint?: { contype?: string; convalidated?: boolean; def?: string } | null;
  backfillCount?: number;
  failOn?: (sql: string) => boolean;
}): Handler {
  return (sql) => {
    if (opts.failOn?.(sql)) return new Error("boom");
    if (sql.includes("pg_advisory_xact_lock")) return {};
    if (sql.includes("information_schema.tables")) {
      return { rows: [{ exists: opts.tableExists }] };
    }
    if (sql.includes("LOCK TABLE")) return {};
    // The backfill UPDATE (the only statement carrying the id-derived placeholder).
    if (sql.includes("left(id, 8)")) {
      return { rowCount: opts.backfillCount ?? 0 };
    }
    if (sql.includes("pg_constraint")) {
      const c = opts.constraint;
      return c
        ? {
            rows: [
              {
                contype: c.contype ?? "c",
                convalidated: c.convalidated ?? true,
                def: c.def ?? VALID_NAME_CHECK_DEF,
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    return {};
  };
}

describe("ensureOrganizationNameNotBlank", () => {
  it("serializes on a constant-key advisory xact-lock BEFORE probing (concurrent runners cannot race the backfill/arm)", async () => {
    const fake = makeFakePool(scripted({ tableExists: true }));
    await ensureOrganizationNameNotBlank(fake.pool);
    const q = fake.clientQueries;
    expect(q[0]).toBe("BEGIN");
    expect(q[1]).toContain("pg_advisory_xact_lock");
    // The advisory key is namespaced to this step.
    expect(q[1]).toContain("organization.nameNotBlank");
    const lockIdx = q.findIndex((s) => s.includes("pg_advisory_xact_lock"));
    const tableIdx = q.findIndex((s) => s.includes("information_schema.tables"));
    expect(lockIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(tableIdx);
  });

  it("skips (rolls back, never LOCKs, no DDL) when the organization table does not exist", async () => {
    const fake = makeFakePool(scripted({ tableExists: false }));
    const result = await ensureOrganizationNameNotBlank(fake.pool);
    expect(result).toEqual({
      provisioned: false,
      backfilledNames: 0,
      skipped: "table-missing",
    });
    const joined = fake.clientQueries.join("\n");
    expect(fake.clientQueries).toContain("ROLLBACK");
    // Never LOCK or ALTER a table that isn't there.
    expect(joined).not.toContain("LOCK TABLE");
    expect(joined).not.toContain("ALTER TABLE");
    expect(joined).not.toContain("COMMIT");
    expect(fake.client.release).toHaveBeenCalledTimes(1);
  });

  it("LOCKs, backfills blank names, THEN arms the CHECK atomically when the constraint is absent", async () => {
    const fake = makeFakePool(scripted({ tableExists: true, backfillCount: 4 }));
    const result = await ensureOrganizationNameNotBlank(fake.pool);
    expect(result).toEqual({ provisioned: true, backfilledNames: 4 });

    const q = fake.clientQueries;
    expect(q[0]).toBe("BEGIN");
    expect(q.at(-1)).toBe("COMMIT");
    const joined = q.join("\n");
    // Rolling-deploy writer guard (mirrors core__0053).
    expect(joined).toContain(
      `LOCK TABLE public."organization" IN SHARE ROW EXCLUSIVE MODE`,
    );
    // Blank predicate + deterministic id-derived placeholder.
    expect(joined).toContain(`WHERE btrim(name) = ''`);
    expect(joined).toContain(`'Organization (' || left(id, 8) || ')'`);
    // Armed CHECK.
    expect(joined).toContain(
      `ADD CONSTRAINT "organization_name_not_blank" CHECK (btrim(name) <> '')`,
    );
    // No DROP on a fresh arm.
    expect(fake.clientQueries.filter((s) => s.includes("DROP CONSTRAINT"))).toHaveLength(0);

    // Ordering: existence probe -> LOCK -> backfill -> constraint arm.
    const tableIdx = q.findIndex((s) => s.includes("information_schema.tables"));
    const lockIdx = q.findIndex((s) => s.includes("LOCK TABLE"));
    const backfillIdx = q.findIndex((s) => s.includes("left(id, 8)"));
    const addIdx = q.findIndex((s) => s.includes("ADD CONSTRAINT"));
    expect(tableIdx).toBeLessThan(lockIdx);
    expect(lockIdx).toBeLessThan(backfillIdx);
    expect(backfillIdx).toBeLessThan(addIdx);
    expect(fake.client.release).toHaveBeenCalledTimes(1);
  });

  it("accepts an existing constraint only with the EXPECTED definition (conrelid+contype+convalidated+def), skipping ADD/DROP", async () => {
    const fake = makeFakePool(
      scripted({
        tableExists: true,
        constraint: { contype: "c", convalidated: true, def: VALID_NAME_CHECK_DEF },
      }),
    );
    const result = await ensureOrganizationNameNotBlank(fake.pool);
    // Idempotent re-run: constraint already correct, backfill finds nothing.
    expect(result).toEqual({ provisioned: false, backfilledNames: 0 });

    const probe = fake.clientQueries.find((s) => s.includes("pg_constraint"));
    expect(probe).toContain(`conrelid = 'public."organization"'::regclass`);
    expect(probe).toContain("pg_get_constraintdef");
    expect(fake.clientQueries.filter((s) => s.includes("ADD CONSTRAINT"))).toHaveLength(0);
    expect(fake.clientQueries.filter((s) => s.includes("DROP CONSTRAINT"))).toHaveLength(0);
    expect(fake.clientQueries.at(-1)).toBe("COMMIT");
  });

  it("REPLACES a same-named constraint whose definition is wrong", async () => {
    const fake = makeFakePool(
      scripted({
        tableExists: true,
        constraint: {
          contype: "c",
          convalidated: true,
          def: `CHECK ((length(name) > 0))`,
        },
      }),
    );
    const result = await ensureOrganizationNameNotBlank(fake.pool);
    expect(result.provisioned).toBe(true);
    const joined = fake.clientQueries.join("\n");
    expect(joined).toContain(`DROP CONSTRAINT "organization_name_not_blank"`);
    expect(joined).toContain(`ADD CONSTRAINT "organization_name_not_blank"`);
  });

  it("REPLACES a same-named constraint that is NOT VALID (re-add validates every row)", async () => {
    const fake = makeFakePool(
      scripted({
        tableExists: true,
        constraint: { contype: "c", convalidated: false, def: VALID_NAME_CHECK_DEF },
      }),
    );
    const result = await ensureOrganizationNameNotBlank(fake.pool);
    expect(result.provisioned).toBe(true);
    const joined = fake.clientQueries.join("\n");
    expect(joined).toContain(`DROP CONSTRAINT "organization_name_not_blank"`);
    expect(joined).toContain(`ADD CONSTRAINT "organization_name_not_blank"`);
  });

  it("rolls back and RETHROWS (wrapped, fail-loud) when arming the constraint fails mid-flight", async () => {
    const fake = makeFakePool(
      scripted({
        tableExists: true,
        failOn: (sql) => sql.includes("ADD CONSTRAINT"),
      }),
    );
    await expect(ensureOrganizationNameNotBlank(fake.pool)).rejects.toThrow(
      /public\."organization"\.name non-blank guard failed/,
    );
    expect(fake.clientQueries).toContain("ROLLBACK");
    expect(fake.clientQueries).not.toContain("COMMIT");
    expect(fake.client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and rethrows when the backfill fails mid-flight (never leaves a half-run)", async () => {
    const fake = makeFakePool(
      scripted({
        tableExists: true,
        failOn: (sql) => sql.includes("left(id, 8)"),
      }),
    );
    await expect(ensureOrganizationNameNotBlank(fake.pool)).rejects.toThrow(/boom/);
    expect(fake.clientQueries).toContain("ROLLBACK");
    expect(fake.clientQueries).not.toContain("COMMIT");
    // Never reached the constraint step.
    expect(fake.clientQueries.join("\n")).not.toContain("ADD CONSTRAINT");
    expect(fake.client.release).toHaveBeenCalledTimes(1);
  });
});
