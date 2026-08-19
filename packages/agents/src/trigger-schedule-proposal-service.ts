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
//   ADJUST   — the reader changes the rows. RE-PROPOSES: a fresh token, a fresh
//              consume identity. It mutates nothing, because there is nothing
//              to mutate — which is why Adjust needs no authority at all and can
//              never half-arm a schedule.
//
// ADJUST HAS TWO FORMS, and they differ in exactly two places. Editing the rows
// on a DRAWN card asks a different question, so it gets a fresh consume identity
// and the superseded card stays separately answerable; it writes nothing at all.
// Adjusting an EXPIRED card re-asks the SAME question off the same ref, so (a)
// its replacement INHERITS the original's consume identity — one lineage, one
// row in the consume table, one run, whatever order a re-propose and an
// in-flight Confirm land in — and (b) it is IDEMPOTENT WHILE LIVE: the lineage
// records the replacement holding its window open, and pressing Adjust again
// hands that same token back rather than minting another. The expired ref is
// readable forever by design, and that is the only thing stopping it being an
// unbounded token mill. See `reproposeExpiredScheduleProposal`.
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
  type RecurringConfig,
} from "./trigger-recurrence";
import {
  proposalConsumeKey,
  readTriggerScheduleProposalToken,
  verifyTriggerScheduleProposalToken,
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
  reproposeTriggerScheduleInLineage,
  type ProposeScheduleInput,
  type ProposeScheduleResult,
} from "./trigger-schedule-propose";

