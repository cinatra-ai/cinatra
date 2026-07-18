/**
 * Publication-operation state-machine tests (cinatra#1450) — the PURE core, run
 * always in CI (no Postgres). These prove the ledger's invariants at the guard
 * level; the DB layer mirrors each guard into a conditional UPDATE and is
 * exercised by publication-ledger.integration.test.ts against real constraints.
 *
 * Coverage maps to the issue's acceptance criteria:
 *   - state machine (every legal transition + every refusal);
 *   - schedule→cancel→edit race (a stale-generation claim is fenced);
 *   - idempotent retry / no double-publish (stable key; a re-claim / re-succeed
 *     is refused);
 *   - publish-failure leaves the artifact LOCKED (fail emits no unlock effect).
 */
import { describe, expect, it } from "vitest";

import {
  deriveIdempotencyKey,
  evaluateTransition,
  scheduleStatusEffect,
  PUBLICATION_OPERATION_STATES,
  TERMINAL_PUBLICATION_STATES,
  type PublicationCommand,
  type PublicationExternalIdentity,
  type PublicationOperationSnapshot,
  type PublicationOperationState,
} from "../publication-operation-state";

const DEST = { connector: "@cinatra-ai/linkedin-connector", account: "acct-1", ref: null };

function snap(over: Partial<PublicationOperationSnapshot> = {}): PublicationOperationSnapshot {
  return {
    state: "pending",
    cancellationGeneration: 0,
    attempt: 0,
    dueAtMs: 1_000,
    startedAtMs: null,
    ...over,
  };
}

const identity: PublicationExternalIdentity = {
  orgId: "org-1",
  artifactId: "art-1",
  pinnedRepresentationRevisionId: "rep-rev-1",
  destination: DEST,
};

// ---------------------------------------------------------------------------
// idempotency key derivation
// ---------------------------------------------------------------------------

describe("deriveIdempotencyKey", () => {
  it("is stable for the same external identity (retry reuses the key)", () => {
    expect(deriveIdempotencyKey(identity)).toBe(deriveIdempotencyKey({ ...identity }));
  });

  it("carries the pubop_ prefix and is deterministic", () => {
    const key = deriveIdempotencyKey(identity);
    expect(key).toMatch(/^pubop_[0-9a-f]{40}$/);
  });

  it("changes when the pinned revision changes (an edit ⇒ a new external effect)", () => {
    const other = { ...identity, pinnedRepresentationRevisionId: "rep-rev-2" };
    expect(deriveIdempotencyKey(other)).not.toBe(deriveIdempotencyKey(identity));
  });

  it("changes when the destination changes", () => {
    const acct = { ...identity, destination: { ...DEST, account: "acct-2" } };
    const ref = { ...identity, destination: { ...DEST, ref: "page-9" } };
    const conn = { ...identity, destination: { ...DEST, connector: "@cinatra-ai/x-connector" } };
    const base = deriveIdempotencyKey(identity);
    expect(deriveIdempotencyKey(acct)).not.toBe(base);
    expect(deriveIdempotencyKey(ref)).not.toBe(base);
    expect(deriveIdempotencyKey(conn)).not.toBe(base);
  });

  it("does not collide across distinct account/ref boundaries (null vs value)", () => {
    const nullRef = deriveIdempotencyKey({ ...identity, destination: { ...DEST, ref: null } });
    const emptyRef = deriveIdempotencyKey({ ...identity, destination: { ...DEST, ref: "" } });
    expect(nullRef).not.toBe(emptyRef);
  });
});

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

describe("state constants", () => {
  it("enumerates the five states", () => {
    expect([...PUBLICATION_OPERATION_STATES]).toEqual([
      "pending",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ]);
  });
  it("marks succeeded and cancelled terminal (not failed — failed is retryable)", () => {
    expect(TERMINAL_PUBLICATION_STATES.has("succeeded")).toBe(true);
    expect(TERMINAL_PUBLICATION_STATES.has("cancelled")).toBe(true);
    expect(TERMINAL_PUBLICATION_STATES.has("failed")).toBe(false);
  });
  it("scheduling always locks the artifact", () => {
    expect(scheduleStatusEffect()).toBe("lock");
  });
});

// ---------------------------------------------------------------------------
// claim (pending → running) — the delivery fence
// ---------------------------------------------------------------------------

