// The authoritative-refetch contract (cinatra#2565, epic #2564 S1).
// Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` v0.1.0 §IV.
//
// Every assertion here is about what a reader may LEARN, not only what they
// see: the order of the checks, the collapse of every denial into `absent`, and
// the refusal of a ref to act as a capability.

import { beforeEach, describe, expect, it, vi } from "vitest";

// The ref codec is keyed off the app secret (the same key source the chat /
// agent-run MCP actor tokens use), so the suite pins one.
process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const enforceReviewRunAccess = vi.fn();
const readReviewGateState = vi.fn();
const readReviewGate = vi.fn();
const readVerificationRecordForGate = vi.fn();

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: (...args: unknown[]) => enforceReviewRunAccess(...args),
  readReviewGateState: (...args: unknown[]) => readReviewGateState(...args),
  readReviewGate: (...args: unknown[]) => readReviewGate(...args),
}));

vi.mock("@cinatra-ai/agents/lifecycle-verification-store", () => ({
  readVerificationRecordForGate: (...args: unknown[]) =>
    readVerificationRecordForGate(...args),
}));

import {
  LIFECYCLE_RESTRICTED_REASON,
  decodeLifecycleGateRef,
  encodeLifecycleGateRef,
  resolveLifecycleCardState,
} from "../lifecycle-card-refetch";

