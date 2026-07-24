/**
 * cinatra#1938 — guard adapters: guardOrgMutation's full refusal/permit flow,
 * the opaque transaction-forcing batch, and ticket redemption semantics. No
 * live DB: a sequence-programmed fake tx returns one canned result per
 * `execute` call (the kernel's call order is deterministic by design).
 */
import { describe, it, expect } from "vitest";
import {
  guardOrgMutation,
  OrgWriteRefusedError,
  buildGuardedOrgWriteBatch,
  guardedBatchQueries,
  guardQueryFor,
  redeemCompletionTicket,
  assertPermitUsable,
  type OrgWriteAuthority,
  type GuardedOrgWriteBatch,
  type OrgWritePermit,
} from "../src/index";

function fakeDb(results: unknown[]) {
  const executed: unknown[] = [];
  let i = 0;
  const tx = {
    execute: async (query: unknown) => {
      executed.push(query);
      return results[i++] ?? { rows: [] };
    },
  };
  const db = {
    transaction: async <R>(fn: (t: typeof tx) => Promise<R>): Promise<R> => fn(tx),
  };
  return { db, tx, executed };
}

const LOCK_OK = { rows: [] };
const ACTIVE_ORG = { rows: [{ archivedAt: null, archiveEpoch: 0 }] };
const ARCHIVED_ORG = { rows: [{ archivedAt: "2026-07-01T00:00:00Z", archiveEpoch: 3 }] };

function authorityFor(
  orgId: string,
  caps: string[],
  run?: { runId: string; executionAttemptId: string },
): OrgWriteAuthority {
  return {
    orgId,
    can: (c) => caps.includes(c),
    runId: run?.runId,
    executionAttemptId: run?.executionAttemptId,
  };
}

describe("guardOrgMutation (#1938)", () => {
  it("active org + capable authority: callback runs with a usable permit, revoked after", async () => {
    const { db, tx } = fakeDb([LOCK_OK, ACTIVE_ORG]);
    let captured: OrgWritePermit | undefined;
    const out = await guardOrgMutation(
      db,
      { orgId: "org-1", capability: "content.write", authority: authorityFor("org-1", ["content.write"]) },
      async (innerTx, permit) => {
        captured = permit;
        assertPermitUsable(permit, {
          txIdentity: innerTx,
          orgId: "org-1",
          capability: "content.write",
          archiveEpoch: 0,
        });
        return "wrote";
      },
    );
    expect(out).toBe("wrote");
    // Outside the callback the permit is dead.
    expect(() =>
      assertPermitUsable(captured!, {
        txIdentity: tx,
        orgId: "org-1",
        capability: "content.write",
        archiveEpoch: 0,
      }),
    ).toThrow(/already exited/);
  });

  it("missing org refuses (organization-not-found)", async () => {
    const { db } = fakeDb([LOCK_OK, { rows: [] }]);
    await expect(
      guardOrgMutation(
        db,
        { orgId: "org-x", capability: "content.write", authority: authorityFor("org-x", ["content.write"]) },
        async () => "never",
      ),
    ).rejects.toThrow(/organization-not-found/);
  });

  it("authority org mismatch and missing capability each refuse independently", async () => {
    const { db } = fakeDb([LOCK_OK, ACTIVE_ORG, LOCK_OK, ACTIVE_ORG]);
    await expect(
      guardOrgMutation(
        db,
        { orgId: "org-1", capability: "content.write", authority: authorityFor("org-2", ["content.write"]) },
        async () => "never",
      ),
    ).rejects.toThrow(/authority-org-mismatch/);
    await expect(
      guardOrgMutation(
        db,
        { orgId: "org-1", capability: "content.write", authority: authorityFor("org-1", []) },
        async () => "never",
      ),
    ).rejects.toThrow(/authority-lacks-capability/);
  });

  it("archived org denies plain content writes", async () => {
    const { db } = fakeDb([LOCK_OK, ARCHIVED_ORG]);
    await expect(
      guardOrgMutation(
        db,
        { orgId: "org-1", capability: "content.write", authority: authorityFor("org-1", ["content.write"]) },
        async () => "never",
      ),
    ).rejects.toThrow(/capability-denied.*archived/);
  });

  it("lease-gated: held lease admits with the archived epoch on the permit", async () => {
    const { db } = fakeDb([LOCK_OK, ARCHIVED_ORG, { rows: [{ "?column?": 1 }] }]);
    const out = await guardOrgMutation(
      db,
      {
        orgId: "org-1",
        capability: "run.complete",
        schema: "cinatra",
        authority: authorityFor("org-1", ["run.complete"], { runId: "run-9", executionAttemptId: "att-9" }),
      },
      async (innerTx, permit) => {
        assertPermitUsable(permit, {
          txIdentity: innerTx,
          orgId: "org-1",
          capability: "run.complete",
          archiveEpoch: 3,
        });
        return "landed";
      },
    );
    expect(out).toBe("landed");
  });

  it("lease-gated refuses fail-closed: no lease row, and no run identity at all", async () => {
    const { db } = fakeDb([LOCK_OK, ARCHIVED_ORG, { rows: [] }]);
    await expect(
      guardOrgMutation(
        db,
        {
          orgId: "org-1",
          capability: "run.complete",
          schema: "cinatra",
          authority: authorityFor("org-1", ["run.complete"], { runId: "run-9", executionAttemptId: "att-9" }),
        },
        async () => "never",
      ),
    ).rejects.toThrow(/lease-required-but-not-held/);

    const second = fakeDb([LOCK_OK, ARCHIVED_ORG]);
    await expect(
      guardOrgMutation(
        second.db,
        {
          orgId: "org-1",
          capability: "run.complete",
          schema: "cinatra",
          authority: authorityFor("org-1", ["run.complete"]),
        },
        async () => "never",
      ),
    ).rejects.toThrow(/lease-required-but-not-held/);
  });

  it("permit is revoked even when the callback throws", async () => {
    const { db, tx } = fakeDb([LOCK_OK, ACTIVE_ORG]);
    let captured: OrgWritePermit | undefined;
    await expect(
      guardOrgMutation(
        db,
        { orgId: "org-1", capability: "org.settings", authority: authorityFor("org-1", ["org.settings"]) },
        async (_tx, permit) => {
          captured = permit;
          throw new Error("writer exploded");
        },
      ),
    ).rejects.toThrow("writer exploded");
    expect(() =>
      assertPermitUsable(captured!, {
        txIdentity: tx,
        orgId: "org-1",
        capability: "org.settings",
        archiveEpoch: 0,
      }),
    ).toThrow(/already exited/);
  });
});

