/**
 * cinatra#1938 — org-write authority resolvers: session (membership +
 * real authz policies), verified run refs (shared live-attempt predicate,
 * runtime WeakSet), system purposes, and the transaction-forcing batch
 * wrapper. auth-session and postgres-sync are mocked; policies are REAL so
 * the capability→permission mapping is proven against the actual role table.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const shared = vi.hoisted(() => ({
  role: undefined as string | undefined,
  syncCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: vi.fn(async () => shared.role),
}));
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn((input: Record<string, unknown>) => {
    shared.syncCalls.push(input);
    return (input.queries as unknown[]).map(() => ({ rows: [], rowCount: 0 }));
  }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
}));

import {
  verifySessionAuthority,
  verifyRunAuthority,
  isVerifiedRunRef,
  mintSystemWriteAuthority,
  OrgWriteAuthorityError,
  type RunRowForAuthority,
  type VerifiedRunRef,
} from "../authority";
import { runGuardedOrgWriteBatchSync } from "../batch-wrapper";
import {
  buildGuardedOrgWriteBatch,
  type GuardedOrgWriteBatch,
} from "@cinatra-ai/org-write-kernel";

beforeEach(() => {
  shared.role = undefined;
  shared.syncCalls.length = 0;
});

describe("verifySessionAuthority (#1938)", () => {
  it("refuses non-members outright", async () => {
    shared.role = undefined;
    await expect(verifySessionAuthority("u1", "org-1")).rejects.toThrow(
      OrgWriteAuthorityError,
    );
  });

  it("plain members hold membership capabilities but no management ones", async () => {
    shared.role = "member";
    const auth = await verifySessionAuthority("u1", "org-1");
    expect(auth.orgId).toBe("org-1");
    expect(auth.can("content.write")).toBe(true);
    expect(auth.can("run.execute")).toBe(true);
    expect(auth.can("run.complete")).toBe(true);
    expect(auth.can("membership.write")).toBe(false);
    expect(auth.can("org.settings")).toBe(false);
    expect(auth.can("org.lifecycle")).toBe(false);
  });

  it("owners hold the lifecycle capability (organization.archive is owner-only)", async () => {
    shared.role = "org_owner";
    const auth = await verifySessionAuthority("u1", "org-1");
    expect(auth.can("org.lifecycle")).toBe(true);
    expect(auth.can("membership.write")).toBe(true);
    expect(auth.can("org.settings")).toBe(true);
  });

  it("admins manage settings but NOT members or lifecycle (mirrors the real policy table: organization.manageMembers is owner-only)", async () => {
    shared.role = "org_admin";
    const auth = await verifySessionAuthority("u1", "org-1");
    expect(auth.can("membership.write")).toBe(false);
    expect(auth.can("org.settings")).toBe(true);
    expect(auth.can("org.lifecycle")).toBe(false);
  });
});

describe("verifyRunAuthority (#1938, shared live-attempt predicate)", () => {
  const NOW = Date.parse("2026-07-23T00:00:00Z");
  const FUTURE = new Date(NOW + 60_000).toISOString();

  function depsFor(row: RunRowForAuthority | null) {
    return { readRunRow: async () => row, nowMs: () => NOW };
  }
  const LIVE_ROW: RunRowForAuthority = {
    orgId: "org-1",
    status: "running",
    executionAttemptId: "att-1",
    executionDeadlineAt: FUTURE,
    humanWaitAttemptId: null,
  };
  const INPUT = { runId: "run-1", orgId: "org-1", claimedAttemptId: "att-1" };

  it("mints a WeakSet-verified ref for a live run, with run-scoped capabilities only", async () => {
    const ref = await verifyRunAuthority(INPUT, depsFor(LIVE_ROW));
    expect(isVerifiedRunRef(ref)).toBe(true);
    expect(ref.runId).toBe("run-1");
    expect(ref.executionAttemptId).toBe("att-1");
    expect(ref.can("content.write")).toBe(true);
    expect(ref.can("run.complete")).toBe(true);
    expect(ref.can("run.execute")).toBe(false);
    expect(ref.can("org.lifecycle")).toBe(false);
    expect(ref.can("membership.write")).toBe(false);
    expect(ref.can("org.settings")).toBe(false);
  });

  it("a cast cannot forge a VerifiedRunRef", () => {
    const forged = {
      orgId: "org-1",
      runId: "run-1",
      executionAttemptId: "att-1",
      can: () => true,
    } as unknown as VerifiedRunRef;
    expect(isVerifiedRunRef(forged)).toBe(false);
  });

  it("refuses: missing run, wrong org, stale/absent attempt id", async () => {
    await expect(verifyRunAuthority(INPUT, depsFor(null))).rejects.toThrow(/not found/);
    await expect(
      verifyRunAuthority(INPUT, depsFor({ ...LIVE_ROW, orgId: "org-2" })),
    ).rejects.toThrow(/different organization/);
    await expect(
      verifyRunAuthority(INPUT, depsFor({ ...LIVE_ROW, executionAttemptId: "att-0" })),
    ).rejects.toThrow(/does not match/);
    await expect(
      verifyRunAuthority(INPUT, depsFor({ ...LIVE_ROW, executionAttemptId: null })),
    ).rejects.toThrow(/does not match/);
  });

  it("refuses runs outside a live attempt: parked states and expired deadlines", async () => {
    for (const status of ["queued", "pending_input", "completed", "failed"]) {
      await expect(
        verifyRunAuthority(INPUT, depsFor({ ...LIVE_ROW, status })),
      ).rejects.toThrow(/not inside a live attempt/);
    }
    await expect(
      verifyRunAuthority(
        INPUT,
        depsFor({ ...LIVE_ROW, executionDeadlineAt: new Date(NOW - 1000).toISOString() }),
      ),
    ).rejects.toThrow(/not inside a live attempt/);
  });

  it("admits a mid-attempt approval wait (marker equality) but not a setup one", async () => {
    await expect(
      verifyRunAuthority(
        INPUT,
        depsFor({ ...LIVE_ROW, status: "pending_approval", humanWaitAttemptId: "att-1" }),
      ),
    ).resolves.toBeTruthy();
    await expect(
      verifyRunAuthority(
        INPUT,
        depsFor({ ...LIVE_ROW, status: "pending_approval", humanWaitAttemptId: null }),
      ),
    ).rejects.toThrow(/not inside a live attempt/);
  });
});

describe("mintSystemWriteAuthority (#1938)", () => {
  it("grants exactly the purpose's capabilities, org-bound", () => {
    const lifecycle = mintSystemWriteAuthority("org-lifecycle-transition", "org-1");
    expect(lifecycle.orgId).toBe("org-1");
    expect(lifecycle.can("org.lifecycle")).toBe(true);
    expect(lifecycle.can("content.write")).toBe(false);

    const finalizer = mintSystemWriteAuthority("lease-expiry-finalizer", "org-1");
    expect(finalizer.can("run.execute")).toBe(true);
    expect(finalizer.can("run.complete")).toBe(true);
    expect(finalizer.can("org.lifecycle")).toBe(false);
  });
});

describe("runGuardedOrgWriteBatchSync (#1938)", () => {
  const authority = {
    orgId: "org-1",
    can: () => true,
  };

  it("runs a kernel-built batch with transaction: true UNCONDITIONALLY", () => {
    const batch = buildGuardedOrgWriteBatch(
      { orgId: "org-1", capability: "content.write", authority },
      [{ text: "INSERT INTO x VALUES ($1)", values: ["v"] }],
    );
    runGuardedOrgWriteBatchSync(batch);
    expect(shared.syncCalls).toHaveLength(1);
    const call = shared.syncCalls[0];
    expect(call.transaction).toBe(true);
    expect((call.queries as unknown[]).length).toBe(4); // lock, refusal message, guard, payload
  });

  it("refuses a forged batch value", () => {
    const forged = {} as unknown as GuardedOrgWriteBatch;
    expect(() => runGuardedOrgWriteBatchSync(forged)).toThrow(/not-a-guarded-batch/);
    expect(shared.syncCalls).toHaveLength(0);
  });
});

describe("run-capability ceiling hook", () => {
  const NOW = Date.parse("2026-07-23T00:00:00Z");
  const ROW = {
    orgId: "org-1",
    status: "running",
    executionAttemptId: "att-1",
    executionDeadlineAt: new Date(NOW + 60_000).toISOString(),
    humanWaitAttemptId: null,
    authPolicy: { ceiling: "narrow" },
  };

  it("the ceiling can only RESTRICT the structural floor, and is consulted with the row", async () => {
    const consulted: string[] = [];
    const ref = await verifyRunAuthority(
      { runId: "run-1", orgId: "org-1", claimedAttemptId: "att-1" },
      {
        readRunRow: async () => ROW,
        nowMs: () => NOW,
        evaluateRunCapabilityCeiling: (row, capability) => {
          consulted.push(capability);
          expect(row.authPolicy).toEqual({ ceiling: "narrow" });
          return capability !== "run.complete"; // ceiling denies completion
        },
      },
    );
    expect(ref.can("content.write")).toBe(true);
    expect(ref.can("run.complete")).toBe(false); // floor allows, ceiling denies
    expect(ref.can("org.lifecycle")).toBe(false); // floor denies regardless
    expect(consulted).toContain("run.complete");
  });
});
