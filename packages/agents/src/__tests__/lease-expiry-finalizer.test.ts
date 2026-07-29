/**
 * cinatra#1940 P4, phase 1 — `runLeaseExpiryFinalizerSweep`.
 *
 * Per expired lease: atomic attempts-increment (pooled) → best-effort A2A
 * cancel (itself gated by a pre-cancel "still expired" recheck, narrowing the
 * window between the increment and the cancel side-effect) → escalation
 * (idempotent stamp + audit + force-settle) → the fenced settle
 * (`finalizeExpiredLeaseRun`, mocked here — its own behavior is pinned by
 * finalize-expired-lease-run.test.ts). No live DB: `agentBuilderPool.query`
 * is a fully-controlled fake keyed on the query text (the kernel's own SQL
 * builders are used verbatim, so this suite also indirectly exercises their
 * exact shape via text-matching). `shared.log` records the ORDER of every
 * DB-adjacent step (increment / recheck / cancel / escalate / finalize) — the
 * outcome-shape assertions elsewhere in this file would pass even if the
 * implementation called these out of order; `shared.log` is what actually
 * pins the order.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FinalizeExpiredLeaseOutcome } from "../run-transition";

const shared = vi.hoisted(() => ({
  finalizeOutcome: { outcome: "settled", mode: "run-and-lease", from: "running", won: true } as FinalizeExpiredLeaseOutcome,
  finalizeCalls: [] as Array<{ orgId: string; runId: string }>,
  finalizeThrows: false,
  incrementRows: [{ finalize_attempts: 1 }] as Array<{ finalize_attempts: number }>,
  escalateRows: [] as Array<{ finalize_escalated_at: string }>,
  // The pre-cancel recheck (`leaseStillExpiredQuery`) — a non-empty row means
  // "still expired, proceed to cancel"; empty means "gone since the
  // increment, skip the cancel side-effect".
  recheckRows: [{}] as Array<Record<string, unknown>>,
  cancelTaskImpl: vi.fn(async () => undefined),
  cancelTaskCalls: [] as string[],
  createClientCalls: [] as string[],
  templatePackageName: "@acme/some-agent" as string | null,
  auditEvents: [] as Record<string, unknown>[],
  log: [] as string[],
}));

vi.mock("../db", () => ({
  agentBuilderPool: {
    query: vi.fn(async (text: string, values: unknown[]) => {
      if (text.includes("l.finalize_attempts") && text.includes("FROM")) {
        // sweepExpiredLeasesQuery — the test itself supplies rows via
        // `agentBuilderPool.query` mockResolvedValueOnce below (call #1
        // per sweep). Fallback: no rows.
        return { rows: [] };
      }
      if (text.includes("SET finalize_attempts = finalize_attempts + 1")) {
        shared.log.push("increment");
        return { rows: shared.incrementRows };
      }
      // leaseStillExpiredQuery — a plain `SELECT 1 ...`, distinct from the
      // sweep read (which selects real columns) and the UPDATE-shaped
      // increment/escalate statements.
      if (text.startsWith("SELECT 1")) {
        shared.log.push("recheck");
        return { rows: shared.recheckRows };
      }
      if (text.includes("SET finalize_escalated_at = now()")) {
        shared.log.push("escalate");
        return { rows: shared.escalateRows };
      }
      throw new Error(`unexpected pooled query in test: ${text} ${JSON.stringify(values)}`);
    }),
  },
}));

vi.mock("../run-transition", () => ({
  finalizeExpiredLeaseRun: vi.fn(async (orgId: string, runId: string) => {
    shared.log.push("finalize");
    shared.finalizeCalls.push({ orgId, runId });
    if (shared.finalizeThrows) throw new Error("simulated finalize failure");
    return shared.finalizeOutcome;
  }),
}));

vi.mock("../store", () => ({
  readAgentTemplateById: vi.fn(async (templateId: string) =>
    shared.templatePackageName
      ? { id: templateId, packageName: shared.templatePackageName }
      : { id: templateId, packageName: null },
  ),
}));

vi.mock("@cinatra-ai/a2a", () => ({
  createInProcessA2AClient: vi.fn(async (input: { packageName: string }) => {
    shared.createClientCalls.push(input.packageName);
    return {
      cancelTask: async (taskId: string) => {
        shared.log.push("cancel");
        shared.cancelTaskCalls.push(taskId);
        return shared.cancelTaskImpl(taskId);
      },
    };
  }),
}));

vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent-builder-execution" },
}));

vi.mock("@/lib/authz", () => ({
  logAuditEvent: vi.fn((input: Record<string, unknown>) => {
    shared.auditEvents.push(input);
  }),
  POLICY_VERSION: "test-policy-version",
}));

import { runLeaseExpiryFinalizerSweep } from "../lease-expiry-finalizer";
import { agentBuilderPool } from "../db";

const ROW = {
  org_id: "org-1",
  archive_epoch: 3,
  run_id: "run-1",
  execution_attempt_id: "att-1",
  finalize_attempts: 0,
  status: "running" as string | null,
  a2a_task_id: null as string | null,
  template_id: "tmpl-1" as string | null,
};

/** A lease row whose run was already deleted —
 *  `sweepExpiredLeasesQuery`'s LEFT JOIN surfaces it with every joined column
 *  NULL. This is what the sweep actually hands `processExpiredLease` for the
 *  orphan/vanished-run case. */
