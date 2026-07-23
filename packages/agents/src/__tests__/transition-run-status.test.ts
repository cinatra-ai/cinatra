/**
 * Unit tests for transitionRunStatus.
 *
 * Covers the behavioral contracts for transitionRunStatus:
 *   1. Illegal edges throw RunTransitionError(illegal_transition) WITHOUT
 *      invoking the CAS or the terminal-hook.
 *   2. Lost CAS races throw RunTransitionError(stale_from_status).
 *   3. Terminal transitions fire expireRunStream exactly once (delegates
 *      to updateAgentRunStatus, preserving the single-hook invariant).
 *   4. Non-terminal transitions skip the delegation when no meta is provided
 *      (CAS's single UPDATE is sufficient).
 *   5. Non-terminal transitions delegate WHEN meta is provided.
 *   6. Terminal meta (stepResults) is forwarded through the second DB write,
 *      not silently dropped in the two-write sequence.
 *
 * DB + @cinatra-ai/a2a are mocked using the shape canonicalized by
 * expire-run-stream-hook.test.ts — Drizzle fluent chain. Two distinct
 * terminators exist in store.ts:
 *   - CAS     (updateAgentRunStatusConditional) → db.update(t).set(v).where(c).returning()
 *   - Non-CAS (updateAgentRunStatus)            → db.update(t).set(v).where(c)        ← awaited directly
 *
 * Because the non-CAS path doesn't call .returning(), the canonical count
 * metric across both paths is `db.update(...)` invocations — tracked via
 * `shared.update.mock.calls.length`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted runs BEFORE the hoisted vi.mock factories below, so the shared
// mocks are in scope by the time the factories evaluate.
const shared = vi.hoisted(() => ({
  // Tracks CAS rows-updated. Default: 1 row updated (CAS success).
  returningRows: [[{ id: "run-1" }]] as Array<Array<{ id: string }>>,
  // Captures every payload passed to .set(...) in call order so test 6 can
  // assert the terminal-delegation payload.
  setPayloads: [] as unknown[],
  // Spies — mocks return void for the non-CAS .where() and rows for .returning().
  updateSpy: vi.fn(),
  expireRunStream: vi.fn(async () => undefined),
}));

vi.mock("../db", () => {
  // Fresh chain factory per db.update() call so tests are isolated at chain-
  // granularity. Each call: update() → { set(payload) → { where() + returning() } }
  const update = vi.fn(() => {
    const chain = {
      set: (payload: unknown) => {
        shared.setPayloads.push(payload);
        return {
          // Non-CAS: awaited directly. Returns a thenable that resolves to undefined.
          where: vi.fn(() => ({
            // CAS: .where(...).returning(...). Consume the next queued rows result.
            returning: vi.fn(async () => {
              const rows = shared.returningRows.length > 0
                ? shared.returningRows.shift()!
                : [{ id: "run-1" }];
              return rows;
            }),
            then: (onFulfilled: (v: unknown) => unknown) => onFulfilled(undefined),
          })),
        };
      },
    };
    return chain;
  });
  shared.updateSpy.mockImplementation(update);
  return {
    db: { update: shared.updateSpy },
    agentBuilderPool: { end: vi.fn() },
  };
});

// Spy on expireRunStream. Firing it is the single-hook invariant.
vi.mock("@cinatra-ai/a2a", () => ({
  expireRunStream: shared.expireRunStream,
}));

// Convenience aliases for readability in tests below.
const update = shared.updateSpy;
const expireRunStream = shared.expireRunStream;

// Import AFTER the mocks so the real transitionRunStatus code path runs
// through the mocked db + @cinatra-ai/a2a.
import {
  transitionRunStatus,
  RunTransitionError,
  type AgentRunStatus,
} from "../store";

beforeEach(() => {
  vi.clearAllMocks();
  shared.setPayloads.length = 0;
  shared.returningRows = [[{ id: "run-1" }]];
});

describe("transitionRunStatus", () => {
  it("throws RunTransitionError(illegal_transition) for unknown edges; never touches the DB", async () => {
    await expect(
      transitionRunStatus("run-1", "completed" as AgentRunStatus, "running" as AgentRunStatus),
    ).rejects.toMatchObject({
      name: "RunTransitionError",
      code: "illegal_transition",
      runId: "run-1",
      from: "completed",
      to: "running",
    });
    // CAS MUST NOT be called when the edge is illegal — that's the whole
    // point of the static validation.
    expect(update).not.toHaveBeenCalled();
    expect(expireRunStream).not.toHaveBeenCalled();
  });

  it("throws RunTransitionError(stale_from_status) when CAS returns 0 rows", async () => {
    shared.returningRows = [[]]; // CAS loses: zero rows updated
    await expect(
      transitionRunStatus("run-1", "queued", "running", {
        dispatch: { attemptId: "attempt-1" },
      }),
    ).rejects.toMatchObject({
      name: "RunTransitionError",
      code: "stale_from_status",
      runId: "run-1",
      from: "queued",
      to: "running",
    });
    // CAS was called once; the terminal-hook delegate was NOT.
    expect(update).toHaveBeenCalledTimes(1);
    expect(expireRunStream).not.toHaveBeenCalled();
  });

  it("fires expireRunStream exactly once for a successful terminal transition", async () => {
    // running→completed is terminal. CAS returns success by default.
    // updateAgentRunStatus (inside store.ts) is the REAL function here —
    // it writes via db.update (also mocked) and calls expireRunStream.
    await transitionRunStatus("run-1", "running", "completed", { stepResults: [{ ok: true }] });
    // CAS + second UPDATE via updateAgentRunStatus = 2 db.update() calls.
    expect(update).toHaveBeenCalledTimes(2);
    expect(expireRunStream).toHaveBeenCalledTimes(1);
    expect(expireRunStream).toHaveBeenCalledWith("run-1");
  });

  it("skips the terminal-hook delegation for non-terminal edges with no meta", async () => {
    await transitionRunStatus("run-1", "pending_input", "queued");
    // Only the CAS UPDATE fires — the terminal-delegation branch is skipped.
    expect(update).toHaveBeenCalledTimes(1);
    expect(expireRunStream).not.toHaveBeenCalled();
  });

  it("delegates to updateAgentRunStatus for non-terminal edges WHEN meta is provided", async () => {
    await transitionRunStatus("run-1", "queued", "pending_input", { error: "compensation" });
    // CAS + second UPDATE (meta patch) = 2 db.update() calls.
    expect(update).toHaveBeenCalledTimes(2);
    // Non-terminal → no expireRunStream fire.
    expect(expireRunStream).not.toHaveBeenCalled();
  });

  // Regression coverage: Assert terminal meta payload is actually forwarded
  // to the second DB update, not just that the count is correct. This catches any
  // regression where meta is silently dropped in the two-write sequence.
  it("persists terminal meta (stepResults) through the second DB write", async () => {
    await transitionRunStatus("run-1", "running", "completed", {
      stepResults: [{ ok: true, step: "final" }],
    });
    // Two set() calls: (1) CAS — only { status }; (2) meta — { status, completedAt, stepResults }.
    expect(shared.setPayloads).toHaveLength(2);
    // stepResults is serialized to JSON by updateAgentRunStatus before writing.
    expect(shared.setPayloads[1]).toMatchObject({
      status: "completed",
      stepResults: JSON.stringify([{ ok: true, step: "final" }]),
    });
    expect(expireRunStream).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// cinatra#1937 (archive S1): every queued→running CAS IS a dispatch and must
// stamp per-dispatch bookkeeping ATOMICALLY with the status flip.
// ---------------------------------------------------------------------------
describe("queued→running dispatch fields (cinatra#1937)", () => {
  it("queued→running WITHOUT dispatch fields throws BEFORE any DB write", async () => {
    await expect(
      transitionRunStatus("run-1", "queued", "running"),
    ).rejects.toThrow(/requires dispatch fields/);
    expect(update).not.toHaveBeenCalled();
  });

  it("queued→running stamps attempt id + DB-clock deadline IN the CAS UPDATE itself", async () => {
    await transitionRunStatus("run-1", "queued", "running", {
      dispatch: { attemptId: "attempt-xyz" },
    });
    // ONE set() call: the CAS — no separate meta write for a non-terminal
    // transition, so atomicity holds by construction.
    expect(shared.setPayloads).toHaveLength(1);
    const cas = shared.setPayloads[0] as Record<string, unknown>;
    expect(cas.status).toBe("running");
    expect(cas.executionAttemptId).toBe("attempt-xyz");
    // The deadline is a raw SQL expression (now() + the row's own
    // COALESCE'd timeout) — presence is the contract; the DB clock does the rest.
    expect(cas.executionDeadlineAt).toBeDefined();
  });

  it("non-dispatch transitions never stamp dispatch fields", async () => {
    await transitionRunStatus("run-1", "running", "completed");
    const cas = shared.setPayloads[0] as Record<string, unknown>;
    expect(cas.executionAttemptId).toBeUndefined();
    expect(cas.executionDeadlineAt).toBeUndefined();
  });

  it("REFUSES dispatch fields on a non-dispatch transition (inverse guard)", async () => {
    await expect(
      transitionRunStatus("run-1", "running", "completed", {
        dispatch: { attemptId: "attempt-misuse" },
      }),
    ).rejects.toThrow(/non-dispatch transition/);
    expect(update).not.toHaveBeenCalled();
  });

  it("strips control keys from the delegated meta write (dispatch never reaches the DB layer)", async () => {
    // startedAt forces the delegated second write (the host content-editor
    // dispatch shape); the payload it receives must carry ONLY DB meta.
    await transitionRunStatus("run-1", "queued", "running", {
      startedAt: new Date("2026-07-21T00:00:00Z"),
      dispatch: { attemptId: "attempt-abc" },
    });
    expect(shared.setPayloads).toHaveLength(2);
    const delegated = shared.setPayloads[1] as Record<string, unknown>;
    expect(delegated.startedAt).toBeInstanceOf(Date);
    expect("dispatch" in delegated).toBe(false);
    expect("humanWaitGate" in delegated).toBe(false);
  });

  it("EVERY queued→running caller in the tree supplies dispatch fields (source scan)", async () => {
    // Codex-adopted guard: an optional param must not quietly produce
    // `running` rows without bookkeeping. The runtime throw above is the hard
    // stop; this scan keeps callers honest at review time. Scans the two
    // roots that host run-dispatch code.
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const repoRoot = resolve(__dirname, "../../../..");
    const roots = [join(repoRoot, "packages/agents/src"), join(repoRoot, "src/lib")];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "__tests__" || name === "node_modules") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const text = readFileSync(p, "utf-8");
        let idx = 0;
        while ((idx = text.indexOf('"queued", "running"', idx)) !== -1) {
          // Only transition CALLS matter (skip comments/enums): require the
          // call prefix on the same line region and `dispatch` in the args.
          const windowText = text.slice(Math.max(0, idx - 200), idx + 300);
          const isCall = /transitionRunStatus\(|updateAgentRunStatusConditional\(/.test(windowText);
          if (isCall && !windowText.includes("dispatch")) {
            offenders.push(p.slice(repoRoot.length + 1));
          }
          idx += 1;
        }
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cinatra#1938 (archive S2): the durable mid-attempt wait marker on
// pending_approval — the one ambiguous wait state (running→ = mid-attempt
// interrupt, queued→ = pre-dispatch setup interrupt). Edge-derived inside the
// CAS with no caller flag: running→pending_approval copies the row's own
// execution_attempt_id in-SQL; queued→pending_approval and every dispatch
// clear it. pending_input gets NO marker: every edge into it (including the
// #1058 human wait, which fires from queued) is pre-dispatch/parked.
// ---------------------------------------------------------------------------

type CasPayload = { humanWaitAttemptId?: unknown; status?: unknown };

describe("mid-attempt wait marker stamping (#1938)", () => {
  it("running\u2192pending_approval (mid-attempt interrupt) stamps the marker from the row's own attempt id", async () => {
    await transitionRunStatus("run-1", "running", "pending_approval");
    const cas = shared.setPayloads[0] as CasPayload;
    // In-SQL copy: a drizzle SQL fragment referencing execution_attempt_id -
    // NOT null, NOT a JS-computed string.
    expect(cas.humanWaitAttemptId).not.toBeNull();
    expect(cas.humanWaitAttemptId).toBeTypeOf("object");
  });

  it("queued\u2192pending_approval (setup interrupt, pre-dispatch) clears the marker", async () => {
    await transitionRunStatus("run-1", "queued", "pending_approval");
    const cas = shared.setPayloads[0] as CasPayload;
    expect(cas).toHaveProperty("humanWaitAttemptId", null);
  });

  it("every dispatch clears the marker atomically with the attempt stamp", async () => {
    await transitionRunStatus("run-1", "queued", "running", {
      dispatch: { attemptId: "att-fresh" },
    });
    const cas = shared.setPayloads[0] as CasPayload;
    expect(cas).toHaveProperty("humanWaitAttemptId", null);
  });

  it("pending_input edges never touch the marker column (parked state, no discriminator)", async () => {
    for (const from of ["queued", "failed"] as const) {
      shared.setPayloads.length = 0;
      shared.returningRows = [[{ id: "run-1" }]];
      await transitionRunStatus("run-1", from, "pending_input", from === "queued" ? { humanWaitGate: true } : undefined);
      const cas = shared.setPayloads[0] as CasPayload;
      expect(Object.prototype.hasOwnProperty.call(cas, "humanWaitAttemptId")).toBe(false);
    }
  });

  it("other transitions leave the marker column untouched", async () => {
    await transitionRunStatus("run-1", "running", "completed");
    const cas = shared.setPayloads[0] as CasPayload;
    expect(Object.prototype.hasOwnProperty.call(cas, "humanWaitAttemptId")).toBe(false);
  });
});