describe("evaluateTransition — claim", () => {
  const claim = (gen: number, nowMs: number): PublicationCommand => ({
    kind: "claim",
    expectedGeneration: gen,
    nowMs,
  });

  it("claims a due pending op at the matching generation → running, bumps attempt, no status effect", () => {
    const r = evaluateTransition(snap({ state: "pending", dueAtMs: 1_000 }), claim(0, 2_000));
    expect(r).toEqual({
      ok: true,
      nextState: "running",
      bumpAttempt: true,
      bumpGeneration: false,
      statusEffect: "none",
    });
  });

  it("refuses when not yet due", () => {
    const r = evaluateTransition(snap({ dueAtMs: 5_000 }), claim(0, 2_000));
    expect(r.ok).toBe(false);
  });

  it("FENCE: refuses a stale generation (cancel/reschedule advanced it)", () => {
    const r = evaluateTransition(snap({ cancellationGeneration: 1 }), claim(0, 9_000));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/fenced/);
  });

  it.each(["running", "succeeded", "failed", "cancelled"] as PublicationOperationState[])(
    "refuses to claim a %s op",
    (state) => {
      expect(evaluateTransition(snap({ state }), claim(0, 9_000)).ok).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// succeed / fail (running → …)
// ---------------------------------------------------------------------------

describe("evaluateTransition — succeed", () => {
  it("running at matching generation → succeeded + publish effect", () => {
    const r = evaluateTransition(snap({ state: "running" }), { kind: "succeed", expectedGeneration: 0 });
    expect(r).toMatchObject({ ok: true, nextState: "succeeded", statusEffect: "publish" });
  });
  it("FENCE: refuses a stale generation (a fenced effect never marks published)", () => {
    const r = evaluateTransition(
      snap({ state: "running", cancellationGeneration: 2 }),
      { kind: "succeed", expectedGeneration: 0 },
    );
    expect(r.ok).toBe(false);
  });
  it("refuses when not running (no re-succeed of a terminal op → no double-publish)", () => {
    for (const state of ["pending", "succeeded", "failed", "cancelled"] as PublicationOperationState[]) {
      expect(evaluateTransition(snap({ state }), { kind: "succeed", expectedGeneration: 0 }).ok).toBe(false);
    }
  });
});

describe("evaluateTransition — fail", () => {
  it("running at matching generation → failed with NO status effect (artifact stays LOCKED)", () => {
    const r = evaluateTransition(snap({ state: "running" }), { kind: "fail", expectedGeneration: 0 });
    expect(r).toMatchObject({ ok: true, nextState: "failed", statusEffect: "none" });
  });
  it("FENCE: refuses a stale generation", () => {
    const r = evaluateTransition(
      snap({ state: "running", cancellationGeneration: 3 }),
      { kind: "fail", expectedGeneration: 0 },
    );
    expect(r.ok).toBe(false);
  });
  it("refuses when not running", () => {
    expect(evaluateTransition(snap({ state: "pending" }), { kind: "fail", expectedGeneration: 0 }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cancel (pending | failed → cancelled)
// ---------------------------------------------------------------------------

describe("evaluateTransition — cancel", () => {
  it("cancels a pending op → cancelled, bumps generation, unlocks the artifact", () => {
    const r = evaluateTransition(snap({ state: "pending" }), { kind: "cancel" });
    expect(r).toEqual({
      ok: true,
      nextState: "cancelled",
      bumpAttempt: false,
      bumpGeneration: true,
      statusEffect: "unlock",
    });
  });
  it("abandons a failed op → cancelled + unlock (recover a failed publish for editing)", () => {
    const r = evaluateTransition(snap({ state: "failed", attempt: 2 }), { kind: "cancel" });
    expect(r).toMatchObject({ ok: true, nextState: "cancelled", statusEffect: "unlock" });
  });
  it.each(["running", "succeeded", "cancelled"] as PublicationOperationState[])(
    "refuses to cancel a %s op (running reconciles; succeeded/cancelled are terminal)",
    (state) => {
      expect(evaluateTransition(snap({ state }), { kind: "cancel" }).ok).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// retry (failed → pending)
// ---------------------------------------------------------------------------

describe("evaluateTransition — retry", () => {
  it("re-arms a failed op under the attempt cap → pending, generation unchanged, no status effect", () => {
    const r = evaluateTransition(snap({ state: "failed", attempt: 1 }), { kind: "retry", maxAttempts: 5 });
    expect(r).toEqual({
      ok: true,
      nextState: "pending",
      bumpAttempt: false,
      bumpGeneration: false,
      statusEffect: "none",
    });
  });
  it("refuses once attempts are exhausted", () => {
    expect(
      evaluateTransition(snap({ state: "failed", attempt: 5 }), { kind: "retry", maxAttempts: 5 }).ok,
    ).toBe(false);
  });
  it("refuses when not failed", () => {
    expect(evaluateTransition(snap({ state: "pending" }), { kind: "retry", maxAttempts: 5 }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconcileTimeout (running → pending | failed)
// ---------------------------------------------------------------------------

describe("evaluateTransition — reconcileTimeout", () => {
  const cmd = (nowMs: number, leaseMs: number, maxAttempts: number): PublicationCommand => ({
    kind: "reconcileTimeout",
    nowMs,
    leaseMs,
    maxAttempts,
  });

  it("re-arms a timed-out running op with attempts remaining → pending", () => {
    const r = evaluateTransition(
      snap({ state: "running", startedAtMs: 0, attempt: 1 }),
      cmd(10_000, 5_000, 5),
    );
    expect(r).toMatchObject({ ok: true, nextState: "pending", statusEffect: "none" });
  });
  it("fails a timed-out running op with attempts exhausted → failed (stays locked)", () => {
    const r = evaluateTransition(
      snap({ state: "running", startedAtMs: 0, attempt: 5 }),
      cmd(10_000, 5_000, 5),
    );
    expect(r).toMatchObject({ ok: true, nextState: "failed", statusEffect: "none" });
  });
  it("refuses when the lease has not elapsed", () => {
    expect(
      evaluateTransition(snap({ state: "running", startedAtMs: 8_000 }), cmd(10_000, 5_000, 5)).ok,
    ).toBe(false);
  });
  it("refuses a running op that never started (no startedAtMs)", () => {
    expect(
      evaluateTransition(snap({ state: "running", startedAtMs: null }), cmd(10_000, 5_000, 5)).ok,
    ).toBe(false);
  });
  it("refuses when not running", () => {
    expect(evaluateTransition(snap({ state: "pending" }), cmd(10_000, 5_000, 5)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC scenarios narrated at the guard level
// ---------------------------------------------------------------------------

describe("AC: schedule → cancel → edit race — a stale job cannot publish an unpinned revision", () => {
  it("a delivery claim carrying the pre-cancel generation is fenced after cancel", () => {
    // schedule: op is pending at generation 0; a delivery job is dispatched for (op, gen 0).
    const scheduled = snap({ state: "pending", cancellationGeneration: 0, dueAtMs: 0 });
    expect(evaluateTransition(scheduled, { kind: "claim", expectedGeneration: 0, nowMs: 1 }).ok).toBe(true);

    // cancel: the op leaves pending and the generation advances.
    const cancel = evaluateTransition(scheduled, { kind: "cancel" });
    expect(cancel).toMatchObject({ ok: true, nextState: "cancelled", bumpGeneration: true });

    // The stale job wakes and tries to claim (op, gen 0). Both fences hold:
    //   (a) state is no longer pending, and
    //   (b) even a same-row reschedule would sit at generation 1.
    const afterCancel = snap({ state: "cancelled", cancellationGeneration: 1 });
    expect(evaluateTransition(afterCancel, { kind: "claim", expectedGeneration: 0, nowMs: 9 }).ok).toBe(false);
    const rescheduledSameRow = snap({ state: "pending", cancellationGeneration: 1, dueAtMs: 0 });
    expect(
      evaluateTransition(rescheduledSameRow, { kind: "claim", expectedGeneration: 0, nowMs: 9 }).ok,
    ).toBe(false);
  });
});

describe("AC: idempotent retry / no double-publish", () => {
  it("a running op cannot be re-claimed by a second worker", () => {
    const running = snap({ state: "running" });
    expect(evaluateTransition(running, { kind: "claim", expectedGeneration: 0, nowMs: 9 }).ok).toBe(false);
  });
  it("a succeeded op refuses a second success", () => {
    const succeeded = snap({ state: "succeeded" });
    expect(evaluateTransition(succeeded, { kind: "succeed", expectedGeneration: 0 }).ok).toBe(false);
  });
  it("a retry reuses the same idempotency key (generation is not part of the key)", () => {
    // The intent identity is unchanged across a retry, so the connector receives
    // the same key and dedupes — the state module never folds generation in.
    const key1 = deriveIdempotencyKey(identity);
    const key2 = deriveIdempotencyKey(identity);
    expect(key1).toBe(key2);
  });
});

describe("AC: publish-failure leaves the artifact locked", () => {
  it("fail emits no unlock; only an explicit cancel unlocks", () => {
    const failed = evaluateTransition(snap({ state: "running" }), { kind: "fail", expectedGeneration: 0 });
    expect(failed).toMatchObject({ ok: true, statusEffect: "none" });
    // The artifact is unlocked only by a deliberate cancel of the failed op.
    const unlock = evaluateTransition(snap({ state: "failed" }), { kind: "cancel" });
    expect(unlock).toMatchObject({ ok: true, statusEffect: "unlock" });
  });
});