const actorCtx = {
  actor: { actorType: "human", userId: "u1", source: "route" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1" },
} as never;

const REF = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!;

/** Grant/deny a specific run-access op; every other op denies. */
function accessFor(granted: string[]) {
  enforceReviewRunAccess.mockImplementation(async (_runId, _actor, op) => ({
    ok: granted.includes(op as string),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the ref codec", () => {
  it("round-trips a gate ref", () => {
    expect(decodeLifecycleGateRef(REF)).toEqual({
      runId: "run-1",
      reviewTaskId: "task-1",
    });
  });

  it("is OPAQUE — the encoded ref reveals neither id", () => {
    expect(REF).not.toContain("run-1");
    expect(REF).not.toContain("task-1");
    // And not merely encoded: decoding the bytes as text/base64 yields nothing.
    expect(Buffer.from(REF, "base64url").toString("utf8")).not.toContain("run-1");
  });

  it("is TAMPER-EVIDENT — a flipped byte decodes to nothing", () => {
    const bytes = Buffer.from(REF, "base64url");
    bytes[bytes.length - (16 + 1)] ^= 0xff; // corrupt the ciphertext body
    expect(decodeLifecycleGateRef(bytes.toString("base64url"))).toBeNull();
  });

  it("mints two DIFFERENT refs for the same row (no equality oracle)", () => {
    const a = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" });
    const b = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" });
    expect(a).not.toBe(b);
  });

  it("refuses ids that would not fit the wire bound", () => {
    expect(
      encodeLifecycleGateRef({ runId: "r".repeat(200), reviewTaskId: "t" }),
    ).toBeNull();
    expect(encodeLifecycleGateRef({ runId: "", reviewTaskId: "t" })).toBeNull();
  });

  it("decodes nothing from junk (never throws)", () => {
    for (const junk of ["", "!!!!", "Zm9v", "a".repeat(600), "eyJ4Ijoxf"]) {
      expect(() => decodeLifecycleGateRef(junk)).not.toThrow();
    }
    expect(decodeLifecycleGateRef("!!!!")).toBeNull();
  });

  it("an encoded ref stays inside the wire ref bound", () => {
    expect(REF.length).toBeLessThanOrEqual(512);
  });
});

describe("artifact_review_gate — the state ladder (§IV)", () => {
  it("`absent` when the reader has no run READ access — and the gate is never read", async () => {
    accessFor([]);
    const state = await resolveLifecycleCardState({
      viewType: "artifact_review_gate",
      ref: REF,
      actorCtx,
    });
    expect(state).toEqual({ state: "absent" });
    // Order is the security property: gate existence is not consulted before
    // the reader is authorized to know about the run at all.
    expect(readReviewGateState).not.toHaveBeenCalled();
  });

  it("`pending` when the gate is open and the reader may decide", async () => {
    accessFor(["read", "approveHitl", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "pending", targets: [] });
    expect(
      await resolveLifecycleCardState({
        viewType: "artifact_review_gate",
        ref: REF,
        actorCtx,
      }),
    ).toEqual({ state: "pending", canDecide: true, canComment: true });
  });

  it("`restricted` — may view and comment, may not decide — with a non-enumerating reason", async () => {
    accessFor(["read", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "pending", targets: [] });
    const state = await resolveLifecycleCardState({
      viewType: "artifact_review_gate",
      ref: REF,
      actorCtx,
    });
    expect(state).toEqual({
      state: "restricted",
      canDecide: false,
      canComment: true,
      reason: LIFECYCLE_RESTRICTED_REASON,
    });
    // The reason describes the READER's standing and names nothing about the item.
    expect(LIFECYCLE_RESTRICTED_REASON).not.toMatch(/run-1|task-1|\d/);
  });

  it("`settled` for a resolved gate — the reload case (a decided gate renders resolved)", async () => {
    accessFor(["read", "approveHitl", "respondToHitl"]);
    readReviewGateState.mockResolvedValue({ status: "resolved", fingerprint: "fp" });
    expect(
      await resolveLifecycleCardState({
        viewType: "artifact_review_gate",
        ref: REF,
        actorCtx,
      }),
    ).toEqual({ state: "settled" });
  });

  it("`absent` for an unavailable gate — a replayed ref draws no DOM for nothing", async () => {
    accessFor(["read"]);
    readReviewGateState.mockResolvedValue({ status: "unavailable" });
    expect(
      await resolveLifecycleCardState({
        viewType: "artifact_review_gate",
        ref: REF,
        actorCtx,
      }),
    ).toEqual({ state: "absent" });
  });

  it("`absent` for a ref that does not decode — a forged ref buys nothing", async () => {
    accessFor(["read", "approveHitl"]);
    expect(
      await resolveLifecycleCardState({
        viewType: "artifact_review_gate",
        ref: "not-a-ref!!",
        actorCtx,
      }),
    ).toEqual({ state: "absent" });
    expect(enforceReviewRunAccess).not.toHaveBeenCalled();
  });

  it("`absent` when the store throws — a failure is not an existence signal", async () => {
    accessFor(["read"]);
    readReviewGateState.mockRejectedValue(new Error("db down"));
    expect(
      await resolveLifecycleCardState({
        viewType: "artifact_review_gate",
        ref: REF,
        actorCtx,
      }),
    ).toEqual({ state: "absent" });
  });
});

describe("verification_summary — advisory, no floor (§VII)", () => {
  it("`advisory` when the reader may read the run and a record exists", async () => {
    accessFor(["read"]);
    readReviewGate.mockResolvedValue({ id: "gate-row-1" });
    readVerificationRecordForGate.mockResolvedValue({ id: "vr-1", outcome: "verified" });
    expect(
      await resolveLifecycleCardState({
        viewType: "verification_summary",
        ref: REF,
        actorCtx,
      }),
    ).toEqual({ state: "advisory" });
  });

  it("`absent` without run read access — and the record is never read", async () => {
    accessFor([]);
    expect(
      await resolveLifecycleCardState({
        viewType: "verification_summary",
        ref: REF,
        actorCtx,
      }),
    ).toEqual({ state: "absent" });
    expect(readVerificationRecordForGate).not.toHaveBeenCalled();
  });

  it("`absent` when no record exists", async () => {
    accessFor(["read"]);
    readReviewGate.mockResolvedValue({ id: "gate-row-1" });
    readVerificationRecordForGate.mockResolvedValue(null);
    expect(
      await resolveLifecycleCardState({
        viewType: "verification_summary",
        ref: REF,
        actorCtx,
      }),
    ).toEqual({ state: "absent" });
  });
});

describe("trigger_schedule_proposal — no producer until S5", () => {
  it("`absent`, so no floor is ever drawn without a proposal behind it", async () => {
    accessFor(["read", "approveHitl"]);
    expect(
      await resolveLifecycleCardState({
        viewType: "trigger_schedule_proposal",
        ref: REF,
        actorCtx,
      }),
    ).toEqual({ state: "absent" });
  });
});
