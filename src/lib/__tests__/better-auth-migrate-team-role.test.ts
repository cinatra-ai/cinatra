// cinatra#1566 — `ensureTeamMemberRoleColumn`, the app-owned guarded DDL that
// provisions `public."teamMember"."role"`. This is the ONLY correct
// provisioning site: better-auth 1.6.19's teamMember schema branch ignores
// `additionalFields` (better-auth discussion#2130; native support pending in
// better-auth#7628/#7886) and core `core__NNNN` migrations are
// ledger-faked on fresh schemas — so the bootstrap migration runner carries a
// post-step that must be idempotent, transactional, and backfill-once.
//
// Driven against a scripted fake pg pool (no live Postgres): the contract
// here is WHICH statements run in WHICH branch, that the whole
// probe→branch→DDL unit is serialized (BEGIN + a constant-key advisory
// xact-lock BEFORE the probes, so concurrent runners cannot double-run the
// one-shot backfill), that the CHECK constraint's DEFINITION is validated
// (contype/convalidated/pg_get_constraintdef — a same-named wrong constraint
// is replaced), that the one-shot backfill is deterministic (DISTINCT ON with
// the createdAt/id tie-break = earliest member ≈ the creator), and that ANY
// failure rolls back and rethrows (a half-shaped role column must stop the
// deployment, never be silently enabled).

import { describe, it, expect, vi } from "vitest";
import type pg from "pg";

import { ensureTeamMemberRoleColumn } from "../../../scripts/better-auth-migrate.mts";

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

const VALID_CHECK_DEF = `CHECK ((role = ANY (ARRAY['member'::text, 'admin'::text])))`;

