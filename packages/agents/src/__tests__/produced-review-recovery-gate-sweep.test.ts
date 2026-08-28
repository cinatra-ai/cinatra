import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * cinatra#3007 — the review-gate delivery sweep is a DIRECT resume caller: it
 * drives the same terminal handler the execution worker drives, and it owns no
 * job it could re-deliver. So when the hold cannot be recorded, the terminal
 * write still owed must already be on its own delivery by the time the sentinel
 * reaches this caller — otherwise the run sits non-terminal with nothing able to
 * land its verdict.
 *
 * The proof: raise an unrecordable hold inside the delivery, then read the
 * delivery back off the queue and let a later convergence pass land it.
 */

import { buildReviewApproveEnvelope } from "@/lib/artifacts/artifact-review-rejection";

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  setAgentRunTokenHash: vi.fn(async () => {}),
  readAgentTemplateById: vi.fn(),
  readAgentTemplates: vi.fn(async () => []),
  readAgentTemplateVersionBySemver: vi.fn(async () => null),
  readAgentTemplateVersionById: vi.fn(async () => null),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(args: { code: string }) {
      super(args.code);
      this.code = args.code;
    }
  },
  findSavedConnectionForAgentUrl: vi.fn(async () => null),
  updateAgentRunA2ATaskId: vi.fn(async () => undefined),
  updateAgentRunA2AContextId: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);

const holdSpy = vi.hoisted(() =>
  vi.fn(async () => ({ held: true, reason: "hold-unpersisted" }) as {
    held: boolean;
    reason: string;
  }),
);
vi.mock("../run-produced-review-hold", () => ({
  holdRunForProducedReview: holdSpy,
  releaseHeldRun: vi.fn(async () => ({ released: false, reason: "not-parked" })),
  readGateRunOwner: vi.fn(async () => null),
  listReleasableHeldRuns: vi.fn(async () => []),
}));

const enqueueSpy = vi.hoisted(() => vi.fn(async () => "queued"));
vi.mock("@/lib/background-jobs", () => ({ enqueueBackgroundJob: enqueueSpy }));

const { publishAgUiEventSpy, materializeSpy } = vi.hoisted(() => ({
  publishAgUiEventSpy: vi.fn(async () => undefined),
  materializeSpy: vi.fn(async () => [] as Array<Record<string, unknown>>),
}));
vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    publishAgUiEvent: publishAgUiEventSpy,
    readLatestAgUiInterrupt: vi.fn(async () => null),
    enrichSchemaWithResolvedData: vi.fn(async (schema: unknown) => ({ ...(schema as object) })),
    DualAdapterDispatch: class {
      onInterrupt = vi.fn();
      onText = vi.fn();
      onTextChunk = vi.fn();
      onToolCall = vi.fn();
      onState = vi.fn();
      onError = vi.fn();
      onFinish = vi.fn();
      onResume = vi.fn();
    },
  };
});
vi.mock("@/lib/artifacts/run-artifact-materializer", () => ({
  materializeRunArtifacts: materializeSpy,
}));
vi.mock("../skill-autosave", () => ({
  runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined),
}));
vi.mock("../trigger-gate", () => ({ isTriggerReleased: vi.fn(async () => true) }));
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_A2A_TIMEOUT_MS: 86_400_000,
  createWayflowFetch: vi.fn(() => globalThis.fetch),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));
vi.mock("../wayflow-run-token-carrier", () => ({
  mintResumeRunTokenMetadata: vi.fn(async () => ({})),
}));

const gateStoreMock = vi.hoisted(() => ({
  claimPendingResumeIntents: vi.fn(async () => []),
  markResumeIntentDelivered: vi.fn(async () => true),
}));
vi.mock("../artifact-review-gate-store", () => gateStoreMock);

const sendTaskSpy = vi.hoisted(() => vi.fn(async (_req: unknown) => ({}) as unknown));
vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    createExternalA2AClient: vi.fn(async () => ({ sendTask: sendTaskSpy })),
    resolveRunIdByWayflowTaskId: vi.fn(async () => null),
    resolveLatestWayflowGateTaskId: vi.fn(async () => "task-1"),
    rememberLatestWayflowGateTask: vi.fn(async () => undefined),
    rememberWayflowGateTask: vi.fn(async () => undefined),
    rememberAnsweredGateSubmission: vi.fn(async () => undefined),
    getOrAddWayflowRendererGateIndex: vi.fn(async () => 0),
  };
});

