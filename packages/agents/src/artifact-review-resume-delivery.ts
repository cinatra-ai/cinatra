import "server-only";
import { mintAgentRunExecutionAuthority } from "@/lib/org-write/agent-run-authority-mint";
/** Stable code carried by AgentTemplateScopeError (cinatra#2485 C) — branch on
 *  the CODE, not `instanceof`, so a refusal is recognized across bundle /
 *  module-mock boundaries (the site-level pattern `project-dispatch.ts` uses
 *  for OBO_CEILING_DISJOINT_CODE). */
const AGENT_TEMPLATE_SCOPE_DENIED_CODE = "AGENT_TEMPLATE_SCOPE_DENIED";
const isScopeDenial = (err: unknown): err is { reason: string } =>
  (err as { code?: string } | null)?.code === AGENT_TEMPLATE_SCOPE_DENIED_CODE;

// ---------------------------------------------------------------------------
// Artifact-review RESUME-DELIVERY worker (cinatra#1796, epic #1620 S13).
//
// The delivery half of the generic artifact-review surface. The decision core
// (#1807) + the #2009 store commit a terminal review decision (approve/reject)
// as ONE transaction that persists a durable resume-outbox intent EXACTLY ONCE.
// THIS worker drains that outbox and delivers the typed decision to the paused
// WayFlow run via the A2A resume — the wire counterpart of the human in-panel
// approve path in `review-task-actions.ts`, but driven from the durable intent
// (the decision was already authorized at submit time, so the worker performs no
// human authz — it is a trusted server-internal drain).
//
//   claimPendingResumeIntents  → LEASE one row at a time (pending, or delivering
//                                with an expired lease — a crashed worker's rows
//                                recover); the lease is renewed while it delivers.
//   deliver each               → resolve the paused run from the gate's
//                                `wayflow-<taskId>` reviewTaskId, send the typed
//                                approve/reject payload into `run.a2aContextId`,
//                                and drive the returned Task through the canonical
//                                `handleWayflowTaskState`.
//   markResumeIntentDelivered  → single-shot, lease-token-guarded: a STALE worker
//                                (its lease expired + re-claimed) can never mark
//                                another worker's in-flight delivery done.
//
// EXACTLY-ONCE PERSISTENCE, AT-LEAST-ONCE DELIVERY: a worker may send then crash
// before marking done; the expired lease is re-claimed and re-delivered. The
// intent row itself records how far its delivery got (cinatra#3745): the claim
// mark (this gate's delivery moved the run to running) and the task WayFlow
// returned. A re-claim re-sends a claimed run with nothing recorded, replays the
// handler from a recorded task, and closes the intent only once the run has left
// this gate or the recorded task witnesses its delivery; a run another driver
// holds is left for a later lease. A crash between WayFlow taking a send and its
// record re-sends.
//
// REJECT ≠ APPROVE (#1807 ADR): the intent's `kind` is authoritative and its
// `responseText` is the STRUCTURALLY-DISTINCT typed envelope the decision core
// built (an approve envelope stamps `approved:true`; a reject envelope carries
// NO `approved` key and `review.decision === "rejected"`). The worker forwards
// that text verbatim as the WayFlow resume message, so a reject can never travel
// the approve wire.
// ---------------------------------------------------------------------------

