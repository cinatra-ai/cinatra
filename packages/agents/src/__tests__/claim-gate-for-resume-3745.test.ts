/**
 * cinatra#3745 — the MCP resume claims the paused run's gate before it records
 * or sends anything.
 *
 * claimGateForResume moves the run `pending_approval -> running` with one
 * conditional write bound to the gate the caller read (the run's a2a task and
 * execution attempt). A lost claim (`stale_from_status`) means the gate was
 * already answered, or the run has paused at a later gate: nothing is prepared,
 * recorded or sent. A failure of the preparation (the run-token mint) after a
 * won claim releases the claim on the same gate and puts back the
 * produced-review park the claim cleared.
 */
import { describe, it, expect, vi } from "vitest";

import { claimGateForResume } from "../run-status";

const AUTHORITY = { orgId: "org-1" };
const GATE = { a2aTaskId: "task-A", executionAttemptId: "attempt-1" };
const PARK = { producedReviewPark: '{"status":"completed"}', withheldTerminal: { status: "completed" } };

type Meta = { resumeGate: { a2aTaskId: string; executionAttemptId: string | null; onParkCleared?: (park: unknown) => void; restorePark?: unknown } };

function staleFromStatus(): Error {
  return Object.assign(new Error("stale_from_status"), { code: "stale_from_status" });
}

describe("claimGateForResume", () => {
  it("claims pending_approval -> running first, then prepares and returns the value", async () => {
    const order: string[] = [];
    const transition = vi.fn(async (_runId: string, from: string, to: string) => {
      order.push(`${from}->${to}`);
    });
    const prepare = vi.fn(async () => {
      order.push("prepare");
      return { token: "t" };
    });
    const result = await claimGateForResume(transition, "run-1", GATE, AUTHORITY, prepare);
    expect(result).toEqual({ claimed: true, value: { token: "t" } });
    expect(order).toEqual(["pending_approval->running", "prepare"]);
    expect(transition).toHaveBeenCalledTimes(1);
  });

  it("the claim is bound to the gate the caller read (its a2a task and execution attempt)", async () => {
    const transition = vi.fn<(runId: string, from: string, to: string, meta: Meta, authority: unknown) => Promise<void>>(async () => undefined);
    await claimGateForResume(transition, "run-1", GATE, AUTHORITY, async () => "v");
    const [runId, from, to, meta, authority] = transition.mock.calls[0] as unknown as [string, string, string, Meta, unknown];
    expect([runId, from, to, authority]).toEqual(["run-1", "pending_approval", "running", AUTHORITY]);
    expect(meta.resumeGate).toMatchObject({ a2aTaskId: "task-A", executionAttemptId: "attempt-1" });
    expect(typeof meta.resumeGate.onParkCleared).toBe("function");
    expect(meta.resumeGate.restorePark).toBeUndefined();
  });

  it("a lost claim returns claimed false and prepares nothing", async () => {
    const transition = vi.fn(async () => {
      throw staleFromStatus();
    });
    const prepare = vi.fn(async () => "never");
    await expect(claimGateForResume(transition, "run-1", GATE, AUTHORITY, prepare)).resolves.toEqual({ claimed: false });
    expect(prepare).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledTimes(1);
  });

  it("a claim error other than stale_from_status is rethrown, nothing prepared", async () => {
    const boom = Object.assign(new Error("db down"), { code: "illegal_transition" });
    const transition = vi.fn(async () => {
      throw boom;
    });
    const prepare = vi.fn(async () => "never");
    await expect(claimGateForResume(transition, "run-1", GATE, AUTHORITY, prepare)).rejects.toBe(boom);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("a failed preparation releases the claim on the same gate and puts back the park the claim cleared", async () => {
    const calls: Array<[string, Meta]> = [];
    const transition = vi.fn(async (_runId: string, from: string, to: string, meta: Meta) => {
      calls.push([`${from}->${to}`, meta]);
      // The claim's transaction reports the park it cleared.
      if (from === "pending_approval") meta.resumeGate.onParkCleared?.(PARK);
    });
    const mintError = new Error("mint failed");
    await expect(
      claimGateForResume(transition, "run-1", GATE, AUTHORITY, async () => {
        throw mintError;
      }),
    ).rejects.toBe(mintError);
    expect(calls.map(([edge]) => edge)).toEqual(["pending_approval->running", "running->pending_approval"]);
    const release = calls[1][1].resumeGate;
    expect(release).toMatchObject({ a2aTaskId: "task-A", executionAttemptId: "attempt-1" });
    expect(release.restorePark).toBe(PARK);
    expect(release.onParkCleared).toBeUndefined();
  });

  it("a failed preparation of a claim that cleared no park releases with nothing to put back", async () => {
    const metas: Meta[] = [];
    const transition = vi.fn(async (_runId: string, _from: string, _to: string, meta: Meta) => {
      metas.push(meta);
    });
    await expect(
      claimGateForResume(transition, "run-1", GATE, AUTHORITY, async () => {
        throw new Error("mint failed");
      }),
    ).rejects.toThrow("mint failed");
    expect(metas[1].resumeGate.restorePark).toBeNull();
  });

  it("a release that also fails still rethrows the preparation error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let calls = 0;
    const transition = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error("release failed");
    });
    const mintError = new Error("mint failed");
    await expect(
      claimGateForResume(transition, "run-1", GATE, AUTHORITY, async () => {
        throw mintError;
      }),
    ).rejects.toBe(mintError);
    expect(transition).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