export {
  naiveDatetimeToUtcMs,
  proposeTriggerSchedule,
  adjustTriggerSchedule,
  reproposeTriggerScheduleInLineage,
  type ProposeScheduleInput,
  type ProposeScheduleResult,
};
import {
  createAgentRunPendingInput,
  readAgentRunById,
  readAgentTemplateById,
  transitionRunStatus,
  RunTransitionError,
} from "./store";
import {
  createOrUpdateRunTrigger,
  readRunTriggerByRunId,
} from "./trigger-store";
import { scheduleTrigger } from "./trigger-schedule";
import { setRunTriggerForActor } from "./trigger-service";
import { assertAgentPackageRunnable } from "./runtime-install-gate";
import {
  ProposalAlreadyConsumedError,
  claimLineageReproposal,
  claimPendingInstallIntents,
  markInstallIntentArmed,
  markInstallIntentDone,
  parkInstallIntent,
  readInstallIntent,
  readLineageReproposal,
  readProposalConsume,
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

/** What Confirm says when the proposal is no longer good. */
export const PROPOSAL_REFUSALS = {
  invalid:
    "This schedule proposal is no longer valid — it may have expired. Ask again and confirm the new one.",
  notRunnable:
    "This agent can't be run right now. Open its listing to see what it needs.",
  unknownAgent:
    "The agent this schedule was proposed for is no longer available.",
  installFailed:
    "The schedule could not be armed just now — please try again.",
  past:
    "That time has already passed. Ask for a new time and confirm the new card.",
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
    const created = await createAgentRunPendingInput(
      {
        templateId: proposal.templateId,
        runBy: actor.userId,
        inputParams: {},
        orgId: actor.orgId,
        // Interactive: the reader is looking at the card they just pressed.
        // cinatra#2067 — the run may park at the recommendation interception
        // before it dispatches, exactly as every other interactive run-start.
        humanPresent: true,
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
      authority,
    );
    runId = created.id;
  } catch (err) {
    if (err instanceof ProposalAlreadyConsumedError) {
      // The race we designed for: a concurrent Confirm won. Our run rolled back
      // with the failed insert, so there is exactly one run and it is theirs.
      const winner = await readProposalConsume(consumeKey);
      if (winner) {
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
  | {
      /** Entitled, unconfirmed, and the window closed. A DRAWN reading. */
      phase: "expired";
      proposal: TriggerScheduleProposal;
      agentName: string;
      scheduleCopy: string;
    }
  | {
      phase: "settled";
      runId: string;
      agentName: string;
      triggerType: "immediate" | "scheduled" | "recurring";
      scheduleCopy: string;
      timezone: string;
      released: boolean;
      arming: boolean;
    };

/**
 * Resolve what a proposal card may draw RIGHT NOW, against this reader.
 *
 * The order matters and mirrors S1's: decode → bind to the reader → has it been
 * confirmed? → is the window still open? → may this reader confirm it? A ref
 * that does not decode, a proposal minted for someone else and a template that
 * has since vanished all answer `absent`, so the card is a probe for nothing.
 *
 * A SPENT proposal resolves to its run — which is why the settled card can be
 * the trigger's chrome without the transcript carrying a run id: the token the
 * turn already holds addresses the consume row, and the consume row names the
 * run.
 *
 * EXPIRY IS READ AFTER THE CONSUME, not before it, and that is the second half
 * of the same fix. The token's TTL bounds how long a proposal may be CONFIRMED;
 * it says nothing about how long the card may be READ. Gating the whole resolve
 * on it (as the verify-only path did) deleted two different cards from the
 * transcript half an hour on: the expired proposal §VI says must stay visible,
 * and the SETTLED card — "the trigger's chrome" — for a schedule that was
 * confirmed and is now happily armed. A confirmed proposal is settled forever;
 * an unconfirmed one reads as `expired` forever. Neither ever goes blank.
 */
export async function resolveProposalForReader(
  token: string,
  actor: ConfirmProposalActor,
): Promise<ProposalResolution> {
  const reading = readTriggerScheduleProposalToken({
    token,
    expectedUserId: actor.userId,
    expectedOrgId: actor.orgId,
  });
  // One `absent` for a forged token, a foreign one and one this reader was
  // never minted — including when it has ALSO expired. Only a reader the token
  // names can learn anything about it at all.
  if (!reading) return { phase: "absent" };
  const { proposal } = reading;

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
    return {
      phase: "settled",
      runId: consumed.runId,
      agentName,
      triggerType:
        (trigger?.triggerType as "immediate" | "scheduled" | "recurring") ??
        (intent?.triggerType ?? "immediate"),
      scheduleCopy: describeProposalSchedule(proposal.schedule),
      timezone: trigger?.timezone ?? intent?.timezone ?? "UTC",
      released: !!trigger?.releasedAt,
      // "Arming…" rather than controls over a schedule still being installed.
      arming: !!intent && intent.status !== "done" && intent.status !== "failed",
    };
  }

  // The window closed with nobody confirming. §VI: not an error state — the
  // card says so and Adjust re-proposes for free. The runnable gate below is
  // deliberately NOT run for it: that verdict describes a floor this reading
  // does not have, and re-resolving it here would spend a provisioning read on
  // every reload of a card that asks nothing.
  if (reading.status === "expired") {
    return {
      phase: "expired",
      proposal,
      agentName,
      scheduleCopy: describeProposalSchedule(proposal.schedule),
    };
  }

  const notRunnable = await assertAgentPackageRunnable(
    template.packageName,
    template.packageName ?? template.name,
    { packageVersion: template.packageVersion ?? null },
  );
  return {
    phase: "proposal",
    proposal,
    agentName,
    canConfirm: !notRunnable,
    // §IV: the reason is on screen, and it describes the reader's own standing
    // without enumerating anything about the instance.
    restrictedReason: notRunnable ? PROPOSAL_REFUSALS.notRunnable : null,
  };
}

// ---------------------------------------------------------------------------
// ADJUST FROM AN EXPIRED CARD — re-propose off the card's own ref
// ---------------------------------------------------------------------------

/**
 * Re-propose the schedule an expired card is showing: a FRESH token on the
 * ORIGINAL's consume identity, nothing mutated.
 *
 * The token is genuinely new — fresh IV, fresh ciphertext, fresh `iat`/`exp`,
 * so the reader gets a real new window. What it deliberately does NOT get is a
 * new consume identity: the replacement is minted with the ORIGINAL's nonce, so
 * the whole lineage derives ONE `consume_key` and therefore addresses one
 * primary-keyed row in `trigger_schedule_proposal_consumes`. Whichever member
 * of the lineage is confirmed first is the only run, and every other card in it
 * resolves settled against that run. "Old and new both confirmed" is not a race
 * this code has to win; it is a state the database cannot hold. (An earlier
 * revision of this comment said "a fresh consume identity" — that was the
 * pre-fix behaviour and it was exactly the double-confirm defect.)
 *
 * It takes the CARD'S OWN REF rather than a template id and a schedule, and
 * that is the point. The expired token already carries both, server-side, and
 * it already proves this reader was minted this proposal — so Adjust from the
 * transcript needs no identifier to travel to the client and back, and cannot
 * be steered at a template the reader was never proposed. The generic
 * `adjustScheduleProposal` (which does take the rows, because a reader editing
 * them is choosing new ones) stays exactly as it is for the drawn form.
 *
 * Re-proposing needs NO authority, by §VI's own argument: it creates no run, no
 * trigger row and no record that this proposal was accepted, so there is nothing
 * to be authorized for. What the reader ends up holding is a new question —
 * whether they may answer it is re-resolved at render and again at Confirm, as
 * it always was. The one row it does write is the lineage ratchet below, which
 * is a bound ON this act rather than a product of it.
 *
 * IDEMPOTENT WHILE LIVE — the lineage-latest ratchet (codex round-4 finding 2).
 * An expired ref reads as authenticated contents FOREVER; that is deliberate
 * (§VI's expired card depends on it) and it means the ref in a transcript is a
 * re-proposal capability with no end date. The consume edge caps the lineage at
 * one RUN and caps minting at nothing: before this, every press produced another
 * fresh-TTL token, so a reader — or anyone holding a lifted transcript who can
 * authenticate as them — could keep an answerable window open indefinitely and
 * accumulate unbounded live tokens for one question.
 *
 * The bound is a single row keyed by the consume key this function already
 * derives (`trigger_schedule_proposal_lineage`). It names the replacement
 * currently holding the window open; while that replacement is un-expired,
 * Adjust RETURNS IT, and only once it has itself expired may another be minted.
 * Three consequences:
 *
 *   - at most ONE live token per lineage at any moment, so "how many
 *     confirmable copies of this question exist" has the answer 1, not n;
 *   - the confirmation window rolls forward by at most one TTL per REAL expiry,
 *     never by one per press;
 *   - the UX is unchanged — the reader may press Adjust as often as they like
 *     and always gets a live card back; it is simply the same one.
 *
 * A SUPERSEDED replacement's own ref keeps working exactly as any other expired
 * member of the lineage: it resolves to the expired reading, and its Adjust
 * answers with the CURRENT live replacement rather than opening a third branch —
 * the lineage has one identity, and now one live token.
 *
 * ONLY AN EXPIRED READING RE-PROPOSES (codex round-3 finding 1). The earlier
 * cut read the token's status and never required it, so an authenticated caller
 * holding a STILL-LIVE ref could ask for a second proposal of the same schedule
 * and then confirm both. That the UI draws this button only on an expired card
 * is not a boundary — the ref travels in the transcript and the action takes it
 * from the wire. The rule is enforced HERE, on the server, and it refuses with
 * the same `invalid` sentence a forged ref gets: a caller probing with a live
 * ref learns nothing it did not already know.
 *
 * ONE CONSUME IDENTITY PER LINEAGE (codex round-3 finding 2). The spent check
 * below is honest UX, NOT the safety property — it is a non-transactional read,
 * and a Confirm that verified while the token was still live can commit at any
 * moment during or after it. Two independently confirmable identities would
 * then exist, and both could be spent. So the replacement does not get an
 * identity of its own: it INHERITS the original's nonce, and therefore its
 * consume key. The old card and the new one are ONE row in
 * `trigger_schedule_proposal_consumes`, whose PRIMARY KEY on `consume_key` is
 * the exact primitive `spendProposalWithinTx` already relies on — the second
 * spender's INSERT raises a unique violation inside its own run-creation
 * transaction, unwinds it, and answers with the FIRST run. "Both confirmed" is
 * not a race the application has to win; it is a state the database cannot
 * hold. No lock, no claim row, no new table, and it composes with the drawn
 * form's Adjust, which keeps minting fresh identities because it is asking a
 * genuinely different question (`adjustTriggerSchedule`).
 *
 * The consequence worth naming: once ANY member of the lineage is confirmed,
 * every card in it resolves `settled` against the same run, so the expired card
 * still sitting in the transcript stops advertising an Adjust that could not
 * have produced anything anyway.
 *
 * A SPENT proposal is refused rather than re-proposed. Its card is settled, not
 * expired, so nothing draws this — but minting a replacement for it would hand
 * the reader a card that is dead on arrival, and saying so is more honest than
 * drawing it.
 */
export async function reproposeExpiredScheduleProposal(
  actor: ConfirmProposalActor,
  token: string,
): Promise<
  { ok: true; token: string; expiresAt: number } | { ok: false; error: string }
> {
  const reading = readTriggerScheduleProposalToken({
    token,
    expectedUserId: actor.userId,
    expectedOrgId: actor.orgId,
  });
  if (!reading) return { ok: false, error: PROPOSAL_REFUSALS.invalid };
  // A LIVE proposal is still answerable as it stands; re-proposing it is not an
  // affordance §VI grants. Indistinguishable from every other refusal here.
  if (reading.status !== "expired") {
    return { ok: false, error: PROPOSAL_REFUSALS.invalid };
  }
  const { proposal } = reading;

  // The lineage's ONE identity — spent by Confirm, and keyed on by the ratchet
  // below. Derived once here; both questions are about the same lineage.
  const consumeKey = proposalConsumeKey(proposal.nonce);
  const consumed = await readProposalConsume(consumeKey);
  if (consumed) return { ok: false, error: PROPOSAL_REFUSALS.invalid };

  // A ONE-SHOT WHOSE MOMENT HAS PASSED cannot be re-proposed as it stands, and
  // saying so is the honest answer rather than a generic "no". `propose` would
  // refuse it anyway (its future check is the same one Confirm applies); naming
  // it here is what turns a dead button into the sentence that tells the reader
  // what to do — ask for a new time.
  if (proposal.schedule.kind === "scheduled") {
    const ms = naiveDatetimeToUtcMs(
      proposal.schedule.runAt,
      proposal.schedule.timezone,
    );
    if (Number.isNaN(ms) || ms <= Date.now()) {
      return { ok: false, error: PROPOSAL_REFUSALS.past };
    }
  }

  // THE LINEAGE-LATEST RATCHET. If this lineage is already holding a
  // replacement open, that replacement IS the answer — pressing Adjust again
  // does not mint a second one. The stored token is re-read against the reader
  // asking, exactly as their own ref was, so the ratchet can never hand back a
  // token this reader is not entitled to and can never disagree with the
  // token's own clock about whether it is still live. BOTH places a stored
  // token can reach the reader do this read — here, and the post-claim yield
  // below; the second one used to only claim to.
  const latest = await readLineageReproposal(consumeKey);
  if (latest) {
    const held = readTriggerScheduleProposalToken({
      token: latest.token,
      expectedUserId: actor.userId,
      expectedOrgId: actor.orgId,
    });
    if (held?.status === "live") {
      return {
        ok: true,
        token: latest.token,
        expiresAt: held.proposal.expiresAt,
      };
    }
  }

  const proposed = await reproposeTriggerScheduleInLineage({
    templateId: proposal.templateId,
    userId: actor.userId,
    orgId: actor.orgId,
    schedule: proposal.schedule,
    // THE LINEAGE. Read back out of a token this server minted and
    // authenticated — never off the wire.
    lineageNonce: proposal.nonce,
  });
  // `propose` answers a bare `{ok:false}` — it is written for a model-facing
  // caller whose every denial is one sentence. The template may have been
  // deleted or moved out of reach since; either way the card can no longer be
  // re-proposed, which is what `invalid` says.
  if (!proposed.ok) return { ok: false, error: PROPOSAL_REFUSALS.invalid };

  // Claim the lineage's live slot for it — or yield to a replacement a
  // concurrent press established first, whose token is then the one the reader
  // gets. The claim is one conditional statement, so "two live replacements"
  // is not a race this code has to win either; see `claimLineageReproposal`.
  // A mint that loses the claim is simply discarded: it wrote no run and armed
  // nothing, so nothing has to be unwound.
  //
  // WHAT THE LOSER PATHS OWE, and did not pay (codex round-5, both findings).
  // Winning is the easy half: the token handed back is the one this call just
  // minted for this actor, so it is live and theirs by construction. Losing is
  // where the two invariants actually have to be re-established, and neither
  // was:
  //
  //   `yielded`  — the token belongs to whoever won, and it arrives here
  //                straight out of a table row. Nothing between the row and the
  //                reader had re-read it, so the ratchet's own promise — "the
  //                stored token is re-read against the reader asking, exactly
  //                as their own ref was" — was written in a comment and not in
  //                the code. See the read below.
  //   `vanished` — see `claimLineageReproposal`: the slot was neither claimed
  //                nor is anyone holding it. The earlier cut returned this
  //                call's OWN mint and called that honest. It was not: that
  //                token is in no lineage row, so the reader would walk away
  //                with a live token the ratchet is not counting, and a
  //                subsequent press could mint a second one alongside it —
  //                exactly the "at most ONE live token per lineage" the whole
  //                table exists to guarantee, broken by the one branch that
  //                claimed to be conceding.
  const claimInput = {
    consumeKey,
    token: proposed.token,
    expiresAt: new Date(proposed.expiresAt * 1000),
    orgId: actor.orgId,
    templateId: proposal.templateId,
    reproposedBy: actor.userId,
  };
  let claim = await claimLineageReproposal(claimInput);
  // ONE BOUNDED RETRY, and one is the right number. `vanished` says the slot is
  // free right now, so the same conditional statement can simply be re-run into
  // it — no new mint, no new state, and the claim is still the thing deciding.
  // A second `vanished` means the row is being churned under us faster than a
  // claim can land; looping would be a spin, and the honest answer is the
  // refusal below rather than an untracked mint.
  if (claim.outcome === "vanished") {
    claim = await claimLineageReproposal(claimInput);
  }

  if (claim.outcome === "claimed") {
    // Ours, and the lineage row names it. `proposed.expiresAt` is the mint's own
    // stamp — the row was written from it.
    return { ok: true, token: claim.record.token, expiresAt: proposed.expiresAt };
  }

  if (claim.outcome === "yielded") {
    // THE WINNER'S TOKEN, READ AS THE READER'S OWN REF WAS. Same call, same
    // expectations, same clock — so the ratchet can never hand back a token
    // this reader was not minted, and can never disagree with the token's own
    // TTL about whether the window is open. A stored token that fails either
    // test is not returned at all: the reader gets the same `invalid` sentence
    // the initial read would have given them, which is also what they would
    // have got had that token been their starting ref.
    const adopted = readTriggerScheduleProposalToken({
      token: claim.record.token,
      expectedUserId: actor.userId,
      expectedOrgId: actor.orgId,
    });
    if (adopted?.status !== "live") {
      return { ok: false, error: PROPOSAL_REFUSALS.invalid };
    }
    return {
      ok: true,
      token: claim.record.token,
      expiresAt: adopted.proposal.expiresAt,
    };
  }

  // Still `vanished` after the retry. Nothing of ours is installed anywhere, so
  // there is nothing to unwind and nothing to hand over. The next press starts
  // clean.
  return { ok: false, error: PROPOSAL_REFUSALS.invalid };
}
