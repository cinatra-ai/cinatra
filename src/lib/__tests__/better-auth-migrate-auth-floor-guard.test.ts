// cinatra#1939 (wave 3 Stage E — "the auth floor", track 3's last piece) —
// `ensureAuthFloorArchiveGuardTriggers`, the app-owned post-step that
// provisions the member/invitation archive-guard triggers underneath the
// app-layer archived-org dispatch policy (cinatra#1942's `hooks.before` in
// src/lib/auth.ts). Driven against a scripted fake pg pool (same harness idiom
// as better-auth-migrate-session-guard.test.ts): the contract here is WHICH
// statements run in WHICH branch, that both functions + both triggers are
// (re)defined inside ONE transaction serialized by a constant-key advisory
// xact-lock (a live repair run must never leave a window with only one of the
// two guards active), that missing tables skip cleanly, and that any failure
// rolls back and rethrows. The guard SQL itself is pinned as source-shape
// assertions: exact quoted camelCase identifiers, growth-only trigger scope
// (INSERT + the growth-shaped UPDATE columns per table — "role" and the
// re-point column "organizationId" on member; "status" and "organizationId"
// on invitation), FOR SHARE ... NOWAIT row locks, the OR-REPLACE idempotency
// forms, and — the "narrow cleanup capability" the design promises — that
// DELETE is never in either trigger's event list and that the invitation
// guard's status condition only ever engages for the 'accepted' transition
// (never 'rejected' / 'canceled').

import { describe, it, expect, vi } from "vitest";
import type pg from "pg";