import { deliverArtifactReviewResumeIntent } from "../artifact-review-resume-delivery";
import type { ResumeIntentRow } from "../artifact-review-gate-store";
import {
  recoverProducedReviewHold,
  runAgentBuilderExecutionJob,
  ProducedReviewHoldUnpersistedError,
  PRODUCED_REVIEW_RECOVERY_PAYLOAD_MAX_BYTES,
  PRODUCED_REVIEW_HOLD_RETRY_DELAY_MS,
  producedReviewRecoveryJobId,
  MAX_PRODUCED_REVIEW_HOLD_PARKS,
  CINATRA_ENDNODE_OUTPUTS_SENTINEL,
} from "../execution";

const AUTHORITY = { orgId: "org-1", can: () => true };

function pausedRun() {
  return {
    id: "run-1",
    templateId: "tmpl-1",
    status: "pending_approval",
    a2aTaskId: "task-1",
    a2aContextId: "ctx-1",
    orgId: "org-1",
    runBy: "user-a",
    packageVersion: "1.0.0",
    inputParams: {},
    createdAt: new Date("2026-01-01"),
  };
}

function completedTask() {
  return {
    id: "task-1",
    contextId: "ctx-1",
    status: { state: "completed", message: { parts: [] } },
    metadata: {},
    history: [
      { role: "agent", parts: [{ kind: "text", text: "here is the draft" }] },
      {
        role: "agent",
        parts: [
          {
            kind: "data",
            data: { [CINATRA_ENDNODE_OUTPUTS_SENTINEL]: { title: "T", content: "C" } },
          },
        ],
      },
    ],
  };
}

function intent(): ResumeIntentRow {
  return {
    gateId: "gate-1",
    runId: "run-1",
    reviewTaskId: "wayflow-task-1",
    kind: "approve",
    responseText: JSON.stringify(
      buildReviewApproveEnvelope({ reviewTaskId: "wayflow-task-1", comment: null, targets: [] }),
    ),
    status: "delivering",
    attempts: 1,
    leaseToken: "lease-abc",
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };
}

/** The delivery this caller's unrecordable hold put on the queue. */
function deliveredRecovery() {
  const call = enqueueSpy.mock.calls.find(
    (c) => (c as unknown[])[0] === "agent-builder-execution",
  ) as unknown as [string, Record<string, unknown>, Record<string, unknown>] | undefined;
  return call;
}

