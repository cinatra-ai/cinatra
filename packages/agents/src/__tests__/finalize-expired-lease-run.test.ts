/**
 * cinatra#1940 P4, phase 2 — `finalizeExpiredLeaseRun`.
 *
 * The lease-expiry finalizer's audited settle under the exclusive fence
 * (`guardOrgLifecycleMutation`). This suite pins:
 *   - active org ⇒ the kernel's OWN `run.lease-expire` ruling refuses
 *     (`capability-denied`) — no CAS, no settle, no mint-side workaround;
 *   - archived org, lease NOT found at the fence's own epoch ⇒ `skipped`
 *     (`lease-gone`) — no CAS, no settle;
 *   - archived org, lease found, run ALREADY terminal ⇒ settle-orphan
 *     (lease-only DELETE, no CAS);
 *   - archived org, lease found, run non-terminal ⇒ CAS to `failed` + meta +
 *     lease DELETE, all in the SAME guarded tx (order: CAS → meta → settle);
 *   - post-commit: `expireRunStream` + `dispatchRunWaitTransition` fire ONLY
 *     on a `run-and-lease` settle, never on a lease-only settle or a skip.
 *
 * Harness: `../db` is mocked so the writer runs against a fake drizzle tx
 * wrapped with the kernel's sanctioned `wrapTxWithOrgWriteKernel` (answers the
 * fence's own lock/state queries). The kernel wrap's `org_archive_lease`
 * needle also answers our OWN in-fence FOR-UPDATE re-verify (both are
 * "does a matching org_archive_lease row exist" checks, so `leaseHeld`
 * doubles as the control for BOTH) — the settle DELETE's return value is
 * simply unused, exactly like the P1 precedent (run-transition-lease-settle.test.ts).
 * An OUTER recording layer captures the settle DELETE + the CAS/meta `set`s
 * into one ordered log. No live DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const shared = vi.hoisted(() => ({
  kernelAnswers: {
    organization: { archivedAt: "2026-07-01T00:00:00Z", archiveEpoch: 3 } as
      | { archivedAt: string | null; archiveEpoch: number }
      | null,
    leaseHeld: true,
  },
  log: [] as string[],
  runRow: { status: "running" } as { status: string } | null,
  updateCalls: 0,
  failOnUpdateCall: null as number | null,
  returningRows: [] as Array<Array<{ id: string }>>,
  auditEvents: [] as Record<string, unknown>[],
  expireRunStream: vi.fn(async () => undefined),
  dispatchRunWaitTransition: vi.fn(async () => undefined),
}));

function sqlText(query: unknown): string {
  try {
    return JSON.stringify(query)?.replaceAll('\\"', '"') ?? "";
  } catch {
    return "";
  }
}

vi.mock("../db", async () => {
  const { wrapTxWithOrgWriteKernel } = await import(
    "@cinatra-ai/org-write-kernel/testing"
  );
  const update = () => {
    shared.updateCalls += 1;
    const thisCall = shared.updateCalls;
    return {
      set: (payload: unknown) => {
        shared.log.push(`set:${(payload as { status?: string })?.status ?? "?"}`);
        return {
          where: () => {
            if (shared.failOnUpdateCall === thisCall) {
              const rej = () => {
                const r = Promise.reject(new Error("simulated write failure"));
                r.catch(() => {});
                return r;
              };
              return Object.assign(rej(), { returning: rej });
            }
            const rows =
              shared.returningRows.length > 0
                ? shared.returningRows.shift()!
                : [{ id: "run-1" }];
            return Object.assign(Promise.resolve(undefined), {
              returning: async () => rows,
            });
          },
        };
      },
    };
  };
  const select = () => ({
    from: () => ({
      where: async () => (shared.runRow ? [{ status: shared.runRow.status }] : []),
    }),
  });
  const inner = wrapTxWithOrgWriteKernel(
    { update, select, execute: async () => ({ rows: [] }) },
    shared.kernelAnswers,
  );
  // OUTER recording layer: capture the settle DELETE (a non-kernel writer
  // statement, matched the same way the P1 precedent does) BEFORE the kernel
  // wrap answers its own `org_archive_lease` needle.
  const tx = Object.create(inner) as typeof inner;
  Object.defineProperty(tx, "execute", {
    enumerable: true,
    value: async (q: unknown) => {
      const text = sqlText(q);
      if (/delete/i.test(text) && text.includes("org_archive_lease")) {
        shared.log.push("settle");
      }
      return inner.execute(q);
    },
  });
  return {
    db: { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
    agentBuilderPool: { end: vi.fn() },
  };
});

vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = await orig<typeof import("@cinatra-ai/a2a")>();
  return { ...actual, expireRunStream: shared.expireRunStream };
});
vi.mock("../run-wait-notifier", async (orig) => {
  const actual = await orig<typeof import("../run-wait-notifier")>();
  return { ...actual, dispatchRunWaitTransition: shared.dispatchRunWaitTransition };
});
vi.mock("@/lib/authz", async (orig) => {
  const actual = await orig<typeof import("@/lib/authz")>();
  return {
    ...actual,
    logAuditEvent: vi.fn((input: Record<string, unknown>) => {
      shared.auditEvents.push(input);
    }),
    POLICY_VERSION: "test-policy-version",
  };
});

import { finalizeExpiredLeaseRun } from "../run-transition";

const ORG = "org-1";
const RUN = "run-1";

beforeEach(() => {
  vi.clearAllMocks();
  shared.log.length = 0;
  shared.auditEvents.length = 0;
  shared.updateCalls = 0;
  shared.failOnUpdateCall = null;
  shared.returningRows = [];
  shared.runRow = { status: "running" };
  shared.kernelAnswers.organization = { archivedAt: "2026-07-01T00:00:00Z", archiveEpoch: 3 };
  shared.kernelAnswers.leaseHeld = true;
});

describe("finalizeExpiredLeaseRun — kernel ruling", () => {
  it("an ACTIVE org refuses at the fence itself (capability-denied) — no CAS, no settle", async () => {
    shared.kernelAnswers.organization = { archivedAt: null, archiveEpoch: 0 };
    await expect(finalizeExpiredLeaseRun(ORG, RUN)).rejects.toMatchObject({
      name: "OrgWriteRefusedError",
      reason: "capability-denied",
    });
    expect(shared.log).toEqual([]);
  });
});

describe("finalizeExpiredLeaseRun — lease-gone (benign skip)", () => {
  it("no matching expired lease row at the fence's own epoch ⇒ skipped, no CAS, no settle", async () => {
    shared.kernelAnswers.leaseHeld = false;
    const outcome = await finalizeExpiredLeaseRun(ORG, RUN);
    expect(outcome).toEqual({ outcome: "skipped", reason: "lease-gone" });
    expect(shared.log).toEqual([]);
    expect(shared.expireRunStream).not.toHaveBeenCalled();
    expect(shared.dispatchRunWaitTransition).not.toHaveBeenCalled();
    expect(shared.auditEvents).toEqual([]);
  });
});

describe("finalizeExpiredLeaseRun — settle-orphan (already terminal)", () => {
  it("an already-terminal run ⇒ lease-only DELETE, no CAS, no run-notify", async () => {
    shared.runRow = { status: "completed" };
    const outcome = await finalizeExpiredLeaseRun(ORG, RUN);
    expect(outcome).toEqual({ outcome: "settled", mode: "lease-only" });
    expect(shared.log).toEqual(["settle"]);
    expect(shared.expireRunStream).not.toHaveBeenCalled();
    expect(shared.dispatchRunWaitTransition).not.toHaveBeenCalled();
    expect(shared.auditEvents).toHaveLength(1);
    expect(shared.auditEvents[0]).toMatchObject({
      operation: "lease_expire",
      decision: "allowed",
      metadata: { via: "lease-expiry-finalizer", mode: "lease-only" },
    });
  });

  it("a vanished run row (deleted) is treated the same as already-terminal", async () => {
    shared.runRow = null;
    const outcome = await finalizeExpiredLeaseRun(ORG, RUN);
    expect(outcome).toEqual({ outcome: "settled", mode: "lease-only" });
    expect(shared.log).toEqual(["settle"]);
  });
});

describe("finalizeExpiredLeaseRun — the real settle (non-terminal run)", () => {
  it("CAS → meta → lease DELETE, in that order, all in the same guarded tx", async () => {
    shared.runRow = { status: "running" };
    const outcome = await finalizeExpiredLeaseRun(ORG, RUN);
    expect(outcome).toEqual({ outcome: "settled", mode: "run-and-lease", from: "running", won: true });
    expect(shared.log).toEqual(["set:failed", "set:failed", "settle"]);
  });

  it("never settles to `stopped` — always `failed` (an expired window is a failure, not user intent)", async () => {
    await finalizeExpiredLeaseRun(ORG, RUN);
    expect(shared.log.filter((e) => e.startsWith("set:"))).toEqual(["set:failed", "set:failed"]);
  });

  it("post-commit: expireRunStream + dispatchRunWaitTransition fire exactly once, with from/to", async () => {
    await finalizeExpiredLeaseRun(ORG, RUN);
    expect(shared.expireRunStream).toHaveBeenCalledTimes(1);
    expect(shared.expireRunStream).toHaveBeenCalledWith(RUN);
    expect(shared.dispatchRunWaitTransition).toHaveBeenCalledTimes(1);
    expect(shared.dispatchRunWaitTransition).toHaveBeenCalledWith({
      runId: RUN,
      from: "running",
      to: "failed",
      humanWaitGate: false,
    });
  });

  it("emits the decision-record audit event post-commit", async () => {
    await finalizeExpiredLeaseRun(ORG, RUN);
    expect(shared.auditEvents).toHaveLength(1);
    expect(shared.auditEvents[0]).toMatchObject({
      actorPrincipalType: "system",
      authSource: "scheduler",
      resourceType: "agent_run",
      resourceId: RUN,
      operation: "lease_expire",
      decision: "allowed",
      runId: RUN,
      organizationId: ORG,
      metadata: { via: "lease-expiry-finalizer", mode: "run-and-lease" },
    });
  });

  // Table-drive every status a lease can ACTUALLY be
  // held against, not just one sample. `isLiveAttempt`
  // (packages/org-write-kernel/src/live-attempt.ts) is the single source of
  // "which in-flight statuses ever get a lease": `running` and
  // `waiting_trigger` unconditionally, `pending_approval` while its
  // human-wait marker matches. `queued`, `pending_input`, `armed`,
  // `pending_trigger` never hold a lease by that predicate's own design (each
  // still carries a real P1 `->failed` edge — just not lease-relevant, so
  // deliberately out of this table's scope).
  it.each(["running", "pending_approval", "waiting_trigger"] as const)(
    "works from the leased status %s -> failed: CAS -> meta -> lease DELETE, in that order",
    async (from) => {
      shared.runRow = { status: from };
      const outcome = await finalizeExpiredLeaseRun(ORG, RUN);
      expect(outcome).toEqual({ outcome: "settled", mode: "run-and-lease", from, won: true });
      expect(shared.log).toEqual(["set:failed", "set:failed", "settle"]);
    },
  );

  it("a lost CAS (0 rows — another writer already terminalized under the same fence) still settles the lease harmlessly, no double-notify", async () => {
    // Row read shows non-terminal, but the CAS itself matches 0 rows (stale) —
    // the defensive fallback: the lease DELETE still runs (harmless no-op if
    // the other writer's own terminal fold already deleted it); this call did
    // not actually land the transition, so it must not also fire its own
    // post-commit notify/audit (that writer's own transitionRunStatus call already did).
    shared.returningRows = [[]];
    const outcome = await finalizeExpiredLeaseRun(ORG, RUN);
    expect(outcome).toEqual({ outcome: "settled", mode: "run-and-lease", from: "running", won: false });
    // Exactly ONE `set:` (the CAS attempt itself, which lost) — the meta write
    // is skipped since `won` is false — then the settle DELETE.
    expect(shared.log).toEqual(["set:failed", "settle"]);
    expect(shared.expireRunStream).not.toHaveBeenCalled();
    expect(shared.dispatchRunWaitTransition).not.toHaveBeenCalled();
    expect(shared.auditEvents).toEqual([]);
  });
});