describe("guarded batches (#1938)", () => {
  const authority = authorityFor("org-1", ["content.write"]);

  it("assembles lock → refusal message → guard → payload, in order", () => {
    const batch = buildGuardedOrgWriteBatch(
      { orgId: "org-1", capability: "content.write", authority },
      [{ text: "INSERT INTO x VALUES ($1)", values: ["v"] }],
    );
    const queries = guardedBatchQueries(batch);
    expect(queries).toHaveLength(4);
    expect(queries[0].text).toContain("pg_advisory_xact_lock(hashtext($1), hashtext($2))");
    expect(queries[1].text).toContain("set_config('cinatra.org_write_refusal', $1, true)");
    expect(queries[1].values).toEqual([
      "org-write-kernel refused: content.write not permitted for this organization's lifecycle state",
    ]);
    expect(queries[2].text).toContain('public."organization"');
    expect(queries[3].text).toBe("INSERT INTO x VALUES ($1)");
  });

  it("the refusal arm can only raise at runtime, never at planning", () => {
    // The refusal cast must read the tx-local setting (STABLE, never
    // constant-folded); an inline literal cast is folded — and raised — by
    // the Postgres planner even when the batch is allowed. The message rides
    // in values, never in SQL text.
    const guard = guardQueryFor({ orgId: "org-1", capability: "content.write", authority });
    expect(guard.text).toContain("(current_setting('cinatra.org_write_refusal'))::int");
    expect(guard.text).not.toMatch(/'[^']*'\s*\)?\s*::int/);
    expect(guard.text).not.toContain("refused");
  });

  it("a hand-built object is not a guarded batch", () => {
    const forged = {} as unknown as GuardedOrgWriteBatch;
    expect(() => guardedBatchQueries(forged)).toThrow(OrgWriteRefusedError);
    expect(() => guardedBatchQueries(forged)).toThrow(/not-a-guarded-batch/);
  });

  it("authority is checked at build time", () => {
    expect(() =>
      buildGuardedOrgWriteBatch(
        { orgId: "org-1", capability: "content.write", authority: authorityFor("org-2", ["content.write"]) },
        [],
      ),
    ).toThrow(/authority-org-mismatch/);
    expect(() =>
      buildGuardedOrgWriteBatch(
        { orgId: "org-1", capability: "content.write", authority: authorityFor("org-1", []) },
        [],
      ),
    ).toThrow(/authority-lacks-capability/);
  });

  it("deny-while-archived capabilities guard on archivedAt IS NULL only", () => {
    const guard = guardQueryFor({ orgId: "org-1", capability: "content.write", authority });
    expect(guard.text).toContain('o."archivedAt" IS NULL');
    expect(guard.values).toEqual(["org-1"]);
  });

  it("lease-gated capability embeds the lease EXISTS with live epoch", () => {
    const guard = guardQueryFor({
      orgId: "org-1",
      capability: "run.complete",
      schema: "cinatra",
      authority: authorityFor("org-1", ["run.complete"], { runId: "run-9", executionAttemptId: "att-9" }),
    });
    expect(guard.text).toContain('"cinatra"."org_archive_lease"');
    expect(guard.text).toContain('l.archive_epoch = COALESCE(o."archiveEpoch", 0)');
    expect(guard.text).toContain("l.expires_at > now()");
    expect(guard.values).toEqual(["org-1", "run-9", "att-9"]);
  });

  it("lease-gated capability without run identity refuses at build time", () => {
    expect(() =>
      guardQueryFor({
        orgId: "org-1",
        capability: "run.complete",
        schema: "cinatra",
        authority: authorityFor("org-1", ["run.complete"]),
      }),
    ).toThrow(/lease-required-but-not-held/);
  });
});

