import "server-only";

// ---------------------------------------------------------------------------
// The trigger schedule PROPOSE / CONFIRM service (cinatra#2569, epic #2564 S5).
// Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` §VI.
//
// §VI in one line: "nothing exists until the reader confirms". Three acts:
//
//   PROPOSE  — the assistant reads a schedule out of what the user said and
//              shows it. Writes NOTHING. The whole proposal is a signed,
//              opaque, expiring token riding the turn.
//   CONFIRM  — the reader presses Confirm. One transaction spends the proposal,
//              creates the run pre-dispatch, and records the schedule-install
//              intent; a drain then ARMS the run before EXPOSING its schedule.
//   ADJUST   — the reader changes the rows. RE-PROPOSES: a fresh token that
//              INHERITS the adjusted-away proposal's consume identity, so the
//              whole family is one row in the consume table and at most one of
//              its members can ever become a run (cinatra#2859). It still
//              mutates nothing, because there is nothing to mutate — which is
//              why Adjust needs no authority at all and can never half-arm a
//              schedule.
//
// THE AI CANNOT ARM ANYTHING. The producer is a read-only render primitive; it
// mints a card. Confirm is a HUMAN SESSION action: it runs under a live cookie
// session and re-derives the user and org from it, then requires a token minted
// for exactly that pair. There is no primitive on any surface — chat, widget,
// OBO — by which a model resolves a proposal, and the chat policy's
// `confirm`/`arm`/`trigger` verb tokens keep the class unreachable by
// construction rather than by allowlist omission.
//
// EXTENDS THE RESHAPED TRIGGER LADDER, DOES NOT FORK IT. #2615 reshaped the
// immediate path into a real transition ladder with honest refusals
// (`setRunTriggerForActor` → `dispatchImmediateNow`); the immediate arm of a
// confirmed proposal goes THROUGH that same call, so every refusal it learned
// to speak is spoken here too. The scheduled/recurring arm is the one place
// this slice deliberately differs, and it differs in ORDER only: the service's
// own path installs the schedule and THEN arms the run, which is exactly the
// window where a one-shot fire can be lost. The drain arms first.
// ---------------------------------------------------------------------------

import {
  buildCron,
  describeRecurrence,
  parseCronToRecurring,
  DEFAULT_RECURRING_CONFIG,
  type RecurringConfig,
} from "./trigger-recurrence";
import {
  proposalConsumeKey,
  verifyTriggerScheduleProposalToken,
  verifyTriggerScheduleProposalTokenDetailed,
  type ProposalSchedule,
  type TriggerScheduleProposal,
} from "@/lib/trigger-schedule-proposal-token";
// PROPOSE lives in its own leaf so the MCP producer can reach it WITHOUT
// dragging this module's confirm transaction and install outbox onto the five
// locked route graphs the self-MCP server sits on. Re-exported here so the
// service stays the one import site for callers that need both halves.
import {
  naiveDatetimeToUtcMs,
  proposeTriggerSchedule,
  adjustTriggerSchedule,
  reproposeExpiredSchedule,
  type AdjustScheduleInput,
  type ProposeScheduleInput,
  type ProposeScheduleResult,
} from "./trigger-schedule-propose";

export {
  naiveDatetimeToUtcMs,
  proposeTriggerSchedule,
  adjustTriggerSchedule,
  reproposeExpiredSchedule,
  type AdjustScheduleInput,
  type ProposeScheduleInput,
  type ProposeScheduleResult,
};
import { launchAgentRun } from "./lifecycle-coordinator";
import {
  readAgentRunById,
  readAgentTemplateById,
  transitionRunStatus,
  RunTransitionError,
} from "./store";
import { AuthzError } from "@/lib/authz";
import type { ActorRoleHints } from "./auth-policy";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import {
  createOrUpdateRunTrigger,
  readRunTriggerByRunId,
} from "./trigger-store";
import { scheduleTrigger } from "./trigger-schedule";
import { setRunTriggerForActor } from "./trigger-service";
import { assertAgentPackageRunnable } from "./runtime-install-gate";
import {
  ProposalAlreadyConsumedError,
  claimPendingInstallIntents,
  markInstallIntentArmed,
  markInstallIntentDone,
  parkInstallIntent,
  readInstallIntent,
  readProposalConsume,
  readProposalConsumeByRunId,
  releaseInstallIntent,
  spendProposalWithinTx,
  type InstallIntentRow,
} from "./trigger-schedule-proposal-store";
import { verifySessionAuthority } from "@/lib/org-write/authority";

// ---------------------------------------------------------------------------
// Refusal copy — honest, actionable, non-enumerating
// ---------------------------------------------------------------------------
//
// Two different audiences, two different rules, and conflating them is the
// mistake this block exists to avoid.
//
// A refusal returned to the READER (the Confirm server action) is UI copy: it
// names the state and the action that clears it, exactly as #2615's immediate
// ladder does. A refusal returned to the MODEL (the producer tool) is the
// generic `LIFECYCLE_REFUSAL_RESULT` sentence, because a tool result persists
// in `assistant_turns.content` and is re-fed to the model — naming what was
// refused there would build a durable enumeration oracle.

/** What Confirm says when the stated schedule is no longer good. */
export const PROPOSAL_REFUSALS = {
  invalid:
    "This schedule is no longer valid — it may have expired. Ask again and confirm the new card.",
  notRunnable:
    "This agent can't be run right now. Open its listing to see what it needs.",
  unknownAgent:
    "The agent this schedule was for is no longer available.",
  installFailed:
    "The schedule could not be armed just now — please try again.",
  past:
    "That time has already passed. Ask for a new time and confirm the new card.",
  supersededBySchedule:
    "This schedule was already set from this card, with different times than the ones shown here. The rows below show the schedule that was set.",
} as const;

// ---------------------------------------------------------------------------
// CONFIRM
// ---------------------------------------------------------------------------

export type ConfirmProposalActor = {
  userId: string;
  orgId: string;
  role?: string | null;
};

export type ConfirmProposalResult =
  | { ok: true; runId: string; alreadyConfirmed: boolean }
  | { ok: false; error: string };

