import "server-only";

// ---------------------------------------------------------------------------
// run-resume-under-claim (cinatra#4245 change B): the WayFlow branch of
// `agent_run_resume` and the compare-and-set of `agent_run_stop` under the pause
// claim, here because the size ratchet of mcp/handlers.ts only shrinks, and the
// two steps every claimer shares.
//
// The order of a resume: read the generation, claim, pre-send steps, fence, send,
// handle the answer, settle. A stop that commits before the fence wins: the status
// change clears the claim, the fence then fails and nothing is sent. A stop during
// a live send loses: the seam refuses it with `pause_resume_in_flight`.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";
import { captureHitlPromptForContinue, updateHitlPromptExcluded } from "./agent-run-hitl-prompts";
import type { AgentRunRecord } from "./agent-run-record";
import { claimPause, PauseClaimReleaseError, releasePauseClaim, settlePauseSend } from "./run-pause-claim";
import { PAUSE_SEND_LEASE_SECONDS, RunTransitionError, TERMINAL_RUN_STATUSES, type AgentRunStatus } from "./run-status";
import { transitionRunStatus } from "./store";

type ClaimRef = { runId: string; orgId: string; token: string };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A pre-send step failed: give the lease back and throw the step's error, or
 * PauseClaimReleaseError when the release failed too. A `lost` release needs
 * nothing: the lease is no longer this claimer's. */
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
}): Promise<Record<string, unknown>> {
  const { run, client, resumeText, prompt, authority, readRun } = args;
  // claimPause refuses a generation that cannot be read.
  const claim = await claimPause({ runId: run.id, orgId: run.orgId, generation: run.pauseGeneration as number }, authority);
  if (claim.kind === "refused") {
    return { error: REFUSALS[claim.reason] ?? `Run is not pending approval (status: ${claim.status}). Only pending_approval runs can be resumed.` };
  }
  const ref = { runId: run.id, orgId: run.orgId, token: claim.token };

  let promptId: string | null = null;
  let resumeMetadata: unknown;
  try {
    promptId = await captureHitlPromptForContinue({
      runId: run.id,
      agentId: prompt.agentId,
      stepKey: run.a2aTaskId, // bare task.id, no `wayflow-` prefix
      message: prompt.message,
      submittedValues: prompt.submittedValues,
      schemaSnapshot: null, // MCP path: the schema is not available at resume time.
      excluded: prompt.message.length === 0,
    }).catch((e) => {
      console.warn("[resumeWayflowUnderPauseClaim] the prompt capture failed", { runId: run.id }, e);
      return null;
    });
    // #1193 resume carrier: the leg's credential goes in the message METADATA,
    // because `resumeText` reaches the gate's InputMessageNode VERBATIM.
    const { mintResumeRunTokenMetadata } = await import("./wayflow-run-token-carrier");
    resumeMetadata = await mintResumeRunTokenMetadata(run.id);
    await transitionRunStatus(run.id, "pending_approval", "running", { pauseFence: { token: claim.token, generation: claim.generation } }, authority);
  } catch (stepError) {
    if (!(stepError instanceof RunTransitionError && stepError.code === "stale_from_status")) {
      return failPreSendStep({ ...ref, expiresAt: claim.expiresAt }, authority, stepError);
    }
    const lost =
      (await readRun())?.status === "stopped"
        ? "Run was stopped before the answer was sent; nothing was sent."
        : "This resume's claim on the pause expired before the send; nothing was sent. Resume again.";
    if (promptId === null) return { error: lost };
    return updateHitlPromptExcluded(promptId, true).then(
      () => ({ error: lost }),
      (e) => ({ error: `${lost} Its captured prompt could not be excluded (${message(e)}).` }),
    );
  }

  const fencedAt = Date.now();
  let finalState: string | undefined;
  let failure: { error: unknown } | null = null;
  try {
    // Into the existing context, so fasta2a routes to the paused conversation.
    const task = (await client.sendTask({
      message: {
        role: "user",
        kind: "message",
        messageId: randomUUID(),
        contextId: run.a2aContextId,
        parts: [{ kind: "text", text: resumeText }],
        metadata: resumeMetadata,
      },
      configuration: { acceptedOutputModes: ["text"] },
    } as never)) as WayflowTask;
    // The fence moved the row to `running`, so the handler's edges start there.
    const { handleWayflowTaskState } = await import("./execution");
    await handleWayflowTaskState({ runId: run.id, run, fromStatus: "running", task, authority, pauseClaimToken: claim.token });
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
