import "server-only";

// ---------------------------------------------------------------------------
// run-resume-under-claim (cinatra#4245 change B): the WayFlow branch of
// `agent_run_resume` and the compare-and-set of `agent_run_stop` under the pause
// claim, here because the size ratchet of mcp/handlers.ts only shrinks, and the
// two steps every claimer shares.
//
// The order of a resume: read the generation, claim, the steps before the fence,
// fence, record the answer, send, handle the answer, settle. A stop that commits
// before the fence wins: the status change clears the claim, the fence then fails
// and nothing is sent. A stop during a live send loses: the seam refuses it with
// `pause_resume_in_flight`. A lost fence gives this claim back (a no-op when the
// claim is no longer this resume's).
//
// What records the answer (the prompt row) runs only after a fence this claimer
// won. A claimer whose lease expired and was taken over stops at its fence, so it
// never adds a row for an answer it did not send. The capture stays best-effort,
// as it was before the claim: a failed capture leaves a sent answer without its
// row (`buildSubmissionMapByStepIndex` reads the rows by position). The
// credential mint and the whole message, its id included, come before the fence,
// because a failure there gives the pause back (unless that release fails too:
// then the claim frees itself when its lease ends): past the fence every failure
// counts as possibly sent. A mint of a claimer that then loses its fence
// only adds a credential of the same run that is never sent (run-token-store.ts:
// the credential set is additive by design).
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";
import { captureHitlPromptForContinue, readCurrentDurableHitlGate } from "./agent-run-hitl-prompts";
import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } from "./agent-builder-ids";
import type { DurableHitlGateArtifact } from "./store";
import type { AgentRunRecord } from "./agent-run-record";
import { claimPause, PauseClaimReleaseError, releasePauseClaim, settlePauseSend } from "./run-pause-claim";
import { PAUSE_SEND_LEASE_SECONDS, RunTransitionError, TERMINAL_RUN_STATUSES, type AgentRunStatus } from "./run-status";
import { transitionRunStatus } from "./store";

type ClaimRef = { runId: string; orgId: string; token: string };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A pre-send step failed: give the lease back and throw the step's error, or
 * PauseClaimReleaseError when the release failed too. A `lost` release needs
 * nothing: the lease is no longer this claimer's. */

/**
 * THE DISPLAY-ONLY STEP IDS: a step parked under one of them is drawn as a card
 * with no answer of its own. The artifact-review redirect is one: the host draws
 * it inline with no approve control (cinatra#1796), and the paused run goes on
 * only by the review's own typed decision. A generic answer is never taken for it.
 */
const DISPLAY_ONLY_HITL_RENDERER_IDS: ReadonlySet<string> = new Set([
  ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
]);

/**
 * WHAT A GENERIC ANSWER MAY NOT CONSUME, read for both generic roads (the MCP
 * resume and the generic answer action). It decides on the run's CURRENT gate:
 * its newest durable row (`readCurrentDurableHitlGate`), never the row the run's
 * task-id column names (that column can be stale). Returns that gate and why an
 * answer is refused, or `null`:
 *   - `stale`: the caller named a gate (`namedReviewTaskId`) and the run's
 *     current gate is another one;
 *   - `display-only`: the current gate is a display-only card
 *     (`DISPLAY_ONLY_HITL_RENDERER_IDS`); only its own decision consumes it.
 * It does not judge whether a page draws the step: every other recorded
 * renderer id is left to the road, as before. No durable row (`gate: null`)
 * refuses nothing. A row that cannot be read throws; each road refuses with its
 * own fixed text.
 */
export async function currentHitlGateRefusal(input: {
  readonly runId: string;
  readonly namedReviewTaskId?: string;
}): Promise<{ gate: DurableHitlGateArtifact | null; refusal: "stale" | "display-only" | null }> {
  const gate = await readCurrentDurableHitlGate(input.runId);
  if (!gate) return { gate: null, refusal: null };
  if (input.namedReviewTaskId !== undefined && gate.reviewTaskId !== input.namedReviewTaskId) {
    return { gate, refusal: "stale" };
  }
  return { gate, refusal: DISPLAY_ONLY_HITL_RENDERER_IDS.has(gate.xRenderer) ? "display-only" : null };
}

export async function failPreSendStep(
  ref: ClaimRef & { expiresAt: Date },
  authority: OrgWriteAuthority | undefined,
  stepError: unknown,
): Promise<never> {
  try {
    await releasePauseClaim({ runId: ref.runId, orgId: ref.orgId, token: ref.token }, authority);
  } catch (releaseError) {
    throw new PauseClaimReleaseError({ stepError, releaseError, expiresAt: ref.expiresAt });
  }
  throw stepError;
}

/** Settle a send's lease; the text that names a failure, or null. Call right
 * after the fence for `fencedAt`: the row's expiry is the database clock's. */
