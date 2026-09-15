import "server-only";
import {
  ensureBackgroundJobRuntime,
} from "@/lib/background-jobs";
import { enqueueAgentRun } from "@/lib/agent-run-enqueue";
import { readRunTriggerPmState } from "@/lib/pm-integration-providers";
import {
  readRunTriggerByRunId,
  createOrUpdateRunTrigger,
  markTriggerFiredInDb,
  deleteRunTriggerByRunId,
  type TriggerRecord,
} from "./trigger-store";
// cinatra#2981 — the ONE serialization stop, save and this job share. See the
// module header for what a claim guarantees and where the BullMQ/Redis boundary
// puts a limit on it.
import {
  withTriggerClaim,
  TriggerClaimUnavailableError,
} from "./trigger-claim";
import { deletePmLinkByRunId } from "./pm-link-store";
import { scheduleTrigger, cancelTriggerSchedule } from "./trigger-schedule";
import { markTriggerReleased } from "./trigger-gate";

/** Stable code carried by AgentTemplateScopeError (cinatra#2485 C) — branch on
 *  the CODE, not `instanceof`, so a refusal is recognized across the dynamic
 *  import boundary the dispatch guard is reached through. */
const AGENT_TEMPLATE_SCOPE_DENIED_CODE = "AGENT_TEMPLATE_SCOPE_DENIED";
const isScopeDenial = (err: unknown): err is { reason: string } =>
  (err as { code?: string } | null)?.code === AGENT_TEMPLATE_SCOPE_DENIED_CODE;
import {
  transitionRunStatus,
  RunTransitionError,
  readAgentRunById,
  readAgentTemplateById,
} from "./store";
import {
  advanceAgentRun,
  clearRunLifecycleMoment,
  launchAgentRun,
} from "./lifecycle-coordinator";
// cinatra#1939 wave 2 (§2b): this scheduler has NO session — it mints the
// SYSTEM `agent-run-dispatch` authority (run.execute + run.complete) per fire to
// ground the run's armed/pending→queued/stopped transitions, scoped to the run's
// own org.
import { mintTriggerReleaseAuthority } from "@/lib/org-write/agent-run-authority-mint";
// cinatra#1940 P3 (Decision 1): the archived-org pre-check, consulted BEFORE
// any fire side-effect (routing/UX only — the kernel's run.execute ruling on
// the guarded create/transition below is the enforcement point).
import { readOrgArchivedAtForDispatch } from "@/lib/org-write/dispatch-freeze";

// ---------------------------------------------------------------------------
// runAgentRunTriggerReleaseJob
// ---------------------------------------------------------------------------
// BullMQ worker handler for AGENT_RUN_TRIGGER_RELEASE.
//
// Fired by:
//  - one-shot delayed job (triggerType: "scheduled") when the delay elapses
//  - JobScheduler (triggerType: "recurring") on each cron tick
//
// Behavior:
//   triggerType "scheduled" / "immediate":
//     1. Mark the trigger released (Redis flag + DB releasedAt).
//     2. Transition the run from `armed` → `queued`.
//     3. Enqueue an AGENT_BUILDER_EXECUTION job for the same runId.
//
//   triggerType "recurring":
//     Each cron tick creates a NEW pending run (clone of the schedule-defining
//     run's templateId + inputParams + runBy) and arms it as immediate. The
//     original schedule-defining run stays in its current status. The
//     JobScheduler refires automatically on the next cron tick.
//
//   trigger.enabled === false at fire time:
//     Unschedule (recurring) and skip release. Re-read enabled at fire time;
//     never trust the scheduler-time snapshot.
//
// Idempotent: Redis SET + DB UPDATE are both safe to write twice; the
// armed→queued CAS swallows stale_from_status (twin-fire window).
// ---------------------------------------------------------------------------