/**
 * Confirm a proposal: ONE transaction, then the drain.
 *
 * The transaction (inside `createAgentRunPendingInput`'s `withinCreateTx`)
 * commits three things together — the proposal is spent, the run exists
 * pre-dispatch, the install is intended. The consume insert is FIRST, so a
 * second Confirm loses it and the run it was creating is rolled back with it:
 * a double press, a retried request and a genuine race all end with ONE run,
 * and the loser answers with the ORIGINAL run id.
 *
 * The drain then runs INLINE (best effort). Inline because the reader is
 * waiting and the card should settle while they are looking at it; best effort
 * because the intent is already durable — if this process dies mid-install, the
 * next drain pass picks the intent up and finishes it. Confirm never reports
 * failure for an install that is merely still pending.
 */
export async function confirmTriggerScheduleProposal(
  actor: ConfirmProposalActor,
  token: string,
): Promise<ConfirmProposalResult> {
  const proposal = verifyTriggerScheduleProposalToken({
    token,
    expectedUserId: actor.userId,
    expectedOrgId: actor.orgId,
  });
  // One answer for a forged token, an expired one, and one minted for someone
  // else — the reader learns only that this card can no longer be confirmed.
  if (!proposal) return { ok: false, error: PROPOSAL_REFUSALS.invalid };

  const consumeKey = proposalConsumeKey(proposal.nonce);

  // Fast path for the ordinary retry: already spent, answer with its run
  // without opening a transaction that would only roll back.
  const existing = await readProposalConsume(consumeKey);
  if (existing) {
    if (await settledOnAnotherSchedule(existing.runId, proposal.schedule)) {
      return { ok: false, error: PROPOSAL_REFUSALS.supersededBySchedule };
    }
    await driveInstall(existing.runId);
    return { ok: true, runId: existing.runId, alreadyConfirmed: true };
  }

  const template = await readAgentTemplateById(proposal.templateId);
  if (!template) return { ok: false, error: PROPOSAL_REFUSALS.unknownAgent };
  if (template.orgId && template.orgId !== actor.orgId) {
    return { ok: false, error: PROPOSAL_REFUSALS.unknownAgent };
  }

  // RUNTIME-LIFECYCLE + PROVISIONING GATE (cinatra#2605). The same verdict the
  // run picker and every other run-start applies — re-resolved NOW, not at
  // propose time: a proposal made twenty minutes ago must not start a run the
  // instance would refuse today.
  const notRunnable = await assertAgentPackageRunnable(
    template.packageName,
    template.packageName ?? template.name,
    { packageVersion: template.packageVersion ?? null },
  );
  if (notRunnable) return { ok: false, error: notRunnable.error };

  const install = installIntentFor(proposal.schedule);
  if (!install) return { ok: false, error: PROPOSAL_REFUSALS.invalid };

  // THE PROPOSED MOMENT MAY HAVE PASSED (codex round-2 finding). A proposal is
  // good for its whole TTL, so a one-shot proposed for 09:00 can reach Confirm
  // at 09:05. The shipped trigger service refuses a past `scheduledAt` before
  // it writes anything, and so must this path — otherwise the run is created
  // first and the install then fails forever, leaving a run nobody can explain.
  // The floor is `scheduleTrigger`'s own: a delay under a second is "in the
  // past" rather than "immediately", because "fire now" is not what the reader
  // confirmed.
  if (install.scheduledAt && install.scheduledAt.getTime() - Date.now() < 1000) {
    return { ok: false, error: PROPOSAL_REFUSALS.past };
  }

  const authority = await verifySessionAuthority(actor.userId, actor.orgId);

  let runId: string;
  try {
    // CONFIRM IS LAUNCH, NOT ADVANCE (cinatra#2928). Until this moment there is
    // no run: the carrier is the schedule the person stated, held in its signed
    // reference, and nothing has been written. Confirm consumes that reference
    // and creates the run WITH its schedule in one transaction — which is why
    // this launch uses the pre-dispatch creator and hands it the companion
    // write. Routing it through the coordinator is what makes "every way of
    // starting an agent calls launch" true of the schedule card too.
    //
    // The run is left pre-dispatch on purpose: the install drain below arms the
    // schedule before it exposes it, and a run enqueued here would start now
    // rather than when the person asked for.
    const launched = await launchAgentRun({
      producer: "schedule_confirm",
      // The reader is looking at the card they just pressed, under a live cookie
      // session this action already re-derived the user and org from.
      frame: { userId: actor.userId },
      interactive: true,
      authority,
      create: {
        kind: "pre_dispatch",
        input: {
          templateId: proposal.templateId,
          runBy: actor.userId,
          inputParams: {},
          orgId: actor.orgId,
          // `scopeActor` is deliberately left to the default, as every other
          // interactive create does: the #2485 C scope guard resolves the run's
          // OWN owner (`runBy`, the confirming human) and the acting principal is
          // already this session. Passing a hand-built actor here would be the
          // only call site in the codebase doing so.
          // The one transaction. See `spendProposalWithinTx`.
          withinCreateTx: async (tx, run) =>
            spendProposalWithinTx(tx, {
              consumeKey,
              runId: run.id,
              orgId: run.orgId,
              templateId: proposal.templateId,
              consumedBy: actor.userId,
              install,
            }),
        },
      },
      dispatch: {
        kind: "await_trigger",
        why: "the install drain arms the schedule before it exposes it; this run starts when the schedule says so",
      },
    });
    if (launched.carrier.kind !== "run") {
      return { ok: false, error: PROPOSAL_REFUSALS.invalid };
    }
    runId = launched.carrier.run.id;
  } catch (err) {
    if (err instanceof ProposalAlreadyConsumedError) {
      // The race we designed for: a concurrent Confirm won. Our run rolled back
      // with the failed insert, so there is exactly one run and it is theirs.
      const winner = await readProposalConsume(consumeKey);
      if (winner) {
        if (await settledOnAnotherSchedule(winner.runId, proposal.schedule)) {
          return { ok: false, error: PROPOSAL_REFUSALS.supersededBySchedule };
        }
        await driveInstall(winner.runId);
        return { ok: true, runId: winner.runId, alreadyConfirmed: true };
      }
      // The winner's transaction has not committed yet (we saw its uncommitted
      // key). It will; the reader's retry finds it.
      return { ok: false, error: PROPOSAL_REFUSALS.invalid };
    }
    // A scope refusal, an org-write refusal, a store failure — the transaction
    // rolled back, so the proposal is UNSPENT and re-confirmable.
    return { ok: false, error: refusalForCreateFailure(err) };
  }

  await driveInstall(runId);
  return { ok: true, runId, alreadyConfirmed: false };
}