import {
  readAgentRunById,
  readAgentRunByTaskId,
  readAgentTemplateById,
} from "./store";
import {
  WAYFLOW_A2A_TIMEOUT_MS,
  createWayflowFetch,
  resolveWayflowUrl,
} from "./wayflow-url";
import {
  claimPendingResumeIntents,
  deferResumeIntent,
  listReviewGatesForRun,
  markResumeIntentDelivered,
  readResumeIntentClaim,
  recordResumeTaskResult,
  renewResumeIntentLease,
  type ResumeIntentRow,
} from "./artifact-review-gate-store";
import {
  baseReviewTaskId,
  declaredReviewFamilyState,
} from "@/lib/artifacts/artifact-review-target";
import { isAutoReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";

/** The per-intent delivery outcome. */
export type ResumeDeliveryOutcome =
  /** The typed resume was sent and the intent marked delivered. */
  | "delivered"
  /** The run already left pending_approval (a prior at-least-once delivery
   *  landed, or the run reached a later gate / terminal state) — the intent is
   *  marked delivered without re-sending (idempotent consumer). */
  | "already-advanced"
  /** The delivery could not be attempted this cycle (run/context not resolvable
   *  yet, or another driver holds the run with no witness that this gate's
   *  resume was delivered); the intent is LEFT pending so the lease expiry
   *  re-claims it. */
  | "retryable"
  /** markResumeIntentDelivered lost its lease race (a re-claim already owns the
   *  row) — no re-send, no double-mark. */
  | "lease-lost"
  /** cinatra#2485 C: the agent's install scope no longer authorizes this run's
   *  principal, so the resume was NOT sent. TERMINAL for the intent (marked
   *  delivered): the decision will not change on the next tick, and leaving it
   *  pending would re-attempt a refused resume forever. */
  | "refused-out-of-scope";

/** The sweep's lease, and a delivery's when its caller names none. */
const DEFAULT_LEASE_MS = 5 * 60_000;

type HandlerTask = Parameters<(typeof import("./execution"))["handleWayflowTaskState"]>[0]["task"];

export interface ResumeSweepSummary {
  attempted: number;
  delivered: number;
  alreadyAdvanced: number;
  retryable: number;
  /** cinatra#3007 — runs released from their produced output's review this pass:
   *  the terminal write each of them parked instead of making. */
  releasedFromReview: number;
  /** cinatra#2485 C — intents closed WITHOUT sending because the run fell out
   *  of the agent's install scope. Counted separately from `failed`: it is a
   *  decision, not an error. */
  refusedOutOfScope: number;
  failed: number;
}

/**
 * Deliver ONE leased resume intent to its paused WayFlow run. Returns the
 * delivery outcome; THROWS only on an unexpected fault (the caller tallies it as
 * `failed` and leaves the intent pending for lease re-claim). Marks the intent
 * delivered on `delivered` / `already-advanced`; leaves it pending on
 * `retryable`.
 *
 * cinatra#3745: from the WayFlow branch on, the lease is renewed while the
 * delivery runs (`opts.leaseMs`, the length the sweep claimed it for) and fenced
 * by an awaited renewal before every send, re-send and replay. The renewal timer
 * stops on every exit.
 */
export async function deliverArtifactReviewResumeIntent(
  intent: ResumeIntentRow,
  opts?: { leaseMs?: number },
): Promise<ResumeDeliveryOutcome> {
  const { gateId, reviewTaskId, leaseToken } = intent;

  // S1 AUTO-created review gate (cinatra#2039, epic #2037): a `lifecycle-review:`
  // reviewTaskId names a policy-created gate whose producing run has no WayFlow
  // resume to take — the run has already done its work and is waiting only for
  // this decision.
  //
  // cinatra#3007 — SO THIS IS WHERE THE DECISION RELEASES IT. The producing run
  // parked at its review moment carrying the terminal write it withheld;
  // `releaseHeldRun` performs that write now, with whichever terminal status this
  // decision implies. It is idempotent and re-drivable by construction (a run that
  // is not parked, is parked for another reason, or is still held by a second
  // undecided gate is left exactly as it is), which is what lets an at-least-once
  // outbox drive it. A run that never parked — every auto-gate opened before this
  // fix, and every produced event with no agent run behind it — simply reports
  // `not-parked` and the intent is marked done as it always was.
  if (isAutoReviewTaskId(reviewTaskId)) {
    if (!leaseToken) return "retryable";
    await releaseRunForResolvedAutoGate(gateId);
    const ok = await markResumeIntentDelivered(gateId, leaseToken);
    console.log(
      `[artifact-review-resume] gate=${gateId} is an S1 auto-gate (task=${reviewTaskId}); the decision released the producing run — marked ${ok ? "done" : "LEASE-LOST"}`,
    );
    return ok ? "already-advanced" : "lease-lost";
  }

  // Every pinned artifact-review gate uses a `wayflow-<taskId>` reviewTaskId
  // (execution.ts marked-gate branch). A row with any other shape has no
  // resumable WayFlow context here — leave it pending rather than mis-route.
  if (!reviewTaskId.startsWith("wayflow-") || !leaseToken) {
    console.warn(
      `[artifact-review-resume] intent gate=${gateId} has non-wayflow reviewTaskId=${reviewTaskId} — skipping`,
    );
    return "retryable";
  }
  const lease = keepResumeIntentLease(gateId, leaseToken, opts?.leaseMs ?? DEFAULT_LEASE_MS);
  try {
    return await deliverWayflowResume(intent, leaseToken, lease);
  } finally {
    lease.stop();
  }
}

async function deliverWayflowResume(
  intent: ResumeIntentRow,
  leaseToken: string,
  lease: ResumeLeaseKeeper,
): Promise<ResumeDeliveryOutcome> {
  const { gateId, reviewTaskId, kind, responseText } = intent;
  const taskId = baseReviewTaskId(reviewTaskId.slice("wayflow-".length));

  // Resolve the paused run: the per-gate a2a_task_id column first, then the
  // Redis reverse-map written at interrupt-emit (authoritative when the column
  // lost a "tuple concurrently updated" race). Mirrors the human approve path.
  let run = await readAgentRunByTaskId(taskId);
  if (!run) {
    const { resolveRunIdByWayflowTaskId } = await import("@cinatra-ai/a2a");
    const fallbackRunId = await resolveRunIdByWayflowTaskId(taskId);
    if (fallbackRunId) run = await readAgentRunById(fallbackRunId);
  }
  if (!run) {
    console.warn(
      `[artifact-review-resume] intent gate=${gateId} task=${taskId} — run not resolvable yet; leaving pending`,
    );
    return "retryable";
  }

  // cinatra#3745 — THE DURABLE ROW DECIDES, NEVER REDIS ALONE. The claim mark
  // and the recorded task are read fresh, after the run: an entry into `running`
  // by another driver clears this intent's mark (and keeps its recorded task) in
  // the run's own transaction. The intent closes only on a durable witness: the
  // run has left this gate, or this gate's recorded task shows its resume was
  // delivered. A status alone is no witness: another driver's claim that fails
  // before its dispatch puts the run back on this gate.
  //   running, no mark, recorded       delivered; another driver moves it on  close
  //   running, no mark, not recorded   another driver holds it          defer, no send
  //   any other status                 terminal, or stopped             close
  //   pending_approval, recorded       its handler moved it to a later gate  close
  //   running, mark, recorded          sent; the handler did not finish  replay the handler
  //   running, mark, not recorded      claimed; not sent or not recorded re-send, no claim
  //   pending_approval                 not claimed                      claim, then send
  // A deferral sends, closes and moves nothing, and gives the attempt back: the
  // next lease reads the run again. A read error throws: the intent stays
  // delivering and is re-claimed.
  const claim = await readResumeIntentClaim(gateId, leaseToken);
  if (!claim) return "lease-lost";
  if (run.status === "running" && !claim.runClaimed) {
    if (claim.result !== null) {
      return closeIntent(gateId, leaseToken, run.id, `was delivered; another driver moves the run on (kind=${kind})`);
    }
    return deferIntent(gateId, leaseToken, run.id, `is held by another driver (kind=${kind})`);
  }
  if (run.status !== "pending_approval" && run.status !== "running") {
    return closeIntent(gateId, leaseToken, run.id, `already ${run.status} (kind=${kind})`);
  }
  if (run.status === "pending_approval" && claim.result !== null) {
    return closeIntent(gateId, leaseToken, run.id, "moved on from this gate after its resume");
  }
  const authority = mintAgentRunExecutionAuthority(run.orgId);
  const { transitionRunStatus } = await import("./run-transition");
  if (run.status === "running" && claim.result !== null) {
    // WayFlow returned this gate's task and it was recorded before the handler
    // ran, but the handler never finished. Replay it from the record: no send.
    // Its side effects (notifications) can repeat.
    if (!(await lease.fence())) return "lease-lost";
    const recorded = claim.result as HandlerTask;
    const { handleWayflowTaskState } = await import("./execution");
    await handleWayflowTaskState({ runId: run.id, run, fromStatus: "running", task: recorded, authority });
    return finishDelivery(gateId, leaseToken, run.id, `REPLAYED ${kind} resume (resultState=${recorded.status?.state})`);
  }
  // This gate's delivery already holds the run (mark set, nothing recorded): the
  // send is repeated without a second claim.
  const claimedByUs = run.status === "running";
  if (!run.a2aContextId) {
    // The paused run must carry the fasta2a context to resume; a missing context
    // is transient (execution persists it right after the initial send). Leave
    // pending for a later cycle.
    console.warn(
      `[artifact-review-resume] gate=${gateId} run=${run.id} has no a2aContextId yet — leaving pending`,
    );
    return "retryable";
  }

  // Idempotency #2 (which gate is the run CURRENTLY paused at): a crash after send
  // but before the run advancement was persisted re-claims this intent; by then a
  // MULTI-gate run may sit at a LATER gate. The a2a_task_id COLUMN is best-effort
  // (its per-gate overwrite loses a "tuple concurrently updated" race and the
  // error is swallowed), so it can falsely still name THIS gate → a resend into
  // the wrong gate. The AUTHORITATIVE witness is the Redis latest-task map, which
  // execution.ts writes fail-closed at EVERY interrupt-emit (rememberLatestWayflow
  // GateTask, including the marked gate): if the run's latest gate task is not
  // THIS one, the run advanced past this gate → the resume already landed → mark
  // done WITHOUT re-sending. A null map (7-day TTL expiry) is inconclusive, so we
  // fall through and deliver (best effort, the same posture the human resume path
  // takes when the map has lapsed). cinatra#3745: Redis is written before the
  // handler's status CAS, so it closes only a run nobody claimed. A claimed run
  // with nothing recorded is never closed or sent on it: whoever advances the run
  // lands a status the rows above close on.
  const { resolveLatestWayflowGateTaskId } = await import("@cinatra-ai/a2a");
  const latestTaskId = await resolveLatestWayflowGateTaskId(run.id);
  if (latestTaskId && latestTaskId !== taskId) {
    if (claimedByUs) {
      console.warn(
        `[artifact-review-resume] gate=${gateId} run=${run.id} is claimed by this gate with nothing recorded, ` +
          `but the latest gate task is another — left for a later cycle`,
      );
      return "retryable";
    }
    const ok = await markResumeIntentDelivered(gateId, leaseToken);
    console.log(
      `[artifact-review-resume] gate=${gateId} run=${run.id} advanced past this gate ` +
        `(latest=${latestTaskId}) — marked ${ok ? "done" : "LEASE-LOST"}`,
    );
    return ok ? "already-advanced" : "lease-lost";
  }

  const template = await readAgentTemplateById(run.templateId);
  if (!template?.packageName) {
    throw new Error(
      `[artifact-review-resume] template.packageName is null for templateId=${run.templateId} (gate=${gateId})`,
    );
  }
  // WayFlow-path invariant, mirroring review-task-actions.ts + mcp/handlers.ts:
  // only an internal template routes through the WayFlow resume.
  if (template.sourceType !== "internal") {
    throw new Error(
      `[artifact-review-resume] WayFlow resume requires an internal template; got sourceType=${template.sourceType} for run ${run.id} (gate=${gateId})`,
    );
  }
  const wayflowUrl = resolveWayflowUrl(template.packageName);

  // cinatra#2485 C — install-scope recheck at DELIVERY time. This sweeper
  // resumes a paused run from an intent persisted at gate time, so its
  // authorization is as old as that intent: a team-scoped run can pause, its
  // owner lose the owning team, and this delivery resume the run days later.
  // The resume drives execution through a DIRECT sendTask (no enqueue, no
  // status transition), so it reaches neither layer-2 chokepoint — the check
  // has to live here. There is no acting human on a sweeper tick, so the run's
  // own persisted principal is the subject, resolved LIVE.
  //
  // A refusal is TERMINAL for the intent (never retried): the scope decision
  // will not change on the next tick, and leaving it pending would re-attempt
  // a refused resume forever. An UNREADABLE check keeps the intent pending for
  // a later cycle, matching this function's existing "retryable" posture for
  // transient faults.
  {
    const { assertAgentRunDispatchAuthorized } = await import(
      "./agent-run-serde"
    );
    try {
      await assertAgentRunDispatchAuthorized({ runId: run.id, stage: "dispatch" });
    } catch (err) {
      if (isScopeDenial(err)) {
        console.warn(
          `[artifact-review-resume] gate=${gateId} run=${run.id} refused — the agent's ` +
            `scope no longer authorizes this run (${err.reason}); not resuming`,
        );
        // Land the RUN terminally, mirroring the worker's fire-time denial
        // (`execution.ts`: queued→failed with this same reason string). Closing
        // only the intent would strand the run in `pending_approval` FOREVER:
        // the intent is the sole thing that would ever resume it, this refusal
        // is terminal for that intent, and no other actor polls a paused gate.
        // A descoped run must still be able to land its own failure — the
        // `→failed` edge is deliberately un-gated for exactly this reason
        // (run-transition.ts §2b) — so this transition cannot itself be refused.
        //
        // Ordering: FAIL FIRST, then close the intent — and close it ONLY if the
        // run actually reached a terminal disposition. The intent is the sole
        // thing that would ever resume this run, so closing it after a TRANSIENT
        // transition failure (a DB blip, an authority mint fault) would strand
        // the run in `pending_approval` with nothing left to retry. So a
        // transient fault returns "retryable" instead: the lease lapses, the
        // sweeper re-claims the intent, re-runs the check (which denies again)
        // and re-attempts the transition — the same posture this function
        // already takes for an UNREADABLE check.
        //
        // `stale_from_status` is the ONE benign failure: the CAS lost because
        // another writer already moved the run off the status this delivery read.
        // It stamps no failure and closes nothing (cinatra#3745): that writer may
        // be a claim that puts the run back on this gate before its dispatch, so
        // the intent is deferred and the next lease reads the run again.
        //
        // cinatra#3745: the failure is fenced by this intent's lease, from the
        // status this delivery reads (`running` when it already claimed the run).
        // A stale worker's refusal fails nothing: the live lease holder decides.
        const refusal = {
          error: `run refused: the agent's scope no longer authorizes this run (${err.reason})`,
          resumeIntentLease: { gateId, leaseToken },
        };
        try {
          if (claimedByUs) {
            await transitionRunStatus(run.id, "running", "failed", refusal, authority);
          } else {
            await transitionRunStatus(
              run.id,
              "pending_approval",
              "failed",
              refusal,
              authority,
            );
          }
        } catch (tErr: unknown) {
          // Branch on the CODE, not `instanceof` — the error class arrives
          // through a dynamic import, so identity is not guaranteed.
          const code = (tErr as { code?: string } | null)?.code;
          if (code === "resume_intent_lease_lost") return "lease-lost";
          if (code !== "stale_from_status") {
            console.warn(
              `[artifact-review-resume] gate=${gateId} run=${run.id} refused, but the terminal ` +
                `transition did not land — LEAVING the intent pending so a later cycle retries ` +
                `rather than stranding the run: ` +
                `${tErr instanceof Error ? tErr.message : String(tErr)}`,
            );
            return "retryable";
          }
          return deferIntent(gateId, leaseToken, run.id,
            "refused, but another writer moved the run first; no failure was stamped");
        }
        const ok = await markResumeIntentDelivered(gateId, leaseToken);
        return ok ? "refused-out-of-scope" : "lease-lost";
      }
      console.warn(
        `[artifact-review-resume] gate=${gateId} run=${run.id} scope check unreadable — ` +
          `leaving pending for a later cycle: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return "retryable";
    }
  }

  // Retain the current dispatch authorization before acknowledging a sibling
  // hold; the existing per-artifact model changes no install-scope boundary.
  // cinatra#3035 (epic #3023 W11) — THE RUN PARKS AT EACH. One WayFlow pause can
  // carry one review per artifact — the post's, then each picture's — and the run
  // may only go on when the LAST of them is decided. A decision on an earlier leg
  // is complete in itself: its intent is closed here WITHOUT a resume, the run
  // stays exactly where it is, and the person reads the next artifact on its own
  // gate. A failed inventory read answers nothing: propagate through the
  // existing sweep error road, which leaves the intent pending for lease
  // re-claim. Neither a resume nor a delivered acknowledgement is authorized by
  // an unreadable sibling set (cinatra#3944, App160).
  const siblingLegs = await listReviewGatesForRun(run.id);
  const familyState = declaredReviewFamilyState({ runId: run.id, orgId: run.orgId,
    reviewTaskId, gates: siblingLegs });
  if (familyState === "incomplete") return "retryable";
  if (familyState === "pending") {
    const ok = await markResumeIntentDelivered(gateId, leaseToken);
    console.log(
      `[artifact-review-resume] gate=${gateId} run=${run.id} decided one artifact of a ` +
        `per-artifact review; another artifact of the same pause is still open — the run stays ` +
        `parked, marked ${ok ? "done" : "LEASE-LOST"}`,
    );
    return ok ? "already-advanced" : "lease-lost";
  }

  // Deliver the typed decision verbatim as the WayFlow resume message. Dynamic
  // import mirrors review-task-actions.ts (circular-dep avoidance:
  // agents ← @cinatra-ai/a2a ← mcp-server ← agent-builder).
  const { createExternalA2AClient } = await import("@cinatra-ai/a2a");
  const client = await createExternalA2AClient({
    agentUrl: wayflowUrl,
    timeoutMs: WAYFLOW_A2A_TIMEOUT_MS,
    fetchImpl: createWayflowFetch(),
  });
  // #1193 resume carrier: mint this leg's per-run credential and persist its hash
  // BEFORE the blocking sendTask, then carry the RAW token in the A2A message
  // METADATA. Metadata is required here rather than the text: this path delivers
  // the typed decision VERBATIM by contract, so the text cannot be wrapped.
  //
  // Rotation is ADDITIVE (agent_run_tokens keeps earlier legs valid), which
  // matters most on THIS path — delivery is at-least-once by design, so a lease
  // that lapses mid-send can redeliver while the first accepted task is still
  // executing. An overwrite-in-place rotation would 403 that live task.
  //
  // THE DELIVERY CLAIMS THE RUN BEFORE IT DISPATCHES (cinatra#3745). The resumed
  // leg's callbacks are admitted only while the run is `running` under the attempt
  // its step policy is bound to, so the paused run moves `pending_approval ->
  // running` (the resume edge, which keeps the attempt) before the message leaves,
  // exactly as the human approve path does. One conditional write: a lost claim
  // means another driver moved the run first. That is no witness that this
  // gate's resume was delivered (a claim can fail before its dispatch and put
  // the run back), so the intent is deferred without a send. The claim and every
  // later run edge carry this intent's lease (cinatra#3745): the claim sets the
  // intent's mark in the run's transaction.
  if (!claimedByUs) {
    try {
      await transitionRunStatus(run.id, "pending_approval", "running", { resumeIntentLease: { gateId, leaseToken } }, authority);
    } catch (claimErr: unknown) {
      const code = (claimErr as { code?: string } | null)?.code;
      if (code === "resume_intent_lease_lost") return "lease-lost";
      if (code !== "stale_from_status") throw claimErr;
      return deferIntent(gateId, leaseToken, run.id, "lost the claim to another driver");
    }
  }
  // Renew the lease before the wire. A refused renewal sends, releases and closes nothing.
  if (!(await lease.fence())) return "lease-lost";
  let task: Awaited<ReturnType<typeof client.sendTask>>;
  let resumeMetadata: Record<string, unknown> = {};
  try {
    const { mintResumeRunTokenMetadata } = await import("./wayflow-run-token-carrier");
    resumeMetadata = await mintResumeRunTokenMetadata(run.id);
    task = await client.sendTask({
      message: {
        role: "user",
        kind: "message",
        metadata: resumeMetadata,
        // DETERMINISTIC per-gate messageId (not random): a gate resumes exactly
        // once, so a stable id lets a dedup-aware receiver drop a duplicate re-send
        // (the at-least-once redelivery of the SAME gate's intent). Harmless if the
        // receiver does not dedup — the guards above already suppress the common
        // redelivery cases.
        messageId: `artifact-review-resume-${gateId}`,
        contextId: run.a2aContextId,
        parts: [{ kind: "text", text: responseText }],
      },
      configuration: { acceptedOutputModes: ["text"] },
    });
  } catch (sendErr) {
    // A failure before the wire (the token mint) or on it puts the gate back
    // under the lease, which clears the mark. A lost lease releases nothing: the
    // live lease holder decides. Any other release error is logged and the send
    // error rethrown; the lease lapses and the re-claim re-sends.
    try {
      await transitionRunStatus(run.id, "running", "pending_approval", { resumeIntentLease: { gateId, leaseToken } }, authority);
    } catch (releaseErr: unknown) {
      if ((releaseErr as { code?: string } | null)?.code === "resume_intent_lease_lost") return "lease-lost";
      console.warn(
        `[artifact-review-resume] gate=${gateId} run=${run.id} could not release the claim after a failed send (${errorLabel(releaseErr)})`,
      );
    }
    throw sendErr;
  }

  // Record what WayFlow returned, under the lease and this claim, BEFORE
  // the handler runs, without the run token. A refused record runs no handler.
  if (!(await recordResumeTaskResult(gateId, leaseToken, withoutRunToken(task, resumeMetadata)))) return "lease-lost";
  if (!(await lease.fence())) return "lease-lost";

  // Drive the returned Task through the canonical state machine (advances the
  // run past the gate — to the next gate or to terminal). fromStatus is the
  // literal "running": the claim above moved the row off `pending_approval`,
  // matching the human resume path.
  const { handleWayflowTaskState } = await import("./execution");
  // cinatra#1939 wave 2: the delivery worker advances the run with no session in
  // scope — it grounds the transition on the system dispatch mint (`authority`
  // above), scoped to the run's org (the human approval already happened when the
  // intent row was written).
  await handleWayflowTaskState({ runId: run.id, run, fromStatus: "running", task, authority });
  return finishDelivery(gateId, leaseToken, run.id, `DELIVERED ${kind} resume (resultState=${task.status?.state})`);
}

type ResumeLeaseKeeper = { fence(): Promise<boolean>; stop(): void };

/**
 * cinatra#3745: renew the lease every third of its length while the delivery
 * runs. A refused renewal stops the timer and every later fence refuses; a
 * renewal that throws is logged and retried on the next tick. `fence()` is an
 * awaited renewal, called before every wire action.
 */
function keepResumeIntentLease(gateId: string, leaseToken: string, leaseMs: number): ResumeLeaseKeeper {
  let lost = false;
  const renew = async (): Promise<boolean> => {
    if (lost) return false;
    const ok = await renewResumeIntentLease(gateId, leaseToken, leaseMs);
    if (!ok) lost = true;
    return ok;
  };
  const timer = setInterval(() => {
    renew().then(
      (ok) => {
        if (!ok) clearInterval(timer);
      },
      (err: unknown) => {
        console.warn(`[artifact-review-resume] gate=${gateId} lease renewal failed (${errorLabel(err)}); retried on the next tick`);
      },
    );
  }, Math.max(250, Math.floor(leaseMs / 3)));
  (timer as { unref?: () => void }).unref?.();
  return { fence: renew, stop: () => clearInterval(timer) };
}

/** A log label for an error: its code or name, never its message. A driver error
 *  can carry the query's parameters (the lease token), a send error the message. */
function errorLabel(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code !== "") return code;
  return err instanceof Error ? err.name : typeof err;
}

/** The task as recorded: every key and value the resume metadata carried is
 *  dropped, so the raw run token a task echoes in its history is never stored. */
function withoutRunToken(task: unknown, resumeMetadata: Record<string, unknown>): unknown {
  const keys = new Set(Object.keys(resumeMetadata));
  const values = new Set(Object.values(resumeMetadata).filter((v): v is string => typeof v === "string"));
  const text = JSON.stringify(task, (key, value: unknown) =>
    keys.has(key) || (typeof value === "string" && values.has(value)) ? undefined : value);
  return text === undefined ? null : JSON.parse(text);
}

async function closeIntent(gateId: string, leaseToken: string, runId: string, why: string): Promise<ResumeDeliveryOutcome> {
  const ok = await markResumeIntentDelivered(gateId, leaseToken);
  console.log(`[artifact-review-resume] gate=${gateId} run=${runId} ${why} — marked ${ok ? "done" : "LEASE-LOST"}`);
  return ok ? "already-advanced" : "lease-lost";
}

/** cinatra#3745: no witness yet; the next lease reads the run again (the attempt is given back). */
async function deferIntent(gateId: string, leaseToken: string, runId: string, why: string): Promise<ResumeDeliveryOutcome> {
  const ok = await deferResumeIntent(gateId, leaseToken);
  console.log(`[artifact-review-resume] gate=${gateId} run=${runId} ${why} — ${ok ? "left for a later lease" : "LEASE-LOST"}`);
  return ok ? "retryable" : "lease-lost";
}

async function finishDelivery(gateId: string, leaseToken: string, runId: string, what: string): Promise<ResumeDeliveryOutcome> {
  const marked = await markResumeIntentDelivered(gateId, leaseToken);
  console.log(`[artifact-review-resume] gate=${gateId} run=${runId} ${what} — marked ${marked ? "done" : "LEASE-LOST"}`);
  return marked ? "delivered" : "lease-lost";
}

/**
 * Perform the terminal write the gate's producing run parked instead of making
 * (cinatra#3007). Best-effort AND idempotent: `releaseHeldRun` re-reads the run
 * and the decisions itself, so a duplicate drive is a no-op, and a failure here
 * never fails the delivery that called it — the release drain below re-drives
 * every still-parked run whose gates are decided.
 */
async function releaseRunForResolvedAutoGate(gateId: string): Promise<void> {
  try {
    const { readGateRunOwner, releaseHeldRun } = await import("./run-produced-review-hold");
    const owner = await readGateRunOwner(gateId);
    if (!owner) return;
    const outcome = await releaseHeldRun(owner.runId, mintAgentRunExecutionAuthority(owner.orgId));
    if (outcome.released) {
      console.log(
        `[artifact-review-resume] gate=${gateId} run=${owner.runId} released by the decision → ${outcome.terminal}`,
      );
    }
  } catch (err) {
    console.error(
      `[artifact-review-resume] gate=${gateId} produced-review release failed (the release drain re-drives it):`,
      err,
    );
  }
}

/**
 * Release every run still parked on a produced-output review whose gates are all
 * decided (cinatra#3007).
 *
 * The decision path above covers a human approve/reject, because those commit a
 * resume intent. Two decisions do NOT: an EXPIRY auto-resolves an optional gate
 * with a bare CAS and mints no intent, and a crash between the CAS and the
 * release leaves a decided gate with a parked run behind it. This pass is what
 * makes the release total — the same durable-drain posture the outbox itself has.
 */
const PRODUCED_REVIEW_RELEASE_LIMIT = 50;

async function releaseDecidedProducedReviewParks(
  limit: number,
  summary: ResumeSweepSummary,
): Promise<void> {
  try {
    const { listReleasableHeldRuns, releaseHeldRun } = await import(
      "./run-produced-review-hold"
    );
    for (const run of await listReleasableHeldRuns(limit)) {
      try {
        const outcome = await releaseHeldRun(run.runId, mintAgentRunExecutionAuthority(run.orgId));
        if (outcome.released) summary.releasedFromReview += 1;
      } catch (err) {
        summary.failed += 1;
        console.error(
          `[artifact-review-resume] produced-review release failed for run=${run.runId} — left parked for the next pass:`,
          err,
        );
      }
    }
  } catch (err) {
    summary.failed += 1;
    console.error("[artifact-review-resume] produced-review release drain failed:", err);
  }
}

/**
 * Drain a batch of deliverable resume intents. Per-intent failures are TALLIED
 * (never rethrown) so one broken row can never poison the queue — the row stays
 * pending and the next cycle (after lease expiry) re-claims it (the sweep is the
 * durable backstop for a lost/crashed one-shot delivery).
 */
export async function sweepArtifactReviewResumeIntents(opts?: {
  limit?: number;
  leaseMs?: number;
}): Promise<ResumeSweepSummary> {
  const summary: ResumeSweepSummary = {
    attempted: 0,
    delivered: 0,
    alreadyAdvanced: 0,
    retryable: 0,
    releasedFromReview: 0,
    refusedOutOfScope: 0,
    failed: 0,
  };
  // cinatra#3745: ONE row per claim. A row this pass has not reached stays
  // pending and unleased, so no row waits leased behind another row's send; the
  // delivery renews its own row's lease while it runs, so a send longer than the
  // lease keeps it, while a crashed worker's row is still recovered after the
  // lease lapses.
  //
  // DELIVERY IS AT-LEAST-ONCE BY DESIGN (the #2009 outbox contract): a crash after
  // WayFlow took a send and before its result was recorded re-sends on the next
  // lease, and repeated crashes there can re-send again. The DETERMINISTIC
  // per-gate messageId helps only a receiver that de-duplicates on it. A crash
  // after the record replays the handler. Exactly-once DELIVERY is explicitly NOT
  // a goal of this outbox — it is exactly-once PERSISTENCE.
  const DEFAULT_LIMIT = 5;
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const leaseMs = opts?.leaseMs ?? DEFAULT_LEASE_MS;
  for (let n = 0; n < limit; n += 1) {
    const [intent] = await claimPendingResumeIntents({ limit: 1, leaseMs });
    if (!intent) break;
    summary.attempted += 1;
    try {
      const outcome = await deliverArtifactReviewResumeIntent(intent, { leaseMs });
      if (outcome === "delivered") summary.delivered += 1;
      else if (outcome === "already-advanced") summary.alreadyAdvanced += 1;
      else if (outcome === "refused-out-of-scope") summary.refusedOutOfScope += 1;
      else summary.retryable += 1; // "retryable" | "lease-lost" both leave the row for another owner/cycle
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[artifact-review-resume] delivery failed for gate=${intent.gateId} (kind=${intent.kind}) — left pending for re-claim (${errorLabel(err)})`,
      );
    }
  }
  // The decision-driven release above reaches every approve/reject; this reaches
  // the two decisions that mint no intent (an expiry, and a crash after the CAS).
  // Its OWN bound, not the intent batch's: an intent delivery is a WayFlow resume
  // and is deliberately small, while a release is one guarded CAS, and the
  // candidate query returns only runs that are actually releasable.
  await releaseDecidedProducedReviewParks(PRODUCED_REVIEW_RELEASE_LIMIT, summary);
  return summary;
}
