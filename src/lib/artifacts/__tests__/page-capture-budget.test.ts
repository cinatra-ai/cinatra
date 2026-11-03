// The page capture budget's decisions over a query double (cinatra#4223).
// What only a real database can prove (two processes, a race, a restart, the
// TTL) is in page-capture-budget.integration.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/pooled", () => ({
  getPooledDb: () => {
    throw new Error("no pool in this suite: postgres://fixture-user:fixture-secret@db.invalid/x");
  },
}));

import {
  MAX_CONCURRENT_PAGE_CAPTURES_PER_RUN,
  MAX_PAGE_CAPTURES_PER_RUN,
  PAGE_CAPTURE_LEASE_TTL_SECONDS,
  acquirePageCaptureLease,
  pageCaptureBudgetLockKey,
  type PageCaptureBudgetDeps,
  type PageCaptureBudgetQuery,
} from "@/lib/artifacts/page-capture-budget";

type Call = { text: string; values: readonly unknown[] };

/** A transaction double: the lock answers nothing, the count answers `counts` (undefined: no row), the insert answers `inserted` (null: no row). */
function scripted(counts: unknown, inserted: unknown = { id: "lease-1" }) {
  const calls: Call[] = [];
  const updates: Call[] = [];
  const txQuery: PageCaptureBudgetQuery = async <T = unknown>(text: string, values: readonly unknown[] = []) => {
    calls.push({ text, values });
    if (/pg_advisory_xact_lock/.test(text)) return [] as T[];
    if (/^SELECT count/.test(text)) return (counts === undefined ? [] : [counts]) as T[];
    if (/^INSERT INTO/.test(text)) return (inserted === null ? [] : [inserted]) as T[];
    throw new Error(`unexpected statement ${text}`);
  };
  const deps: PageCaptureBudgetDeps = {
    schema: "cinatra",
    transaction: async (fn) => fn(txQuery),
    query: async <T = unknown>(text: string, values: readonly unknown[] = []) => {
      updates.push({ text, values });
      return [] as T[];
    },
  };
  return { calls, updates, deps };
}

