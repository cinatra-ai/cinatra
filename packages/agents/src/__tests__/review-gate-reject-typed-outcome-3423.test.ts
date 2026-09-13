/**
 * THE REJECT TWIN ANSWERS THE SAME WAY (cinatra#3423).
 *
 * Declining a gate is the other half of deciding it, and it loses the same race.
 * The approve half has crossed the Server Action boundary as a typed, returned
 * outcome since cinatra#3219; the reject half threw the refusal away — the
 * action swallowed its lost compare-and-swap and returned `void`, so no caller
 * could tell a landed decline from a refused one and the review surface had
 * nothing to draw its blocked state from.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/review-gate-reject-typed-outcome-3423.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { GateNotPendingError, RunTransitionError } from "../run-status";

// The string an ordinary Server Action error actually carries on the client in a
// production build — handed to every error below, so a mechanism that reads the
// message cannot pass.
const MASKED =
  "An error occurred in the Server Components render. The specific message is " +
  "omitted in production builds to avoid leaking sensitive details.";

const rejectInternal = vi.fn();
vi.mock("../actions", () => ({
  approveReviewTask: vi.fn(),
  rejectReviewTask: (...args: unknown[]) => rejectInternal(...args),
}));

describe("rejectReviewTask (the Server Action boundary) — data, not silence", () => {
  beforeEach(() => {
    rejectInternal.mockReset();
  });

  it("returns { ok: true } when the decline lands", async () => {
    rejectInternal.mockResolvedValue(undefined);
    const { rejectReviewTask } = await import("../hitl-actions");
    await expect(rejectReviewTask("setup-run-1", "no thanks")).resolves.toEqual({ ok: true });
  });

  it("a decline that lost the race crosses as the blocked outcome (the CAS)", async () => {
    rejectInternal.mockRejectedValue(
      new RunTransitionError({
        code: "stale_from_status",
        runId: "run-1",
        from: "pending_approval",
        to: "failed",
        message: MASKED,
      }),
    );
    const { rejectReviewTask } = await import("../hitl-actions");
    await expect(rejectReviewTask("setup-run-1")).resolves.toEqual({
      ok: false,
      blocked: "no-longer-pending",
    });
  });

  it("a decline of a gate already decided elsewhere crosses the same way", async () => {
    rejectInternal.mockRejectedValue(
      new GateNotPendingError({ runId: "run-1", currentStatus: "running", message: MASKED }),
    );
    const { rejectReviewTask } = await import("../hitl-actions");
    await expect(rejectReviewTask("setup-run-1")).resolves.toEqual({
      ok: false,
      blocked: "no-longer-pending",
    });
  });

  it("still throws every other failure, so nothing is silently swallowed", async () => {
    rejectInternal.mockRejectedValue(new Error("boom"));
    const { rejectReviewTask } = await import("../hitl-actions");
    await expect(rejectReviewTask("setup-run-1")).rejects.toThrow("boom");
  });
});

describe("the reject road no longer drops its lost compare-and-swap", () => {
  const SRC = readFileSync(join(__dirname, "..", "actions.ts"), "utf8");

  it("the setup-path transition is not wrapped in a stale_from_status catch", () => {
    expect(SRC).not.toMatch(
      /transitionRunStatus\(runId, run\.status as AgentRunStatus, "failed", undefined, authority\)\.catch\(/,
    );
    expect(SRC).toMatch(
      /await transitionRunStatus\(runId, run\.status as AgentRunStatus, "failed", undefined, authority\);/,
    );
  });
});