/** Handler presets keyed by probe results. */
function scripted(opts: {
  tableExists: boolean;
  columnExists: boolean;
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
    if (sql.includes("information_schema.columns")) {
      return { rows: [{ exists: opts.columnExists }] };
    }
    if (sql.includes("pg_constraint")) {
      const c = opts.constraint;
      return c
        ? {
            rows: [
              {
                contype: c.contype ?? "c",
                convalidated: c.convalidated ?? true,
                def: c.def ?? VALID_CHECK_DEF,
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("SET \"role\" = 'admin'")) {
      return { rowCount: opts.backfillCount ?? 0 };
    }
    return {};
  };
}

describe("ensureTeamMemberRoleColumn", () => {
  it("serializes on a constant-key advisory xact-lock BEFORE probing (concurrent runners cannot double-backfill)", async () => {
    const fake = makeFakePool(
      scripted({ tableExists: true, columnExists: false }),
    );
    await ensureTeamMemberRoleColumn(fake.pool);
    const q = fake.clientQueries;
    expect(q[0]).toBe("BEGIN");
    expect(q[1]).toContain("pg_advisory_xact_lock");
    // Probes come AFTER the lock, on the SAME client/transaction — a loser
    // re-probes after the winner committed, sees the column, and takes the
    // repair path instead of re-running the one-shot backfill.
    const lockIdx = q.findIndex((s) => s.includes("pg_advisory_xact_lock"));
    const tableIdx = q.findIndex((s) => s.includes("information_schema.tables"));
    const columnIdx = q.findIndex((s) => s.includes("information_schema.columns"));
    expect(lockIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(tableIdx);
    expect(tableIdx).toBeLessThan(columnIdx);
  });

  it("skips (rolls back, no DDL) when the teamMember table does not exist", async () => {
    const fake = makeFakePool(
      scripted({ tableExists: false, columnExists: false }),
    );
    const result = await ensureTeamMemberRoleColumn(fake.pool);
    expect(result).toEqual({
      provisioned: false,
      backfilledAdmins: 0,
      skipped: "table-missing",
    });
    expect(fake.clientQueries).toContain("ROLLBACK");
    expect(fake.clientQueries.join("\n")).not.toContain("ALTER TABLE");
    expect(fake.client.release).toHaveBeenCalledTimes(1);
  });

  it("provisions column + CHECK + one-shot backfill atomically when the column is absent", async () => {
    const fake = makeFakePool(
      scripted({ tableExists: true, columnExists: false, backfillCount: 3 }),
    );
    const result = await ensureTeamMemberRoleColumn(fake.pool);
    expect(result).toEqual({ provisioned: true, backfilledAdmins: 3 });

    const q = fake.clientQueries;
    expect(q[0]).toBe("BEGIN");
    expect(q.at(-1)).toBe("COMMIT");
    const joined = q.join("\n");
    expect(joined).toContain(
      `ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'member'`,
    );
    expect(joined).toContain(`CHECK ("role" IN ('member', 'admin'))`);
    // Backfill determinism: exactly one 'admin' per team — earliest member,
    // stable tie-break (≈ the creator, inserted first by teams/new/actions).
    expect(joined).toContain(`DISTINCT ON ("teamId")`);
    expect(joined).toMatch(/ORDER BY "teamId", "createdAt" ASC, id ASC/);
    expect(fake.client.release).toHaveBeenCalledTimes(1);
  });

  it("accepts an existing constraint only with the EXPECTED definition (contype+convalidated+def), skipping ADD", async () => {
    const fake = makeFakePool(
      scripted({
        tableExists: true,
        columnExists: false,
        constraint: { contype: "c", convalidated: true, def: VALID_CHECK_DEF },
      }),
    );
    await ensureTeamMemberRoleColumn(fake.pool);
    const probe = fake.clientQueries.find((s) => s.includes("pg_constraint"));
    // conrelid-scoped (not name-only) and definition-bearing.
    expect(probe).toContain(`conrelid = 'public."teamMember"'::regclass`);
    expect(probe).toContain("pg_get_constraintdef");
    expect(
      fake.clientQueries.filter((s) => s.includes("ADD CONSTRAINT")),
    ).toHaveLength(0);
    expect(
      fake.clientQueries.filter((s) => s.includes("DROP CONSTRAINT")),
    ).toHaveLength(0);
  });

  it("REPLACES a same-named constraint whose definition is wrong", async () => {
    const fake = makeFakePool(
      scripted({
        tableExists: true,
        columnExists: false,
        constraint: {
          contype: "c",
          convalidated: true,
          def: `CHECK ((role = ANY (ARRAY['member'::text, 'admin'::text, 'owner'::text])))`,
        },
      }),
    );
    await ensureTeamMemberRoleColumn(fake.pool);
    const joined = fake.clientQueries.join("\n");
    expect(joined).toContain(`DROP CONSTRAINT "teamMember_role_check"`);
    expect(joined).toContain(`ADD CONSTRAINT "teamMember_role_check"`);
  });

  it("REPLACES a same-named constraint that is NOT VALID (re-add validates every row)", async () => {
    const fake = makeFakePool(
      scripted({
        tableExists: true,
        columnExists: true,
        constraint: { contype: "c", convalidated: false, def: VALID_CHECK_DEF },
      }),
    );
    await ensureTeamMemberRoleColumn(fake.pool);
    const joined = fake.clientQueries.join("\n");
    expect(joined).toContain(`DROP CONSTRAINT "teamMember_role_check"`);
    expect(joined).toContain(`ADD CONSTRAINT "teamMember_role_check"`);
  });

  it("is a shape-repair no-backfill pass when the column pre-exists (idempotent re-run)", async () => {
    const fake = makeFakePool(
      scripted({
        tableExists: true,
        columnExists: true,
        constraint: { contype: "c", convalidated: true, def: VALID_CHECK_DEF },
      }),
    );
    const result = await ensureTeamMemberRoleColumn(fake.pool);
    expect(result).toEqual({ provisioned: false, backfilledAdmins: 0 });

    const joined = fake.clientQueries.join("\n");
    // Repair: NULL cleanup + DEFAULT + NOT NULL (roleless inserts rely on
    // them) — but NEVER the one-shot backfill again.
    expect(joined).toContain(`SET "role" = 'member' WHERE "role" IS NULL`);
    expect(joined).toContain(`SET DEFAULT 'member'`);
    expect(joined).toContain(`SET NOT NULL`);
    expect(joined).not.toContain(`DISTINCT ON`);
    expect(joined).not.toContain(`SET "role" = 'admin'`);
  });

  it("rolls back and rethrows when the fresh-provisioning transaction fails mid-flight", async () => {
    const fake = makeFakePool(
      scripted({
        tableExists: true,
        columnExists: false,
        failOn: (sql) => sql.includes("DISTINCT ON"),
      }),
    );
    await expect(ensureTeamMemberRoleColumn(fake.pool)).rejects.toThrow(/boom/);
    expect(fake.clientQueries).toContain("ROLLBACK");
    expect(fake.clientQueries).not.toContain("COMMIT");
    expect(fake.client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and RETHROWS when the shape repair fails — a half-shaped column must stop the deployment", async () => {
    const fake = makeFakePool(
      scripted({
        tableExists: true,
        columnExists: true,
        failOn: (sql) => sql.includes("SET NOT NULL"),
      }),
    );
    await expect(ensureTeamMemberRoleColumn(fake.pool)).rejects.toThrow(
      /provisioning\/repairing public\."teamMember"\."role" failed/,
    );
    expect(fake.clientQueries).toContain("ROLLBACK");
    expect(fake.clientQueries).not.toContain("COMMIT");
    expect(fake.client.release).toHaveBeenCalledTimes(1);
  });
});