function orphanRow(overrides: Partial<typeof ROW> = {}): typeof ROW {
  return { ...ROW, status: null, a2a_task_id: null, template_id: null, ...overrides };
}

function mockSweep(rows: typeof ROW[]): void {
  (agentBuilderPool.query as ReturnType<typeof vi.fn>).mockImplementationOnce(
    async () => ({ rows }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  shared.finalizeOutcome = { outcome: "settled", mode: "run-and-lease", from: "running", won: true };
  shared.finalizeCalls = [];
  shared.finalizeThrows = false;
  shared.incrementRows = [{ finalize_attempts: 1 }];
  shared.escalateRows = [];
  shared.recheckRows = [{}];
  shared.cancelTaskCalls = [];
  shared.createClientCalls = [];
  shared.templatePackageName = "@acme/some-agent";
  shared.auditEvents = [];
  shared.cancelTaskImpl = vi.fn(async () => undefined);
  shared.log = [];
});

describe("runLeaseExpiryFinalizerSweep — empty sweep", () => {
  it("no expired leases ⇒ an all-zero summary, no finalize calls", async () => {
    mockSweep([]);
    const summary = await runLeaseExpiryFinalizerSweep();
    expect(summary).toEqual({
      swept: 0,
      skippedLeaseGone: 0,
      cancelDeferred: 0,
      settled: 0,
      settledLeaseOnly: 0,
      escalated: 0,
      failed: 0,
    });
    expect(shared.finalizeCalls).toEqual([]);
  });
});

describe("runLeaseExpiryFinalizerSweep — attempts-increment gate", () => {
  it("0 rows from the atomic increment ⇒ skip this lease entirely, no cancel, no finalize", async () => {
    mockSweep([{ ...ROW }]);
    shared.incrementRows = [];
    const summary = await runLeaseExpiryFinalizerSweep();
    expect(summary.swept).toBe(1);
    expect(summary.skippedLeaseGone).toBe(1);
    expect(summary.settled).toBe(0);
    expect(shared.finalizeCalls).toEqual([]);
    expect(shared.cancelTaskCalls).toEqual([]);
  });
});

describe("runLeaseExpiryFinalizerSweep — no a2aTaskId (nothing to cancel)", () => {
  it("proceeds straight to the fenced settle (no recheck, no cancel)", async () => {
    mockSweep([{ ...ROW, a2a_task_id: null }]);
    const summary = await runLeaseExpiryFinalizerSweep();
    expect(summary.settled).toBe(1);
    expect(shared.cancelTaskCalls).toEqual([]);
    expect(shared.finalizeCalls).toEqual([{ orgId: "org-1", runId: "run-1" }]);
    // No task id ⇒ bestEffortCancelRuntime returns before ever issuing the
    // pre-cancel recheck query (nothing to gate).
    expect(shared.log).toEqual(["increment", "finalize"]);
  });
});

describe("runLeaseExpiryFinalizerSweep — best-effort runtime cancel", () => {
  it("a2aTaskId present, cancel CONFIRMED ⇒ settles this tick, in DB-call order", async () => {
    mockSweep([{ ...ROW, a2a_task_id: "task-1" }]);
    const summary = await runLeaseExpiryFinalizerSweep();
    expect(shared.cancelTaskCalls).toEqual(["task-1"]);
    expect(shared.createClientCalls).toEqual(["@acme/some-agent"]);
    expect(summary.settled).toBe(1);
    expect(shared.finalizeCalls).toEqual([{ orgId: "org-1", runId: "run-1" }]);
    // The actual DB-call ORDER, not just outcome shape: atomic increment ->
    // pre-cancel recheck -> the cancel itself -> the fenced settle.
    expect(shared.log).toEqual(["increment", "recheck", "cancel", "finalize"]);
  });

  it("a2aTaskId present, cancel THROWS, attempts below threshold ⇒ deferred, NO settle this tick", async () => {
    shared.cancelTaskImpl = vi.fn(async () => {
      throw new Error("cancel failed");
    });
    shared.incrementRows = [{ finalize_attempts: 2 }];
    mockSweep([{ ...ROW, a2a_task_id: "task-1" }]);
    const summary = await runLeaseExpiryFinalizerSweep();
    expect(summary.cancelDeferred).toBe(1);
    expect(summary.settled).toBe(0);
    expect(shared.finalizeCalls).toEqual([]);
    expect(shared.log).toEqual(["increment", "recheck", "cancel"]);
  });

  it("no resolvable packageName for the template ⇒ treated as nothing-to-cancel (settle proceeds)", async () => {
    shared.templatePackageName = null;
    mockSweep([{ ...ROW, a2a_task_id: "task-1" }]);
    const summary = await runLeaseExpiryFinalizerSweep();
    expect(shared.cancelTaskCalls).toEqual([]);
    expect(summary.settled).toBe(1);
    // Still recheck-gated (the a2aTaskId IS present); the unresolvable
    // packageName is discovered only after the recheck passes.
    expect(shared.log).toEqual(["increment", "recheck", "finalize"]);
  });
});

describe("runLeaseExpiryFinalizerSweep — pre-cancel recheck (the pre-fence cancel race fix)", () => {
  it("the lease is no longer expired at recheck time (e.g. an unarchive raced ahead of the cancel) ⇒ skip the cancel, still run the fenced settle", async () => {
    shared.recheckRows = []; // gone — the fence would now refuse this run
    // The fenced settle independently re-discovers this via its OWN in-tx
    // FOR UPDATE re-verify; simulate that here too for realism.
    shared.finalizeOutcome = { outcome: "skipped", reason: "lease-gone" };
    mockSweep([{ ...ROW, a2a_task_id: "task-1" }]);
    const summary = await runLeaseExpiryFinalizerSweep();
    // The runtime is NEVER cancelled for a run the fence would refuse to
    // finalize — this is the actual bug fix: cancelling here would interrupt
    // a run that is legitimately continuing post-unarchive.
    expect(shared.cancelTaskCalls).toEqual([]);
    expect(shared.createClientCalls).toEqual([]);
    expect(shared.finalizeCalls).toEqual([{ orgId: "org-1", runId: "run-1" }]);
    expect(summary.skippedLeaseGone).toBe(1);
    expect(shared.log).toEqual(["increment", "recheck", "finalize"]);
  });
});

describe("runLeaseExpiryFinalizerSweep — orphan lease / vanished run", () => {
  it("a lease whose run row is already gone (LEFT JOIN NULLs) ⇒ no cancel attempted, still reaches the fenced settle-orphan path", async () => {
    shared.finalizeOutcome = { outcome: "settled", mode: "lease-only" };
    mockSweep([orphanRow()]);
    const summary = await runLeaseExpiryFinalizerSweep();
    // No a2a_task_id on an orphan row (LEFT JOIN NULL) ⇒ nothing to cancel —
    // bestEffortCancelRuntime never even reaches the template lookup.
    expect(shared.cancelTaskCalls).toEqual([]);
    expect(shared.createClientCalls).toEqual([]);
    expect(shared.finalizeCalls).toEqual([{ orgId: "org-1", runId: "run-1" }]);
    expect(summary.settledLeaseOnly).toBe(1);
    expect(summary.settled).toBe(0);
    expect(shared.log).toEqual(["increment", "finalize"]);
  });
});

describe("runLeaseExpiryFinalizerSweep — escalation", () => {
  it("attempts >= threshold, cancel THROWS ⇒ idempotent stamp applies, audits, FORCE-SETTLES anyway", async () => {
    shared.cancelTaskImpl = vi.fn(async () => {
      throw new Error("cancel failed");
    });
    shared.incrementRows = [{ finalize_attempts: 5 }];
    shared.escalateRows = [{ finalize_escalated_at: "2026-07-28T00:00:00Z" }];
    mockSweep([{ ...ROW, a2a_task_id: "task-1" }]);
    const summary = await runLeaseExpiryFinalizerSweep();
    expect(summary.escalated).toBe(1);
    expect(summary.cancelDeferred).toBe(0);
    expect(summary.settled).toBe(1);
    expect(shared.finalizeCalls).toEqual([{ orgId: "org-1", runId: "run-1" }]);
    expect(shared.auditEvents).toHaveLength(1);
    expect(shared.auditEvents[0]).toMatchObject({
      operation: "lease_expire",
      decision: "allowed",
      metadata: { via: "lease-expiry-finalizer", escalated: true, attempts: 5 },
    });
    // The escalation path's DB-call order: increment -> recheck -> cancel
    // (attempted, throws) -> escalate -> the fenced settle.
    expect(shared.log).toEqual(["increment", "recheck", "cancel", "escalate", "finalize"]);
  });

  it("already escalated by a concurrent tick (0 rows from the idempotent stamp) ⇒ force-settles WITHOUT a second audit", async () => {
    shared.cancelTaskImpl = vi.fn(async () => {
      throw new Error("cancel failed");
    });
    shared.incrementRows = [{ finalize_attempts: 6 }];
    shared.escalateRows = []; // already escalated — 0 rows
    mockSweep([{ ...ROW, a2a_task_id: "task-1" }]);
    const summary = await runLeaseExpiryFinalizerSweep();
    expect(summary.escalated).toBe(0);
    expect(summary.settled).toBe(1);
    expect(shared.auditEvents).toEqual([]);
    expect(shared.finalizeCalls).toEqual([{ orgId: "org-1", runId: "run-1" }]);
    // The idempotent stamp still ISSUES the escalate query (0 rows back) —
    // the order is unchanged by who wins it.
    expect(shared.log).toEqual(["increment", "recheck", "cancel", "escalate", "finalize"]);
  });
});

describe("runLeaseExpiryFinalizerSweep — outcome tallying", () => {
  it("finalize returns skipped (lease-gone) ⇒ tallied as skippedLeaseGone, not settled", async () => {
    shared.finalizeOutcome = { outcome: "skipped", reason: "lease-gone" };
    mockSweep([{ ...ROW }]);
    const summary = await runLeaseExpiryFinalizerSweep();
    expect(summary.settled).toBe(0);
    expect(summary.skippedLeaseGone).toBe(1);
  });

  it("finalize returns settled/lease-only ⇒ tallied separately from a real run settle", async () => {
    shared.finalizeOutcome = { outcome: "settled", mode: "lease-only" };
    mockSweep([{ ...ROW }]);
    const summary = await runLeaseExpiryFinalizerSweep();
    expect(summary.settledLeaseOnly).toBe(1);
    expect(summary.settled).toBe(0);
  });
});

describe("runLeaseExpiryFinalizerSweep — per-lease failure isolation", () => {
  it("one lease throwing unexpectedly does not stop the batch — every OTHER lease still gets processed", async () => {
    shared.finalizeThrows = false;
    mockSweep([
      { ...ROW, run_id: "run-A", org_id: "org-A" },
      { ...ROW, run_id: "run-B", org_id: "org-B" },
    ]);
    // Make the FIRST lease's increment call throw (simulating an unexpected
    // pooled-query failure) by overriding the mock implementation once.
    (agentBuilderPool.query as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new Error("pooled query blew up for run-A");
      },
    );
    const summary = await runLeaseExpiryFinalizerSweep();
    expect(summary.swept).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.settled).toBe(1);
    expect(shared.finalizeCalls).toEqual([{ orgId: "org-B", runId: "run-B" }]);
  });
});
