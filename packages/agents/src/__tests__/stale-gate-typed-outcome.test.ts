/**
 * The stale-gate rejection as a TYPED, serializable outcome (cinatra#3219).
 *
 * A person presses Continue on a step that is waiting for their approval, and
 * in the small window where the run has already moved on the server correctly
 * refuses the stale approval. The run surface draws a ratified blocked state
 * for exactly that case — "This review is no longer open / The gate was
 * already decided or the run moved on." — so the refusal has to REACH the
 * client as something the caller can act on.
 *
 * It used to reach the client as a thrown message the panels pattern-matched.
 * Next.js masks an ordinary Server Action error in production: the client
 * receives a generic framework string plus an opaque digest, never the
 * original text. Every match therefore degraded silently, and on the
 * setup-field path the masked string was rendered verbatim inside the run
 * surface.
 *
 * These are the two deterministic regression cases the issue names, under
 * conditions matching production error delivery — the message the client
 * receives is NOT assumed to be the original thrown text:
 *   (1) the run has already left `pending_approval` by the time the status is
 *       read (the pre-write guard in review-task-actions.ts), and
 *   (2) the status is still `pending_approval` at that read but the CAS loses
 *       the race before the write (resume-run-from-setup-approval.ts).
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/stale-gate-typed-outcome.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { GateNotPendingError, RunTransitionError } from "../run-status";
import { classifyGateRejection } from "../hitl-gate-submit";

// The string an ordinary Server Action error actually carries on the client in
// a production build. Every test below hands this to the error it constructs,
// so a mechanism that reads the message cannot pass.
const MASKED =
  "An error occurred in the Server Components render. The specific message is " +
  "omitted in production builds to avoid leaking sensitive details. A digest " +
  "property is included on this error instance which may provide additional " +
  "details about the nature of the error.";

describe("classifyGateRejection — the typed discriminant, not the message", () => {
  it("regression case 1: the run already left pending_approval at the read", () => {
    const err = new GateNotPendingError({
      runId: "run-1",
      currentStatus: "queued",
      message: MASKED,
    });
    expect(err.code).toBe("gate_not_pending");
    expect(classifyGateRejection(err)).toBe("no-longer-pending");
  });

  it("regression case 2: the CAS loses the race before the write", () => {
    const err = new RunTransitionError({
      code: "stale_from_status",
      runId: "run-1",
      from: "pending_approval",
      to: "queued",
      message: MASKED,
    });
    expect(classifyGateRejection(err)).toBe("no-longer-pending");
  });

  it("classifies every forward-progress AND terminal current status the same way", () => {
    for (const currentStatus of [
      "queued",
      "pending_input",
      "running",
      "completed",
      "failed",
      "stopped",
    ] as const) {
      const err = new GateNotPendingError({
        runId: "run-1",
        currentStatus,
        message: MASKED,
      });
      expect(classifyGateRejection(err)).toBe("no-longer-pending");
    }
  });

  it("never swallows an unrelated failure", () => {
    expect(classifyGateRejection(new Error(MASKED))).toBeNull();
    expect(classifyGateRejection(new Error("Could not continue this run."))).toBeNull();
    expect(
      classifyGateRejection(
        new RunTransitionError({
          code: "illegal_transition",
          runId: "run-1",
          from: "completed",
          to: "queued",
        }),
      ),
    ).toBeNull();
    expect(classifyGateRejection(null)).toBeNull();
    expect(classifyGateRejection(undefined)).toBeNull();
    expect(classifyGateRejection("not pending_approval (current status: queued)")).toBeNull();
  });

  it("classifies from the raw shape alone, so a structured clone still classifies", () => {
    // A typed outcome has to survive being carried as DATA, which is the whole
    // point of returning it rather than throwing it.
    const carried = JSON.parse(
      JSON.stringify({ name: "GateNotPendingError", code: "gate_not_pending" }),
    );
    expect(classifyGateRejection(carried)).toBe("no-longer-pending");
  });
});

// ---------------------------------------------------------------------------
// The Server Action boundary returns the outcome as DATA.
// ---------------------------------------------------------------------------

const approveInternal = vi.fn();
vi.mock("../actions", () => ({
  approveReviewTask: (...args: unknown[]) => approveInternal(...args),
  rejectReviewTask: vi.fn(),
}));

describe("approveReviewTask (the Server Action boundary) — data, not a throw", () => {
  beforeEach(() => {
    approveInternal.mockReset();
  });

  it("returns { ok: true } when the approval lands", async () => {
    approveInternal.mockResolvedValue(undefined);
    const { approveReviewTask } = await import("../hitl-actions");
    await expect(approveReviewTask("setup-run-1", { approved: true })).resolves.toEqual({
      ok: true,
    });
  });

  it("regression case 1 crosses the boundary as a blocked outcome", async () => {
    approveInternal.mockRejectedValue(
      new GateNotPendingError({ runId: "run-1", currentStatus: "queued", message: MASKED }),
    );
    const { approveReviewTask } = await import("../hitl-actions");
    await expect(approveReviewTask("setup-run-1", { approved: true })).resolves.toEqual({
      ok: false,
      blocked: "no-longer-pending",
    });
  });

  it("regression case 2 crosses the boundary as a blocked outcome", async () => {
    approveInternal.mockRejectedValue(
      new RunTransitionError({
        code: "stale_from_status",
        runId: "run-1",
        from: "pending_approval",
        to: "queued",
        message: MASKED,
      }),
    );
    const { approveReviewTask } = await import("../hitl-actions");
    await expect(approveReviewTask("setup-run-1", { approved: true })).resolves.toEqual({
      ok: false,
      blocked: "no-longer-pending",
    });
  });

  it("still throws every other failure, so nothing is silently swallowed", async () => {
    approveInternal.mockRejectedValue(new Error("boom"));
    const { approveReviewTask } = await import("../hitl-actions");
    await expect(approveReviewTask("setup-run-1", { approved: true })).rejects.toThrow("boom");
  });
});

// ---------------------------------------------------------------------------
// Both server throw sites construct the typed class.
// ---------------------------------------------------------------------------

describe("review-task-actions — both guards throw the typed rejection", () => {
  const SRC = readFileSync(join(__dirname, "..", "review-task-actions.ts"), "utf8");

  it("the setup-approval pre-write guard throws GateNotPendingError", () => {
    expect(SRC).toMatch(
      /if \(run\.status !== "pending_approval"\) \{[\s\S]{0,600}?throw new GateNotPendingError\(\{[\s\S]{0,300}?Setup approval rejected/,
    );
  });

  it("the WayFlow pre-write guard throws GateNotPendingError", () => {
    expect(SRC).toMatch(
      /if \(run\.status !== "pending_approval"\) \{[\s\S]{0,600}?throw new GateNotPendingError\(\{[\s\S]{0,300}?WayFlow approval rejected/,
    );
  });

  it("carries the observed status on the error, not only in the message", () => {
    expect(SRC).toMatch(/currentStatus: run\.status/);
  });
});