export async function runAgentRunTriggerReleaseJob(
  data: { runId: string },
  _jobId: string,
): Promise<void> {
  const trigger = await readRunTriggerByRunId(data.runId);
  if (!trigger) {
    console.warn(
      `[trigger-release] no trigger row for run ${data.runId} — skipping`,
    );
    return;
  }

  // enabled: false → unschedule + skip release.
  // The LOCAL `!enabled` short-circuit stays the immediate skip and runs BEFORE
  // the PM check: a locally-disabled trigger is authoritative without consulting
  // PM (and a 'paused' PM result must NOT collide with this — see below).
  if (!trigger.enabled) {
    console.log(
      `[trigger-release] trigger disabled for run ${data.runId} — unscheduling`,
    );
    if (trigger.triggerType === "recurring" && trigger.jobSchedulerId) {
      const runtime = await ensureBackgroundJobRuntime();
      await runtime.queue.removeJobScheduler(trigger.jobSchedulerId);
    }
    return;
  }

  // ---------- Pre-execution PM check (cinatra#319) ----------
  // BEFORE firing, consult PM-side state so a PM-side delete / reschedule / pause
  // is honored at fire time. FAIL-OPEN: the bridge NEVER throws and classifies
  // every outage as no-provider / no-link / unreachable; those proceed to fire.
  // Only definitive PM signals (deleted / paused / rescheduled) alter the fire.
  // ALL local side-effects below are wrapped so a failure logs + falls through
  // to FIRE — a PM glitch must never strand the run.
  const pmAction = await checkPmStateBeforeFire(trigger, data.runId);
  if (pmAction === "skip") {
    // The PM handler already performed its teardown/refresh and decided this
    // fire should not happen (deleted / paused / rescheduled). Stop here.
    return;
  }
  // pmAction === "fire" → fall through to the normal release logic below.

  // Read the run ONCE, reused by BOTH the fire gate below AND the recurring
  // clone (avoids a second readAgentRunById round-trip). Null for a scheduled/
  // immediate run whose row is absent is tolerated by the armed→queued CAS.
  const runForFire = await readAgentRunById(data.runId);

  // ---------- Dispatch-freeze pre-check (cinatra#1940 P3, Decision 1) ----------
  // Checked BEFORE any side-effect below: markTriggerReleased (either branch),
  // the recurring clone's createAgentRunPendingInput, and createOrUpdateRunTrigger.
  // A skip here never throws (a throw would BullMQ-retry a deterministic
  // refusal) — leaving the run `armed` with the gate closed IS the freeze; on
  // unarchive a later tick / manual re-release fires it normally. Fail-open on
  // `null` (unknown) — this is routing/UX, not the enforcement point (the
  // guarded create/transition below is the kernel backstop for the race
  // window between this read and that write).
  if (runForFire?.orgId) {
    const archived = await readOrgArchivedAtForDispatch(runForFire.orgId);
    if (archived === true) {
      console.log(
        `[trigger-release] run ${data.runId} org ${runForFire.orgId} is archived — skipping fire (audited)`,
      );
      try {
        const { logAuditEvent, POLICY_VERSION } = await import("@/lib/authz");
        void logAuditEvent({
          actorPrincipalId: runForFire.runBy ?? undefined,
          actorPrincipalType: "system",
          authSource: "scheduler",
          resourceType: "agent_run",
          resourceId: runForFire.id,
          operation: "create",
          decision: "denied",
          policyVersion: POLICY_VERSION,
          runId: runForFire.id,
          organizationId: runForFire.orgId,
          metadata: { via: "trigger-fire", reason: "org-archived" },
        });
      } catch (auditErr) {
        console.warn(
          `[trigger-release] archived-org fire-gate audit write failed for run ${data.runId} (continuing):`,
          auditErr instanceof Error ? auditErr.message : auditErr,
        );
      }
      return;
    }
  }

  // ---------- Configuration-needs FIRE gate (cinatra #1057 ruling (b)) ----------
  // A scheduled/recurring trigger must NOT fire an agent whose REQUIRED
  // connectors are not configured for its owner. Re-checked HERE, at FIRE time,
  // so a trigger armed earlier (or a recurring tick) does not fire once a
  // connection is later removed. FAIL-CLOSED on a determinate unconfigured
  // result: do NOT release the gate, do NOT enqueue/clone; leave the run armed
  // for a later tick (recurring) / a re-arm, and AUDIT why. FAIL-OPEN on a thrown
  // infra error only — a glitch must never strand the run (matches this job's
  // local-side-effect philosophy). Covers BOTH branches below (recurring source
  // run + scheduled/immediate).
  if (runForFire) {
    const fireBlock = await agentRunConfigBlockForTrigger(runForFire);
    if (fireBlock) {
      console.warn(
        `[trigger-release] run ${data.runId} NOT fired — required connections unconfigured: ${fireBlock.unconfiguredConnectors
          .map((c) => c.displayName)
          .join(", ")} (leaving armed; audited)`,
      );
      return;
    }
  }

  // ---------- Recurring branch ----------
  // Each cron tick creates a fresh pending run + arms it as immediate. The
  // schedule-defining run stays in whatever status it was in (typically still
  // `queued` if it has yet to start, or terminal). Recurring ticks DO NOT
  // re-release the schedule-defining run — gates are monotonic per-run.
  if (trigger.triggerType === "recurring") {
    // THE FIRE DECISION IS TAKEN UNDER THE CLAIM (cinatra#2981).
    //
    // This branch used to re-read the row HERE, immediately before the clone, to
    // catch a **Cancel schedule** that landed while the tick worked through its
    // pre-flight (the PM check, the archived-org read, the configuration-needs
    // gate — all awaits). That read closed the ordinary case and said so in as
    // many words: "a stop landing between this read and the launch below is
    // still a tick that fires. Closing that needs a row lock or a conditional
    // write."
    //
    // This is that write. The re-read now happens INSIDE the trigger claim, and
    // the launch happens inside it too, so the two are ONE decision: a stop
    // either commits before this tick takes the claim — and the tick reads the
    // stamp and refuses — or it waits for the claim and commits after this
    // tick's copy, stopping everything from there on. There is no longer an
    // interval in which a stop commits and a copy is launched anyway.
    //
    // Everything the claim does not need is hoisted ABOVE it, so the section
    // held is only the decision and the act: the source-run checks and the
    // authority mint below take no locks and read nothing a stop can change.
    const sourceRun = runForFire;
    if (!sourceRun) {
      console.warn(
        `[trigger-release] recurring source run ${data.runId} disappeared — skipping tick`,
      );
      return;
    }
    // Defense in depth: TS says sourceRun.orgId is `string` because the column
    // is NOT NULL, so this branch is structurally unreachable in TS-only flows.
    // Kept as a runtime guard so a raw-SQL test fixture, manual DB edit, or
    // otherwise corrupt row that bypasses Drizzle's typing surfaces a clean
    // warn-and-skip rather than poisoning the cron queue with a doomed insert.
    // This matches the existing `if (!sourceRun)` skip-with-warn pattern;
    // throwing would poison the queue.
    if (!sourceRun.orgId) {
      console.warn(
        `[trigger-release] recurring source run ${data.runId} has null org_id — skipping tick`,
      );
      return;
    }
    // Clone: same templateId + inputParams + runBy + orgId + projectId.
    // createAgentRunPendingInput mints a new id and returns the row in
    // pending_input status. Propagate orgId so the cloned run preserves tenant
    // scope, AND projectId so the run stays project-scoped — the clone otherwise
    // dropped it, silently widening the run out of its project. Copying projectId
    // also makes the pre-dispatch creator re-derive the same OBO scope-ceiling
    // ANCHOR as the schedule-defining run (the template owner anchor is locked
    // after first run).
    //
    // "THE SAME ANCHOR" IS NOT "THE SAME CEILING", and this note used to say the
    // stronger thing. A run that was itself dispatched UNDER a parent carries a
    // COMPOSED chain narrower than its own anchor, and a copy derived from
    // template and project alone does not inherit that narrowing — the
    // pre-dispatch creator takes no parent chain at all. Every tick has worked
    // this way since recurring schedules existed and this change does not widen
    // it; what changed is that the comment no longer claims otherwise. Threading
    // the source run's persisted chain through the copy is a change to the
    // creator's own inputs and belongs with the epic's review-core wave.
    // cinatra#1940 P3 (Decision 2): mint BEFORE the clone insert — the
    // creation perimeter is now guarded, so the authority must exist before
    // createAgentRunPendingInput runs (was previously minted only after, for
    // the transition below). The clone shares sourceRun.orgId (non-null,
    // checked above == newRun.orgId).
    const releaseAuthority = mintTriggerReleaseAuthority(sourceRun.orgId);
    try {
      await withTriggerClaim(data.runId, async (stillLive) => {
        // THE CLAIMED ROW DECIDES, INCLUDING ITS KIND (cinatra#2981). This
        // tick chose the recurring branch from the row
        // it read at the top of the job; a save can have replaced that schedule
        // with a one-off while this tick waited for the claim, and firing a
        // recurring COPY from a row that is now a one-off would start a run
        // nobody's schedule asks for. A tick whose kind no longer matches is
        // stale, and a stale tick does nothing.
        if (
          !stillLive ||
          stillLive.stoppedAt ||
          !stillLive.enabled ||
          stillLive.triggerType !== "recurring"
        ) {
          console.log(
            `[trigger-release] recurring schedule for run ${data.runId} was stopped or replaced while this tick was preparing — not firing`,
          );
          // AND THE ORPHAN REMOVES ITSELF. Two ways a scheduler outlives its
          // stop: its cancel failed inside `stopRecurringTriggerForActor`
          // (which stamps the row first and treats the cancel as best-effort),
          // or a Save changes held the claim and installed a fresh one before
          // the stop could take it. Either way THIS tick is the first thing to
          // notice, so it tears the scheduler down rather than leaving it to
          // tick forever into a skip. Best-effort and never fatal: the refusal
          // above is the safety property, and this is only tidying.
          if (stillLive?.stoppedAt && stillLive.jobSchedulerId) {
            try {
              const runtime = await ensureBackgroundJobRuntime();
              await runtime.queue.removeJobScheduler(stillLive.jobSchedulerId);
            } catch (err) {
              console.warn(
                "[trigger-release] could not unschedule the orphan of a stopped schedule for run",
                data.runId,
                err,
              );
            }
          }
          return;
        }
        // A RECURRING TICK IS A LAUNCH, not a release (cinatra#2928): each tick is a
        // FRESH copy of the run, so it goes through the coordinator's launch entry
        // like every other way of starting an agent. It stays headless — nobody is
        // present for a schedule firing, so no moment applies and the schedule the
        // run was given is what applies. The dispatch stays here because this branch
        // arms the copy's own immediate trigger and opens its gate first.
        const launched = await launchAgentRun({
          producer: "recurring_trigger_tick",
          frame: null,
          authority: releaseAuthority,
          create: {
            kind: "pre_dispatch",
            input: {
              templateId: sourceRun.templateId,
              runBy: sourceRun.runBy,
              orgId: sourceRun.orgId,
              inputParams: sourceRun.inputParams ?? {},
              projectId: sourceRun.projectId,
            },
          },
          dispatch: {
            kind: "await_trigger",
            why: "the copy is armed as immediate and its gate opened below before it is enqueued",
          },
        });
        if (launched.carrier.kind !== "run") {
          throw new Error("the recurring tick's launch answered with a carrier that is not a run");
        }
        const newRun = launched.carrier.run;
        // Arm the new run as immediate so the gate opens at run-start.
        // We call createOrUpdateRunTrigger directly here (we are inside the worker
        // — no actor context). The setRunTriggerForActor service is for
        // user-initiated changes; recurring ticks are system-initiated.
        await createOrUpdateRunTrigger({
          runId: newRun.id,
          triggerType: "immediate",
          timezone: trigger.timezone,
          enabled: true,
          jobSchedulerId: null,
        });
        await markTriggerReleased(newRun.id);
        // …and the copy is RELEASED through advance, so a tick's two halves — the
        // fresh run and letting it go — are the same two entries every other surface
        // uses. The coordinator clears the moment before the run moves, so a copy
        // cannot start while still stating one.
        await advanceAgentRun({
          run: newRun,
          release: {
            reason: "trigger_fired",
            from: "pending_input",
            to: "queued",
            dispatch: { kind: "enqueue", options: { jobId: `agent-builder-${newRun.id}` } },
          },
          authority: releaseAuthority,
        });
        // THE SCHEDULE HAS NOW FIRED (cinatra#2972). Stamped AFTER the copy is
        // launched, so the stamp means what it says: this schedule has produced at
        // least one run. Plan (A) §7.2 as amended 2026-08-25 keys two readings to
        // it — the scheduler stays editable for a recurring schedule that has fired
        // once, and **Cancel schedule** is shown "only for a recurring schedule
        // that has fired once".
        //
        // NOT `markTriggerReleased`. That stamp opens the schedule-defining run's
        // OWN side-effect gate, and this branch's whole contract is that it does not
        // ("Recurring ticks DO NOT re-release the schedule-defining run — gates are
        // monotonic per-run", above). A separate column is what lets the card read
        // "has fired" without the gate moving.
        //
        // Best-effort: the copy is already running, so a failed stamp must not
        // poison the cron queue or double-fire the tick on a BullMQ retry. The cost
        // of a missed stamp is a Cancel schedule control that appears one tick late.
        try {
          await markTriggerFiredInDb(data.runId);
        } catch (err) {
          // LOUD. A lost stamp leaves a schedule that HAS fired reading as one
          // that has not, which withholds **Cancel schedule** until the next tick —
          // a long time on a monthly or yearly schedule. Nothing downstream repairs
          // it, so it is an error rather than a note. It is still swallowed: the
          // copy is already running, and rethrowing would have BullMQ retry the
          // whole tick and fire a second run.
          console.error(
            "[trigger-release] recurring fire stamp FAILED — the schedule fired but will read as unfired until the next tick, for run",
            data.runId,
            err,
          );
        }
        console.log(
          `[trigger-release] recurring tick — created new run ${newRun.id} from ${data.runId}`,
        );
      });
    } catch (err) {
      if (err instanceof TriggerClaimUnavailableError) {
        // Somebody else is deciding about this schedule right now. SKIPPING is
        // the safe answer for a tick: nothing is written, the scheduler stays,
        // and the next tick asks again against whatever that writer left. A
        // throw would have BullMQ retry the whole tick, which is the one thing
        // a fire path must not do on an ambiguous outcome.
        console.warn(
          "[trigger-release] recurring tick for run",
          data.runId,
          "could not take the trigger claim — skipping this tick",
        );
        return;
      }
      throw err;
    }
    // The JobScheduler refires automatically on next cron tick.
    return;
  }

  // ---------- Scheduled / immediate branch ----------
  // Open the gate, transition armed → queued, enqueue execution.
  //
  // THE GATE OPENS UNDER THE CLAIM (cinatra#2981), AND THAT IS THE FIX FOR THE
  // ONE WINDOW THAT COULD ACTUALLY FIRE A STOPPED SCHEDULE. This branch had no
  // `stopped_at` check at all — the stop re-read lived entirely inside the
  // recurring branch above — so a row a racing save had switched from recurring
  // to one-off carried the stop stamp, read `enabled: true`, and was released
  // and dispatched anyway. That is a run the person never stopped, started from
  // a schedule they did. The claim makes the check and the release ONE decision,
  // and it reads the SAME two columns the recurring branch reads, so "stopped"
  // means one thing on both paths.
  //
  // THE DISPATCH STAYS OUTSIDE THE CLAIM, deliberately. Opening the gate IS the
  // commit of this fire: a stop arriving after it is, by definition, after the
  // schedule fired, and holding the claim across the armed→queued transition and
  // the BullMQ enqueue would stretch it over a network round-trip without buying
  // a guarantee — the claim serializes decisions, not the queue (see
  // trigger-claim.ts on that boundary).
  let gateOpened: boolean;
  try {
    gateOpened = await withTriggerClaim(data.runId, async (live) => {
      // Same three questions the recurring branch asks of the CLAIMED row, plus
      // the same kind check: a one-off job that was
      // dequeued before a save turned this schedule recurring is stale, and
      // opening the gate for it would release a run the recurring schedule
      // never meant to release.
      if (
        !live ||
        live.stoppedAt ||
        !live.enabled ||
        live.triggerType === "recurring"
      ) {
        console.log(
          `[trigger-release] one-off schedule for run ${data.runId} reads stopped, disabled or replaced — not releasing`,
        );
        return false;
      }
      await markTriggerReleased(data.runId);
      return true;
    });
  } catch (err) {
    if (err instanceof TriggerClaimUnavailableError) {
      // A ONE-OFF MUST NOT SWALLOW THIS (cinatra#2981). Returning
      // normally would COMPLETE the single delayed job that is this schedule's
      // only chance to fire, leaving the run armed forever with nothing left to
      // release it. Rethrowing fails the attempt instead, which is what the
      // `attempts`/`backoff` this schedule is now enqueued with are for — and
      // if every attempt loses the claim, the job lands in the failed set where
      // it is visible and re-armable, rather than reading as a fire that
      // happened. Nothing was written either way.
      console.warn(
        "[trigger-release] one-off fire for run",
        data.runId,
        "could not take the trigger claim — failing this attempt so the delayed job retries",
      );
    }
    throw err;
  }
  if (!gateOpened) return;
  console.log(`[trigger-release] released gate for run ${data.runId}`);

  // A vanished run row (the old CAS tolerated this as a 0-row stale) means there
  // is nothing to fire — skip cleanly (matches the prior stale-swallow return).
  if (!runForFire) {
    console.log(`[trigger-release] run ${data.runId} row absent — skipping fire`);
    return;
  }
  const releaseAuthority = mintTriggerReleaseAuthority(runForFire.orgId);
  // A ONE-OFF FIRING IS ADVANCE (cinatra#2928): the run already exists and is
  // parked at its schedule moment, and the schedule is what says to let it go.
  //
  // THE ENQUEUE STAYS BELOW rather than riding the release, because this branch
  // already carries its own compensation for the one failure it treats as
  // terminal — a scope denial, which fails the run rather than returning it to a
  // wait it has no schedule left to be released from.
  //
  // A TRANSIENT ENQUEUE FAILURE IS THE JOB'S RETRY, which is why this branch
  // wants none of the coordinator's compensation. BullMQ re-runs this job; the
  // re-run finds the run already `queued`, so the `armed → queued` release LOSES
  // its race — and the retry still has to re-enqueue.
  //
  // THE LOST RACE THEREFORE THROWS rather than answering. `onLostRace: "answer"`
  // reports the state it re-read and RETURNS NORMALLY, which reads the retry
  // correctly and reads every other loser wrong: a run cancelled to `stopped`
  // before its instant, or one that was never armed, would fall straight through
  // to the enqueue below and have its moment wiped by a job that released
  // nothing. The coordinator's own note says which shape this is — a caller that
  // has to know WHICH writer won asks it to throw — and the re-read below is what
  // this branch decides on:
  //
  //   • the run reads `queued` — an earlier fire (or its own retry) already
  //     released it and the execution job did not stick. Re-enqueue: the job id
  //     is derived from the run id, so BullMQ collapses the duplicate, and a
  //     `queued` run with no job behind it is the one state nothing recovers
  //     from on its own.
  //   • the run reads ANYTHING ELSE — stopped, still pre-dispatch, already
  //     finished, or gone. This job released nothing, so it enqueues nothing and
  //     never reaches the clear at the end of this function: the moment on that
  //     run states what its own writer is waiting at, and is not this fire's to
  //     take off.
  try {
    await advanceAgentRun({
      run: runForFire,
      release: {
        reason: "trigger_fired",
        from: "armed",
        to: "queued",
        dispatch: { kind: "caller_dispatches", why: "the scope-denial compensation below owns this enqueue" },
        onLostRace: "throw",
      },
      authority: releaseAuthority,
    });
  } catch (err) {
    if (!(err instanceof RunTransitionError && err.code === "stale_from_status")) {
      throw err;
    }
    // The run id is request-influenced, so it stays a discrete ARGUMENT and is
    // never interpolated into a format string (CodeQL js/tainted-format-string).
    const afterTheRace = await readAgentRunById(data.runId);
    if (afterTheRace?.status !== "queued") {
      console.log(
        "[trigger-release] run",
        data.runId,
        `was not released by this fire (it reads ${afterTheRace?.status ?? "absent"}) — skipping the execution enqueue, and leaving the moment to whoever owns the run now`,
      );
      return;
    }
    console.log(
      "[trigger-release] run",
      data.runId,
      "was already released before this fire — re-enqueueing its execution (the job id collapses the duplicate)",
    );
  }

  // Enqueue the actual execution job. Idempotent on jobId — re-enqueue is safe
  // if BullMQ has already accepted a job with the same id.
  //
  // cinatra#2485 C — COMPENSATION on a scope denial. The run is already `queued`
  // above, and `enqueueAgentRun` re-asserts the dispatch guard: if the agent's
  // scope changed between the transition's own guard and this one, the enqueue
  // throws and the run would otherwise sit `queued` forever with no job. Landed
  // here (not inside the enqueue chokepoint) because this frame already holds
  // `releaseAuthority` — the chokepoint is deliberately not allowed to mint one
  // (org-write-boundary-gate R2/R5). Same shape as `releaseTriggerNow`.
  try {
    await enqueueAgentRun(
      { runId: data.runId },
      { jobId: `agent-builder-${data.runId}` },
    );
  } catch (err) {
    if (!isScopeDenial(err)) throw err;
    console.warn(
      "[trigger-release] run",
      data.runId,
      `refused — the agent's scope no longer authorizes this run (${err.reason}); failing it`,
    );
    try {
      await transitionRunStatus(
        data.runId,
        "queued",
        "failed",
        {
          error:
            `run refused: the agent's scope no longer authorizes this run (${err.reason})`,
        },
        releaseAuthority,
      );
    } catch (compErr) {
      if (
        !(compErr instanceof RunTransitionError && compErr.code === "stale_from_status")
      ) {
        console.error(
          "[trigger-release] run",
          data.runId,
          "was refused but could not be failed — it stays queued with no job:",
          compErr instanceof Error ? compErr.message : String(compErr),
        );
      }
    }
    return;
  }
  // DISPATCHED — the schedule moment this run was waiting at is over
  // (cinatra#2928). Here rather than inside the release, because this branch
  // owns its own enqueue: a clear made before the dispatch answered would be
  // lost to the scope-denial compensation above, and a run failed for scope
  // should keep the record of what it was waiting at.
  await clearRunLifecycleMoment(data.runId, releaseAuthority);
  console.log(`[trigger-release] enqueued execution for run ${data.runId}`);
}

