// cinatra#1566 — `ensureTeamMemberRoleColumn`, the app-owned guarded DDL that
// provisions `public."teamMember"."role"`. This is the ONLY correct
// provisioning site: better-auth 1.6.19's teamMember schema branch ignores
// `additionalFields` (better-auth#5234) and core `core__NNNN` migrations are
// ledger-faked on fresh schemas — so the bootstrap migration runner carries a
// post-step that must be idempotent, transactional, and backfill-once.
//
// Driven against a scripted fake pg pool (no live Postgres): the contract
// here is WHICH statements run in WHICH branch, that the DDL+backfill unit is
// atomic (single checked-out client, BEGIN/COMMIT, ROLLBACK on failure), and
// that the one-shot backfill is deterministic (DISTINCT ON with the
// createdAt/id tie-break = earliest member ≈ the creator).

import { describe, it, expect, vi } from "vitest";
import type pg from "pg";

import { ensureTeamMemberRoleColumn } from "../../../scripts/better-auth-migrate.mts";

type FakeResult = { rows: unknown[]; rowCount: number };
type Handler = (sql: string) => Partial<FakeResult> | Error;

function makeFakePool(handler: Handler) {
  const poolQueries: string[] = [];
  const clientQueries: string[] = [];
  const run = async (sql: string, log: string[]): Promise<FakeResult> => {
    log.push(sql);
    const out = handler(sql);
    if (out instanceof Error) throw out;
    return { rows: out.rows ?? [], rowCount: out.rowCount ?? 0 };
  };
  const client = {
    query: vi.fn((sql: string) => run(sql, clientQueries)),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn((sql: string) => run(sql, poolQueries)),
    connect: vi.fn(async () => client),
  };
  return {
    pool: pool as unknown as pg.Pool,
    raw: pool,
    client,
    poolQueries,
    clientQueries,
  };
}

/** Handler presets keyed by probe result. */
function scripted(opts: {
  tableExists: boolean;
  columnExists: boolean;
  constraintExists?: boolean;
  backfillCount?: number;
  failOn?: (sql: string) => boolean;
}): Handler {
  return (sql) => {
    if (opts.failOn?.(sql)) return new Error("boom");
    if (sql.includes("information_schema.tables")) {
      return { rows: [{ exists: opts.tableExists }] };
    }
    if (sql.includes("information_schema.columns")) {
      return { rows: [{ exists: opts.columnExists }] };
    }
    if (sql.includes("pg_constraint")) {
      return { rows: opts.constraintExists ? [{ "?column?": 1 }] : [], rowCount: opts.constraintExists ? 1 : 0 };
    }
    if (sql.includes("SET \"role\" = 'admin'")) {
      return { rowCount: opts.backfillCount ?? 0 };
    }
    return {};
  };
}

describe("ensureTeamMemberRoleColumn", () => {
  it("skips entirely (no client checkout) when the teamMember table does not exist", async () => {
    const fake = makeFakePool(scripted({ tableExists: false, columnExists: false }));
    const result = await ensureTeamMemberRoleColumn(fake.pool);
    expect(result).toEqual({
      provisioned: false,
      backfilledAdmins: 0,
      skipped: "table-missing",
    });
    expect(fake.raw.connect).not.toHaveBeenCalled();
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

  it("guards the CHECK constraint by conrelid, not name alone, and skips ADD when present", async () => {
    const fake = makeFakePool(
      scripted({ tableExists: true, columnExists: false, constraintExists: true }),
    );
    await ensureTeamMemberRoleColumn(fake.pool);
    const probe = fake.clientQueries.find((s) => s.includes("pg_constraint"));
    expect(probe).toContain(`conrelid = 'public."teamMember"'::regclass`);
    expect(
      fake.clientQueries.filter((s) => s.includes("ADD CONSTRAINT")),
    ).toHaveLength(0);
  });

  it("is a shape-repair no-backfill pass when the column pre-exists (idempotent re-run)", async () => {
    const fake = makeFakePool(
      scripted({ tableExists: true, columnExists: true, constraintExists: true }),
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
    await expect(ensureTeamMemberRoleColumn(fake.pool)).rejects.toThrow("boom");
    expect(fake.clientQueries).toContain("ROLLBACK");
    expect(fake.clientQueries).not.toContain("COMMIT");
    expect(fake.client.release).toHaveBeenCalledTimes(1);
  });

  it("reports (not throws) a failed shape repair on a pre-existing malformed column", async () => {
    const fake = makeFakePool(
      scripted({
        tableExists: true,
        columnExists: true,
        failOn: (sql) => sql.includes("SET NOT NULL"),
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await ensureTeamMemberRoleColumn(fake.pool);
      expect(result).toEqual({
        provisioned: false,
        backfilledAdmins: 0,
        repairFailed: true,
      });
      expect(fake.clientQueries).toContain("ROLLBACK");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
