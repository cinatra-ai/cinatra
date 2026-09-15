// THE HITL SCREEN'S SUBMIT — the rule, without a database
// (cinatra#2930, lifecycle-b W3).
//
// What is pinned here is what a later slice must not be able to weaken:
//
//   · the ANSWER goes to the shipped approval core, with the VERIFIED ACTOR
//     attached — which is what makes the core run `run.execute` and
//     `run.approveHitl` against the run it resolves. Handing it no actor makes
//     that gate a documented NO-OP, so the actor is asserted, not assumed;
//   · the gate a caller names must be THE GATE THE RUN IS PARKED ON. A
//     credential-declaring surface names a run AND a review task, so the two
//     have to agree or a reader could borrow another run's gate id;
//   · the entry's own binding runs BEFORE the gate is derived and before
//     anything is written;
//   · every refusal is the SAME refusal, so a caller learns nothing about which
//     runs exist;
//   · "already resolved" settles rather than refusing — the question really is
//     answered.

import { beforeEach, describe, expect, it, vi } from "vitest";

const readAgentRunById = vi.fn();
const deriveRunHitlContext = vi.fn();
const approveReviewTaskInternal = vi.fn();

vi.mock("../store", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
}));
vi.mock("../hitl-context", () => ({
  deriveRunHitlContext: (...a: unknown[]) => deriveRunHitlContext(...a),
}));
vi.mock("../review-task-actions", () => ({
  approveReviewTaskInternal: (...a: unknown[]) => approveReviewTaskInternal(...a),
}));

import {
  AGENT_HITL_SUBMIT_REFUSAL,
  submitAgentHitlScreenForActor,
} from "../agent-hitl-screen-submit";

const RUN_ID = "run-2930";
const RUN = { id: RUN_ID, runBy: "user-a", orgId: "org-a", status: "pending_approval" };

/** The gate this run is really parked on, as the shipped derivation answers. */
const CONTEXT = {
  xRenderer: "cinatra.schema-field:output",
  childRunId: null,
  reviewTaskId: "task-2930",
  inputSchema: { type: "object", properties: { answer: { type: "string" } } },
  currentValues: {},
};

const WHO = {
  actor: { userId: "user-a", orgId: "org-a" } as never,
  roleHints: { orgRole: "member" } as never,
};

function call(over?: Record<string, unknown>) {
  return submitAgentHitlScreenForActor({
    runId: RUN_ID,
    reviewTaskId: "task-2930",
    values: { approved: true },
    actorId: "user-a",
    who: WHO,
    ...(over ?? {}),
  } as Parameters<typeof submitAgentHitlScreenForActor>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  readAgentRunById.mockResolvedValue(RUN);
  deriveRunHitlContext.mockResolvedValue(CONTEXT);
  approveReviewTaskInternal.mockResolvedValue(undefined);
});

describe("the answer reaches the shipped core, as this actor", () => {
  it("hands the gate, the values and the VERIFIED ACTOR to approveReviewTaskInternal", async () => {
    const outcome = await call({ values: { approved: true }, fieldName: undefined });
    expect(outcome).toEqual({ ok: true });
    expect(approveReviewTaskInternal).toHaveBeenCalledTimes(1);
    const args = approveReviewTaskInternal.mock.calls[0];
    expect(args[0], "the gate the RUN is on, not the one the caller typed").toBe("task-2930");
    expect(args[1], "the principal the write is grounded on").toBe("user-a");
    expect(args[2]).toEqual({ approved: true });
    // THE ACTOR IS THE POINT. Without arguments 6 and 7 the core's
    // `run.execute` + `run.approveHitl` enforcement is a documented no-op.
    expect(args[5], "no actorContext ⇒ the run-access gate does not run").toBe(WHO.actor);
    expect(args[6]).toBe(WHO.roleHints);
  });

  it("forwards the single-field setup shape exactly as the panel submits it", async () => {
    deriveRunHitlContext.mockResolvedValue({
      ...CONTEXT,
      reviewTaskId: `setup-${RUN_ID}`,
      fieldName: "destination",
    });
    const outcome = await call({
      reviewTaskId: `setup-${RUN_ID}`,
      values: { destination: { city: "Berlin" } },
      fieldName: "destination",
    });
    expect(outcome).toEqual({ ok: true });
    const args = approveReviewTaskInternal.mock.calls[0];
    expect(args[2]).toEqual({ destination: { city: "Berlin" } });
    expect(args[3]).toBe("destination");
  });

  it("a gate answered elsewhere SETTLES rather than refusing", async () => {
    approveReviewTaskInternal.mockRejectedValue(
      new Error("Review task task-2930 already resolved"),
    );
    await expect(call()).resolves.toEqual({ ok: true });
  });
});