// ---------------------------------------------------------------------------
// agentRunConfigBlockForTrigger — the cinatra #1057 (b) fire-time run gate
// ---------------------------------------------------------------------------
// Resolves the run's agent package (from the ALREADY-read run row) and
// re-evaluates the shared configuration-needs run gate (src/lib/agent-run-
// readiness) scoped to the run's OWNER (`runBy`). Returns the structured refusal
// (naming each unconfigured connector) when the agent must NOT fire, else null.
// On a determinate block it also emits a `denied` audit event (decision-record
// of the skipped fire — "do not fire and audit why"). FAIL-OPEN on any thrown
// infra error (returns null → fire) so a canonical-store / import glitch never
// strands the run; the primitive-level gates are the backstop. Dynamic imports
// mirror the established @/lib boundary break used across this package.
async function agentRunConfigBlockForTrigger(run: {
  id: string;
  templateId: string;
  runBy: string | null;
  orgId?: string | null;
}): Promise<{
  unconfiguredConnectors: { displayName: string; packageName: string }[];
} | null> {
  try {
    const template = await readAgentTemplateById(run.templateId);
    if (!template?.packageName) return null;

    const { assertAgentRunReadyByPackage } = await import("@/lib/agent-run-readiness");
    const block = await assertAgentRunReadyByPackage(
      template.packageName,
      template.packageName,
      { userId: run.runBy ?? null },
    );
    if (!block) return null;

    // Decision record: the fire was refused because required connections are
    // unconfigured. Best-effort — never let an audit-write failure change the
    // fire decision.
    try {
      const { logAuditEvent, POLICY_VERSION } = await import("@/lib/authz");
      void logAuditEvent({
        actorPrincipalId: run.runBy ?? undefined,
        actorPrincipalType: "system",
        authSource: "scheduler",
        resourceType: "agent_run",
        resourceId: run.id,
        operation: "create",
        decision: "denied",
        policyVersion: POLICY_VERSION,
        runId: run.id,
        organizationId: run.orgId ?? undefined,
        metadata: {
          via: "trigger-fire",
          reason: block.code,
          connectors: block.unconfiguredConnectors.map((c) => c.packageName),
        },
      });
    } catch (auditErr) {
      console.warn(
        `[trigger-release] config-needs fire-gate audit write failed for run ${run.id} (continuing):`,
        auditErr instanceof Error ? auditErr.message : auditErr,
      );
    }
    return { unconfiguredConnectors: block.unconfiguredConnectors };
  } catch (err) {
    console.warn(
      `[trigger-release] config-needs fire gate errored for run ${run.id} — firing anyway (fail-open):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// checkPmStateBeforeFire — the cinatra#319 pre-execution PM consult
// ---------------------------------------------------------------------------
// Reads PM-side state (via the host bridge, which NEVER throws and classifies
// every outage as a fail-open kind) and applies the PM-authoritative decision:
//
//   no-provider | no-link | unreachable | present → "fire" (proceed; warn on
//       unreachable). The PM side has nothing decisive to say, or agrees → fire.
//
//   deleted     → tear the schedule down + delete the local trigger row + the
//       pm-link row + transition the run armed→stopped, then "skip" — the
//       upstream task is gone. RECURRING removes the JobScheduler (distinct from
//       the active tick). A scheduled ONE-SHOT is NOT cancelled here: it is THIS
//       active, locked job and self-completes on "skip" (removing an active job
//       would throw → spurious FIRE).
//
//   paused      → "skip" THIS fire only. Leave the schedule in place and DO NOT
//       mutate local `enabled` (persisting enabled=false would collide with the
//       pre-PM `!enabled` short-circuit + the recurring scheduler removal — keep
//       it purely PM-authoritative per tick).
//
//   rescheduled → "skip" this tick — never fire the OLD tick after learning of a
//       change (refresh-then-skip). RECURRING re-arms via scheduleTrigger/
//       upsertJobScheduler with the PM cron + persists it. A scheduled ONE-SHOT
//       in the FUTURE is NOT re-armed inline (the in-flight deterministic-id job
//       is active + retained, so re-add would no-op/diverge); instead it PERSISTS
//       the new instant + clears releasedAt + skips, and the reconcile loop
//       (#318) re-arms the delayed job. now/past → fire.
//
// FAIL-OPEN SIDE-EFFECTS: every local mutation here is wrapped — on ANY failure
// we log and return "fire" so a transient local error never strands the run; the
// reconcile loop (#318) repairs the residual state.
// ---------------------------------------------------------------------------
/**
 * The trigger row's own revision stamp (cinatra#2981).
 *
 * Every writer of this row moves `updated_at` — the save's upserts, the stop,
 * the released and fired stamps — so an UNCHANGED stamp is the cheapest true
 * answer to "did anybody change this schedule while we were away?", and it
 * needs no new column. `null` when the row is absent or carries no stamp; two
 * unknowns compare equal, because an unknown revision on both sides is not
 * evidence that anything changed.
 */
function triggerRevision(row: TriggerRecord | null): number | null {
  return row?.updatedAt instanceof Date ? row.updatedAt.getTime() : null;
}

async function checkPmStateBeforeFire(
  trigger: TriggerRecord,
  runId: string,
): Promise<"fire" | "skip"> {
  // THE REVISION THIS DECISION IS ABOUT. Captured before the remote PM read,
  // which is the asynchronous gap a concurrent save can land in: every local
  // mutation below is derived from THIS schedule, so applying one to a row that
  // has since been rewritten would delete or overwrite the schedule somebody
  // just saved. Each claim below re-reads and refuses on a moved stamp.
  const decisionRevision = triggerRevision(trigger);
  const pm = await readRunTriggerPmState({
    runId,
    triggerType: trigger.triggerType,
    localCronExpression: trigger.cronExpression,
    localScheduledAt: trigger.scheduledAt
      ? trigger.scheduledAt.toISOString()
      : null,
  });

  switch (pm.kind) {
    case "no-provider":
    case "no-link":
    case "present":
      // Nothing PM-decisive — fire normally.
      return "fire";

    case "unreachable":
      // PM outage / misconfigured provider → fail-open proceed (warn).
      console.warn(
        `[trigger-release] PM pre-exec read unreachable for run ${runId} (firing anyway): ${pm.reason}`,
      );
      return "fire";

    case "deleted": {
      console.log(
        `[trigger-release] PM task for run ${runId} was DELETED upstream — tearing down local schedule + skipping`,
      );
      try {
        // THE LOCAL TEARDOWN TAKES THE SAME CLAIM (cinatra#2981). This
        // handler is the FOURTH writer of the trigger row, and
        // it runs BEFORE the fire decision — so without the claim a stop landing
        // between its own reads and these writes was the same race again, with
        // the same forbidden outcome. Under the claim the live row decides, and
        // a schedule somebody has already stopped is left exactly as they left
        // it: a stop is not a delete, and a PM-side delete must not take away
        // the stopped schedule they are owed a reading of.
        const tornDown = await withTriggerClaim(runId, async (live) => {
          if (!live) return "gone" as const;
          if (live.stoppedAt) return "stopped" as const;
          if (triggerRevision(live) !== decisionRevision) return "changed" as const;
          // Tear down the FUTURE schedule. For recurring this removes the
          // JobScheduler (distinct from this active tick — safe). For a scheduled
          // ONE-SHOT we must NOT cancel here: the delayed job has ALREADY fired
          // (it is THIS active, locked job) — `getJob(id).remove()` on an active
          // job throws, which the catch below would turn into a spurious FIRE,
          // defeating the delete (#319). The one-shot self-completes when we
          // return "skip"; only the local rows need cleanup.
          if (live.triggerType === "recurring") {
            await cancelTriggerSchedule({
              jobSchedulerId: live.jobSchedulerId,
              triggerType: "recurring",
            });
          }
          await deleteRunTriggerByRunId(runId);
          await deletePmLinkByRunId(runId);
        // Mirror the local-delete path (deleteRunTriggerForActor): a deleted
        // schedule must not leave the run stuck in `armed` with no trigger row
        // or job to ever release it (codex#319). Transition armed → stopped;
        // swallow stale_from_status (the run was never armed / already moved on,
        // e.g. a recurring schedule-defining run that is queued/terminal). A
        // vanished run row (null) means nothing to stop — skip (the old CAS
        // tolerated this as a 0-row stale-swallow). cinatra#1939: mint the
        // per-fire system authority scoped to this run's org.
          const runRow = await readAgentRunById(runId);
          if (runRow) {
            const teardownAuthority = mintTriggerReleaseAuthority(runRow.orgId);
            try {
              await transitionRunStatus(runId, "armed", "stopped", undefined, teardownAuthority);
            } catch (err) {
              if (
                !(err instanceof RunTransitionError && err.code === "stale_from_status")
              ) {
                throw err;
              }
              console.log(
                `[trigger-release] run ${runId} not armed on PM-delete — leaving status as-is`,
              );
            }
          }
          return "done" as const;
        });
        if (tornDown !== "done") {
          console.log(
            `[trigger-release] PM delete for run ${runId} found the local schedule already`,
            tornDown,
            "— leaving it as it stands and skipping this fire (a stop, a delete or a save got there first)",
          );
          return "skip";
        }
      } catch (err) {
        // A local teardown glitch must not strand the run — fall through to FIRE.
        console.warn(
          "[trigger-release] PM-delete teardown failed for run",
          runId,
          "— firing anyway:",
          err,
        );
        return "fire";
      }
      return "skip";
    }

    case "paused": {
      // Skip THIS fire only. Do NOT mutate local enabled or remove the schedule
      // — the next tick re-checks PM (PM-authoritative per tick). No local writes.
      console.log(
        `[trigger-release] PM task for run ${runId} is PAUSED — skipping this fire (schedule left intact)`,
      );
      return "skip";
    }

    case "rescheduled": {
      try {
        if (trigger.triggerType === "recurring") {
          // Refresh the recurring schedule to the PM cron, persist it, skip this
          // tick. A rescheduled recurring with no PM cron is incoherent — treat
          // a null cron as "nothing to refresh" and fire normally.
          if (!pm.cronExpression) {
            console.warn(
              `[trigger-release] PM reschedule for recurring run ${runId} had no cron — firing this tick`,
            );
            return "fire";
          }
          // UNDER THE CLAIM (cinatra#2981): this
          // upsert writes `enabled: true`, and the store deliberately leaves
          // `stopped_at` alone — so a stop landing beside it produced exactly
          // the stopped-AND-enabled row this issue exists to make impossible.
          const refreshed = await withTriggerClaim(runId, async (live) => {
            if (!live || live.stoppedAt) return false;
            if (triggerRevision(live) !== decisionRevision) return false;
            const result = await scheduleTrigger({
              runId,
              triggerType: "recurring",
              cronExpression: pm.cronExpression!,
              timezone: trigger.timezone,
            });
            await createOrUpdateRunTrigger({
              runId,
              triggerType: "recurring",
              cronExpression: pm.cronExpression!,
              timezone: trigger.timezone,
              enabled: true,
              jobSchedulerId: result.jobSchedulerId,
            });
            return true;
          });
          if (!refreshed) {
            console.log(
              `[trigger-release] PM rescheduled recurring run ${runId}, but the local schedule was stopped, removed or changed meanwhile — leaving it as it stands and skipping this tick`,
            );
            return "skip";
          }
          console.log(
            `[trigger-release] PM rescheduled recurring run ${runId} to cron "${pm.cronExpression}" — refreshed + skipping this tick`,
          );
          return "skip";
        }

        // Scheduled one-shot: if the new instant is in the FUTURE, persist it +
        // skip (reconcile #318 re-arms — see below); if now/past, fire this tick.
        const newAtMs = pm.scheduledAt ? Date.parse(pm.scheduledAt) : NaN;
        if (!pm.scheduledAt || Number.isNaN(newAtMs)) {
          console.warn(
            `[trigger-release] PM reschedule for scheduled run ${runId} had no valid instant — firing this tick`,
          );
          return "fire";
        }
        // A 1s floor mirrors scheduleTrigger's past-time guard — an instant
        // effectively "now" should fire, not be re-armed into an immediate error.
        const newDelay = newAtMs - Date.now();
        if (newDelay < 1000) {
          console.log(
            `[trigger-release] PM rescheduled scheduled run ${runId} to a now/past instant — firing this tick`,
          );
          return "fire";
        }
        // Scheduled ONE-SHOT moved to a FUTURE instant. We deliberately do NOT
        // re-arm a BullMQ job inline here (codex#319): the in-flight job IS the
        // deterministic-id one-shot (`trigger-release-{runId}`), it is ACTIVE and
        // self-completes on this "skip", and BullMQ retains it (removeOnComplete:
        // 200). Re-adding the SAME id now no-ops (HSETNX) and silently drops the
        // reschedule; using a DIFFERENT id would diverge from the deterministic
        // id the local reschedule path (setRunTriggerForActor → scheduleTrigger)
        // reuses, leaving a retained completed job that later collides. Either
        // inline re-arm is unsafe from within the firing job. So we PERSIST the
        // new instant (and clear releasedAt) and SKIP — the run stays armed with
        // the corrected time, and the reconcile loop (#318) re-arms the delayed
        // job once this one-shot has completed and its id is free. This honors
        // the reschedule (never fires the OLD tick) without any id hazard.
        // UNDER THE CLAIM, for the same reason as the recurring refresh above.
        const persisted = await withTriggerClaim(runId, async (live) => {
          if (!live || live.stoppedAt) return false;
          if (triggerRevision(live) !== decisionRevision) return false;
          await createOrUpdateRunTrigger({
            runId,
            triggerType: "scheduled",
            scheduledAt: new Date(newAtMs),
            timezone: trigger.timezone,
            enabled: true,
            // Keep the prior jobSchedulerId untouched; the in-flight one-shot is
            // completing and #318 owns the deterministic re-arm. Clear releasedAt
            // so the re-armed instant can open the gate.
            jobSchedulerId: live.jobSchedulerId,
            releasedAt: null,
          });
          return true;
        });
        if (!persisted) {
          console.log(
            `[trigger-release] PM rescheduled scheduled run ${runId}, but the local schedule was stopped, removed or changed meanwhile — leaving it as it stands and skipping this tick`,
          );
          return "skip";
        }
        console.log(
          `[trigger-release] PM rescheduled scheduled run ${runId} to ${pm.scheduledAt} — persisted new instant + skipping this tick (reconcile #318 re-arms the delayed job)`,
        );
        return "skip";
      } catch (err) {
        // A refresh glitch must not strand the run — fall through to FIRE.
        console.warn(
          "[trigger-release] PM reschedule refresh failed for run",
          runId,
          "— firing anyway:",
          err,
        );
        return "fire";
      }
    }

    default: {
      // Exhaustiveness guard: an unknown kind fails open (fire).
      const _exhaustive: never = pm;
      void _exhaustive;
      return "fire";
    }
  }
}