import {
  ensureAuthFloorArchiveGuardTriggers,
  MEMBER_ARCHIVE_GUARD_FUNCTION_SQL,
  MEMBER_ARCHIVE_GUARD_TRIGGER_SQL,
  INVITATION_ARCHIVE_GUARD_FUNCTION_SQL,
  INVITATION_ARCHIVE_GUARD_TRIGGER_SQL,
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

const ALL_TABLES = ["member", "invitation", "organization"];

describe("ensureAuthFloorArchiveGuardTriggers — statement contract", () => {
  it("provisions BOTH functions + BOTH triggers in ONE advisory-locked transaction", async () => {
    const { pool, clientQueries } = makeFakePool(scripted({ presentTables: ALL_TABLES }));
    const result = await ensureAuthFloorArchiveGuardTriggers(pool);
    expect(result).toEqual({ provisioned: true });

    // Exact statement order: BEGIN → lock → probe → member fn/trigger →
    // invitation fn/trigger → COMMIT.
    expect(clientQueries[0]).toBe("BEGIN");
    expect(clientQueries[1]).toContain("pg_advisory_xact_lock");
    expect(clientQueries[1]).toContain("authFloor.archiveGuard");
    expect(clientQueries[2]).toContain("information_schema.tables");
    expect(clientQueries[3]).toBe(MEMBER_ARCHIVE_GUARD_FUNCTION_SQL);
    expect(clientQueries[4]).toBe(MEMBER_ARCHIVE_GUARD_TRIGGER_SQL);
    expect(clientQueries[5]).toBe(INVITATION_ARCHIVE_GUARD_FUNCTION_SQL);
    expect(clientQueries[6]).toBe(INVITATION_ARCHIVE_GUARD_TRIGGER_SQL);
    expect(clientQueries[7]).toBe("COMMIT");
    expect(clientQueries).toHaveLength(8);
  });

  it.each([
    [["invitation", "organization"]],
    [["member", "organization"]],
    [["member", "invitation"]],
    [[]],
  ])("skips cleanly (ROLLBACK, no DDL) when tables are missing: present=%j", async (present) => {
    const { pool, clientQueries } = makeFakePool(scripted({ presentTables: present }));
    const result = await ensureAuthFloorArchiveGuardTriggers(pool);
    expect(result).toEqual({ provisioned: false, skipped: "table-missing" });
    expect(clientQueries).toContain("ROLLBACK");
    expect(clientQueries.some((q) => q.includes("CREATE OR REPLACE"))).toBe(false);
  });

  it("rolls back and rethrows loudly when DDL fails", async () => {
    const { pool, clientQueries, client } = makeFakePool(
      scripted({
        presentTables: ALL_TABLES,
        failOn: (sql) => sql.includes("cinatra_invitation_archive_guard"),
      }),
    );
    await expect(ensureAuthFloorArchiveGuardTriggers(pool)).rejects.toThrow(
      /auth-floor archive-guard triggers/,
    );
    expect(clientQueries).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });
});

describe("member archive-guard SQL — shape pins", () => {
  const FN = MEMBER_ARCHIVE_GUARD_FUNCTION_SQL;
  const TRG = MEMBER_ARCHIVE_GUARD_TRIGGER_SQL;

  it("idempotent OR-REPLACE forms (definition-repair on every run)", () => {
    expect(FN).toMatch(/^CREATE OR REPLACE FUNCTION public\.cinatra_member_archive_guard\(\)/);
    expect(TRG).toMatch(/^CREATE OR REPLACE TRIGGER cinatra_member_archive_guard/);
  });

  it('trigger covers INSERT and column-scoped UPDATE OF "role"/"organizationId" on public.member ONLY (never DELETE)', () => {
    expect(TRG).toContain(`BEFORE INSERT OR UPDATE OF "role", "organizationId" ON public.member`);
    expect(TRG).toContain("FOR EACH ROW EXECUTE FUNCTION public.cinatra_member_archive_guard()");
    expect(TRG).not.toMatch(/DELETE/);
  });

  it("resolves the organization directly via member.organizationId (no join needed)", () => {
    expect(FN).toContain(`WHERE o.id = NEW."organizationId"`);
  });

  it("locks the org row with FOR SHARE ... NOWAIT (contention = refusal)", () => {
    expect(FN).toContain("FOR SHARE OF o NOWAIT");
  });

  it("fails closed: dangling org id AND archived org both refuse", () => {
    expect(FN).toContain("organization-missing (%)");
    expect(FN).toContain("organization-archived (%)");
    expect((FN.match(/RAISE EXCEPTION/g) ?? []).length).toBe(2);
  });

  it("engages on INSERT (TG_OP branch), on a CHANGED role, and on a RE-POINTED organizationId (never an unchanged UPDATE)", () => {
    expect(FN).toContain("TG_OP = 'INSERT'");
    expect(FN).toContain(`NEW."role" IS DISTINCT FROM OLD."role"`);
    // Re-pointing an existing membership row at a different organization is a
    // new-membership write in disguise — a direct-SQL org re-point must not
    // slip past a guard listening only on "role".
    expect(FN).toContain(`NEW."organizationId" IS DISTINCT FROM OLD."organizationId"`);
    // The function never rewrites columns — it only refuses or passes NEW through.
    expect(FN).toContain("RETURN NEW;");
    expect(FN).not.toMatch(/NEW\."role"\s*:=/);
  });

  it("pins the exact quoted camelCase identifiers Better Auth provisions", () => {
    for (const ident of ['"organizationId"', '"role"', '"archivedAt"']) {
      expect(FN).toContain(ident);
    }
  });
});

describe("invitation archive-guard SQL — shape pins", () => {
  const FN = INVITATION_ARCHIVE_GUARD_FUNCTION_SQL;
  const TRG = INVITATION_ARCHIVE_GUARD_TRIGGER_SQL;

  it("idempotent OR-REPLACE forms (definition-repair on every run)", () => {
    expect(FN).toMatch(/^CREATE OR REPLACE FUNCTION public\.cinatra_invitation_archive_guard\(\)/);
    expect(TRG).toMatch(/^CREATE OR REPLACE TRIGGER cinatra_invitation_archive_guard/);
  });

  it('trigger covers INSERT and column-scoped UPDATE OF "status"/"organizationId" on public.invitation ONLY (never DELETE)', () => {
    expect(TRG).toContain(`BEFORE INSERT OR UPDATE OF "status", "organizationId" ON public.invitation`);
    expect(TRG).toContain("FOR EACH ROW EXECUTE FUNCTION public.cinatra_invitation_archive_guard()");
    expect(TRG).not.toMatch(/DELETE/);
  });

  it("resolves the organization directly via invitation.organizationId (no join needed)", () => {
    expect(FN).toContain(`WHERE o.id = NEW."organizationId"`);
  });

  it("locks the org row with FOR SHARE ... NOWAIT (contention = refusal)", () => {
    expect(FN).toContain("FOR SHARE OF o NOWAIT");
  });

  it("fails closed: dangling org id AND archived org both refuse", () => {
    expect(FN).toContain("organization-missing (%)");
    expect(FN).toContain("organization-archived (%)");
    expect((FN.match(/RAISE EXCEPTION/g) ?? []).length).toBe(2);
  });

  it("the ONLY growth-shaped status transition is guarded: accepting", () => {
    expect(FN).toContain(`NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" = 'accepted'`);
    // Never a bare status-changed check without the 'accepted' condition —
    // that would also block reject/cancel, which must stay unconditionally
    // allowed (the narrow cleanup capability).
    expect(FN).not.toContain(`NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" = 'rejected'`);
    expect(FN).not.toContain(`NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" = 'canceled'`);
  });

  it("an organizationId re-point on an existing invitation row is also guarded (a direct-SQL re-point into an archived org must not slip past the status-only condition)", () => {
    expect(FN).toContain(`NEW."organizationId" IS DISTINCT FROM OLD."organizationId"`);
  });

  it("engages on INSERT (TG_OP branch) too — a brand-new invitation into an archived org also refuses", () => {
    expect(FN).toContain("TG_OP = 'INSERT'");
    expect(FN).toContain("RETURN NEW;");
    // The function never REWRITES the status column (plpgsql assignment is
    // `:=`) — it only refuses or passes NEW through unchanged.
    expect(FN).not.toMatch(/NEW\."status"\s*:=/);
  });

  it("pins the exact quoted camelCase identifiers Better Auth provisions", () => {
    for (const ident of ['"organizationId"', '"status"', '"archivedAt"']) {
      expect(FN).toContain(ident);
    }
  });
});

describe("narrow cleanup capability — cross-guard invariant", () => {
  it("neither growth guard's trigger event list includes DELETE (leaving, removal, and account-deletion cascades are never intercepted)", () => {
    for (const trg of [MEMBER_ARCHIVE_GUARD_TRIGGER_SQL, INVITATION_ARCHIVE_GUARD_TRIGGER_SQL]) {
      expect(trg).toMatch(/^CREATE OR REPLACE TRIGGER \S+\nBEFORE INSERT OR UPDATE OF /);
    }
  });

  it("the S1 session-activation guard (logout path) is untouched by this stage — DELETE was already outside its event list", async () => {
    const { SESSION_ACTIVATION_GUARD_TRIGGER_SQL } = await import("../../../scripts/better-auth-migrate.mts");
    expect(SESSION_ACTIVATION_GUARD_TRIGGER_SQL).not.toMatch(/DELETE/);
  });
});
