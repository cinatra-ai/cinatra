// The GATE-SCOPED decision entry (cinatra#2566, epic #2564 S2).
//
// The point of this suite is that the endpoint adds NOTHING to the decision. It
// resolves a reader, decodes a server-minted ref, and hands the SAME decision
// helper the review page has always called the same three arguments. Everything
// that makes a review decidable exactly once — the access-before-gate-read
// order, the pinned set read from the frozen gate, the CAS — lives behind that
// helper and is asserted where it lives (`review-gate-ports`, `actions.ts`).
// What is pinned here is the boundary: no client-named gate, no status-code
// oracle, and no shape that could be mistaken for a landed decision.

import { beforeEach, describe, expect, it, vi } from "vitest";

// The ref codec is keyed off the app secret, exactly as S1's suite does.
process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const resolveReviewActorContext = vi.fn();
const submitReviewDecisionAction = vi.fn();
const enforceReviewRunAccess = vi.fn();

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: (...args: unknown[]) => enforceReviewRunAccess(...args),
}));

vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor",
  () => ({
    resolveReviewActorContext: (...args: unknown[]) => resolveReviewActorContext(...args),
  }),
);

vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions",
  () => ({
    submitReviewDecisionAction: (...args: unknown[]) => submitReviewDecisionAction(...args),
  }),
);

import { encodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";

import { POST } from "../route";

const ACTOR = {
  actor: { actorType: "human", userId: "u1", source: "route" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1" },
};

const REF = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!;

function post(body: unknown): Request {
  return new Request("https://app.example/api/lifecycle-views/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveReviewActorContext.mockResolvedValue(ACTOR);
  enforceReviewRunAccess.mockResolvedValue({ ok: true });
  submitReviewDecisionAction.mockResolvedValue({
    kind: "decided",
    disposition: "approve",
    idempotent: false,
  });
});

describe("the decision travels through the ONE existing core", () => {
  it("decodes the ref server-side and calls the SAME helper with run + gate", async () => {
    const res = await POST(post({ ref: REF, disposition: "approve", comment: null }));
    expect(res.status).toBe(200);
    // ONE actor context for both the read check and the decision-op check.
    expect(submitReviewDecisionAction).toHaveBeenCalledWith(
      "run-1",
      "task-1",
      "approve",
      null,
      ACTOR,
      // cinatra#2571 — no suggestion partition on this body.
      null,
      // cinatra#3080 — no picture prompt on this body.
      null,
    );
    await expect(res.json()).resolves.toEqual({
      outcome: { kind: "decided", disposition: "approve", idempotent: false },
    });
  });

  it("returns the helper's outcome verbatim — including a conflict BLOCK", async () => {
    submitReviewDecisionAction.mockResolvedValue({
      kind: "blocked",
      reason: "no-longer-pending",
    });
    const res = await POST(post({ ref: REF, disposition: "regenerate", comment: "again" }));
    await expect(res.json()).resolves.toEqual({
      outcome: { kind: "blocked", reason: "no-longer-pending" },
    });
  });

  it("passes the rationale through unchanged (it is the comment path's substance)", async () => {
    await POST(post({ ref: REF, disposition: "comment", comment: "warmer opening" }));
    expect(submitReviewDecisionAction).toHaveBeenCalledWith(
      "run-1",
      "task-1",
      "comment",
      "warmer opening",
      ACTOR,
      null,
      // cinatra#3080 — no picture prompt on this body.
      null,
    );
  });

  it("is never cached", async () => {
    const res = await POST(post({ ref: REF, disposition: "approve" }));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("a client can never name a gate", () => {
  it("ignores run/gate ids in the body — the schema is strict", async () => {
    const res = await POST(
      post({
        ref: REF,
        disposition: "approve",
        runId: "run-someone-elses",
        reviewTaskId: "task-someone-elses",
      }),
    );
    expect(res.status).toBe(400);
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
  });

  it("a forged / tampered ref is refused WITHOUT reaching the decision core", async () => {
    const res = await POST(post({ ref: "not-one-of-ours", disposition: "approve" }));
    expect(res.status).toBe(200);
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
    const body = (await res.json()) as { outcome: { kind: string } };
    expect(body.outcome.kind).toBe("not-permitted");
  });

  it("a ref minted under a DIFFERENT key does not decode", async () => {
    const original = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "a-completely-different-secret";
    const foreign = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!;
    process.env.BETTER_AUTH_SECRET = original;
    const res = await POST(post({ ref: foreign, disposition: "approve" }));
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
    expect(((await res.json()) as { outcome: { kind: string } }).outcome.kind).toBe(
      "not-permitted",
    );
  });
});

describe("no oracle", () => {
  it("a bad ref and a refused decision are the SAME status and the SAME kind", async () => {
    submitReviewDecisionAction.mockResolvedValue({
      kind: "not-permitted",
      message:
        "You do not have the run access this decision needs — a terminal decision requires the run's decision access, a comment requires respond access.",
    });
    const refused = await POST(post({ ref: REF, disposition: "approve" }));
    const forged = await POST(post({ ref: "nope", disposition: "approve" }));
    expect(forged.status).toBe(refused.status);
    const a = (await refused.json()) as { outcome: { kind: string; message: string } };
    const b = (await forged.json()) as { outcome: { kind: string; message: string } };
    expect(b.outcome).toEqual(a.outcome);
  });

  it("no session is a 401 that does not depend on the ref", async () => {
    resolveReviewActorContext.mockResolvedValue(null);
    const withRef = await POST(post({ ref: REF, disposition: "approve" }));
    const withGarbage = await POST(post({ ref: "nope", disposition: "approve" }));
    expect(withRef.status).toBe(401);
    expect(withGarbage.status).toBe(401);
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
  });

  it("rejects a disposition outside the closed set (no fourth decision)", async () => {
    const res = await POST(post({ ref: REF, disposition: "changes_requested" }));
    expect(res.status).toBe(400);
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // cinatra#3080 — THE FLOOR'S VOCABULARY ON THE WIRE.
  // -------------------------------------------------------------------------
  it("accepts the three floor actions and hands each to the ONE decision entry", async () => {
    for (const action of ["comment", "regenerate", "continue"]) {
      vi.clearAllMocks();
      submitReviewDecisionAction.mockResolvedValue({ kind: "annotated" });
      const res = await POST(post({ ref: REF, disposition: action, comment: "words" }));
      expect(res.status).toBe(200);
      expect(submitReviewDecisionAction.mock.calls[0]?.[2]).toBe(action);
    }
  });

  it("still accepts `approve` — a shipped card that posts it gets Continue", async () => {
    const res = await POST(post({ ref: REF, disposition: "approve" }));
    expect(res.status).toBe(200);
    expect(submitReviewDecisionAction.mock.calls[0]?.[2]).toBe("approve");
  });

  it("does not decide a `reject` at the schema — the ONE entry states the refusal", async () => {
    // The word is still ACCEPTED by the wire so the answer is the platform's
    // sentence rather than a bare 400 an old card would render as a fault. What
    // makes the retirement real is that the entry (and the decision core beneath
    // it) refuses it; this route asserts only that it forwards rather than decides.
    submitReviewDecisionAction.mockResolvedValue({ kind: "error", message: "there is no reject" });
    const res = await POST(post({ ref: REF, disposition: "reject", comment: "no" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: { kind: "error", message: "there is no reject" } });
    expect(submitReviewDecisionAction.mock.calls[0]?.[2]).toBe("reject");
  });

  it("forwards a picture prompt as its own argument, never folded into the comment", async () => {
    await POST(
      post({
        ref: REF,
        disposition: "regenerate",
        comment: "warmer light",
        regeneratePrompt: "a red bicycle at golden hour",
      }),
    );
    const call = submitReviewDecisionAction.mock.calls[0];
    expect(call?.[3]).toBe("warmer light");
    expect(call?.[6]).toBe("a red bicycle at golden hour");
  });
});

describe("run READ is enforced before the decision op (Codex round 1, finding 1)", () => {
  it("a reader who may not READ the run cannot decide it, even holding a valid ref", async () => {
    // The shared helper checks the DECISION axis only, because on the review page
    // the caller had already cleared run READ by loading the surface. A card has
    // no preceding page load, and the ops are separate policy axes.
    enforceReviewRunAccess.mockResolvedValue({ ok: false });
    const res = await POST(post({ ref: REF, disposition: "approve" }));
    expect(res.status).toBe(200);
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
    expect(((await res.json()) as { outcome: { kind: string } }).outcome.kind).toBe(
      "not-permitted",
    );
  });

  it("the read check runs for the SAME actor, on the run the ref decodes to", async () => {
    await POST(post({ ref: REF, disposition: "comment", comment: "note" }));
    expect(enforceReviewRunAccess).toHaveBeenCalledWith(
      "run-1",
      ACTOR.actor,
      "read",
      ACTOR.roleHints,
    );
  });

  it("a read check that THROWS denies — never falls through open", async () => {
    enforceReviewRunAccess.mockRejectedValue(new Error("store down"));
    const res = await POST(post({ ref: REF, disposition: "approve" }));
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
    expect(((await res.json()) as { outcome: { kind: string } }).outcome.kind).toBe(
      "not-permitted",
    );
  });

  it("a read denial is byte-identical to a forged-ref refusal", async () => {
    enforceReviewRunAccess.mockResolvedValue({ ok: false });
    const denied = await POST(post({ ref: REF, disposition: "approve" }));
    const forged = await POST(post({ ref: "nope", disposition: "approve" }));
    expect(denied.status).toBe(forged.status);
    expect(await denied.json()).toEqual(await forged.json());
  });
});

// ---------------------------------------------------------------------------
// cinatra#2571 (epic #2564 S6b) — the suggestion partition rides this body.
// ---------------------------------------------------------------------------

describe("the suggestion partition", () => {
  it("is forwarded to the ONE decision helper, verbatim", async () => {
    await POST(
      post({
        ref: REF,
        disposition: "approve",
        suggestionDecisions: { accepted: ["sug_1"], dismissed: ["sug_2"] },
      }),
    );
    expect(submitReviewDecisionAction).toHaveBeenCalledWith(
      "run-1",
      "task-1",
      "approve",
      null,
      ACTOR,
      { accepted: ["sug_1"], dismissed: ["sug_2"] },
      // cinatra#3080 — no picture prompt on this body.
      null,
    );
  });

  it("a half-specified partition is normalized to two lists, not rejected", async () => {
    await POST(post({ ref: REF, disposition: "approve", suggestionDecisions: { accepted: ["sug_1"] } }));
    expect(submitReviewDecisionAction).toHaveBeenCalledWith(
      "run-1",
      "task-1",
      "approve",
      null,
      ACTOR,
      { accepted: ["sug_1"], dismissed: [] },
      // cinatra#3080 — no picture prompt on this body.
      null,
    );
  });

  it("this route decides NOTHING about which ids are real — it never reads a store", async () => {
    // A forged id is forwarded; the decision core refuses it against the pinned
    // snapshot. A route that pre-filtered would be a second place that knows.
    await POST(
      post({ ref: REF, disposition: "approve", suggestionDecisions: { accepted: ["sug_forged"] } }),
    );
    expect(submitReviewDecisionAction).toHaveBeenCalledWith(
      "run-1",
      "task-1",
      "approve",
      null,
      ACTOR,
      { accepted: ["sug_forged"], dismissed: [] },
      // cinatra#3080 — no picture prompt on this body.
      null,
    );
  });

  it("rejects an over-long id list at 400, before any decision is attempted", async () => {
    const res = await POST(
      post({
        ref: REF,
        disposition: "approve",
        suggestionDecisions: { accepted: Array.from({ length: 51 }, (_, i) => `sug_${i}`) },
      }),
    );
    expect(res.status).toBe(400);
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
  });

  it("rejects an unknown key inside the partition (strict shape)", async () => {
    const res = await POST(
      post({
        ref: REF,
        disposition: "approve",
        suggestionDecisions: { accepted: ["sug_1"], applied: ["sug_2"] },
      }),
    );
    expect(res.status).toBe(400);
    expect(submitReviewDecisionAction).not.toHaveBeenCalled();
  });

  it("an absent partition forwards null (an old client is unchanged)", async () => {
    await POST(post({ ref: REF, disposition: "approve" }));
    expect(submitReviewDecisionAction).toHaveBeenCalledWith(
      "run-1",
      "task-1",
      "approve",
      null,
      ACTOR,
      null,
      // cinatra#3080 — no picture prompt on this body.
      null,
    );
  });
});