/**
 * Did this family already settle on a DIFFERENT schedule than the one this card
 * is showing? (cinatra#2859)
 *
 * ADJUST MAKES A FAMILY'S MEMBERS DISAGREE, which is what makes this check
 * necessary and why it did not exist before. Every member of an adjust lineage
 * shares ONE consume identity — that is the invariant that stops two runs — but
 * unlike a re-proposed EXPIRED card, whose replacement re-asks the same question
 * with the same rows, an adjusted card deliberately carries DIFFERENT rows. So
 * "this identity is already spent" no longer implies "spent on what you are
 * looking at": if a stale tab confirmed the adjusted-away card first, the run
 * that exists is on the schedule the reader corrected away from.
 *
 * Answering that Confirm with the ordinary idempotent `alreadyConfirmed: true`
 * would be a lie the reader cannot see through — their card would settle
 * showing rows nothing was armed with. So it is refused in words instead, and
 * the words name the discrepancy rather than the generic "no longer valid".
 *
 * Compares against the INSTALL INTENT, which is the durable record of what was
 * actually committed for that run, written in the same transaction as the
 * consume row. When there is nothing to compare against — the intent is missing,
 * or this card's own schedule no longer translates — the answer is the
 * pre-existing one: this function only ever converts a KNOWN disagreement into a
 * refusal, never an unknown into one.
 *
 * A re-proposed expired card and a plain double-press both compare EQUAL, so
 * #2837's lineage and the ordinary retry keep landing exactly as they did.
 */
async function settledOnAnotherSchedule(
  runId: string,
  schedule: ProposalSchedule,
): Promise<boolean> {
  return installedOnAnotherSchedule(await readInstallIntent(runId), schedule);
}

/**
 * The comparison itself, over an install intent the caller ALREADY holds.
 *
 * Confirm reaches it through `settledOnAnotherSchedule`, which does the read.
 * `resolveProposalForReader` calls it directly, because its settled branch has
 * already fetched the same intent for `arming`. Deliberately ONE comparison
 * behind both doors rather than a copy on each: the refusal Confirm gives and
 * the line the settled card draws are two answers to the same question, and two
 * implementations of it would be free to drift into disagreeing.
 */
function installedOnAnotherSchedule(
  settled: Pick<
    InstallIntentRow,
    "triggerType" | "scheduledAt" | "cronExpression" | "timezone"
  > | null,
  schedule: ProposalSchedule,
): boolean {
  const shown = installIntentFor(schedule);
  if (!shown) return false;
  if (!settled) return false;
  if (settled.triggerType !== shown.triggerType) return true;
  if ((settled.cronExpression ?? null) !== (shown.cronExpression ?? null)) return true;
  if (
    (settled.scheduledAt?.getTime() ?? null) !==
    (shown.scheduledAt?.getTime() ?? null)
  ) {
    return true;
  }
  return settled.timezone !== shown.timezone;
}

/**
 * A create-time failure, in the reader's words.
 *
 * `#2485 C` scope denials name the template id, the reason and the level in
 * their message; that detail belongs in a log, never on a card. Everything else
 * degrades to one retryable sentence — the transaction rolled back, so trying
 * again is genuinely the right advice.
 */
function refusalForCreateFailure(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "AGENT_TEMPLATE_SCOPE_DENIED") {
    return "This agent's scope does not include you, so it can't be scheduled from here.";
  }
  console.warn(
    "[confirmTriggerScheduleProposal] create failed",
    err instanceof Error ? err.message : String(err),
  );
  return PROPOSAL_REFUSALS.installFailed;
}

// ---------------------------------------------------------------------------
// The install DRAIN — arm before expose
// ---------------------------------------------------------------------------

/**
 * Drain this run's install intent if it is claimable. Swallows everything: the
 * intent is durable, so a failure here is a retry, never a lost schedule.
 */