const RUN = { orgId: "org-1", runId: "run-1" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("page capture budget (cinatra#4223)", () => {
  it("states the limits: 20 per run, 2 at once, a 300 second lease", () => {
    expect(MAX_PAGE_CAPTURES_PER_RUN).toBe(20);
    expect(MAX_CONCURRENT_PAGE_CAPTURES_PER_RUN).toBe(2);
    expect(PAGE_CAPTURE_LEASE_TTL_SECONDS).toBe(300);
  });

  it("admits a capture under both limits: lock, count and insert run in one transaction, in that order", async () => {
    const { calls, deps } = scripted({ total: 3, live: 1 });
    const answer = await acquirePageCaptureLease(RUN, deps);
    expect(answer.ok).toBe(true);
    if (answer.ok) expect(answer.lease.leaseId).toBe("lease-1");
    expect(calls.map((c) => c.text.split(/\s+/)[0] + " " + c.text.split(/\s+/)[1])).toEqual([
      "SELECT pg_advisory_xact_lock(hashtextextended($1,",
      "SELECT count(*)::int",
      "INSERT INTO",
    ]);
    expect(calls[0].values).toEqual([pageCaptureBudgetLockKey("org-1", "run-1")]);
    expect(calls[1].values).toEqual(["org-1", "run-1"]);
    expect(calls[1].text).toContain('FROM "cinatra"."page_capture_leases" WHERE org_id = $1 AND run_id = $2');
    expect(calls[1].text).toContain("released_at IS NULL AND expires_at > now()");
    expect(calls[2].values).toEqual(["org-1", "run-1", 300]);
    expect(calls[2].text).toContain("now() + make_interval(secs => $3)");
  });

  it("refuses run_cap_exceeded once the run took 20 leases, even with none in flight, and takes no lease", async () => {
    const { calls, deps } = scripted({ total: 20, live: 0 });
    expect(await acquirePageCaptureLease(RUN, deps)).toEqual({ ok: false, reason: "run_cap_exceeded" });
    expect(calls.some((c) => c.text.startsWith("INSERT"))).toBe(false);
  });

  it("refuses concurrency_exceeded while the run holds 2 live leases, and takes no lease", async () => {
    const { calls, deps } = scripted({ total: 5, live: 2 });
    expect(await acquirePageCaptureLease(RUN, deps)).toEqual({ ok: false, reason: "concurrency_exceeded" });
    expect(calls.some((c) => c.text.startsWith("INSERT"))).toBe(false);
  });

  it("names the run cap first when both limits are reached", async () => {
    const { deps } = scripted({ total: 20, live: 2 });
    expect(await acquirePageCaptureLease(RUN, deps)).toEqual({ ok: false, reason: "run_cap_exceeded" });
  });

  it("applies the limits it is given", async () => {
    const { deps } = scripted({ total: 1, live: 0 });
    deps.limits = { perRun: 1, concurrent: 5, ttlSeconds: 9 };
    expect(await acquirePageCaptureLease(RUN, deps)).toEqual({ ok: false, reason: "run_cap_exceeded" });
  });

  it("refuses budget_unavailable when the store throws, and its log line carries no text of the error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps: PageCaptureBudgetDeps = {
      transaction: async () => {
        throw new Error("connect failed: postgres://fixture-user:fixture-secret@db.invalid/x");
      },
    };
    expect(await acquirePageCaptureLease(RUN, deps)).toEqual({ ok: false, reason: "budget_unavailable" });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain("fixture-secret");
    expect(logged).not.toContain("postgres://");
    expect(logged).toContain("run-1");
  });

  it("refuses budget_unavailable on the configured store when no pool can be made (it never throws)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(acquirePageCaptureLease(RUN)).resolves.toEqual({ ok: false, reason: "budget_unavailable" });
  });

  it("refuses budget_unavailable on a count it cannot read or an insert that returns no id", async () => {
    for (const [counts, inserted] of [
      [undefined, { id: "x" }],
      [{ total: "3", live: 0 }, { id: "x" }],
      [{ total: 1 }, { id: "x" }],
      [{ total: 0, live: 0 }, null],
      [{ total: 0, live: 0 }, { id: "" }],
    ] as const) {
      const { deps } = scripted(counts, inserted);
      expect(await acquirePageCaptureLease(RUN, deps)).toEqual({ ok: false, reason: "budget_unavailable" });
    }
  });

  it("refuses budget_unavailable for an empty organisation or run, without a transaction", async () => {
    const { calls, deps } = scripted({ total: 0, live: 0 });
    for (const input of [
      { orgId: "", runId: "run-1" },
      { orgId: "org-1", runId: "" },
      { orgId: undefined as unknown as string, runId: "run-1" },
    ]) {
      expect(await acquirePageCaptureLease(input, deps)).toEqual({ ok: false, reason: "budget_unavailable" });
    }
    expect(calls).toHaveLength(0);
  });

  it("release ends exactly its own live lease once; a second release does nothing", async () => {
    const { updates, deps } = scripted({ total: 0, live: 0 });
    const answer = await acquirePageCaptureLease(RUN, deps);
    if (!answer.ok) throw new Error("expected a lease");
    await answer.lease.release();
    await answer.lease.release();
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toEqual(["lease-1", "org-1", "run-1"]);
    expect(updates[0].text).toContain("SET released_at = now()");
    expect(updates[0].text).toContain("WHERE id = $1 AND org_id = $2 AND run_id = $3 AND released_at IS NULL");
  });

  it("a release that fails does not throw, and its log line carries no text of the error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = scripted({ total: 0, live: 0 });
    deps.query = async () => {
      throw new Error("lost: postgres://fixture-user:fixture-secret@db.invalid/x");
    };
    const answer = await acquirePageCaptureLease(RUN, deps);
    if (!answer.ok) throw new Error("expected a lease");
    await expect(answer.lease.release()).resolves.toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain("fixture-secret");
  });

  it("gives two different id pairs two different lock keys, even when their joined text is equal", () => {
    expect(pageCaptureBudgetLockKey("a:b", "c")).not.toBe(pageCaptureBudgetLockKey("a", "b:c"));
    expect(pageCaptureBudgetLockKey("org-1", "run-1")).toBe(pageCaptureBudgetLockKey("org-1", "run-1"));
  });
});
