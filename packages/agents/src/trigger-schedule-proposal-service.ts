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
  mintTriggerScheduleProposalToken,
  proposalConsumeKey,
  verifyTriggerScheduleProposalToken,
  type ProposalSchedule,
  type TriggerScheduleProposal,
} from "@/lib/trigger-schedule-proposal-token";
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
  claimPendingInstallIntents,
  markInstallIntentArmed,
  markInstallIntentDone,
  parkInstallIntent,
  readInstallIntent,
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
// PROPOSE
// ---------------------------------------------------------------------------

export type ProposeScheduleInput = {
  templateId: string;
  userId: string;
  orgId: string;
  schedule: ProposalSchedule;
};

export type ProposeScheduleResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false };

/**
 * Mint a proposal. WRITES NOTHING.
 *
 * The only checks here are the ones that would make the card a lie: the
 * template has to exist and be in the caller's reach, and the schedule has to
 * be one the scheduling step could have produced. Whether the reader may
 * DISPATCH is re-resolved at render and again at Confirm — a proposal is a
 * question, and a question the reader turns out not to be allowed to answer is
 * a drawn card with a disabled floor (§IV `restricted`), not a refusal to draw.
 *
 * Returns `{ok:false}` with no reason: the caller is a model-facing tool whose
 * every denial is one fixed sentence.
 */
export async function proposeTriggerSchedule(
  input: ProposeScheduleInput,
): Promise<ProposeScheduleResult> {
  if (!input.userId || !input.orgId) return { ok: false };

  const template = await readAgentTemplateById(input.templateId);
  if (!template) return { ok: false };
  // The org boundary, before anything confirms the template exists to a caller
  // outside it.
  if (template.orgId && template.orgId !== input.orgId) return { ok: false };

  // A schedule with a past `runAt` would be refused at Confirm by the trigger
  // service's own future check; refusing it HERE instead means the assistant
  // re-reads the user's intent rather than drawing a card that cannot be
  // pressed.
  if (input.schedule.kind === "scheduled") {
    const ms = naiveDatetimeToUtcMs(input.schedule.runAt, input.schedule.timezone);
    if (Number.isNaN(ms) || ms <= Date.now()) return { ok: false };
  }

  const minted = mintTriggerScheduleProposalToken({
    templateId: input.templateId,
    userId: input.userId,
    orgId: input.orgId,
    schedule: input.schedule,
  });
  if (!minted) return { ok: false };
  return { ok: true, token: minted.token, expiresAt: minted.expiresAt };
}

/**
 * ADJUST. A distinct name for the same act, because §VI draws it as a distinct
 * affordance and the distinction is the safety property: "Adjust opens the same
 * option rows in place; Confirm settles them." Adjusting a proposal RE-PROPOSES
 * — a new token with a new consume identity — rather than editing the old one,
 * so the previous proposal simply stops being confirmable and no partially
 * changed schedule can ever exist.
 *
 * The superseded token is deliberately NOT revoked. It has no server record to
 * revoke, and it does not need one: the two tokens carry DIFFERENT consume
 * identities, so confirming the stale one still creates exactly one run — the
 * one it describes. Revocation would buy nothing and cost a table.
 */
export async function adjustTriggerSchedule(
  input: ProposeScheduleInput,
): Promise<ProposeScheduleResult> {
  return proposeTriggerSchedule(input);
}

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

/**
 * Interpret a timezone-naive "YYYY-MM-DDTHH:MM" wall clock in an IANA zone.
 *
 * The same derivation `trigger-service.ts` uses, and it has to be: a proposal
 * validated here and armed there must agree on what "09:00 in Europe/Berlin"
 * is. `new Date(naive)` would read the string in the SERVER's zone (UTC), which
 * is the bug this exists to avoid.
 *
 * KNOWN LIMIT, INHERITED DELIBERATELY (codex round-2 finding). The offset is
 * inferred at a single reference instant and not round-tripped, so the two DST
 * edge cases are imprecise: a wall clock inside a spring-forward GAP (a time
 * that does not exist) maps to a nearby real instant rather than being refused,
 * and a fall-back AMBIGUOUS time resolves to one of its two instants without an
 * explicit policy. This is the SHIPPED behaviour of the scheduling form, and
 * making the conversational path stricter would be worse, not better: the
 * proposal and the form would then disagree about what a confirmed schedule
 * means, which is the one thing §VI's "confirm what you see" cannot survive.
 * Closing it is a change to BOTH, on its own issue.
 */
export function naiveDatetimeToUtcMs(naive: string, timezone: string): number {
  const padded = naive.length === 16 ? `${naive}:00` : naive;
  const asUtcMs = new Date(`${padded}Z`).getTime();
  if (Number.isNaN(asUtcMs)) return NaN;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(asUtcMs));
  } catch {
    // An unknown IANA zone. NaN, so both the propose check and the install
    // translation refuse rather than silently scheduling in UTC.
    return NaN;
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const rawHour = get("hour");
  const tzHour = rawHour === "24" ? "00" : rawHour;
  const inTzMs = new Date(
    `${get("year")}-${get("month")}-${get("day")}T${tzHour}:${get("minute")}:${get("second")}Z`,
  ).getTime();
  if (Number.isNaN(inTzMs)) return NaN;
  return asUtcMs + (asUtcMs - inTzMs);
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
 * confirmed? → may this reader confirm it? A ref that does not decode, a
 * proposal minted for someone else and a template that has since vanished all
 * answer `absent`, so the card is a probe for nothing.
 *
 * A SPENT proposal resolves to its run — which is why the settled card can be
 * the trigger's chrome without the transcript carrying a run id: the token the
 * turn already holds addresses the consume row, and the consume row names the
 * run.
 */
export async function resolveProposalForReader(
  token: string,
  actor: ConfirmProposalActor,
): Promise<ProposalResolution> {
  const proposal = verifyTriggerScheduleProposalToken({
    token,
    expectedUserId: actor.userId,
    expectedOrgId: actor.orgId,
  });
  if (!proposal) return { phase: "absent" };

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
