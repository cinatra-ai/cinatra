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
// returned. A re-claim puts a claimed run with nothing recorded back on its gate
// and sends again only under a fresh pause claim and fence, replays the handler
// from a recorded task bound to the claimed gate, and closes the intent only once
// the run has left this gate or the recorded task witnesses its delivery; a run
// another driver holds is left for a later lease. A crash between WayFlow taking
// a send and its record re-sends.
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
  updateAgentRunA2ATaskId,
} from "./store";
import type { AgentRunRecord } from "./agent-run-record";
import type { ResumeGateIdentity } from "./run-transition";
import { claimPause, PauseClaimReleaseError, releasePauseClaim } from "./run-pause-claim";
import { failPreSendStep, givePauseBackOnHoldFault, recheckPublishHoldUnderClaim, settleSendOrDescribe } from "./run-resume-under-claim";
import {
  WAYFLOW_A2A_TIMEOUT_MS,
  createWayflowFetch,
  resolveWayflowUrl,
} from "./wayflow-url";
import {
  claimPendingResumeIntents,
  deadLetterExhaustedResumeIntents,
  deadLetterResumeIntentUnderLease,
  deferResumeIntent,
  leaseExhaustedResumeClaims,
  listReviewGatesForRun,
  markResumeIntentDelivered,
  withRunDecisionLock,
  type GateStoreExecutor,
  readResumeIntentClaim,
  recordResumeTaskResult,
  renewResumeIntentLease,
  type ResumeIntentRow,
} from "./artifact-review-gate-store";
import {
  baseReviewTaskId,
  declaredReviewFamilyState,
  isDeclaredReviewTaskId,
} from "@/lib/artifacts/artifact-review-target";
import { isAutoReviewTaskId, isRepairSuccessorTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import { laterDeclaredPause } from "./declared-review-pause";

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
 * `retryable`. A `retryable`, a `lease-lost` and a throw each leave the intent
 * for a re-claim after its lease, and each claim uses one of its attempts
 * (cinatra#4312): see `sweepArtifactReviewResumeIntents`. A deferral
 * (cinatra#3745) uses its attempt too.
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
    // cinatra#4312 — Regenerate on a leg of a declared review (the featured
    // image's, or the post's own through a caller other than the review surface)
    // settled that leg and opened this successor gate on its repair lineage. The
    // run the leg paused waits for THIS decision, so the intent takes that leg's
    // WayFlow road below with this gate's own decision: the family check, then
    // every leg's lineage, as for any decision of the family. The lineage read is
    // strict: a malformed task id, an unknown repair, another attempt, a repair
    // that does not name this gate, or a missing root gate THROWS
    // (RepairLineageStateError), and the sweep leaves the intent for re-claim
    // until its attempts are used, then dead-letters it. A successor whose
    // lineage started on any other gate keeps the automatic-gate road.
    if (isRepairSuccessorTaskId(reviewTaskId)) {
      const { readRepairLineageRootGate } = await import("./lifecycle-repair-store");
      const leg = await readRepairLineageRootGate(reviewTaskId, gateId);
      if (isDeclaredReviewTaskId(leg.reviewTaskId)) {
        return deliverArtifactReviewResumeIntent({ ...intent, reviewTaskId: leg.reviewTaskId }, opts);
      }
    }
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
    return await deliverWayflowResume(intent, leaseToken, lease, false);
  } finally {
    lease.stop();
  }
}

async function deliverWayflowResume(
  intent: ResumeIntentRow,
  leaseToken: string,
  lease: ResumeLeaseKeeper,
  /** True on the one pass after this delivery put its claimed run back on the gate. */
  afterRelease: boolean,
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
  //   running, mark, recorded          sent; the handler did not finish  replay the handler, bound to the claimed gate
  //   running, mark, not recorded      claimed; not sent or not recorded put the run back on its gate, then claim and send
  //   pending_approval                 not claimed                      claim, then send
  // A deferral sends, closes and moves nothing; its claim's attempt stays used
  // (cinatra#4312): the next lease reads the run again. A read error throws: the
  // intent stays delivering and is re-claimed. Every send is made under a pause
  // claim and its fence (cinatra#4245), and every answer the handler applies is
  // bound to the gate the delivery claimed (`claimedGate`, cinatra#3745), so an
  // answer never moves a run another driver or a newer execution holds.
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
    // Its side effects (notifications) can repeat. The answer is applied only
    // while the run is still `running` at the gate this delivery claimed, in the
    // execution attempt read above (`claimedGate`, the run's gate task as read:
    // the claim's, or the one the handler's own bind wrote; the mark set at the
    // claim read shows no other driver entered `running` since this delivery's
    // claim). A run stopped, failed, retried under a fresh attempt or moved to
    // another gate task after this read takes nothing from the replay
    // (bindResumeLegToTask), as on the MCP resume.
    if (!(await lease.fence())) return "lease-lost";
    const recorded = claim.result as HandlerTask;
    if (!run.a2aTaskId) {
      // Not reached for a claim this delivery made: its claim names the gate task
      // (the fill under the pause claim below). Nothing is applied unbound; the
      // intent stays, and its settle puts the run back on its gate once its attempts are used.
      console.warn(`[artifact-review-resume] gate=${gateId} run=${run.id} names no gate task; the recorded task is not replayed`);
      return "retryable";
    }
    const replayGate: ResumeGateIdentity = { a2aTaskId: run.a2aTaskId, executionAttemptId: run.executionAttemptId ?? null };
    const { handleWayflowTaskState } = await import("./execution");
    await handleWayflowTaskState({ runId: run.id, run, fromStatus: "running", task: recorded, authority, claimedGate: replayGate });
    return finishDelivery(gateId, leaseToken, run.id, `REPLAYED ${kind} resume (resultState=${recorded.status?.state})`);
  }
  if (run.status === "running") {
    // This gate's delivery holds the run (mark set, nothing recorded): a claim
    // whose send may or may not have reached WayFlow. It is never sent again
    // while `running`: a send there would have no pause claim and no fence, so a
    // stop could land during it (cinatra#4245 rule 4). The run is put back on its
    // gate under this lease (`releaseClaimedRun`: bound to the gate and execution
    // attempt read above, and to the mark, which any other driver's entry into
    // `running` clears), and this same delivery then reads the run again and
    // claims it like any paused run: a fresh pause claim, the hold read, the
    // fence, then the send. The lease is this delivery's proof that the earlier
    // one is gone (it renews every third of the lease); a send of that earlier
    // delivery still on the wire is the at-least-once case of the outbox
    // contract (the release ends that delivery's `sending` lease; its record and
    // its handler are refused, because its lease is gone).
    return putClaimedRunBack(intent, run, leaseToken, lease, afterRelease, taskId);
  }
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
  // with nothing recorded is never closed on it (`putClaimedRunBack` reads it
  // before its release): whoever advances the run lands a status the rows above
  // close on. From here on the run is `pending_approval`.
  const { resolveLatestWayflowGateTaskId } = await import("@cinatra-ai/a2a");
  const latestTaskId = await resolveLatestWayflowGateTaskId(run.id);
  if (latestTaskId && latestTaskId !== taskId) {
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
        // cinatra#3745: the failure is fenced by this intent's lease, and only
        // from `pending_approval`: a run this delivery claimed was put back on
        // its gate first (`putClaimedRunBack`), so no refusal fails a `running`
        // run, which a newer execution can hold. A stale worker's refusal fails
        // nothing: the live lease holder decides.
        const refusal = {
          error: `run refused: the agent's scope no longer authorizes this run (${err.reason})`,
          resumeIntentLease: { gateId, leaseToken },
        };
        try {
          await transitionRunStatus(run.id, "pending_approval", "failed", refusal, authority);
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
  // cinatra#4312 — when the run's gates, as read here, show that the run went on
  // to another declared review after this one, the intent is closed WITHOUT a
  // send, whatever wrote it (a decision, or a carrier a close inserted before that
  // later review's gates were committed) (`laterDeclaredPause`: created times in
  // microseconds; an equal created time, and a time it cannot read, are read as
  // later). A later review whose gates are committed after this read is not
  // seen. The latest-task check above
  // answers the same when its map is present; this read does not depend on the
  // map. A lost lease answers `lease-lost`.
  if (laterDeclaredPause(siblingLegs, reviewTaskId)) {
    const ok = await markResumeIntentDelivered(gateId, leaseToken);
    console.log(
      `[artifact-review-resume] gate=${gateId} run=${run.id} is paused at a later review ` +
        `than ${baseReviewTaskId(reviewTaskId)} — marked ${ok ? "done" : "LEASE-LOST"} without a send`,
    );
    return ok ? "already-advanced" : "lease-lost";
  }
  const familyState = declaredReviewFamilyState({ runId: run.id, orgId: run.orgId,
    reviewTaskId, gates: siblingLegs });
  if (familyState === "incomplete") return "retryable";
  if (familyState === "pending" || await regenerationOpen(siblingLegs, reviewTaskId)) {
    // cinatra#4312 — an open repair lineage on a leg reads like a sibling leg
    // that is still pending: the intent is closed without a send and the run
    // stays parked. This acknowledgement is written under the run's decision
    // lock, on a re-read of the family and its repair lineages. A close of a
    // lineage with no gate decision (escalated, stale, the sweep's naming) takes
    // the same lock before it reads the lineage and inserts a new intent that
    // carries the family's latest decision, so either that close reads the
    // lineage closed after this commit, or this re-read sees it closed
    // (artifact-review-gate-store `withRunDecisionLock`).
    // A re-read that finds the pause decided falls through to the resume below.
    const parked = await withRunDecisionLock(run.id, async (tx) => {
      const legs = await listReviewGatesForRun(run.id, tx);
      const state = declaredReviewFamilyState({ runId: run.id, orgId: run.orgId, reviewTaskId, gates: legs });
      if (state === "incomplete") return "retryable" as const;
      if (state !== "pending" && !(await regenerationOpen(legs, reviewTaskId, tx))) return null;
      const ok = await markResumeIntentDelivered(gateId, leaseToken, tx);
      console.log(
        `[artifact-review-resume] gate=${gateId} run=${run.id} decided one artifact of a ` +
          `per-artifact review; another artifact of the same pause, or a regenerated artifact's ` +
          `review, is still open — the run stays parked, marked ${ok ? "done" : "LEASE-LOST"}`,
      );
      return ok ? "already-advanced" as const : "lease-lost" as const;
    });
    if (parked !== null) return parked;
  }

  // cinatra#4150: a run held at a publish decision goes on only by that decision. The
  // intent stays pending; a decline or an expiry stops the run, and the status guard
  // above then closes it. A hold that cannot be read keeps it pending too. Neither log
  // line names the gate, the run or the store's error.
  const publishHold = await import("./publish-decision-actions");
  const refused = (err: unknown): "retryable" => {
    const why = publishHold.isPublishDecisionRequired(err) ? publishHold.PUBLISH_DECISION_REQUIRED : "the publish hold could not be checked";
    console.warn(`[artifact-review-resume] a resume was refused: ${why}`);
    return "retryable";
  };
  let decided: boolean; // the run has a decision: it met a publish gate, whatever the template lists
  try {
    decided = await publishHold.assertNoOpenPublishDecision(run.id);
  } catch (err) {
    return refused(err);
  }

  // cinatra#4150 (A5): a publishing template, or a run with a decision, reads the hold again before the send.
  const recheckHold = (template.publishingSteps?.length ?? 0) > 0 || decided;

  // THE DELIVERY CLAIMS THE RUN BEFORE IT DISPATCHES (cinatra#3745). The resumed
  // leg runs while the run is `running`, so the paused run moves `pending_approval
  // -> running` (the resume edge, which keeps the attempt) before the message
  // leaves, exactly as the human approve path does. That edge is the pause fence
  // (cinatra#4245): the delivery first claims the pause at the generation it read,
  // as every other resume road does, and the fence and this intent's lease ride
  // on the one edge, so the claim sets the intent's mark in the run's
  // transaction. A claim or a fence lost to another driver is no witness that
  // this gate's resume was delivered (a claim can fail before its dispatch and
  // put the run back), so the intent is deferred without a send; a pause that a
  // change request ended needs no send, and the intent is done. Every later run
  // edge carries this intent's lease (cinatra#3745). A run parked on its produced
  // output's review is never claimed (S4): the claim refuses it in its own
  // transaction (`refuseParkedRunClaim`), the pause claim is given back and the
  // intent is done with nothing sent.
  const pause = await claimPause({ runId: run.id, orgId: run.orgId, generation: run.pauseGeneration as number }, authority);
  if (pause.kind === "refused") {
    if (pause.reason === "changes-requested") {
      return closeIntent(gateId, leaseToken, run.id, `was ended by a change request; nothing was sent (kind=${kind})`);
    }
    return deferIntent(gateId, leaseToken, run.id, `lost the pause claim to another driver (${pause.reason})`);
  }
  const pauseRef = { runId: run.id, orgId: run.orgId, token: pause.token };
  // cinatra#3745: the gate this claim is bound to (the run's gate task, in its
  // execution attempt). The fence names it, and the handler applies the answer
  // only while the run is still `running` at it (`claimedGate`), as on the MCP
  // resume. A run found through the reverse map whose task column is empty gets
  // this gate's task written under the pause claim first, so every run this
  // delivery claims names its gate, and its release is bound like any other.
  const gate: ResumeGateIdentity = { a2aTaskId: run.a2aTaskId || taskId, executionAttemptId: run.executionAttemptId ?? null };

  // The steps before the wire come before the fence (cinatra#4245): a failure
  // there gives the claim back, a publish-hold refusal included, and the intent
  // stays pending (a release that fails too leaves it pending until the claim's
  // lease frees itself). null: the claim no longer holds the row.
  const preWire = async () => {
    if (!run.a2aTaskId) {
      const { written } = await updateAgentRunA2ATaskId(run.id, taskId, { pauseClaimToken: pause.token });
      if (!written) return null;
    }
    // Deliver the typed decision verbatim as the WayFlow resume message. Dynamic
    // import mirrors review-task-actions.ts (circular-dep avoidance:
    // agents ← @cinatra-ai/a2a ← mcp-server ← agent-builder).
    const { createExternalA2AClient } = await import("@cinatra-ai/a2a");
    const preWireClient = await createExternalA2AClient({
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
    const { mintResumeRunTokenMetadata } = await import("./wayflow-run-token-carrier");
    const metadata = await mintResumeRunTokenMetadata(run.id);
    // cinatra#4150 (A5): the hold read again under the claim and before the send. A
    // decision parked after the first read above refuses the send.
    if (recheckHold) await recheckPublishHoldUnderClaim(run.id);
    return { client: preWireClient, resumeMetadata: metadata };
  };
  let ready: Awaited<ReturnType<typeof preWire>>;
  try {
    ready = await preWire();
  } catch (stepError) {
    if (await givePauseBackOnHoldFault(pauseRef, authority, stepError, "[artifact-review-resume] could not give the claim back after a publish-hold refusal")) {
      return refused(stepError);
    }
    try {
      return await failPreSendStep({ ...pauseRef, expiresAt: pause.expiresAt }, authority, stepError);
    } catch (surfaced) {
      if (!(surfaced instanceof PauseClaimReleaseError)) throw surfaced;
      console.warn(`[artifact-review-resume] gate=${gateId} run=${run.id} left pending: ${releaseFailureLabel(surfaced)}`);
      return "retryable";
    }
  }
  if (ready === null) {
    // A stop, a status change or a claimer that took the expired claim over
    // cleared it: nothing to give back, nothing moved.
    return deferIntent(gateId, leaseToken, run.id, "lost the pause claim before its fence");
  }
  const { client, resumeMetadata } = ready;

  // THE FENCE: the claim of the run, under the live pause claim and this intent's
  // lease, bound to the gate read above.
  try {
    await transitionRunStatus(
      run.id,
      "pending_approval",
      "running",
      {
        pauseFence: { token: pause.token, generation: pause.generation },
        resumeIntentLease: { gateId, leaseToken },
        resumeGate: { ...gate, onParkCleared: refuseParkedRunClaim },
      },
      authority,
    );
  } catch (claimErr: unknown) {
    if (claimErr instanceof ParkedRunClaimRefused) {
      // The claim rolled back with the park, its withheld terminal write, the
      // claim mark and the edge: the run is parked exactly as it was read, and the
      // produced-review drain releases it. The pause claim is still this worker's
      // (the refusal wrote nothing); a release that fails is logged, and the
      // claim's lease frees itself.
      await releasePauseClaim(pauseRef, authority).catch((releaseErr: unknown) => {
        console.warn(`[artifact-review-resume] gate=${gateId} run=${run.id} could not give the pause claim back (${errorLabel(releaseErr)})`);
      });
      return closeIntent(gateId, leaseToken, run.id,
        `is parked on its produced output's review; its WayFlow work is done and nothing was sent (kind=${kind})`);
    }
    const code = (claimErr as { code?: string } | null)?.code;
    if (code === "resume_intent_lease_lost" || code === "stale_from_status") {
      // A lost intent lease rolled the edge back, and a lost compare-and-set
      // wrote nothing, so the pause can still be claimed by this worker (the
      // fence is bound to the gate too): give it back. The release clears only
      // this token's `claimed` lease, so it changes nothing when a stop or
      // another claimer has the pause. A release that fails is logged; the
      // claim's lease then frees itself.
      await releasePauseClaim(pauseRef, authority).catch((releaseErr: unknown) => {
        console.warn(`[artifact-review-resume] gate=${gateId} run=${run.id} could not give the pause claim back (${errorLabel(releaseErr)})`);
      });
      if (code === "resume_intent_lease_lost") return "lease-lost";
      return deferIntent(gateId, leaseToken, run.id, "lost the fence to another driver");
    }
    try {
      return await failPreSendStep({ ...pauseRef, expiresAt: pause.expiresAt }, authority, claimErr);
    } catch (surfaced) {
      if (!(surfaced instanceof PauseClaimReleaseError)) throw surfaced;
      console.warn(`[artifact-review-resume] gate=${gateId} run=${run.id} left pending: ${releaseFailureLabel(surfaced)}`);
      return "retryable";
    }
  }

  // Past the fence the send counts as possibly made. The pause lease is settled
  // however the delivery ends; a settle that fails leaves the intent pending, and
  // the next lease reads the claim row again.
  const fencedAt = Date.now();
  let settled = false;
  const settle = async (): Promise<string | null> => {
    if (settled) return null;
    settled = true;
    const failure = await settleSendOrDescribe(pauseRef, authority, fencedAt);
    if (failure !== null) console.error(`[artifact-review-resume] gate=${gateId} run=${run.id}: ${failure}`);
    return failure;
  };
  try {
    // Renew the lease before the wire. A refused renewal sends, releases and closes nothing.
    if (!(await lease.fence())) return "lease-lost";
    let task: Awaited<ReturnType<typeof client.sendTask>>;
    try {
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
      // A failed send puts the gate back under the lease, which clears the mark
      // (and, as every status change, the pause claim). A lost lease releases
      // nothing: the live lease holder decides. Any other release error is logged
      // and the send error rethrown; the lease lapses and the re-claim re-sends.
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
    // matching the human resume path. The handler gets the claim's token
    // (cinatra#4245) and the claimed gate (cinatra#3745), so the answer is
    // applied only while the token holds the row and the run is still `running`
    // at that gate in that execution attempt.
    const { handleWayflowTaskState } = await import("./execution");
    // cinatra#1939 wave 2: the delivery worker advances the run with no session in
    // scope — it grounds the transition on the system dispatch mint (`authority`
    // above), scoped to the run's org (the human approval already happened when the
    // intent row was written).
    await handleWayflowTaskState({ runId: run.id, run, fromStatus: "running", task, authority, pauseClaimToken: pause.token, claimedGate: gate });
    if ((await settle()) !== null) return "retryable";
    return finishDelivery(gateId, leaseToken, run.id, `DELIVERED ${kind} resume (resultState=${task.status?.state})`);
  } finally {
    await settle();
  }
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

/** What `releaseClaimedRun` did. */
type ClaimRelease =
  /** The run is back on this gate; the release cleared the mark. */
  | "released"
  /** No row under this lease with the mark set: another driver's entry into
   *  `running` cleared it, or the lease is another worker's. Nothing moved. */
  | "lease-lost"
  /** The run left the status, gate or execution attempt the caller read. Nothing moved. */
  | "moved"
  /** Any other error. Nothing moved. */
  | "failed";

/**
 * cinatra#3745: put a run this gate's delivery claimed back on its gate
 * (`running -> pending_approval`) under the intent's lease. The lease fence needs
 * the claim mark still set, and every other driver's entry into `running` clears
 * it, so a delivery that read the run before it was stopped and dispatched again,
 * or resumed by another driver, moves nothing. The release is bound to the gate
 * and execution attempt the caller read (`resumeGate`) as well. A run with no
 * gate task (not reached for a claim this delivery makes: it writes the task
 * under its pause claim before its fence) is released on the mark alone, never
 * left `running` with no driver.
 */
async function releaseClaimedRun(
  run: AgentRunRecord,
  gateId: string,
  leaseToken: string,
  when: string,
): Promise<ClaimRelease> {
  const { transitionRunStatus } = await import("./run-transition");
  try {
    await transitionRunStatus(
      run.id,
      "running",
      "pending_approval",
      {
        resumeIntentLease: { gateId, leaseToken },
        ...(run.a2aTaskId
          ? { resumeGate: { a2aTaskId: run.a2aTaskId, executionAttemptId: run.executionAttemptId ?? null } }
          : {}),
      },
      mintAgentRunExecutionAuthority(run.orgId),
    );
    return "released";
  } catch (releaseErr: unknown) {
    const code = (releaseErr as { code?: string } | null)?.code;
    if (code === "resume_intent_lease_lost") return "lease-lost";
    if (code === "stale_from_status") return "moved";
    console.warn(
      `[artifact-review-resume] gate=${gateId} run=${run.id} could not release the claim ${when} (${errorLabel(releaseErr)})`,
    );
    return "failed";
  }
}

/**
 * cinatra#3745: the road of a run this gate's delivery claimed, with nothing
 * recorded. It is never sent again while `running` (no pause claim could fence
 * that send). cinatra#4312 bounds it:
 *   the claim of the intent's last attempt   put the run back, send nothing; the
 *                                            dead-letter pass takes the intent with
 *                                            its run parked at the gate for ops
 *   Redis names another gate task           left for a later cycle (never closed
 *                                            or sent on it; whoever advances the
 *                                            run lands a status that closes it)
 *   any other                               put the run back, then read the run
 *                                            again and claim it under a fresh pause
 *                                            claim and fence, on this attempt
 * The replay of a recorded task sends nothing and keeps its last attempt. A
 * release that moved nothing or failed leaves the intent (`retryable`): the next
 * lease reads the run again, and once the attempts are used, the settle pass
 * leases the intent again with its mark still set (`settleExhaustedResumeClaim`).
 * The pass after a release never releases again.
 */
async function putClaimedRunBack(
  intent: ResumeIntentRow,
  run: AgentRunRecord,
  leaseToken: string,
  lease: ResumeLeaseKeeper,
  afterRelease: boolean,
  taskId: string,
): Promise<ResumeDeliveryOutcome> {
  const { gateId } = intent;
  if (afterRelease) return "retryable";
  const finalAttempt = intent.finalAttempt === true;
  if (!finalAttempt) {
    const { resolveLatestWayflowGateTaskId } = await import("@cinatra-ai/a2a");
    const latestTaskId = await resolveLatestWayflowGateTaskId(run.id);
    if (latestTaskId && latestTaskId !== taskId) {
      console.warn(
        `[artifact-review-resume] gate=${gateId} run=${run.id} is claimed by this gate with nothing recorded, ` +
          `but the latest gate task is another — left for a later cycle`,
      );
      return "retryable";
    }
  }
  const released = await releaseClaimedRun(run, gateId, leaseToken, finalAttempt ? "at its last attempt" : "before its re-send");
  if (released === "lease-lost") return "lease-lost";
  if (released !== "released") return "retryable";
  if (finalAttempt) {
    console.warn(
      `[artifact-review-resume] gate=${gateId} run=${run.id} used its last attempt while it held the run; ` +
        `the run is back on this gate and the intent is left for the dead-letter pass`,
    );
    return "retryable";
  }
  return deliverWayflowResume(intent, leaseToken, lease, true);
}

/**
 * cinatra#3745: SETTLE one claimed intent that used its attempts, under the
 * lease `leaseExhaustedResumeClaims` took (no attempt used, nothing sent). Its
 * last claim died before it put the run back, so no other pass takes it:
 *   running, mark, nothing recorded   put the run back on its gate, then dead-letter
 *   running, mark, recorded           sent; its handler did not finish: renew the lease,
 *                                     replay the handler from the record (no send), bound
 *                                     to the run's gate, then read the run and the mark again
 *   any other state                   nothing of this gate to put back: dead-letter
 * After a replay, whether it returned or threw, the intent closes only when the
 * run left `running` or another driver's entry into `running` cleared the mark.
 * A run still `running` with the mark set is put back from that second read (a
 * replay can bind the run to the returned task before it throws), then the
 * intent is dead-lettered. A run with no gate task is never replayed: it is put
 * back on the mark alone. A release that moved nothing is read again: a run
 * still `running` with the mark set is left for a later settle, any other is
 * dead-lettered. A lost lease closes and dead-letters nothing; any other release
 * error leaves the intent for a later settle.
 */
async function settleExhaustedResumeClaim(
  intent: ResumeIntentRow,
  leaseMs: number,
): Promise<"delivered" | "dead-lettered" | "lease-lost" | "retryable"> {
  const { gateId, leaseToken } = intent;
  if (!leaseToken) return "lease-lost";
  const run = await readAgentRunById(intent.runId);
  const claim = await readResumeIntentClaim(gateId, leaseToken);
  if (!claim) return "lease-lost";
  /** The run read again, and whether it is still `running` under this gate's claim mark. Null: the lease is gone. */
  const readAgain = async (): Promise<{ run: AgentRunRecord | null; held: boolean } | null> => {
    const now = await readAgentRunById(intent.runId);
    const again = await readResumeIntentClaim(gateId, leaseToken);
    if (!again) return null;
    return { run: now, held: !!now && now.status === "running" && again.runClaimed };
  };
  let why: string;
  if (run && run.status === "running" && claim.runClaimed) {
    let replayed: string | null = null;
    let current: AgentRunRecord = run;
    if (claim.result !== null && run.a2aTaskId) {
      // The last claim sent and recorded, then died before its handler moved the
      // run. Replay the record as the delivery does (no send), bound to the gate
      // and execution attempt read here, under a renewed lease.
      if (!(await renewResumeIntentLease(gateId, leaseToken, leaseMs))) return "lease-lost";
      const replayGate: ResumeGateIdentity = { a2aTaskId: run.a2aTaskId, executionAttemptId: run.executionAttemptId ?? null };
      try {
        const { handleWayflowTaskState } = await import("./execution");
        await handleWayflowTaskState({
          runId: run.id, run, fromStatus: "running", task: claim.result as HandlerTask,
          authority: mintAgentRunExecutionAuthority(run.orgId), claimedGate: replayGate,
        });
        replayed = "its recorded task was replayed";
      } catch (err: unknown) {
        replayed = `the replay of its recorded task threw (${errorLabel(err)})`;
      }
      const after = await readAgain();
      if (after === null) return "lease-lost";
      if (!after.held || !after.run) {
        const marked = await markResumeIntentDelivered(gateId, leaseToken);
        console.warn(
          `[artifact-review-resume] gate=${gateId} run=${intent.runId} used its attempts after its resume was recorded: ` +
            `${replayed}; the run left running or another driver holds it; marked ${marked ? "done" : "LEASE-LOST"}`,
        );
        return marked ? "delivered" : "lease-lost";
      }
      // Put back from this read: the replay may have bound the run to the returned task.
      current = after.run;
    }
    const released = await releaseClaimedRun(current, gateId, leaseToken, "to settle its exhausted intent");
    if (released === "lease-lost") return "lease-lost";
    if (released === "failed") return "retryable";
    let where = "the run is back on its gate";
    if (released === "moved") {
      const again = await readAgain();
      if (again === null) return "lease-lost";
      if (again.held) return "retryable";
      where = `the run left running (run ${again.run?.status ?? "gone"})`;
    }
    why = claim.result === null ? where : `${replayed ?? "its recorded task was not replayed: the run names no gate task"}; ${where}`;
  } else {
    why = run ? `nothing of this gate to put back (run ${run.status})` : "the run is gone";
  }
  const dead = await deadLetterResumeIntentUnderLease(gateId, leaseToken, `resume delivery attempts exhausted; ${why}`);
  console.warn(
    `[artifact-review-resume] gate=${gateId} run=${intent.runId} used its attempts while its delivery held the run: ` +
      `${dead ? "dead-lettered" : "LEASE-LOST"}; ${why}`,
  );
  return dead ? "dead-lettered" : "lease-lost";
}

/**
 * cinatra#3745 S4: the refusal the delivery's claim of the run raises in its own
 * transaction when the claim would clear a produced-review park. Every exit from
 * `pending_approval` clears the park (cinatra#3046 leg 12), the claim included,
 * and hands what it cleared to `onParkCleared` inside the claim's transaction. A
 * run parked on its produced output's review has reached its terminal write (the
 * park withholds it), so its WayFlow work is done and no resume is owed to it.
 * And a claim that cleared the park and then went back on the gate (a failed
 * send, or the release of a later lease or of the settle after the claiming
 * worker died with nothing recorded) would leave the run `pending_approval` with
 * neither the park nor its withheld terminal write, which no drain could then
 * release. The throw rolls the claim back, so the park never leaves the row.
 */
class ParkedRunClaimRefused extends Error {
  readonly code = "produced_review_parked";
  constructor() {
    super("the run is parked on its produced output's review");
    this.name = "ParkedRunClaimRefused";
  }
}

/** The claim's `onParkCleared`: any park the claim would clear refuses the claim. */
function refuseParkedRunClaim(): never {
  throw new ParkedRunClaimRefused();
}

/** cinatra#3745: the claimed intents that used their attempts one sweep settles. */
const SETTLE_LIMIT = 20;

/** A log label for an error: its code or name, never its message. A driver error
 *  can carry the query's parameters (the lease token), a send error the message. */
function errorLabel(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code !== "") return code;
  return err instanceof Error ? err.name : typeof err;
}

/** A log text for a pre-send step that failed and a claim that could not be given
 *  back: each error's label only, never its message (a driver error's message can
 *  carry the query's parameters, the claim and lease tokens among them). */
function releaseFailureLabel(err: PauseClaimReleaseError): string {
  return (
    `the step before the send failed (${errorLabel(err.stepError)}), and the claim on this pause ` +
    `could not be given back (${errorLabel(err.releaseError)}); its lease frees itself`
  );
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

/** cinatra#3745: no witness yet; the next lease reads the run again (the attempt stays used, cinatra#4312). */
async function deferIntent(gateId: string, leaseToken: string, runId: string, why: string): Promise<ResumeDeliveryOutcome> {
  const ok = await deferResumeIntent(gateId, leaseToken);
  console.log(`[artifact-review-resume] gate=${gateId} run=${runId} ${why} — ${ok ? "left for a later lease" : "LEASE-LOST"}`);
  return ok ? "retryable" : "lease-lost";
}

async function finishDelivery(gateId: string, leaseToken: string, runId: string, what: string): Promise<ResumeDeliveryOutcome> {
  const marked = await markResumeIntentDelivered(gateId, leaseToken);
  console.log(`[artifact-review-resume] gate=${gateId} run=${runId} ${what} — marked ${marked ? "done" : "LEASE-LOST"}`);
  // cinatra#4312 — no other intent of this review is closed here: no stored row
  // tells a later pause on the same base task id from this one (its replayed
  // emission writes no new gate), so a second pending intent of the review, a
  // carrier among them, stays live and can send this review's decision again,
  // at least once, as on main for two legs decided at the same time.
  return marked ? "delivered" : "lease-lost";
}

/**
 * cinatra#4312 — is a regenerated artifact of this pause still under review? A
 * leg settled as `changes_requested` (Regenerate) is resolved, so the family can
 * read complete while the successor gate of its repair lineage is still open.
 * The run stays parked until that lineage is decided. A failed read, and a
 * lineage in a missing, malformed or unknown state (RepairLineageStateError),
 * propagates like the sibling read above: it never authorizes a resume and never
 * acknowledges this intent. Every leg settled as changes requested is read, the
 * post's own leg's too. A lineage closes on one of two kinds of road. A decision
 * on its successor gate writes its own intent, which takes the family road above
 * (the successor branch at the top of `deliverArtifactReviewResumeIntent`). A
 * close with no gate decision (escalated, stale, or the sweep's naming of a
 * reopen gate that makes the lineage read closed) inserts, in its own commit, a
 * new intent that carries the family's latest decision (lifecycle-repair-store
 * `carryDeclaredReviewDecision`). Neither road writes an intent that already
 * exists. `executor`: the run decision lock's transaction, for the re-read under
 * that lock.
 */
async function regenerationOpen(
  legs: readonly { id: string; reviewTaskId: string; disposition: string | null }[],
  reviewTaskId: string,
  executor?: GateStoreExecutor,
): Promise<boolean> {
  const base = baseReviewTaskId(reviewTaskId);
  const settled = legs.filter((g) =>
    baseReviewTaskId(g.reviewTaskId) === base && g.disposition === "changes_requested");
  if (settled.length === 0) return false;
  const { isRepairLineageOpen } = await import("./lifecycle-repair-store");
  for (const leg of settled) {
    if (await (executor ? isRepairLineageOpen(leg.id, executor) : isRepairLineageOpen(leg.id))) return true;
  }
  return false;
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
 * durable backstop for a lost/crashed one-shot delivery) until its attempts are
 * used; the sweep after that dead-letters it (cinatra#4312, the comment above
 * the dead-letter pass below).
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
  // cinatra#4312 — an intent that used its attempts (`attempts >= max_attempts`,
  // no live lease) is dead-lettered here, where ops read it, before the claim
  // below (which leaves such an intent out). Before cinatra#4312 no production
  // code ran this pass and the claim had no attempts bound, so an intent that
  // was not delivered was re-claimed after each lease expiry without a bound.
  //
  // The bound counts CLAIMS, whatever their outcome: the claim adds one to
  // `attempts` before the delivery runs. Every outcome that leaves the intent
  // for a re-claim uses an attempt: a throw (a lineage the reader refuses, a
  // send that fails), `lease-lost`, and each `retryable` road of
  // `deliverArtifactReviewResumeIntent` (no lease token, a review task id that
  // is not `wayflow-`, a run not resolvable, a run with no a2aContextId, a
  // refusal whose terminal transition did not land, an unreadable scope check,
  // an incomplete declared family, and the cinatra#3745 deferral while another
  // driver holds the run). An intent whose delivery claimed the run is bounded
  // the same way: the claim of its last attempt puts a claimed run with nothing
  // recorded back on its gate instead of a re-send, so the pass below finds
  // its run parked there. A last claim that died before it put the run back
  // leaves the mark set: the dead-letter pass leaves such an intent out, and
  // the settle pass before it leases it again, puts the run back and
  // dead-letters it (`settleExhaustedResumeClaim`). With the default
  // `max_attempts` of 20 and the default 5-minute lease, an intent that is never closed is
  // dead-lettered no sooner than about 100 minutes after its first claim (20
  // claims, each after the lease of the claim before it expired). That is
  // intended (the #2038 ceiling, artifact-review-gate-store, above
  // `deadLetterExhaustedResumeIntents`): no retryable road waits for a step
  // that comes after the decision, but one: a lineage the reader refuses until
  // the review orchestration sweep names its reopen gate (an old writer's
  // attempt on an unnamed gate). Such an intent can be dead-lettered first; the
  // naming then inserts a new intent that carries the family's latest decision,
  // whatever the status of the intent it copies (lifecycle-repair-store
  // `carryDeclaredReviewDecision`). The run's context is persisted right after
  // its initial send (the a2aContextId road above), the legs of a declared
  // family are inserted in one transaction (`emitDeclaredReviewGateFamily`),
  // and an outcome that repeats on 20 claims is a fault for ops. A
  // dead-lettered intent is not claimed again; ops read it
  // (`readDeadLetteredResumeIntents`). One road puts one back: the upgrade
  // recovery below, for the newest decision of a declared pause from before the
  // upgrade (or with an old writer's reopen attempt), once per pause, ever
  // (cinatra#4476, `declared-review-recovery.ts`). Only
  // `delivered`, `already-advanced` and `refused-out-of-scope` close an intent,
  // and no code puts a closed intent back to pending. A failed pass is tallied;
  // the claim still leaves exhausted intents out.
  // cinatra#3745: the settle pass. A failed pass, and each failed settle, is
  // tallied; the claimed intent stays out of the claim and the dead-letter
  // pass, and a later sweep settles it.
  try {
    const settling = await leaseExhaustedResumeClaims({ limit: SETTLE_LIMIT, leaseMs: opts?.leaseMs ?? DEFAULT_LEASE_MS });
    for (const intent of settling) {
      try {
        await settleExhaustedResumeClaim(intent, opts?.leaseMs ?? DEFAULT_LEASE_MS);
      } catch (err) {
        summary.failed += 1;
        console.error(`[artifact-review-resume] settle failed for gate=${intent.gateId}; left for a later settle (${errorLabel(err)})`);
      }
    }
  } catch (err) {
    summary.failed += 1;
    console.error(`[artifact-review-resume] settle pass failed (${errorLabel(err)})`);
  }
  try {
    const dead = await deadLetterExhaustedResumeIntents();
    if (dead > 0) console.warn(`[artifact-review-resume] dead-lettered ${dead} exhausted resume intent(s)`);
  } catch (err) {
    summary.failed += 1;
    console.error("[artifact-review-resume] dead-letter pass failed:", err);
  }
  // cinatra#4476 — the upgrade recovery: a declared review's pause that the
  // cinatra#4312 upgrade left with no live intent (an intent main left exhausted, or
  // a lineage an old writer left unreadable until the chain check read it) gets its
  // newest decision re-armed or carried, once per pause, ever, right before the
  // claim below takes it. It acts only after core__0127 wrote its epoch row. A pause
  // it cannot recover is logged for ops; a failed pass or pause is tallied and the
  // claim still runs (`declared-review-recovery.ts`).
  try {
    const { recoverStrandedDeclaredReviews } = await import("./declared-review-recovery");
    for (const o of await recoverStrandedDeclaredReviews()) {
      if (o.outcome === "rearmed" || o.outcome === "carried") {
        console.warn(`[artifact-review-resume] upgrade recovery ${o.outcome} run=${o.runId} review=${o.baseTaskId} gate=${o.gateId}`);
      } else if (o.outcome === "ops") {
        console.warn(
          `[artifact-review-resume] upgrade recovery cannot resume run=${o.runId} review=${o.baseTaskId}: ${o.reason}` +
            ("lineageId" in o ? ` lineage=${o.lineageId} code=${o.code}` : "") + " — for ops",
        );
      } else if (o.outcome === "failed") {
        summary.failed += 1;
        // The error's name and SQLSTATE code only: a query error's message carries the
        // query's parameters, the decision's text among them.
        console.error(
          `[artifact-review-resume] upgrade recovery failed for run=${o.runId} review=${o.baseTaskId}: error=${o.errorName}` +
            (o.errorCode ? ` code=${o.errorCode}` : ""),
        );
      }
    }
  } catch (err) {
    summary.failed += 1;
    console.error("[artifact-review-resume] upgrade recovery pass failed:", err);
  }
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

/** cinatra#4150: one pass of the publish-decision expiry on this unfenced ~30-second loop, under
 *  the loop's system dispatch authority: due decisions close and their runs stop; unmade stops finish. */
export async function sweepExpiredPublishDecisionsOnce(): Promise<void> {
  const { sweepExpiredPublishDecisions } = await import("./publish-decision-actions");
  const s = await sweepExpiredPublishDecisions({ authorityFor: mintAgentRunExecutionAuthority });
  if (s.due + s.stopped + s.failed > 0) {
    console.log(
      `[publish-decision-expiry] due=${s.due} expired=${s.expired} run_ended=${s.runEnded} lost=${s.lost} failed=${s.failed} stopped=${s.stopped}`,
    );
  }
}