describe("cinatra#3007 — an unrecordable hold inside the gate delivery sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.readAgentRunByTaskId.mockResolvedValue(pausedRun());
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: "tmpl-1",
      packageName: "@cinatra-ai/web-research-agent",
      sourceType: "internal",
    });
    gateStoreMock.markResumeIntentDelivered.mockResolvedValue(true);
    sendTaskSpy.mockResolvedValue(completedTask());
    materializeSpy.mockResolvedValue([
      { ok: true, outputId: "draft", nodeId: "end", extension: "@cinatra-ai/blog-post-artifact" },
    ]);
    holdSpy.mockResolvedValue({ held: true, reason: "hold-unpersisted" });
  });

  it("puts the withheld terminal write on its delivery, and writes no terminal status", async () => {
    const err = (await deliverArtifactReviewResumeIntent(intent()).catch(
      (e: unknown) => e,
    )) as ProducedReviewHoldUnpersistedError;

    expect(err).toBeInstanceOf(ProducedReviewHoldUnpersistedError);
    // The caller never holds the payload — it was handed over where it was raised.
    expect(err.delivered).toBe(true);

    const call = deliveredRecovery();
    expect(call).toBeDefined();
    const [, data, options] = call!;
    expect(data.runId).toBe("run-1");
    expect(data.producedReviewHoldPark).toBe(1);
    // Keyed on the run, its CHAIN and the ordinal — the chain is what keeps a
    // later chain's first delivery off an id a settled job still holds.
    expect(typeof data.producedReviewHoldChain).toBe("string");
    expect(options.jobId).toBe(
      producedReviewRecoveryJobId("run-1", data.producedReviewHoldChain as string, 1),
    );
    expect(options.delay).toBe(PRODUCED_REVIEW_HOLD_RETRY_DELAY_MS);
    // The carried record stays under the cap the withheld write is bounded by.
    expect(
      Buffer.byteLength(JSON.stringify(data.producedReviewHold) ?? "", "utf8"),
    ).toBeLessThanOrEqual(PRODUCED_REVIEW_RECOVERY_PAYLOAD_MAX_BYTES);

    // The run is NOT terminal, and the intent is not marked done — the sweep
    // redelivers it, which is the at-least-once contract it already has.
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(gateStoreMock.markResumeIntentDelivered).not.toHaveBeenCalled();
  });

  it("the delivered payload lets a later convergence pass land the withheld verdict", async () => {
    await deliverArtifactReviewResumeIntent(intent()).catch(() => undefined);
    const [, data] = deliveredRecovery()!;

    // The next pass: nothing holds the run any more.
    holdSpy.mockResolvedValue({ held: false, reason: "no-review" });
    await recoverProducedReviewHold({
      runId: "run-1",
      run: { orgId: "org-1", status: "pending_approval" },
      recovery: data.producedReviewHold as never,
      authority: AUTHORITY,
      park: data.producedReviewHoldPark as number,
    });

    const calls = storeMock.transitionRunStatus.mock.calls as unknown as Array<
      [string, string, string, Record<string, unknown> | undefined, unknown]
    >;
    expect(calls).toHaveLength(1);
    expect([calls[0][1], calls[0][2]]).toEqual(["pending_approval", "completed"]);
    expect(calls[0][3]?.stepResults).toBeDefined();
    expect(calls[0][3]?.derivationOutbox).toMatchObject({ contentHash: expect.any(String) });
  });

  it("the queued delivery is what the execution job consumes — carrier and consumer agree", async () => {
    await deliverArtifactReviewResumeIntent(intent()).catch(() => undefined);
    const [, data] = deliveredRecovery()!;
    enqueueSpy.mockClear();

    // Hand the queue record BACK to the worker exactly as it was queued. Nothing
    // is re-executed: the leg asks the review question again and finishes the run.
    holdSpy.mockResolvedValue({ held: false, reason: "no-review" });
    storeMock.readAgentRunById.mockResolvedValue({
      ...pausedRun(),
      projectId: null,
    });
    await runAgentBuilderExecutionJob(
      data as { runId: string; producedReviewHold?: never },
      "delivery-1",
    );

    const calls = storeMock.transitionRunStatus.mock.calls as unknown as Array<
      [string, string, string, Record<string, unknown> | undefined, unknown]
    >;
    expect(calls).toHaveLength(1);
    expect([calls[0][1], calls[0][2]]).toEqual(["pending_approval", "completed"]);
    expect(calls[0][3]?.derivationOutbox).toMatchObject({ contentHash: expect.any(String) });
  });

  it("a leg redelivered at the same ordinal collapses onto the one queued recovery", async () => {
    await deliverArtifactReviewResumeIntent(intent()).catch(() => undefined);
    const [, data] = deliveredRecovery()!;
    const chain = data.producedReviewHoldChain as string;
    const park = data.producedReviewHoldPark as number;
    enqueueSpy.mockClear();

    // The SAME leg runs twice — a lock lost and reclaimed, a redelivery. Both
    // raises carry the chain and the ordinal, so both address one queue record.
    const run = { orgId: "org-1", status: "pending_approval" as const };
    await recoverProducedReviewHold({
      runId: "run-1",
      run,
      recovery: data.producedReviewHold as never,
      authority: AUTHORITY,
      park,
      chain,
    }).catch(() => undefined);
    await recoverProducedReviewHold({
      runId: "run-1",
      run,
      recovery: data.producedReviewHold as never,
      authority: AUTHORITY,
      park,
      chain,
    }).catch(() => undefined);

    const jobIds = enqueueSpy.mock.calls
      .filter((c) => (c as unknown[])[0] === "agent-builder-execution")
      .map((c) => ((c as unknown[])[2] as { jobId?: string }).jobId);
    expect(jobIds).toEqual([
      producedReviewRecoveryJobId("run-1", chain, park + 1),
      producedReviewRecoveryJobId("run-1", chain, park + 1),
    ]);
  });

  it("the sentinel carries what a job holder needs to enter the SAME delivery in place", async () => {
    const err = (await deliverArtifactReviewResumeIntent(intent()).catch(
      (e: unknown) => e,
    )) as ProducedReviewHoldUnpersistedError;
    const [, data] = deliveredRecovery()!;

    // Identity and ordinal, so a re-delivery in place is indistinguishable from
    // the queued one to the leg that consumes it.
    expect(err.chain).toBe(data.producedReviewHoldChain);
    expect(err.nextPark).toBe(data.producedReviewHoldPark);
    expect(err.capped).toBe(false);
  });

  it("a delivery the queue REFUSED is reported as undelivered, uncapped, and still non-terminal", async () => {
    enqueueSpy.mockRejectedValueOnce(new Error("the queue refused the delivery"));

    const err = (await deliverArtifactReviewResumeIntent(intent()).catch(
      (e: unknown) => e,
    )) as ProducedReviewHoldUnpersistedError;

    expect(err).toBeInstanceOf(ProducedReviewHoldUnpersistedError);
    // Undelivered but NOT capped — the difference a job holder branches on.
    expect(err.delivered).toBe(false);
    expect(err.capped).toBe(false);
    expect(err.chain).not.toBe("");
    expect(err.nextPark).toBe(1);
    // The payload is still on the sentinel, whole and bounded.
    expect(err.recovery.withheld.status).toBe("completed");
    expect(
      Buffer.byteLength(JSON.stringify(err.recovery) ?? "", "utf8"),
    ).toBeLessThanOrEqual(PRODUCED_REVIEW_RECOVERY_PAYLOAD_MAX_BYTES);
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("the execution worker re-enters the SAME delivery in place, and ONLY when the queue refused", () => {
    // Read on purpose: the worker's branch lives in the host dispatcher, which
    // owns the job handle this package cannot reach. What must hold is
    // structural — it re-delivers exactly the road's own job data, it branches
    // on the sentinel rather than on a guess, and it never re-delivers a chain
    // that is delivered or capped.
    const registry = readFileSync(
      join(__dirname, "..", "..", "..", "..", "src/lib/background-jobs-registry.ts"),
      "utf-8",
    );
    const at = registry.indexOf("err instanceof ProducedReviewHoldUnpersistedError");
    expect(at).toBeGreaterThan(-1);
    const branch = registry.slice(at, at + 1200);
    expect(branch).toContain("if (err.delivered || err.capped) throw err;");
    expect(branch).toContain("producedReviewHold: err.recovery");
    expect(branch).toContain("producedReviewHoldPark: err.nextPark");
    expect(branch).toContain("producedReviewHoldChain: err.chain");
    expect(branch).toContain("moveToDelayed");
    expect(branch).toContain("DelayedError");
    // And it never writes a terminal status on this edge.
    expect(branch).not.toContain("transitionRunStatus");
  });

  it("AT THE CAP nothing more is queued, and the run is still not terminal", async () => {
    await deliverArtifactReviewResumeIntent(intent()).catch(() => undefined);
    const [, data] = deliveredRecovery()!;
    enqueueSpy.mockClear();

    const err = (await recoverProducedReviewHold({
      runId: "run-1",
      run: { orgId: "org-1", status: "pending_approval" },
      recovery: data.producedReviewHold as never,
      authority: AUTHORITY,
      park: MAX_PRODUCED_REVIEW_HOLD_PARKS,
      chain: data.producedReviewHoldChain as string,
    }).catch((e: unknown) => e)) as ProducedReviewHoldUnpersistedError;

    expect(err).toBeInstanceOf(ProducedReviewHoldUnpersistedError);
    // No delivery was made, and the sentinel says so rather than promising one.
    expect(err.delivered).toBe(false);
    // CAPPED, which is what stops a job holder from re-delivering it in place.
    expect(err.capped).toBe(true);
    expect(err.message).toContain("could NOT be queued");
    expect(deliveredRecovery()).toBeUndefined();
    // And still no terminal write: the cap never licenses one.
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });
});