export async function driveInstall(runId: string): Promise<void> {
  try {
    const claimed = await claimPendingInstallIntents({ runId, limit: 1 });
    for (const intent of claimed) await installScheduleForIntent(intent);
  } catch (err) {
    console.warn(
      "[trigger-schedule-proposal] inline install drain failed for run",
      runId,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Drain a batch. The background pass that finishes what a crash interrupted. */
export async function drainScheduleInstallIntents(opts?: {
  limit?: number;
}): Promise<{ installed: number; retried: number; failed: number }> {
  const claimed = await claimPendingInstallIntents({ limit: opts?.limit ?? 20 });
  let installed = 0;
  let retried = 0;
  let failed = 0;
  for (const intent of claimed) {
    const outcome = await installScheduleForIntent(intent);
    if (outcome === "installed") installed += 1;
    else if (outcome === "failed") failed += 1;
    else retried += 1;
  }
  return { installed, retried, failed };
}

/**
 * Install ONE claimed intent, in the pinned order.
 *
 * SCHEDULED / RECURRING — the order is the whole point:
 *
 *   1. write the trigger ROW (no scheduler yet: nothing can fire),
 *   2. ARM the run (`pending_input → armed`) and stamp `armed_at`,
 *   3. EXPOSE the schedule (`scheduleTrigger` installs the BullMQ job),
 *   4. persist the `jobSchedulerId` and mark the intent done.
 *
 * The inversion — expose, then arm — is what the shipped
 * `setRunTriggerForActor` does, and it is safe there because that path is
 * driven by a human sitting on the Trigger tab whose schedule is minutes or
 * days away. It is NOT safe here: a proposal confirmed at 08:59:58 for 09:00:00
 * would install a job that fires before the arm lands, and a release firing on
 * a not-armed run hits the `armed → queued` CAS, logs, and skips. The fire is
 * then gone — a one-shot schedule that silently never runs. Arming first closes
 * that window completely: from step 2 onward the CAS always finds `armed`, so a
 * schedule falling due DURING the drain fires exactly once.
 *
 * Every step is idempotent, because delivery is at-least-once: the row upsert
 * is an upsert, and `scheduleTrigger` keys the BullMQ job on a per-run id so
 * re-installing replaces rather than duplicates.
 *
 * The EXPOSE is reached only for a run this pass OBSERVED as `armed` — either
 * because it armed it, or because it read `armed` back after a stale CAS. A run
 * that has moved past `armed` is never re-exposed: for a one-shot that is how a
 * schedule fires twice. (Even then the `armed → queued` CAS at the release site
 * is a second wall — a duplicate release on a run that is no longer armed skips
 * — but relying on it would make double-firing a near miss rather than an
 * impossibility.)
 *
 * IMMEDIATE — delegated whole to `setRunTriggerForActor`, so the reshaped
 * ladder from #2615 (the legal `→queued` edges, the honest refusals, the
 * enqueue, the compensation) is reused rather than restated. Ordering is not at
 * stake for an immediate trigger: it has no future fire to lose.
 */
export async function installScheduleForIntent(
  intent: InstallIntentRow,
): Promise<"installed" | "retry" | "failed"> {
  const leaseToken = intent.leaseToken;
  if (!leaseToken) return "retry";

  try {
    if (intent.triggerType === "immediate") {
      const result = await setRunTriggerForActor(
        { userId: intent.requestedBy, source: "ui" },
        { runId: intent.runId, triggerType: "immediate", timezone: intent.timezone },
      );
      if (!result.ok) {
        // An honest refusal from the reshaped ladder is TERMINAL, not a
        // transient fault: retrying "this run has already finished" twenty
        // times would only bury it. Park it with the refusal recorded.
        return (await parkIntent(intent, leaseToken, result.error)) satisfies
          | "retry"
          | "failed";
      }
      await markInstallIntentArmed(intent.runId, leaseToken);
      await markInstallIntentDone(intent.runId, leaseToken);
      return "installed";
    }

    // 1. The durable row. No scheduler id yet — nothing can fire from this.
    await createOrUpdateRunTrigger({
      runId: intent.runId,
      triggerType: intent.triggerType,
      scheduledAt: intent.scheduledAt,
      cronExpression: intent.cronExpression,
      timezone: intent.timezone,
      enabled: true,
      jobSchedulerId: null,
    });

    // 2. ARM — the step that makes a fire impossible to lose.
    const run = await readAgentRunById(intent.runId);
    if (!run) return await parkIntent(intent, leaseToken, "run not found");
    const authority = await verifySessionAuthority(intent.requestedBy, intent.orgId);
    try {
      await transitionRunStatus(intent.runId, "pending_input", "armed", undefined, authority, {
        actingUserId: intent.requestedBy,
      });
    } catch (err) {
      if (!(err instanceof RunTransitionError && err.code === "stale_from_status")) {
        throw err;
      }
      // NOT `pending_input`. A stale CAS is NOT by itself evidence of "already
      // armed" (codex round-2 finding): a cancelled, stopped, queued, running
      // or finished run also fails it, and treating any of them as armed would
      // walk straight past this function's whole reason for existing and expose
      // a schedule whose run is not armed. So ask what the run actually IS.
      const current = await readAgentRunById(intent.runId);
      if (!current) return await parkIntent(intent, leaseToken, "run not found");
      if (current.status !== "armed") {
        // The run has MOVED ON. Two honest cases, and neither is "expose it":
        //
        //  - we armed it on an earlier pass and its schedule has since fired
        //    (`armedAt` is stamped) — the install already happened, so close the
        //    intent instead of re-installing. Re-installing a ONE-SHOT here is
        //    exactly how a schedule fires twice.
        //  - we never armed it, and someone else moved it (a cancel, a manual
        //    start). There is nothing of ours to install; park it with the
        //    reason on the row rather than retrying nineteen more times.
        if (intent.armedAt) {
          await markInstallIntentDone(intent.runId, leaseToken);
          return "installed";
        }
        return await parkIntent(
          intent,
          leaseToken,
          `run is ${current.status} — no longer awaiting a schedule`,
        );
      }
      // Genuinely already armed: the at-least-once redelivery this ordering is
      // built for. Fall through and (re-)install, which is an upsert.
    }
    await markInstallIntentArmed(intent.runId, leaseToken);

    // 3. EXPOSE. Only now can the scheduler see it — and the run it will fire
    //    is already armed.
    const scheduled = await scheduleTrigger({
      runId: intent.runId,
      triggerType: intent.triggerType,
      scheduledAt: intent.scheduledAt ?? undefined,
      cronExpression: intent.cronExpression ?? undefined,
      timezone: intent.timezone,
    });

    // 4. Persist the scheduler id so Cancel can find the job.
    await createOrUpdateRunTrigger({
      runId: intent.runId,
      triggerType: intent.triggerType,
      scheduledAt: intent.scheduledAt,
      cronExpression: intent.cronExpression,
      timezone: intent.timezone,
      enabled: true,
      jobSchedulerId: scheduled.jobSchedulerId,
    });

    await markInstallIntentDone(intent.runId, leaseToken);
    return "installed";
  } catch (err) {
    const outcome = await releaseInstallIntent(
      intent.runId,
      leaseToken,
      err instanceof Error ? err.message : String(err),
    );
    return outcome === "failed" ? "failed" : "retry";
  }
}

/** Record a TERMINAL refusal against an intent and stop retrying it. */
async function parkIntent(
  intent: InstallIntentRow,
  leaseToken: string,
  reason: string,
): Promise<"failed"> {
  await parkInstallIntent(intent.runId, leaseToken, reason);
  return "failed";
}

// ---------------------------------------------------------------------------
// Schedule translation
// ---------------------------------------------------------------------------

/**
 * The proposal's SELECTIONS → the trigger row's fields. The one place the
 * conversation's vocabulary becomes the scheduler's, and it goes through the
 * same `buildCron` the scheduling step submits with, so a proposal and a
 * hand-built schedule that look the same ARE the same.
 */
export function installIntentFor(
  schedule: ProposalSchedule,
): Omit<
  {
    triggerType: "immediate" | "scheduled" | "recurring";
    scheduledAt: Date | null;
    cronExpression: string | null;
    timezone: string;
  },
  never
> | null {
  if (schedule.kind === "immediate") {
    return {
      triggerType: "immediate",
      scheduledAt: null,
      cronExpression: null,
      timezone: "UTC",
    };
  }
  if (schedule.kind === "scheduled") {
    const ms = naiveDatetimeToUtcMs(schedule.runAt, schedule.timezone);
    if (Number.isNaN(ms)) return null;
    return {
      triggerType: "scheduled",
      scheduledAt: new Date(ms),
      cronExpression: null,
      timezone: schedule.timezone,
    };
  }
  return {
    triggerType: "recurring",
    scheduledAt: null,
    cronExpression: buildCron(schedule.selection as RecurringConfig),
    timezone: schedule.timezone,
  };
}

/**
 * The plain-language schedule line §VI's settled card draws.
 *
 * Derived from the SELECTIONS, never from the cron: the settled card reads back
 * what the reader confirmed, and a cron-to-prose renderer would be a second
 * description of the same thing, free to disagree with the first.
 */
export function describeProposalSchedule(schedule: ProposalSchedule): string {
  if (schedule.kind === "immediate") return "Runs right after setup";
  if (schedule.kind === "scheduled") return `Once, at ${schedule.runAt.replace("T", " ")}`;
  return describeRecurrence(schedule.selection as RecurringConfig);
}

/**
 * The schedule line a SUPERSEDED settled card draws instead (cinatra#2859).
 *
 * It names the supersession and sends the reader to the run; it does NOT
 * restate times. That is the deliberate part. The durable record of what was
 * actually installed is the trigger row and the install intent — scheduler
 * fields, not selections — so rendering "the schedule that was set" as prose
 * would mean parsing the cron back into selections. `describeProposalSchedule`
 * exists precisely to avoid that: the settled line is derived from selections
 * "rather than from the cron, [because] a cron-to-prose renderer would be a
 * second, drift-prone description of the same thing". Inventing one HERE — on
 * the one card whose whole problem is that it was showing the wrong times —
 * would be the worst place to start drifting. So the card stops claiming times
 * it cannot vouch for and points at the row that is authoritative.
 */
export const SUPERSEDED_SCHEDULE_COPY =
  "This card was adjusted before it was set — open the run to see the schedule that was set.";

// ---------------------------------------------------------------------------
// The card's authoritative state
// ---------------------------------------------------------------------------

export type ProposalResolution =
  | { phase: "absent" }
  | {
      phase: "proposal";
      proposal: TriggerScheduleProposal;
      agentName: string;
      canConfirm: boolean;
      restrictedReason: string | null;
    }
  /**
   * EXPIRED, AND STILL THIS READER'S (cinatra#2836). The thirty-minute window
   * closed with nobody pressing anything, and the token is otherwise perfect:
   * authentic, unstretched, minted for exactly this reader in exactly this org.
   *
   * A READING, NOT AN ABSENCE. Plan (A) §7.2 step 2 — an expired card "stays
   * visible", still editable, with Confirm to set the schedule again — and
   * design §IV reserves the undrawn answer for a reader who may not see the
   * subject AT ALL. Collapsing the two, which is what this resolver did before
   * this fix, deleted the card and the question it asked out of the reader's
   * own transcript, and made every timed-out reader indistinguishable from one
   * who was never entitled to anything.
   *
   * Only a reader who OWNS the token can ever reach this arm: the verify
   * reports `expired` strictly behind both bindings, so an expired token
   * belonging to somebody else is the same flat refusal a forged one is, and
   * lands on `absent` exactly as before.
   *
   * It carries the same fields the live proposal does. `canConfirm` is still
   * the floor read against the reader — an agent the instance would refuse to
   * run cannot be scheduled by re-proposing it either — and `proposal` carries
   * the rows the reader last saw, so the expired card re-opens on those rather
   * than on an empty form.
   */
  | {
      phase: "expired";
      proposal: TriggerScheduleProposal;
      agentName: string;
      canConfirm: boolean;
      restrictedReason: string | null;
    }
  | {
      phase: "settled";
      runId: string;
      agentName: string;
      triggerType: "immediate" | "scheduled" | "recurring";
      scheduleCopy: string;
      timezone: string;
      /**
       * THE ARMED SCHEDULE AS SELECTIONS — what the settled card's option rows
       * draw (plan (A) §7.2: "the same card, with the same option rows, now
       * shows the armed schedule"). Read back from what was INSTALLED, never
       * from the token: the durable trigger row (or the install intent while it
       * drains) is what the family actually settled on, so a superseded card's
       * rows are right for the same reason its `scheduleCopy` is honest.
       */
      schedule: ProposalSchedule;
      released: boolean;
      arming: boolean;
      /**
       * HAS THIS SCHEDULE FIRED AT LEAST ONCE (cinatra#2972)?
       *
       * The two trigger families answer it from two different stamps, and they
       * have to: a one-off's firing IS the gate opening (`releasedAt`), while a
       * recurring schedule never opens its own run's gate — each tick starts a
       * copy — so its firing is the tick's own stamp (`lastFiredAt`).
       *
       * Plan (A) §7.2 as amended 2026-08-25 keys **Cancel schedule** to it:
       * "shown only for a recurring schedule that has fired once".
       */
      firedOnce: boolean;
      /**
       * THE SCHEDULE WAS STOPPED — **Cancel schedule** was pressed
       * (cinatra#2972). The row is still there and still drawn; what it has
       * lost is every control. Plan (A) §7.2: Cancel schedule "stops the
       * recurring schedule and then makes the scheduler non-editable".
       */
      stopped: boolean;
      /**
       * May **Save changes** re-arm from this card (plan (A) §7.2 step 6)?
       *
       * The refusals, and each is the server's rule read forward rather than a
       * second policy: a trigger still ARMING has no scheduler to replace yet, a
       * STOPPED schedule is over, and a ONE-OFF (or an immediate) THAT HAS
       * ALREADY FIRED is not a schedule any more — re-arming it would make a
       * second run out of a card that says "change this one".
       *
       * A RECURRING SCHEDULE THAT HAS FIRED IS NOT REFUSED, and that is the
       * change cinatra#2972 lands: plan (A) §7.2 as amended 2026-08-25 — "a run
       * set to **Recurring** that has fired keeps its scheduler editable — the
       * same rows and **Save changes**, and a change applies to its future
       * runs".
       */
      canSave: boolean;
      /**
       * This card's rows are NOT the ones the family settled on — it was
       * adjusted away from before Confirm landed. `scheduleCopy` says so and
       * `triggerType`/`timezone` are the installed ones, so the card is honest
       * without it; the flag is what lets a renderer say it in its own chrome.
       * False for every ordinary settled card, including a double-press and
       * #2837's re-proposed expired lineage.
       */
      superseded: boolean;
    };

/**
 * Resolve what a proposal card may draw RIGHT NOW, against this reader.
 *
 * The order matters and mirrors S1's: decode → bind to the reader → has it been
 * confirmed? → may this reader confirm it? A ref that does not decode, a
 * proposal minted for someone else and a template that has since vanished all
 * answer `absent`, so the card is a probe for nothing.
 *
 * A SPENT proposal resolves to its run — which is why the settled card can be
 * the trigger's chrome without the transcript carrying a run id: the token the
 * turn already holds addresses the consume row, and the consume row names the
 * run.
 *
 * "SPENT" IS NOT "SPENT ON THESE ROWS" (cinatra#2859). Sharing one consume
 * identity across an adjust family is what stops the second run, and the price
 * of it is exactly here: the reader's own token is no longer evidence of what
 * was installed, because a sibling may have settled the family on different
 * rows. Confirm already refuses that in words, but resolution is a READ — no
 * Confirm is pressed when a stale tab is merely reopened — so the same
 * divergence has to be answered on this side too, or the card quietly renders
 * the schedule its family was corrected away from. `superseded` is that answer.
 */
export async function resolveProposalForReader(
  token: string,
  actor: ConfirmProposalActor,
): Promise<ProposalResolution> {
  // THE FINER READ, AND ONLY HERE (cinatra#2836). Confirm and the live Adjust
  // keep the collapsing verify, because for them an expired token has nothing
  // left to spend. RESOLUTION is the one caller that must tell an expired card
  // apart from an absent one, because it is the caller that decides whether the
  // card is DRAWN at all — and drawing it is what plan (A) §7.2 step 2 asks for.
  //
  // `refused` still swallows everything, on the identical path and with the
  // identical answer as before this change: forged, foreign, stretched,
  // future-dated, AND expired-but-foreign all arrive here as one value.
  const verified = verifyTriggerScheduleProposalTokenDetailed({
    token,
    expectedUserId: actor.userId,
    expectedOrgId: actor.orgId,
  });
  if (verified.outcome === "refused") return { phase: "absent" };
  const proposal = verified.proposal;

  const template = await readAgentTemplateById(proposal.templateId);
  if (!template) return { phase: "absent" };
  if (template.orgId && template.orgId !== actor.orgId) return { phase: "absent" };
  const agentName = template.name ?? template.packageName ?? "this agent";

  const consumed = await readProposalConsume(proposalConsumeKey(proposal.nonce));
  if (consumed) {
    const [trigger, intent] = await Promise.all([
      readRunTriggerByRunId(consumed.runId),
      readInstallIntent(consumed.runId),
    ]);
    // Spent — but spent on WHAT? Under #2859's shared consume identity every
    // member of an adjust family addresses one row, so a matching row proves
    // the family settled, not that it settled on the rows THIS card is holding.
    // Same comparison Confirm refuses on, over the intent already in hand.
    const superseded = installedOnAnotherSchedule(intent, proposal.schedule);
    return {
      phase: "settled",
      runId: consumed.runId,
      agentName,
      // Both already come from the DURABLE rows rather than from the token, so
      // a superseded card was never wrong about these two.
      triggerType:
        (trigger?.triggerType as "immediate" | "scheduled" | "recurring") ??
        (intent?.triggerType ?? "immediate"),
      scheduleCopy: superseded
        ? SUPERSEDED_SCHEDULE_COPY
        : describeProposalSchedule(proposal.schedule),
      timezone: trigger?.timezone ?? intent?.timezone ?? "UTC",
      // THE ROWS COME FROM THE INSTALLED ROW, not from `proposal.schedule`.
      // Under #2859's shared consume identity this card's own token may be
      // holding rows the family was corrected away from; the durable trigger
      // row is what is armed, and "shows the armed schedule in the same rows"
      // (plan (A) §7.2) is only true if the rows are read from it.
      schedule: selectionsFromInstalled({
        triggerType:
          (trigger?.triggerType as "immediate" | "scheduled" | "recurring") ??
          (intent?.triggerType ?? "immediate"),
        scheduledAt: trigger?.scheduledAt ?? intent?.scheduledAt ?? null,
        cronExpression: trigger?.cronExpression ?? intent?.cronExpression ?? null,
        timezone: trigger?.timezone ?? intent?.timezone ?? "UTC",
      }),
      released: !!trigger?.releasedAt,
      // "Arming…" rather than controls over a schedule still being installed.
      arming: !!intent && intent.status !== "done" && intent.status !== "failed",
      // THE TWO FAMILIES, TWO STAMPS (cinatra#2972). The conversation's card and
      // the page's step read one schedule, so both readings come off the same
      // durable row here as they do on the run-addressed path.
      firedOnce:
        ((trigger?.triggerType as "immediate" | "scheduled" | "recurring") ??
          (intent?.triggerType ?? "immediate")) === "recurring"
          ? !!trigger?.lastFiredAt
          : !!trigger?.releasedAt,
      stopped: trigger?.stoppedAt != null,
      canSave: canSaveInstalled({
        triggerType:
          (trigger?.triggerType as "immediate" | "scheduled" | "recurring") ??
          (intent?.triggerType ?? "immediate"),
        scheduledAt: trigger?.scheduledAt ?? intent?.scheduledAt ?? null,
        released: !!trigger?.releasedAt,
        arming: !!intent && intent.status !== "done" && intent.status !== "failed",
        stopped: trigger?.stoppedAt != null,
      }),
      superseded,
    };
  }

  const notRunnable = await assertAgentPackageRunnable(
    template.packageName,
    template.packageName ?? template.name,
    { packageVersion: template.packageVersion ?? null },
  );
  return {
    // THE EXPIRY READING IS TAKEN LAST, and that order carries meaning rather
    // than convenience. An expired token whose family was already CONFIRMED is
    // a settled card, not an expired one — the run exists and the reader should
    // see it — so the consume lookup above answers first. An expired token for
    // a template that has since vanished is still `absent`, for the same reason
    // a live one is. What is left here is exactly the plan's case: the window
    // closed and nothing was ever armed.
    phase: verified.outcome === "expired" ? "expired" : "proposal",
    proposal,
    agentName,
    canConfirm: !notRunnable,
    // §IV: the reason is on screen, and it describes the reader's own standing
    // without enumerating anything about the instance.
    restrictedReason: notRunnable ? PROPOSAL_REFUSALS.notRunnable : null,
  };
}

/**
 * Resolve a proposal card for a RUN, for one reader (cinatra#2788, S9d).
 *
 * The run-page / review-page identity. Those hosts hold no proposal token, so
 * they address the card by the run it settled into; this call re-derives the
 * (viewer, organization, template) binding the plan keys the card by from the
 * proposal's own CONSUME row — the one row that recorded all three, at the one
 * moment they were all true.
 *
 * TWO BINDINGS, ONE CARD (cinatra#3004). A run reaches this call by one of two
 * histories, and each carries its own proof of who may read it:
 *
 *   · IT CAME FROM A PROPOSAL — the consume row recorded (viewer, organization,
 *     template) at the one moment all three were true, and that row is the
 *     binding, re-checked against the live reader.
 *   · IT CAME FROM THE RUN'S OWN SCHEDULING STEP — there is no proposal and never
 *     was one, so the binding is THE RUN'S OWN ACCESS CONTROL, re-run here
 *     against the live reader: `readAgentRunById` with the reader's actor and
 *     role hints is the same probe every other run surface takes, so an owner, a
 *     co-owner of a shared run and an organization administrator each read this
 *     schedule exactly where they already read the run — and nobody else does.
 *     This used to answer `absent`, on the reading that "the Trigger tab is that
 *     schedule's surface" and drawing the card here would be a second renderer
 *     of one thing. cinatra#3004 retires that surface: the schedule tab now
 *     mounts THIS card, so refusing here would leave the ordinary run — the one
 *     scheduled on its own step, which is most of them — with no schedule drawn
 *     on any page at all.
 *
 *     WITHOUT AN ACCESS CONTEXT IT FAILS CLOSED to the run's own owner in the
 *     reader's own organization. A caller that cannot present the reader's
 *     standing cannot be granted the standing's answer.
 *
 * THE REFUSALS THAT STAY, all `absent`, and each is deliberate:
 *
 *   · the reader is not the person the schedule is bound to — the proposal's
 *     (user, org) pair, or the run's own access control.
 *   · the organization does not match the reader's active one.
 *   · the run or its template has vanished.
 *   · an `immediate` row on a run with no proposal — **Run right after setup**
 *     names no moment to open a schedule step onto, and that run's surface is
 *     the first-step form, which draws its own read-only reading once the row
 *     has fired (cinatra#2980). Written as an allow-list of the two scheduled
 *     kinds, so a kind added later is absent by default rather than drawn
 *     unnamed.
 *
 * There is NO proposal phase on this path, and that is structural rather than
 * an omission: Confirm CREATES the run, so a run exists only after a proposal
 * was confirmed. The pre-confirm phases live where the proposal does — in the
 * conversation that made it.
 */
export async function resolveProposalForRun(
  runId: string,
  actor: ConfirmProposalActor,
  /**
   * The reader's standing, for the no-proposal branch (cinatra#3004). Optional
   * because the proposal branch never needs it and a caller that holds no
   * session cannot invent one; absent, that branch falls back to the run's own
   * owner, which is the narrowest true answer rather than a wider guess.
   */
  access?: { actor: PrimitiveActorContext; roles?: ActorRoleHints },
): Promise<ProposalResolution> {
  const consumed = await readProposalConsumeByRunId(runId);
  // The proposal's own binding, re-checked against the LIVE reader. Neither
  // half comes from the caller: both are read off the row the confirm
  // transaction wrote.
  if (consumed) {
    if (consumed.consumedBy !== actor.userId) return { phase: "absent" };
    if (consumed.orgId !== actor.orgId) return { phase: "absent" };
  }
  // No proposal: the RUN is the binding (cinatra#3004), and the run's OWN access
  // control is what says so — the same probe the run's pages take, so this card
  // is neither narrower nor wider than the run it belongs to.
  let run: Awaited<ReturnType<typeof readAgentRunById>> = null;
  if (!consumed) {
    try {
      run = access
        ? await readAgentRunById(runId, access.actor, access.roles)
        : await readAgentRunById(runId);
    } catch (err) {
      // A denial is an ABSENCE here, like every other refusal on this call: the
      // reader learns nothing about a run they may not see.
      if (err instanceof AuthzError) return { phase: "absent" };
      throw err;
    }
    if (!run) return { phase: "absent" };
    if (run.orgId !== actor.orgId) return { phase: "absent" };
    // Fail closed where no standing was presented: the owner, and only them.
    if (!access && run.runBy !== actor.userId) return { phase: "absent" };
  }
  const templateId = consumed ? consumed.templateId : run!.templateId;

  const [template, trigger, intent] = await Promise.all([
    readAgentTemplateById(templateId),
    readRunTriggerByRunId(runId),
    readInstallIntent(runId),
  ]);
  if (!template) return { phase: "absent" };
  if (template.orgId && template.orgId !== actor.orgId) return { phase: "absent" };

  const triggerType =
    (trigger?.triggerType as "immediate" | "scheduled" | "recurring" | undefined) ??
    intent?.triggerType ??
    null;
  // Neither a trigger row nor an install intent means there is nothing armed to
  // draw the chrome of — the install never reached the outbox.
  if (!triggerType) return { phase: "absent" };
  // A run that came from no proposal draws the card only for the two SCHEDULED
  // kinds — see the header. A confirmed proposal keeps drawing whatever it
  // settled into, `immediate` included: that card is the answer to a schedule
  // the reader stated in a conversation, and it has always been drawn.
  if (!consumed && triggerType !== "scheduled" && triggerType !== "recurring") {
    return { phase: "absent" };
  }

  return {
    phase: "settled",
    runId,
    agentName: template.name ?? template.packageName ?? "this agent",
    triggerType,
    // The plain-language line is the SETTLED trigger's, read back from the row
    // the install wrote rather than from a token this host does not hold.
    scheduleCopy: describeInstalledSchedule({
      triggerType,
      scheduledAt: trigger?.scheduledAt ?? intent?.scheduledAt ?? null,
      cronExpression: trigger?.cronExpression ?? intent?.cronExpression ?? null,
    }),
    timezone: trigger?.timezone ?? intent?.timezone ?? "UTC",
    // The same read-back the conversation's settled card uses, from the same
    // durable row, so the run page's schedule step and the chat card cannot
    // draw two different sets of rows for one armed trigger.
    schedule: selectionsFromInstalled({
      triggerType,
      scheduledAt: trigger?.scheduledAt ?? intent?.scheduledAt ?? null,
      cronExpression: trigger?.cronExpression ?? intent?.cronExpression ?? null,
      timezone: trigger?.timezone ?? intent?.timezone ?? "UTC",
    }),
    released: !!trigger?.releasedAt,
    arming: !!intent && intent.status !== "done" && intent.status !== "failed",
    // THE TWO FAMILIES, TWO STAMPS (cinatra#2972). See `ProposalResolution`.
    firedOnce:
      triggerType === "recurring"
        ? !!trigger?.lastFiredAt
        : !!trigger?.releasedAt,
    stopped: trigger?.stoppedAt != null,
    canSave: canSaveInstalled({
      triggerType,
      scheduledAt: trigger?.scheduledAt ?? intent?.scheduledAt ?? null,
      released: !!trigger?.releasedAt,
      arming: !!intent && intent.status !== "done" && intent.status !== "failed",
      stopped: trigger?.stoppedAt != null,
    }),
    // NEVER superseded on this path, and structurally so rather than by
    // omission (cinatra#2859). `superseded` answers "this CARD is holding rows
    // the family did not settle on", and it can only be asked where the card
    // holds rows of its own — a proposal TOKEN. A run-addressed card holds
    // none: every line above is read back from the durable trigger row and the
    // install intent, which ARE what the family settled on. There is nothing
    // for the installed schedule to disagree with.
    superseded: false,
  };
}

/**
 * The INSTALLED schedule, read back as §VI's SELECTIONS (cinatra#2788, S9d).
 *
 * The settled card draws the same three option rows as the proposal — plan (A)
 * §7.2, "the same card, with the same option rows, now shows the armed
 * schedule" — and rows cannot be drawn from prose. So the durable row is read
 * back into the closed selection vocabulary by `parseCronToRecurring`, the ONE
 * module that says what a selection means, completed against its own defaults
 * exactly as the scheduling step completes a partial reading before drawing it.
 * A cron that will not parse falls back to the vocabulary's default selection
 * rather than inventing one: `scheduleCopy` beside the rows still carries the
 * raw expression, so nothing is claimed that the row does not say.
 *
 * A NAIVE WALL CLOCK is what the one-off row hands back, because that is what
 * the `datetime-local` control and the wire schema both take. The stored
 * instant is UTC; it is rendered in the trigger's OWN timezone, so re-saving
 * an untouched card re-arms the same moment rather than shifting it by the
 * offset.
 */
export function selectionsFromInstalled(input: {
  triggerType: "immediate" | "scheduled" | "recurring";
  scheduledAt: Date | null;
  cronExpression: string | null;
  timezone: string;
}): ProposalSchedule {
  if (input.triggerType === "immediate") return { kind: "immediate" };
  if (input.triggerType === "scheduled") {
    return {
      kind: "scheduled",
      runAt: naiveWallClockIn(input.scheduledAt ?? new Date(), input.timezone),
      timezone: input.timezone,
    };
  }
  const partial = input.cronExpression ? parseCronToRecurring(input.cronExpression) : null;
  return {
    kind: "recurring",
    selection: { ...DEFAULT_RECURRING_CONFIG, ...(partial ?? {}) },
    timezone: input.timezone,
  };
}

/** A UTC instant as the timezone-naive "YYYY-MM-DDTHH:MM" the form emits,
 *  rendered in `timezone`. The inverse of `naiveDatetimeToUtcMs`. */
function naiveWallClockIn(at: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hour = get("hour") === "24" ? "00" : get("hour");
    return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
  } catch {
    return at.toISOString().slice(0, 16);
  }
}

/**
 * May **Save changes** re-arm this installed trigger?
 *
 * The reading the server enforces, computed once so the card and the endpoint
 * cannot disagree about which schedules are still changeable.
 */
export function canSaveInstalled(input: {
  triggerType: "immediate" | "scheduled" | "recurring";
  scheduledAt: Date | null;
  released: boolean;
  arming: boolean;
  /** The schedule was stopped by **Cancel schedule** (cinatra#2972). */
  stopped: boolean;
}): boolean {
  if (input.arming) return false;
  // A STOPPED SCHEDULE IS OVER. Plan (A) §7.2: Cancel schedule "stops the
  // recurring schedule and then makes the scheduler non-editable".
  if (input.stopped) return false;
  // A RECURRING SCHEDULE STAYS CHANGEABLE AFTER IT HAS FIRED (cinatra#2972).
  // Plan (A) §7.2 as amended 2026-08-25: "a run set to **Recurring** that has
  // fired keeps its scheduler editable … and a change applies to its future
  // runs". `released` is not even consulted for it — a recurring schedule's own
  // gate is never opened by a tick, so the stamp says nothing about it, and the
  // ticks already fired are separate runs no change reaches back into.
  if (input.triggerType === "recurring") return true;
  // A ONE-OFF THAT HAS FIRED IS NOT A SCHEDULE. Re-arming it would create a
  // second run from a control whose whole promise is "change this one". Plan (A)
  // §7.2: "once a run set to **Run right after setup** or **Schedule for later**
  // has fired, its schedule cannot be changed any more".
  if (input.released) return false;
  if (input.triggerType === "scheduled") {
    return !!input.scheduledAt && input.scheduledAt.getTime() > Date.now();
  }
  return true;
}

/**
 * The settled schedule in plain words, from the INSTALLED row.
 *
 * The conversation's settled card reads its line off the proposal token it
 * still holds; this host has no token, so the line is derived from what was
 * actually installed. `parseCronToRecurring` + `describeRecurrence` is the SAME
 * pair the scheduling step and the proposal both use, so the two readings of
 * one schedule cannot drift; the raw expression is the honest fallback the
 * Trigger tab already falls back to when no preview can be built.
 */
function describeInstalledSchedule(input: {
  triggerType: "immediate" | "scheduled" | "recurring";
  scheduledAt: Date | null;
  cronExpression: string | null;
}): string {
  if (input.triggerType === "immediate") return "Runs right after setup";
  if (input.triggerType === "scheduled") {
    return input.scheduledAt
      ? `Once, at ${input.scheduledAt.toISOString().slice(0, 16).replace("T", " ")} UTC`
      : "Once, at the scheduled time";
  }
  if (!input.cronExpression) return "On its recurring schedule";
  // `parseCronToRecurring` answers a PARTIAL selection — it reads back only what
  // the expression actually pins — so it is completed against the vocabulary's
  // own defaults, exactly as the scheduling step completes it before drawing.
  const selection = parseCronToRecurring(input.cronExpression);
  return selection
    ? describeRecurrence({ ...DEFAULT_RECURRING_CONFIG, ...selection })
    : input.cronExpression;
}