describe("the refusals, and they are all the same refusal", () => {
  const REFUSED = { ok: false, error: AGENT_HITL_SUBMIT_REFUSAL };

  it("a run this actor may not read is refused, and nothing is written", async () => {
    readAgentRunById.mockResolvedValue(null);
    await expect(call()).resolves.toEqual(REFUSED);
    expect(approveReviewTaskInternal).not.toHaveBeenCalled();
  });

  it("the ENTRY'S OWN BINDING refuses before the gate is even derived", async () => {
    await expect(call({ bindRun: () => false })).resolves.toEqual(REFUSED);
    expect(deriveRunHitlContext, "the run's moment was observed anyway").not.toHaveBeenCalled();
    expect(approveReviewTaskInternal).not.toHaveBeenCalled();
  });

  it("a gate id that is NOT the run's own gate is refused, and nothing is written", async () => {
    // The defect this closes: a reader whose standing can drive some other run
    // names THAT run's gate id here, against a run id this session does own.
    await expect(call({ reviewTaskId: "task-belonging-to-another-run" })).resolves.toEqual(
      REFUSED,
    );
    expect(approveReviewTaskInternal).not.toHaveBeenCalled();
  });

  it("the FIELD is part of the gate — a setup id cannot be pointed at another input", async () => {
    // A setup-loop run asks its questions one at a time and they ALL carry the
    // same `setup-<runId>` id. Downstream, `fieldName` selects which declared
    // input the answer is merged into — so an id-only binding let a caller who
    // was shown "destination" write "apiKey" instead.
    deriveRunHitlContext.mockResolvedValue({
      ...CONTEXT,
      reviewTaskId: `setup-${RUN_ID}`,
      fieldName: "destination",
    });
    await expect(
      call({
        reviewTaskId: `setup-${RUN_ID}`,
        values: { apiKey: "stolen" },
        fieldName: "apiKey",
      }),
    ).resolves.toEqual(REFUSED);
    expect(approveReviewTaskInternal).not.toHaveBeenCalled();
  });

  it("a gate that names NO field refuses a caller that names one", async () => {
    // A grouped-setup form and a mid-run gate carry no field at all, and the
    // merge treats a named field as "single-field write". Without this, either
    // could be converted into an arbitrary one-input write.
    deriveRunHitlContext.mockResolvedValue({ ...CONTEXT, reviewTaskId: `setup-${RUN_ID}` });
    await expect(
      call({ reviewTaskId: `setup-${RUN_ID}`, values: { apiKey: "x" }, fieldName: "apiKey" }),
    ).resolves.toEqual(REFUSED);
    expect(approveReviewTaskInternal).not.toHaveBeenCalled();
  });

  it("a gate that NAMES a field refuses a caller that names none", async () => {
    deriveRunHitlContext.mockResolvedValue({
      ...CONTEXT,
      reviewTaskId: `setup-${RUN_ID}`,
      fieldName: "destination",
    });
    await expect(
      call({ reviewTaskId: `setup-${RUN_ID}`, values: { destination: "Berlin" } }),
    ).resolves.toEqual(REFUSED);
    expect(approveReviewTaskInternal).not.toHaveBeenCalled();
  });

  it("a run that is not parked at all is refused", async () => {
    deriveRunHitlContext.mockResolvedValue(null);
    await expect(call()).resolves.toEqual(REFUSED);
    expect(approveReviewTaskInternal).not.toHaveBeenCalled();
  });

  it("a MARKED artifact-review gate is not this kind, and is refused here too", async () => {
    const { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } = await import("../agent-builder-ids");
    deriveRunHitlContext.mockResolvedValue({
      ...CONTEXT,
      xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
    });
    await expect(call()).resolves.toEqual(REFUSED);
    expect(approveReviewTaskInternal).not.toHaveBeenCalled();
  });

  it("a core that throws for any other reason refuses uniformly", async () => {
    approveReviewTaskInternal.mockRejectedValue(new Error("Run access denied."));
    await expect(call()).resolves.toEqual(REFUSED);
  });

  it("an empty run id, gate id or principal is refused before any read", async () => {
    for (const over of [{ runId: "" }, { reviewTaskId: "" }, { actorId: "" }]) {
      vi.clearAllMocks();
      readAgentRunById.mockResolvedValue(RUN);
      deriveRunHitlContext.mockResolvedValue(CONTEXT);
      await expect(call(over)).resolves.toEqual(REFUSED);
      expect(readAgentRunById).not.toHaveBeenCalled();
    }
  });
});
