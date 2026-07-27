/**
 * cinatra#1940 P1 (Decision 4) — the terminal-transaction LEASE-SETTLE fold.
 *
 * transitionRunStatus now settles the run's archive lease INSIDE its guarded
 * terminal transaction, so status CAS + delegated meta + (derivation outbox) +
 * LEASE DELETE commit as ONE atomic unit. This suite pins:
 *   - statement ORDER on both terminal branches (plain + derivationOutbox):
 *     CAS → meta/insert → lease DELETE;
 *   - the settle fires ONLY on terminal edges (never on a non-terminal move);
 *   - ROLLBACK: an injected meta-write failure means the settle DELETE is never
 *     issued (the lease row survives → the finalizer settles it later) and the
 *     post-commit side-effects are suppressed;
 *   - the archive-vs-terminal race closure (order B): an in-window run.complete
 *     under an ARCHIVED org (lease-gated, lease held) commits CAS+meta+settle
 *     atomically — no lingering lease residue.
 *
 * Harness: `../db` is mocked so the writer runs against a fake drizzle tx wrapped
 * with the kernel's sanctioned `wrapTxWithOrgWriteKernel` (answers the guard's
 * own lock/state/lease queries). The kernel wrap would SWALLOW our settle DELETE
 * (it matches the wrap's `org_archive_lease` needle), so an OUTER recording
 * `execute` layer captures it — every op lands in one ordered `log`. No live DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const shared = vi.hoisted(() => ({
  kernelAnswers: {
    organization: { archivedAt: null as string | null, archiveEpoch: 0 } as
      | { archivedAt: string | null; archiveEpoch: number }
      | null,
    leaseHeld: false,
  },
  // Unified ordered op log: "set:<status>" (CAS + meta), "insert", "settle".
  log: [] as string[],
  returningRows: [] as Array<Array<{ id: string }>>,
  updateCalls: 0,
  failOnUpdateCall: null as number | null,
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
  const insert = () => ({
    values: () => ({
      onConflictDoNothing: async () => {
        shared.log.push("insert");
      },
    }),
  });
  const inner = wrapTxWithOrgWriteKernel(
    { update, insert, execute: async () => ({ rows: [] }) },
    shared.kernelAnswers,
  );
  // OUTER recording layer: capture the settle DELETE (a non-kernel writer
  // statement) BEFORE the kernel wrap answers its own `org_archive_lease` needle.
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

import { transitionRunStatus } from "../store";

const ORG = "org-1";
const RUN = "run-1";
const SESSION = { orgId: ORG, can: () => true };
// A VerifiedRunRef-shaped authority (self-bound, carries attempt id) — the only
// shape that can satisfy an ARCHIVED (lease-gated) run.complete ruling.
const RUN_AUTH_LEASE = {
  orgId: ORG,
  runId: RUN,
  executionAttemptId: "att-1",
  can: (c: string) => c === "run.complete" || c === "content.write",
};

function derivationCapture() {
  return {
    orgId: ORG,
    templateId: "tmpl-1",
    packageVersion: null,
    createdBy: "user-1",
    content: "final output",
    contentIsJson: false,
    contentHash: "abc123",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  shared.log.length = 0;
  shared.returningRows = [];
  shared.updateCalls = 0;
  shared.failOnUpdateCall = null;
  shared.kernelAnswers.organization = { archivedAt: null, archiveEpoch: 0 };
  shared.kernelAnswers.leaseHeld = false;
});

describe("terminal-tx lease-settle fold — statement order (Decision 4)", () => {
  it("plain terminal edge: CAS → meta → lease DELETE, all in-tx", async () => {
    await transitionRunStatus(RUN, "queued", "stopped", undefined, SESSION);
    // Two `set`s (CAS + delegated terminal meta) then exactly one settle, last.
    expect(shared.log).toEqual(["set:stopped", "set:stopped", "settle"]);
    expect(shared.log.filter((o) => o === "settle")).toHaveLength(1);
    expect(shared.log.at(-1)).toBe("settle");
  });

  it("derivationOutbox terminal edge: CAS → outbox INSERT → lease DELETE, all in-tx", async () => {
    await transitionRunStatus(
      RUN,
      "running",
      "completed",
      { derivationOutbox: derivationCapture() },
      SESSION,
    );
    expect(shared.log).toEqual(["set:completed", "insert", "settle"]);
    // Settle strictly after the CAS and the outbox insert.
    expect(shared.log.indexOf("settle")).toBeGreaterThan(shared.log.indexOf("insert"));
  });

  it("the new pending_trigger->stopped edge terminalizes AND settles the lease", async () => {
    await transitionRunStatus(RUN, "pending_trigger", "stopped", undefined, SESSION);
    expect(shared.log).toContain("settle");
    expect(shared.log.at(-1)).toBe("settle");
  });
});

describe("terminal-tx lease-settle fold — negative + rollback pins", () => {
  it("a NON-terminal transition issues NO lease settle", async () => {
    await transitionRunStatus(RUN, "pending_input", "queued", undefined, SESSION);
    expect(shared.log).not.toContain("settle");
  });

  it("an injected meta-write failure never issues the settle (lease row intact) and suppresses post-commit", async () => {
    // running→completed with meta ⇒ CAS (update #1, wins) then meta (update #2);
    // fail the meta write. The settle would run AFTER meta — so it must never be
    // reached, leaving the lease row for the finalizer.
    shared.failOnUpdateCall = 2;
    await expect(
      transitionRunStatus(RUN, "running", "completed", { stepResults: [{ ok: true }] }, SESSION),
    ).rejects.toThrow(/simulated write failure/);
    expect(shared.log).not.toContain("settle");
    expect(shared.expireRunStream).not.toHaveBeenCalled();
    expect(shared.dispatchRunWaitTransition).not.toHaveBeenCalled();
  });

  it("a lost CAS (stale) issues NO settle and no post-commit side-effects", async () => {
    shared.returningRows = [[]]; // CAS matches 0 rows
    await expect(
      transitionRunStatus(RUN, "queued", "stopped", undefined, SESSION),
    ).rejects.toMatchObject({ code: "stale_from_status" });
    expect(shared.log).not.toContain("settle");
    expect(shared.expireRunStream).not.toHaveBeenCalled();
  });
});

describe("archive-vs-terminal race closure — in-window completion settles atomically (Decision 4, order B)", () => {
  it("archived org + held lease + run.complete ⇒ CAS + meta + lease DELETE commit together", async () => {
    shared.kernelAnswers.organization = { archivedAt: "2026-07-01T00:00:00Z", archiveEpoch: 1 };
    shared.kernelAnswers.leaseHeld = true; // the archive snapshot's in-window lease
    await transitionRunStatus(RUN, "running", "completed", undefined, RUN_AUTH_LEASE);
    // The completion committed under lease-gating AND revoked the lease in the
    // same guarded tx — zero lingering window residue.
    expect(shared.log).toEqual(["set:completed", "set:completed", "settle"]);
    expect(shared.expireRunStream).toHaveBeenCalledTimes(1);
  });

  it("archived org + terminal edge but NO held lease ⇒ refused, no CAS, no settle", async () => {
    shared.kernelAnswers.organization = { archivedAt: "2026-07-01T00:00:00Z", archiveEpoch: 1 };
    shared.kernelAnswers.leaseHeld = false;
    await expect(
      transitionRunStatus(RUN, "running", "completed", undefined, RUN_AUTH_LEASE),
    ).rejects.toMatchObject({ name: "OrgWriteRefusedError", reason: "lease-required-but-not-held" });
    expect(shared.log).not.toContain("set:completed");
    expect(shared.log).not.toContain("settle");
  });
});