describe("ticket redemption (#1938)", () => {
  const runAuth = authorityFor("org-1", ["run.complete"], { runId: "run-9", executionAttemptId: "att-9" });
  const TICKET = {
    archive_epoch: 3,
    run_id: "run-9",
    execution_attempt_id: "att-9",
    output_ref: "out-1",
    consumed_at: null as string | null,
    unexpired: true,
  };

  function redemption(rows: unknown[], overrides: Partial<typeof TICKET> = {}) {
    // Order: epoch lock, write lock, org state, ticket SELECT, consume UPDATE.
    return fakeDb([
      LOCK_OK,
      LOCK_OK,
      ARCHIVED_ORG,
      { rows: rows.length ? rows : [{ ...TICKET, ...overrides }] },
      { rows: [] },
    ]);
  }

  it("valid ticket: consumed once, callback runs with a run.complete permit", async () => {
    const { db } = redemption([]);
    const outcome = await redeemCompletionTicket(
      db,
      { schema: "cinatra", orgId: "org-1", authority: runAuth, idempotencyKey: "idem-1", outputRef: "out-1" },
      async (innerTx, permit) => {
        assertPermitUsable(permit, {
          txIdentity: innerTx,
          orgId: "org-1",
          capability: "run.complete",
          archiveEpoch: 3,
        });
        return 42;
      },
    );
    expect(outcome).toEqual({ alreadyApplied: false, result: 42 });
  });

  it("replay with the same output is an idempotent no-op (callback NOT run)", async () => {
    const { db } = redemption([], { consumed_at: "2026-07-22T10:00:00Z" });
    let ran = false;
    const outcome = await redeemCompletionTicket(
      db,
      { schema: "cinatra", orgId: "org-1", authority: runAuth, idempotencyKey: "idem-1", outputRef: "out-1" },
      async () => {
        ran = true;
        return 0;
      },
    );
    expect(outcome).toEqual({ alreadyApplied: true });
    expect(ran).toBe(false);
  });

  it("replay with a DIFFERENT output refuses", async () => {
    const { db } = redemption([], { consumed_at: "2026-07-22T10:00:00Z", output_ref: "out-OTHER" });
    await expect(
      redeemCompletionTicket(
        db,
        { schema: "cinatra", orgId: "org-1", authority: runAuth, idempotencyKey: "idem-1", outputRef: "out-1" },
        async () => 0,
      ),
    ).rejects.toThrow(/different output/);
  });

  it("epoch bump, expiry, run-identity mismatch, and missing ticket each refuse", async () => {
    for (const [overrides, pattern] of [
      [{ archive_epoch: 2 }, /epoch changed/],
      [{ unexpired: false }, /expired/],
      [{ run_id: "run-OTHER" }, /run identity mismatch/],
    ] as const) {
      const { db } = redemption([], overrides);
      await expect(
        redeemCompletionTicket(
          db,
          { schema: "cinatra", orgId: "org-1", authority: runAuth, idempotencyKey: "idem-1", outputRef: "out-1" },
          async () => 0,
        ),
      ).rejects.toThrow(pattern);
    }
    const missing = fakeDb([LOCK_OK, LOCK_OK, ARCHIVED_ORG, { rows: [] }]);
    await expect(
      redeemCompletionTicket(
        missing.db,
        { schema: "cinatra", orgId: "org-1", authority: runAuth, idempotencyKey: "idem-x", outputRef: "out-1" },
        async () => 0,
      ),
    ).rejects.toThrow(/no such ticket/);
  });

  it("takes BOTH locks in global order (epoch before write)", async () => {
    const { db, executed } = redemption([]);
    await redeemCompletionTicket(
      db,
      { schema: "cinatra", orgId: "org-1", authority: runAuth, idempotencyKey: "idem-1", outputRef: "out-1" },
      async () => 0,
    );
    const first = JSON.stringify(executed[0]);
    const second = JSON.stringify(executed[1]);
    expect(first).toContain("cinatra-org-archive-epoch");
    expect(second).toContain("cinatra-org-write");
  });
});
