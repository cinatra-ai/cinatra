/**
 * The bounded recovery/telemetry predicates for a paused run
 * whose derived HITL context never arrived.
 *
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/hitl-recovery-state.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  classifyHitlDerivation,
  describeHitlInvariantViolation,
  hitlRecoveryReason,
  isHitlRecoveryVisible,
  reduceHitlDerivation,
  HITL_RECOVERY_MIN_ATTEMPTS,
  INITIAL_HITL_DERIVATION_STATE,
  type HitlDerivationState,
} from "../hitl-recovery-state";

const gate = { xRenderer: "x", reviewTaskId: "setup-run-1" };

function fold(...outcomes: Parameters<typeof reduceHitlDerivation>[1][]): HitlDerivationState {
  return outcomes.reduce(reduceHitlDerivation, INITIAL_HITL_DERIVATION_STATE);
}

describe("classifyHitlDerivation", () => {
  it("reports a usable context", () => {
    expect(classifyHitlDerivation("pending_approval", gate)).toEqual({ kind: "context" });
  });

  it("reports a SERVER-SIDE derivation failure when a paused run carries no context", () => {
    const outcome = classifyHitlDerivation("pending_approval", null);
    expect(outcome.kind).toBe("derivation_failed");
  });

  it("treats a run that left the gate as resolved, not failed", () => {
    expect(classifyHitlDerivation("running", null)).toEqual({ kind: "resolved" });
    expect(classifyHitlDerivation(null, null)).toEqual({ kind: "resolved" });
  });
});

describe("reduceHitlDerivation", () => {
  it("counts attempts and consecutive failures", () => {
    const state = fold(
      { kind: "transport_failed", reason: "HTTP 500" },
      { kind: "transport_failed", reason: "HTTP 500" },
    );
    expect(state).toEqual({
      attempts: 2,
      consecutiveFailures: 2,
      lastFailure: { scope: "transport", reason: "HTTP 500" },
    });
  });

  it("resets the failure book-keeping once a context arrives", () => {
    const state = fold(
      { kind: "derivation_failed", reason: "no approval step" },
      { kind: "context" },
    );
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastFailure).toBeNull();
    expect(state.attempts).toBe(2);
  });
});

describe("isHitlRecoveryVisible — the BOUND on the recovery state", () => {
  it("stays hidden during normal hydration (context still null, no failure yet)", () => {
    expect(
      isHitlRecoveryVisible({
        isPendingApproval: true,
        hasContext: false,
        state: fold({ kind: "resolved" }),
      }),
    ).toBe(false);
  });

  it("shows immediately on a server-side derivation failure", () => {
    expect(
      isHitlRecoveryVisible({
        isPendingApproval: true,
        hasContext: false,
        state: fold({ kind: "derivation_failed", reason: "no approval step" }),
      }),
    ).toBe(true);
  });

  it("shows after the bounded number of silent attempts", () => {
    const silent = Array.from({ length: HITL_RECOVERY_MIN_ATTEMPTS }, () => ({
      kind: "resolved" as const,
    }));
    expect(
      isHitlRecoveryVisible({
        isPendingApproval: true,
        hasContext: false,
        state: fold(...silent),
      }),
    ).toBe(true);
  });

  it("never shows while the run has a usable context or is not paused", () => {
    const failed = fold({ kind: "transport_failed", reason: "offline" });
    expect(
      isHitlRecoveryVisible({ isPendingApproval: true, hasContext: true, state: failed }),
    ).toBe(false);
    expect(
      isHitlRecoveryVisible({ isPendingApproval: false, hasContext: false, state: failed }),
    ).toBe(false);
  });
});

describe("describeHitlInvariantViolation — the BOUND on telemetry", () => {
  it("stays silent on normal hydration", () => {
    expect(
      describeHitlInvariantViolation({
        isPendingApproval: true,
        hasContext: false,
        state: INITIAL_HITL_DERIVATION_STATE,
      }),
    ).toBeNull();
  });

  it("reports the scope and reason once the run is degraded", () => {
    const state = fold({ kind: "transport_failed", reason: "the run could not be read" });
    expect(
      describeHitlInvariantViolation({
        isPendingApproval: true,
        hasContext: false,
        state,
      }),
    ).toEqual({
      attempts: 1,
      consecutiveFailures: 1,
      failureScope: "transport",
      reason: "the run could not be read",
    });
  });
});

describe("hitlRecoveryReason", () => {
  it("prefers the observed failure, and explains the silent case otherwise", () => {
    expect(hitlRecoveryReason(fold({ kind: "transport_failed", reason: "offline" }))).toBe(
      "offline",
    );
    expect(hitlRecoveryReason(INITIAL_HITL_DERIVATION_STATE)).toContain("did not load");
  });
});
