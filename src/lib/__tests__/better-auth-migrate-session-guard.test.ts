// cinatra#1937 (archive S1) — `ensureSessionActivationGuardTrigger`, the
// app-owned post-step that provisions the session activation-guard trigger.
// Driven against a scripted fake pg pool (same harness idiom as
// better-auth-migrate-team-role.test.ts): the contract here is WHICH
// statements run in WHICH branch, that function + trigger are (re)defined
// inside ONE transaction serialized by a constant-key advisory xact-lock (a
// live repair run must never leave a window without the guard), that missing
// tables skip cleanly, and that any failure rolls back and rethrows.
// The guard SQL itself is pinned as source-shape assertions: exact quoted
// camelCase identifiers, per-field independent validation, FOR SHARE ... NOWAIT
// row locks, and the OR-REPLACE idempotency forms.

import { describe, it, expect, vi } from "vitest";
import type pg from "pg";

import {
  ensureSessionActivationGuardTrigger,
  SESSION_ACTIVATION_GUARD_FUNCTION_SQL,
  SESSION_ACTIVATION_GUARD_TRIGGER_SQL,
} from "../../../scripts/better-auth-migrate.mts";

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
  return { pool: pool as unknown as pg.Pool, client, clientQueries };
}

function scripted(opts: {
  presentTables: string[];
  failOn?: (sql: string) => boolean;
}): Handler {
  return (sql) => {
    if (opts.failOn?.(sql)) return new Error("boom");
    if (sql.includes("pg_advisory_xact_lock")) return {};
    if (sql.includes("information_schema.tables")) {
      return { rows: opts.presentTables.map((t) => ({ table_name: t })) };
    }
    return {};
  };
}

const ALL_TABLES = ["session", "organization", "team"];

describe("ensureSessionActivationGuardTrigger — statement contract", () => {
  it("provisions function + trigger in ONE advisory-locked transaction", async () => {
    const { pool, clientQueries } = makeFakePool(scripted({ presentTables: ALL_TABLES }));
    const result = await ensureSessionActivationGuardTrigger(pool);
    expect(result).toEqual({ provisioned: true });

    // Exact statement order: BEGIN → lock → probe → function → trigger → COMMIT.
    expect(clientQueries[0]).toBe("BEGIN");
    expect(clientQueries[1]).toContain("pg_advisory_xact_lock");
    expect(clientQueries[1]).toContain("session.activationGuard");
    expect(clientQueries[2]).toContain("information_schema.tables");
    expect(clientQueries[3]).toBe(SESSION_ACTIVATION_GUARD_FUNCTION_SQL);
    expect(clientQueries[4]).toBe(SESSION_ACTIVATION_GUARD_TRIGGER_SQL);
    expect(clientQueries[5]).toBe("COMMIT");
    expect(clientQueries).toHaveLength(6);
  });

  it.each([
    [["organization", "team"]],
    [["session", "team"]],
    [["session", "organization"]],
    [[]],
  ])("skips cleanly (ROLLBACK, no DDL) when tables are missing: present=%j", async (present) => {
    const { pool, clientQueries } = makeFakePool(scripted({ presentTables: present }));
    const result = await ensureSessionActivationGuardTrigger(pool);
    expect(result).toEqual({ provisioned: false, skipped: "table-missing" });
    expect(clientQueries).toContain("ROLLBACK");
    expect(clientQueries.some((q) => q.includes("CREATE OR REPLACE"))).toBe(false);
  });

  it("rolls back and rethrows loudly when DDL fails", async () => {
    const { pool, clientQueries, client } = makeFakePool(
      scripted({
        presentTables: ALL_TABLES,
        failOn: (sql) => sql.includes("CREATE OR REPLACE TRIGGER"),
      }),
    );
    await expect(ensureSessionActivationGuardTrigger(pool)).rejects.toThrow(
      /session activation guard failed/,
    );
    expect(clientQueries).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });
});

describe("session activation guard SQL — shape pins", () => {
  const FN = SESSION_ACTIVATION_GUARD_FUNCTION_SQL;
  const TRG = SESSION_ACTIVATION_GUARD_TRIGGER_SQL;

  it("idempotent OR-REPLACE forms (definition-repair on every run)", () => {
    expect(FN).toMatch(/^CREATE OR REPLACE FUNCTION public\.cinatra_session_activation_guard\(\)/);
    expect(TRG).toMatch(/^CREATE OR REPLACE TRIGGER cinatra_session_activation_guard/);
  });

  it("trigger covers INSERT and column-scoped UPDATE on public.session", () => {
    expect(TRG).toContain(
      `BEFORE INSERT OR UPDATE OF "activeOrganizationId", "activeTeamId" ON public.session`,
    );
    expect(TRG).toContain("FOR EACH ROW EXECUTE FUNCTION public.cinatra_session_activation_guard()");
  });

  it("validates BOTH active references independently (each has its own guard block)", () => {
    // Direct org block: change-gated, resolves public.organization by id.
    expect(FN).toContain(
      `NEW."activeOrganizationId" IS DISTINCT FROM OLD."activeOrganizationId"`,
    );
    expect(FN).toContain(`WHERE o.id = NEW."activeOrganizationId"`);
    // Team block: change-gated, resolves the TEAM'S org via the join.
    expect(FN).toContain(`NEW."activeTeamId" IS DISTINCT FROM OLD."activeTeamId"`);
    expect(FN).toContain(`JOIN public.organization o ON o.id = t."organizationId"`);
    expect(FN).toContain(`WHERE t.id = NEW."activeTeamId"`);
  });

  it("locks the org row with FOR SHARE ... NOWAIT in BOTH blocks (contention = refusal)", () => {
    const locks = FN.match(/FOR SHARE OF o NOWAIT/g) ?? [];
    expect(locks).toHaveLength(2);
  });

  it("fails closed: dangling ids AND archived orgs both refuse, in BOTH blocks", () => {
    expect(FN).toContain("activation-target-missing (organization %)");
    expect(FN).toContain("organization-archived (%)");
    expect(FN).toContain("activation-target-missing (team %)");
    expect(FN).toContain("team-organization-archived (%)");
    // Refusals are exceptions — never a silent value rewrite.
    expect((FN.match(/RAISE EXCEPTION/g) ?? []).length).toBe(4);
  });

  it("INSERT validates non-null values (TG_OP branch) and NULL-clearing never blocks", () => {
    // Each block only engages when its NEW value is non-null…
    expect(FN).toContain(`NEW."activeOrganizationId" IS NOT NULL`);
    expect(FN).toContain(`NEW."activeTeamId" IS NOT NULL`);
    // …and fires on INSERT regardless of OLD (which does not exist there).
    expect((FN.match(/TG_OP = 'INSERT'/g) ?? []).length).toBe(2);
    // The function never writes columns — it only refuses or passes NEW through.
    expect(FN).toContain("RETURN NEW;");
    expect(FN).not.toMatch(/NEW\."active\w+"\s*:?=/);
  });

  it("pins the exact quoted camelCase identifiers Better Auth provisions", () => {
    for (const ident of ['"activeOrganizationId"', '"activeTeamId"', '"archivedAt"', '"organizationId"']) {
      expect(FN).toContain(ident);
    }
  });
});