export async function settleSendOrDescribe(
  ref: ClaimRef,
  authority: OrgWriteAuthority | undefined,
  fencedAt: number,
): Promise<string | null> {
  try {
    await settlePauseSend(ref, authority);
    return null;
  } catch (err) {
    const until = new Date(fencedAt + PAUSE_SEND_LEASE_SECONDS * 1000).toISOString();
    return `its claim on the pause could not be settled (${message(err)}); it frees itself at ${until}`;
  }
}

/**
 * cinatra#4150 (A5) under the pause claim: the publish hold read again after the
 * claim and before the fence. Under a claim no other road sends at this pause, and
 * a claimer whose lease was taken over loses its fence, so a decision parked after
 * the road's first read is seen here and nothing is sent. Throws the hold's fault
 * (publishHoldFault: the refusal unchanged, any read error one fixed text that
 * names no run and carries no store error).
 */
export async function recheckPublishHoldUnderClaim(runId: string): Promise<void> {
  const hold = await import("./publish-decision-actions");
  await hold.assertNoOpenPublishDecision(runId).catch((err: unknown) => {
    throw hold.publishHoldFault(err);
  });
}

/**
 * cinatra#4150: a publish-hold fault before the fence gives the claim back and
 * stays the answer; true when `fault` is one. A release that fails too is logged
 * by `warnLine` (a constant) and the error's name only, no run, task or raw error;
 * the lease then frees itself when it ends. Any other fault: false, nothing done.
 */
export async function givePauseBackOnHoldFault(
  ref: ClaimRef,
  authority: OrgWriteAuthority | undefined,
  fault: unknown,
  warnLine: string,
): Promise<boolean> {
  const { isPublishHoldFault } = await import("./publish-decision-actions");
  if (!isPublishHoldFault(fault)) return false;
  try {
    await releasePauseClaim({ runId: ref.runId, orgId: ref.orgId, token: ref.token }, authority);
  } catch (releaseError) {
    console.warn(warnLine, releaseError instanceof Error ? releaseError.name : "error");
  }
  return true;
}

const REFUSALS: Record<string, string> = {
  "moved-on": "Run moved on from the pause this resume read; nothing was sent.",
  held: "Run is already being resumed at this pause by another request.",
  "changes-requested": "Run can no longer be resumed at this pause: changes were requested on its review.",
};

type ResumeClient = { sendTask(params: never): Promise<unknown> };
type WayflowTask = Parameters<typeof import("./execution").handleWayflowTaskState>[0]["task"];

/**
 * The WayFlow branch of `agent_run_resume`. Nothing is sent unless the fence
 * landed. A failed send is not given back, because WayFlow may hold the message:
 * the lease is settled and the run stays where the fence put it.
 */
