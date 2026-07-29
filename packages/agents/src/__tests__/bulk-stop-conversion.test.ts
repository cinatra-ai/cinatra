/**
 * cinatra#1940 P1 (Decision 4) — bulkStop* canonical-transition conversion.
 *
 * The bulk stop functions no longer do a direct, unguarded
 * `db.update(agentRuns).set({status:"stopped"})` — they loop over the canonical
 * `transitionRunStatus(id, row.status, "stopped", undefined, authority)`
 * primitive. This suite pins:
 *   - one guarded transition per STOPPABLE row, with the from-status and the
 *     threaded frame authority;
 *   - the EXTENDED status set (armed / pending_trigger / waiting_trigger) is now
 *     covered — the disclosed behavior change (these were silently skipped);
 *   - already-terminal rows are counted, never transitioned;
 *   - stale-swallow: a stale CAS whose re-read shows a genuinely TERMINAL row is
 *     counted alreadyTerminal and does NOT abort the batch;
 *   - RETRY-ON-STALE: a stale CAS whose row RACED to ANOTHER live
 *     status (e.g. queued→running) is re-read and re-driven from the fresh
 *     status — the run is still stopped, not silently miscounted;
 *   - a non-stale error propagates.
 *
 * `../db` is mocked to feed the bulk SELECT and the per-row re-read;
 * `../run-transition` is mocked so transitionRunStatus is a scriptable spy.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ORG = "org-1";

const shared = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; status: string; orgId: string }>,
  calls: [] as Array<{ runId: string; from: string; to: string; auth: unknown }>,
  // per-run script: "ok" | "throw" | "stale-terminal" | "stale-then-ok"
  behavior: new Map<string, string>(),
  attempts: new Map<string, number>(),
  // status the per-row re-read returns for a run after a stale CAS.
  reread: new Map<string, string>(),
  lastStaleId: null as string | null,
  ORG: "org-1",
}));

vi.mock("../db", () => ({
  db: {
    select: (cols: Record<string, unknown>) => ({
      from: () => ({
        where: async () => {
          // Bulk select projects {id,...}; the per-row re-read projects
          // {status, orgId} (no id) — distinguish by the presence of `id`.
          if (cols && "id" in cols) return shared.rows;
          const st = shared.lastStaleId ? shared.reread.get(shared.lastStaleId) : undefined;
          return st ? [{ status: st, orgId: shared.ORG }] : [];
        },
      }),
    }),
  },
  agentBuilderPool: { end: vi.fn() },
}));

vi.mock("../run-transition", async (orig) => {
  const actual = await orig<typeof import("../run-transition")>();
  const { RunTransitionError } = await import("../run-status");
  return {
    ...actual,
    transitionRunStatus: vi.fn(
      async (runId: string, from: string, to: string, _meta: unknown, authority: unknown) => {
        shared.calls.push({ runId, from, to, auth: authority });
        const b = shared.behavior.get(runId) ?? "ok";
        const n = (shared.attempts.get(runId) ?? 0) + 1;
        shared.attempts.set(runId, n);
        const stale = () => {
          shared.lastStaleId = runId;
          throw new RunTransitionError({ code: "stale_from_status", runId, from: from as never, to: to as never });
        };
        if (b === "throw") throw new Error(`boom for ${runId}`);
        if (b === "stale-terminal") stale(); // re-read will show a terminal status
        if (b === "stale-then-ok" && n === 1) stale(); // succeeds on the retry
        // "ok" (or the retry of "stale-then-ok") resolves.
      },
    ),
  };
});

import { bulkStopAgentRuns, bulkStopAgentRunsByTemplate } from "../store";

const AUTH = { orgId: ORG, can: () => true };

beforeEach(() => {
  vi.clearAllMocks();
  shared.rows = [];
  shared.calls = [];
  shared.behavior = new Map();
  shared.attempts = new Map();
  shared.reread = new Map();
  shared.lastStaleId = null;
});

describe("bulkStopAgentRuns — canonical transitions", () => {
  it("empty runIds is a no-op (no DB read, no transitions)", async () => {
    const res = await bulkStopAgentRuns([], AUTH);
    expect(res).toEqual({ stopped: 0, alreadyTerminal: 0, total: 0 });
    expect(shared.calls).toHaveLength(0);
  });

  it("transitions every STOPPABLE row to stopped (from its own status), threading the authority", async () => {
    shared.rows = [
      { id: "r-queued", status: "queued", orgId: ORG },
      { id: "r-running", status: "running", orgId: ORG },
      { id: "r-done", status: "completed", orgId: ORG }, // terminal → skipped
    ];
    const res = await bulkStopAgentRuns(["r-queued", "r-running", "r-done"], AUTH);

    expect(res).toEqual({ stopped: 2, alreadyTerminal: 1, total: 3 });
    expect(shared.calls).toEqual([
      { runId: "r-queued", from: "queued", to: "stopped", auth: AUTH },
      { runId: "r-running", from: "running", to: "stopped", auth: AUTH },
    ]);
  });

  it("EXTENDED status set: armed / pending_trigger / waiting_trigger are now stopped (disclosed change)", async () => {
    shared.rows = [
      { id: "r-armed", status: "armed", orgId: ORG },
      { id: "r-pt", status: "pending_trigger", orgId: ORG },
      { id: "r-wt", status: "waiting_trigger", orgId: ORG },
    ];
    const res = await bulkStopAgentRuns(["r-armed", "r-pt", "r-wt"], AUTH);
    expect(res.stopped).toBe(3);
    expect(shared.calls.map((c) => `${c.from}->${c.to}`)).toEqual([
      "armed->stopped",
      "pending_trigger->stopped",
      "waiting_trigger->stopped",
    ]);
  });

  it("stale CAS whose row is genuinely terminal → alreadyTerminal, batch continues", async () => {
    shared.rows = [
      { id: "r-1", status: "running", orgId: ORG },
      { id: "r-2", status: "queued", orgId: ORG }, // raced to terminal
      { id: "r-3", status: "pending_approval", orgId: ORG },
    ];
    shared.behavior.set("r-2", "stale-terminal");
    shared.reread.set("r-2", "completed"); // re-read shows it really terminalized
    const res = await bulkStopAgentRuns(["r-1", "r-2", "r-3"], AUTH);
    expect(res).toEqual({ stopped: 2, alreadyTerminal: 1, total: 3 });
  });

  it("RETRY-ON-STALE: a row that RACED to another live status is re-driven and stopped", async () => {
    shared.rows = [{ id: "r-race", status: "queued", orgId: ORG }];
    shared.behavior.set("r-race", "stale-then-ok");
    shared.reread.set("r-race", "running"); // raced queued→running, still stoppable
    const res = await bulkStopAgentRuns(["r-race"], AUTH);
    // The run is STOPPED (not silently miscounted as alreadyTerminal).
    expect(res).toEqual({ stopped: 1, alreadyTerminal: 0, total: 1 });
    // Second drive came from the fresh live status.
    expect(shared.calls.map((c) => c.from)).toEqual(["queued", "running"]);
  });

  it("a NON-stale transition error propagates (never silently dropped)", async () => {
    shared.rows = [{ id: "r-x", status: "running", orgId: ORG }];
    shared.behavior.set("r-x", "throw");
    await expect(bulkStopAgentRuns(["r-x"], AUTH)).rejects.toThrow(/boom for r-x/);
  });

  it("stopped + alreadyTerminal always sums to total", async () => {
    shared.rows = [
      { id: "a", status: "running", orgId: ORG },
      { id: "b", status: "stopped", orgId: ORG }, // already terminal (filtered)
      { id: "c", status: "queued", orgId: ORG }, // raced terminal
    ];
    shared.behavior.set("c", "stale-terminal");
    shared.reread.set("c", "failed");
    const res = await bulkStopAgentRuns(["a", "b", "c"], AUTH);
    expect(res.stopped + res.alreadyTerminal).toBe(res.total);
    expect(res).toEqual({ stopped: 1, alreadyTerminal: 2, total: 3 });
  });
});

describe("bulkStopAgentRunsByTemplate — canonical transitions", () => {
  it("transitions every returned (pre-filtered stoppable) row, threading authority", async () => {
    shared.rows = [
      { id: "t-1", status: "running", orgId: ORG },
      { id: "t-2", status: "armed", orgId: ORG },
    ];
    const res = await bulkStopAgentRunsByTemplate("tmpl-1", AUTH);
    expect(res).toEqual({ stopped: 2, alreadyTerminal: 0, total: 2 });
    expect(shared.calls).toEqual([
      { runId: "t-1", from: "running", to: "stopped", auth: AUTH },
      { runId: "t-2", from: "armed", to: "stopped", auth: AUTH },
    ]);
  });

  it("no matching rows is a no-op", async () => {
    shared.rows = [];
    const res = await bulkStopAgentRunsByTemplate("tmpl-empty", AUTH);
    expect(res).toEqual({ stopped: 0, alreadyTerminal: 0, total: 0 });
    expect(shared.calls).toHaveLength(0);
  });

  it("stale-swallow (terminal re-read) applies per row", async () => {
    shared.rows = [
      { id: "t-1", status: "running", orgId: ORG },
      { id: "t-2", status: "queued", orgId: ORG },
    ];
    shared.behavior.set("t-1", "stale-terminal");
    shared.reread.set("t-1", "completed");
    const res = await bulkStopAgentRunsByTemplate("tmpl-1", AUTH);
    expect(res).toEqual({ stopped: 1, alreadyTerminal: 1, total: 2 });
  });
});