export async function resumeWayflowUnderPauseClaim(args: {
  run: AgentRunRecord & { a2aTaskId: string; a2aContextId: string };
  client: ResumeClient;
  resumeText: string;
  prompt: { agentId: string; message: string; submittedValues: Record<string, unknown> | null };
  /** The RESUMING PRINCIPAL's authority (D-OBO-RESUME), never the frame's run authority. */
  authority: OrgWriteAuthority;
  readRun: () => Promise<{ status: string } | null | undefined>;
  /** cinatra#4150 (A5): read the publish hold again under the claim, before the fence. */
  recheckPublishHold?: boolean;
}): Promise<Record<string, unknown>> {
  const { run, client, resumeText, prompt, authority, readRun } = args;
  // claimPause refuses a generation that cannot be read.
  const claim = await claimPause({ runId: run.id, orgId: run.orgId, generation: run.pauseGeneration as number }, authority);
  if (claim.kind === "refused") {
    return { error: REFUSALS[claim.reason] ?? `Run is not pending approval (status: ${claim.status}). Only pending_approval runs can be resumed.` };
  }
  const ref = { runId: run.id, orgId: run.orgId, token: claim.token };
  // cinatra#3745: the gate this resume read (its a2a task, in its execution
  // attempt). The fence is bound to it, and the answer is applied only while the
  // run is still `running` at it (execution.ts, `claimedGate`).
  const gate = { a2aTaskId: run.a2aTaskId, executionAttemptId: run.executionAttemptId ?? null };

  let resumeMessage: Record<string, unknown> | undefined;
  try {
    // #1193 resume carrier: the leg's credential goes in the message METADATA,
    // because `resumeText` reaches the gate's InputMessageNode VERBATIM.
    const { mintResumeRunTokenMetadata } = await import("./wayflow-run-token-carrier");
    const resumeMetadata = await mintResumeRunTokenMetadata(run.id);
    // The message is complete before the fence (see the header). Into the existing
    // context, so fasta2a routes to the paused conversation.
    resumeMessage = {
      role: "user",
      kind: "message",
      messageId: randomUUID(),
      contextId: run.a2aContextId,
      parts: [{ kind: "text", text: resumeText }],
      metadata: resumeMetadata,
    };
    if (args.recheckPublishHold) await recheckPublishHoldUnderClaim(run.id);
    await transitionRunStatus(
      run.id,
      "pending_approval",
      "running",
      { pauseFence: { token: claim.token, generation: claim.generation }, resumeGate: gate },
      authority,
    );
  } catch (stepError) {
    if (!(stepError instanceof RunTransitionError && stepError.code === "stale_from_status")) {
      if (await givePauseBackOnHoldFault(ref, authority, stepError, "[resumeWayflowUnderPauseClaim] could not give the claim back after a publish-hold refusal")) {
        return (await import("./publish-decision-actions")).publishHoldAnswer(stepError);
      }
      return failPreSendStep({ ...ref, expiresAt: claim.expiresAt }, authority, stepError);
    }
    // A lost fence sent nothing, and its rollback wrote nothing, so this claim can
    // still be live: the fence is bound to the gate (cinatra#3745), and the run can
    // be at another gate at the same generation (the delivery worker re-emits the
    // next gate in place, with no status change). Give the pause back, so the next
    // resume is not refused as `held` until the lease ends. The release clears only
    // this token's `claimed` lease: when a stop or another claimer has it, it is
    // `lost` and changes nothing. A failed release is logged (a constant and the
    // error's name only); the lease then frees itself when it ends.
    await releasePauseClaim(ref, authority).catch((releaseError: unknown) => {
      console.warn(
        "[resumeWayflowUnderPauseClaim] could not give the claim back after a lost fence",
        releaseError instanceof Error ? releaseError.name : "error",
      );
    });
    return {
      error:
        (await readRun())?.status === "stopped"
          ? "Run was stopped before the answer was sent; nothing was sent."
          : "This resume's claim on the pause expired before the send; nothing was sent. Resume again.",
    };
  }

  const fencedAt = Date.now();
  // The answer is recorded under the fence this claimer won (see the header). A
  // failed capture stays best-effort, as it was before the claim.
  await captureHitlPromptForContinue({
    runId: run.id,
    agentId: prompt.agentId,
    stepKey: run.a2aTaskId, // bare task.id, no `wayflow-` prefix
    message: prompt.message,
    submittedValues: prompt.submittedValues,
    schemaSnapshot: null, // MCP path: the schema is not available at resume time.
    excluded: prompt.message.length === 0,
  }).catch((e) => {
    console.warn("[resumeWayflowUnderPauseClaim] the prompt capture failed", { runId: run.id }, e);
  });
  let finalState: string | undefined;
  let failure: { error: unknown } | null = null;
  try {
    const task = (await client.sendTask({
      message: resumeMessage,
      configuration: { acceptedOutputModes: ["text"] },
    } as never)) as WayflowTask;
    // The fence moved the row to `running`, so the handler's edges start there.
    const { handleWayflowTaskState } = await import("./execution");
    await handleWayflowTaskState({ runId: run.id, run, fromStatus: "running", task, authority, pauseClaimToken: claim.token, claimedGate: gate });
    finalState = task.status?.state;
  } catch (error) {
    failure = { error };
  }
  const settleFailure = await settleSendOrDescribe(ref, authority, fencedAt);
  if (failure) {
    if (settleFailure === null) throw failure.error;
    throw new Error(`${message(failure.error)}; ${settleFailure}`, { cause: failure.error });
  }
  return {
    runId: run.id,
    status: finalState === "input-required" ? "pending_approval" : finalState === "failed" ? "failed" : "completed",
    message:
      finalState === "input-required" ? "WayFlow task paused at next gate."
      : finalState === "failed" ? "WayFlow task failed."
      : "WayFlow task completed.",
    ...(settleFailure !== null ? { error: `Run resumed, but ${settleFailure}.` } : {}),
  };
}

const STOP_ATTEMPTS = 3;

/**
 * The compare-and-set of `agent_run_stop`: null when it won, or the MCP answer
 * otherwise. A lost compare-and-set is never a success: the row is read again, a
 * terminal row gets the terminal answer, and a live row is tried again from its
 * live status, at most 3 attempts in all.
 */
export async function stopRunRespectingPauseClaim(args: {
  runId: string;
  fromStatus: AgentRunStatus;
  authority: OrgWriteAuthority | undefined;
  readRun: () => Promise<{ status: string } | null | undefined>;
}): Promise<Record<string, unknown> | null> {
  const { runId, authority, readRun } = args;
  let from = args.fromStatus;
  for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt += 1) {
    try {
      await transitionRunStatus(runId, from, "stopped", undefined, authority);
      return null;
    } catch (err) {
      if (!(err instanceof RunTransitionError) || err.code === "illegal_transition") throw err;
      const live = await readRun();
      if (err.code === "pause_resume_in_flight") {
        return {
          runId,
          status: live?.status ?? from,
          error: "Run is already resuming: its answer was sent before this stop, so it was not stopped. Stop it again once the resumed step returns.",
        };
      }
      if (!live) break;
      from = live.status as AgentRunStatus;
      if (TERMINAL_RUN_STATUSES.has(from)) return { runId, status: from, message: `Run already in terminal state: ${from}` };
    }
  }
  return { runId, status: from, error: "Run changed state while stopping and was not stopped; try again." };
}
