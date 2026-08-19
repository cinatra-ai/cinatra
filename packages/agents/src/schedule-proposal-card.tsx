"use client";

// ---------------------------------------------------------------------------
// `ScheduleProposalCard` — THE renderer of `trigger_schedule_proposal`
// (cinatra#2788, epic #2784 S9d). Design: design@92c1be7c6f864dec6382a9ef01e7b2e1c38aa871
// `specs/app-lifecycle-cards.html` §VI (the schedule proposal card), sourced
// from `specs/app-components.html` § "Standard scheduling step" (the rows) and
// § "Persistent trigger tab" (the settled chrome). Plan: PLAN: Agents Lifecycle
// §7 (the schedule trigger card) and §2 (the conversation the screens sit in).
//
// WHAT WAS HERE BEFORE: nothing. `registry.tsx` dispatched this kind to the S1
// shell — a grey box reading "Schedule proposal · Waiting for your decision."
// with no controls — while the server had been returning the whole card body
// and the confirm action had zero UI callers on any surface. A proposal made in
// a conversation could not be confirmed in that conversation, or anywhere else.
// This file is that card, and the shell is retired for this kind.
//
// ONE RENDERER, EVERY HOST. The same component draws the proposal in the chat
// thread, in the site widget, on the run page and in the review page's gate
// region. The HOST supplies a frame (spacing) and a credential; it never
// supplies a second drawing. That is the epic's structural rule and the reason
// this file is the only place §VI is composed.
//
// THREE BODY PHASES OVER S1's STATE LADDER. The state ladder is shared by every
// lifecycle kind and says what this READER may do; the body is §VI's and says
// what there IS to draw. They are resolved together, in one pass, so the card
// can never show a `pending` floor over a settled schedule:
//
//   proposal → the standard scheduling step: "When should this run?" over the
//              three option rows with the chosen one taking the indigo edge and
//              tint and owning its fields, then Estimated run duration, then
//              §VI's floor — Adjust · Confirm. Nothing exists yet.
//   settled  → the trigger's own chrome: the read-only Trigger configuration
//              summary, the steps held until the trigger fires, and two quiet
//              right-aligned controls — Cancel trigger, and Release now for an
//              administrator.
//   expired  → the proposal's thirty minutes ran out with nobody pressing
//              anything. It STAYS VISIBLE with Adjust to propose again (plan §7
//              step 5; §9.1 row 8). Not an error, and emphatically not `absent`
//              — that rung is reserved for a reader who may not see the subject
//              at all, and answering it deleted the card, and the question it
//              asked, out of the reader's own transcript.
//
// THE EXPIRED PHASE IS SHARED WITH cinatra#2836 (PR #2837), NOT FORKED FROM IT.
// That branch lands the today-fix: the token read that tells "expired" apart
// from "forged or foreign" without leaking which, and the resolver branch that
// stops collapsing the first into `absent`. This slice DRAWS the state. The body
// shape both need — `triggerScheduleProposalExpiredViewSchema` — is copied
// verbatim from that branch so the two additions are byte-identical and the
// merge is a resolution, not a reconciliation. Nothing of its token or
// entitlement work is duplicated here: on THIS branch the resolver never emits
// `expired` yet, so the phase is drawn and tested from the body and goes live
// the moment #2837 merges.
//
// EVERY DECISION IS CREDENTIAL-AWARE — the shape S8b gave the review card. A
// first-party host posts same-origin with its cookie; the widget posts the
// broker headers it already proves its RESOLVE with, at `credentials: "omit"`.
// That is not a second decision path: it is the same endpoint, the same
// canonical service calls, entered with the proof the surface actually has. On
// the widget the omission is load-bearing — the embed is same-origin to the
// app, so an ambient cookie would record an arming against a different person
// entirely. Drawing this card without it would have recreated the widget-parity
// defect the epic exists to close.
//
// AND EVERY COOKIE-BOUND AFFORDANCE IS GATED ON `useCookieSessionSurface`.
// "No auth declared" is TRUE in two situations — a well-formed cookie host, and
// a broken non-cookie declaration the provider refused — so it is not the
// question. The one control that is genuinely first-party (the deep link to the
// armed run) reads the context that answers it, and draws nothing outside a
// real cookie session rather than offering a link that would answer as somebody
// else or 404.
//
// THE ROWS ARE REPRODUCED, THE FLOOR IS NEW. §VI says so in as many words: "the
// same scheduling step everywhere else arms its trigger directly on Continue
// … On a proposal nothing exists until you confirm", and "this floor is the only
// new drawing in this section — the rows above it are reproduced unchanged". So
// the rows here carry the shipped scheduling step's own structure, classes and
// selection vocabulary — `trigger-recurrence` is the ONE module that says what a
// selection means, imported by the form, by the server's proposal producer and
// by this card alike, so the three cannot drift. What is deliberately NOT reused
// is the form's machinery: `TriggerScreenClient` is bound to react-hook-form, to
// a run id it submits against, and to `setRunTrigger`, which ARMS. A proposal
// has no run and must not arm on Continue. Reusing the component would have
// meant reusing the act, and the act is the one thing §VI changes.
//
// NO RAW CRON FIELD, ANYWHERE. §VI: "the builder's selections are what the
// reader sees and confirms". The selections travel; the cron is derived
// server-side at Confirm by the same `buildCron` the form would have called.
// There is no input here that could carry an expression, and the wire schema has
// no field to put one in.
//
// THE CLIENT NEVER NAMES A RUN OR A TEMPLATE. Cancel and Release act on the run
// the REF resolves to, server-side; Adjust re-proposes against the template the
// verified token names. A body that could name either would be a way to operate
// a trigger this card never drew.
//
// THE PROMPT-WINDOW SEAM (cinatra#2853, plan §2.2: "make it 8 in the morning on
// weekdays and confirm"). That issue owns the language — which card is active,
// what the words mean, whether they were an instruction at all. It does not own
// the act. So this module exports the act: `submitScheduleDecision` for one
// operation and `adjustAndConfirmSchedule` for §2.2's exact composite, both
// taking the same ref and the same host credential the card's own controls use,
// and both landing on the same re-authorizing endpoint. #2853 interprets; the
// card's own action surface decides. No card gains an action its controls do not
// already have.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { CalendarClock, Check, Pencil, Repeat, Zap } from "lucide-react";

import {
  LIFECYCLE_VIEW_SCHEMA_VERSION,
  type LifecycleCardHost,
  type LifecycleCardState,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type {
  ProposedSchedule,
  RecurringSelection,
  TriggerScheduleProposalPendingView,
  TriggerScheduleProposalSettledView,
  TriggerScheduleProposalExpiredView,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";
import { Button } from "@/components/ui/button";

import {
  useCookieSessionSurface,
  useLifecycleCardAuth,
  useLifecycleCardHost,
  useLifecycleCardResolve,
  type LifecycleCardAuth,
} from "./lifecycle-card-runtime";
import { WEEKDAY_LABELS } from "./trigger-recurrence";

export { LIFECYCLE_VIEW_SCHEMA_VERSION };

/** The one decision entry — the SAME endpoint the review card's floor posts to
 *  (`src/app/api/lifecycle-views/decide/route.ts`), branched by kind. §VI's card
 *  does not get an endpoint of its own for the same reason the widget does not:
 *  a second route would need a second widget audience that no already-minted
 *  `cwu_` carries. */
export const LIFECYCLE_VIEW_DECIDE_PATH = "/api/lifecycle-views/decide";

/**
 * The per-host FRAME — spacing only.
 *
 * "Presence is not layout": §IX fixes WHETHER a card appears and §VI fixes HOW
 * it is drawn, so a host may change the box the card sits in and nothing else.
 * Keeping this a total map over `LifecycleCardHost` is what makes "one renderer,
 * host-specific frame" checkable: a new host cannot be added without deciding
 * its frame here.
 */
const HOST_FRAME: Record<LifecycleCardHost, string> = {
  chat_thread: "my-3 flex w-full flex-col gap-3",
  run_card: "flex w-full flex-col gap-3",
  page_gate_region: "flex w-full flex-col gap-3",
  site_widget: "my-3 flex w-full flex-col gap-3",
};

// ---------------------------------------------------------------------------
// The ACTION SURFACE — exported so #2853's prompt window calls the card's own
// act rather than inventing a second one.
// ---------------------------------------------------------------------------

/** What one press (or one typed instruction) asks for. */
export type ScheduleDecisionOp = "confirm" | "adjust" | "cancel" | "release";

/** What the endpoint answers. `reproposed` carries the NEW ref: Adjust mints a
 *  fresh proposal and the card swaps to it, because a proposal is single-use. */
export type ScheduleDecisionOutcome =
  | { kind: "confirmed"; runId: string; alreadyConfirmed: boolean }
  | { kind: "reproposed"; ref: string; expiresAt: number }
  | { kind: "cancelled" }
  | { kind: "released" }
  | { kind: "not-permitted"; message: string }
  | { kind: "error"; message: string };

/** The generic transport failure. A non-2xx is deliberately uninformative: the
 *  endpoint answers the same way for "not yours" and "not there". */
const TRANSPORT_REFUSAL: ScheduleDecisionOutcome = {
  kind: "not-permitted",
  message: "This action could not be taken on this surface.",
};

/**
 * Submit ONE schedule decision on the host's own credential.
 *
 * Exported for #2853: the prompt window acting on the active card must reach
 * exactly this function with exactly the ref the card was drawn from, so a typed
 * "confirm it" and a pressed Confirm are the same request, re-authorized by the
 * same server, under the same authorization as the card's own controls.
 */
export async function submitScheduleDecision(input: {
  ref: string;
  op: ScheduleDecisionOp;
  /** §VI's selections — `adjust` only. Never a cron expression: the vocabulary
   *  has no field for one. */
  schedule?: ProposedSchedule;
  /** The host's credential. `null` on a first-party host: the request goes
   *  same-origin with the ambient cookie, exactly as it always has. */
  auth: LifecycleCardAuth | null;
}): Promise<ScheduleDecisionOutcome> {
  try {
    const response = await fetch(LIFECYCLE_VIEW_DECIDE_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(input.auth?.headers() ?? {}),
      },
      credentials: input.auth?.credentials ?? "same-origin",
      body: JSON.stringify({
        kind: "trigger_schedule_proposal",
        ref: input.ref,
        op: input.op,
        ...(input.schedule ? { schedule: input.schedule } : {}),
      }),
    });
    if (!response.ok) return TRANSPORT_REFUSAL;
    const payload: unknown = await response.json();
    const outcome = (payload as { outcome?: unknown } | null)?.outcome;
    if (typeof outcome !== "object" || outcome === null) return TRANSPORT_REFUSAL;
    return outcome as ScheduleDecisionOutcome;
  } catch {
    return { kind: "error", message: "The decision could not be sent." };
  }
}

/**
 * §2.2's composite, in one call: "make it 8 in the morning on weekdays and
 * confirm".
 *
 * ADJUST THEN CONFIRM, IN THAT ORDER, ON THE NEW REF. Adjust RE-PROPOSES — it
 * mints a fresh token with a fresh consume identity and writes nothing — so
 * confirming the OLD ref afterwards would arm the schedule the reader just
 * corrected. The new ref is what gets confirmed, and a failed adjust never
 * reaches a confirm.
 */
export async function adjustAndConfirmSchedule(input: {
  ref: string;
  schedule: ProposedSchedule;
  auth: LifecycleCardAuth | null;
}): Promise<ScheduleDecisionOutcome> {
  const adjusted = await submitScheduleDecision({
    ref: input.ref,
    op: "adjust",
    schedule: input.schedule,
    auth: input.auth,
  });
  if (adjusted.kind !== "reproposed") return adjusted;
  return submitScheduleDecision({
    ref: adjusted.ref,
    op: "confirm",
    auth: input.auth,
  });
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * §VI's card, on whichever host declared itself.
 *
 * Renders `null` for BOTH absences, and they are separate branches on purpose:
 * no host declared (this subtree is not a lifecycle surface) and `absent` (this
 * reader may not see the subject). Neither is ever drawn as the other, and
 * neither is drawn as a disabled card.
 */
export function ScheduleProposalCard({
  view,
}: {
  view: { viewType: "trigger_schedule_proposal"; schemaVersion: number; ref: string };
}): ReactElement | null {
  const host = useLifecycleCardHost();
  const auth = useLifecycleCardAuth();
  const present = host !== null;

  // Adjust RE-PROPOSES, so the ref this card is drawn from can change under it
  // without the turn changing. The wire ref is the starting point; a successful
  // adjust replaces it and the card re-resolves against the new proposal.
  const [liveRef, setLiveRef] = useState(view.ref);
  useEffect(() => setLiveRef(view.ref), [view.ref]);
  const [reloadToken, setReloadToken] = useState(0);

  const resolved = useLifecycleCardResolve({
    viewType: "trigger_schedule_proposal",
    ref: liveRef,
    enabled: present,
    reloadToken,
  });
  const state: LifecycleCardState | null = resolved?.state ?? null;
  const body = resolved?.body ?? null;

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  const decide = useCallback(
    async (op: ScheduleDecisionOp, schedule?: ProposedSchedule) => {
      const outcome = await submitScheduleDecision({ ref: liveRef, op, schedule, auth });
      // A landed decision RE-RESOLVES the card. Whatever it did, the server is
      // the only thing that knows what the card now shows — an armed schedule, a
      // deleted trigger, an opened gate — so nothing is drawn optimistically.
      if (outcome.kind === "reproposed") {
        setLiveRef(outcome.ref);
      } else if (
        outcome.kind === "confirmed" ||
        outcome.kind === "cancelled" ||
        outcome.kind === "released"
      ) {
        refresh();
      }
      return outcome;
    },
    [liveRef, auth, refresh],
  );

  if (!present || state === null || body === null) return null;
  // `advisory` is not a schedule state (§VII owns it) and `absent` draws no DOM
  // at all. Both fail closed rather than draw a floor over nothing.
  if (state.state === "advisory" || state.state === "absent") return null;

  const drawn =
    body.phase === "proposal" ? (
      <ProposalPhase
        body={body}
        state={state}
        onDecide={decide}
        onAdjustAndConfirm={async (schedule) => {
          const outcome = await adjustAndConfirmSchedule({ ref: liveRef, schedule, auth });
          if (outcome.kind === "confirmed") refresh();
          return outcome;
        }}
      />
    ) : body.phase === "expired" ? (
      <ExpiredPhase
        body={body}
        onRepropose={async (schedule) => {
          const outcome = await submitScheduleDecision({
            ref: liveRef,
            op: "adjust",
            schedule,
            auth,
          });
          if (outcome.kind === "reproposed") setLiveRef(outcome.ref);
          return outcome;
        }}
      />
    ) : (
      <SettledPhase body={body} onDecide={decide} />
    );

  return (
    <div
      className={HOST_FRAME[host]}
      data-lifecycle-card="trigger_schedule_proposal"
      data-lifecycle-card-state={state.state}
      data-lifecycle-card-host={host}
      data-lifecycle-card-phase={body.phase}
      data-conformance-id="schedule-proposal-card"
    >
      {drawn}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PROPOSAL — the standard scheduling step, then §VI's new floor
// ---------------------------------------------------------------------------

function ProposalPhase({
  body,
  state,
  onDecide,
  onAdjustAndConfirm,
}: {
  body: TriggerScheduleProposalPendingView;
  state: LifecycleCardState;
  onDecide: (op: ScheduleDecisionOp, schedule?: ProposedSchedule) => Promise<ScheduleDecisionOutcome>;
  onAdjustAndConfirm: (schedule: ProposedSchedule) => Promise<ScheduleDecisionOutcome>;
}): ReactElement {
  // §VI: "Adjust opens the same option rows IN PLACE". So the rows are always
  // the same rows — Adjust makes them writable, it does not swap in a second
  // form. Until it is pressed they are the reader's own proposal, read-only.
  const [adjusting, setAdjusting] = useState(false);
  const [draft, setDraft] = useState<ProposedSchedule>(body.schedule);
  const [pending, setPending] = useState<null | "confirm" | "adjust">(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  // A re-resolve that brings a different proposal replaces the draft: the rows
  // must show what the SERVER says was proposed, never a stale local edit.
  useEffect(() => {
    setDraft(body.schedule);
    setAdjusting(false);
  }, [body.schedule]);

  // §IV: a reader who may see the proposal but not confirm it gets a DRAWN card
  // with a disabled floor and the reason on screen — never a dropped one.
  const canConfirm = state.state === "pending" && body.canConfirm;
  const reason =
    !canConfirm
      ? body.restrictedReason ??
        (state.state === "restricted" ? state.reason : null) ??
        "You can't confirm this schedule."
      : null;

  const edited = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(body.schedule),
    [draft, body.schedule],
  );

  const confirm = async () => {
    setRefusal(null);
    setPending("confirm");
    // An EDITED proposal is re-proposed before it is confirmed, in that order,
    // on the new ref — the same composite §2.2's typed "…and confirm" performs.
    // Confirming the original ref would arm the schedule the reader just fixed.
    const outcome = edited ? await onAdjustAndConfirm(draft) : await onDecide("confirm");
    setPending(null);
    if (outcome.kind === "not-permitted" || outcome.kind === "error") {
      setRefusal(outcome.message);
    }
  };

  return (
    <div className="flex w-full flex-col gap-4 rounded-card border border-line bg-surface-strong p-4">
      <ScheduleOptionRows
        schedule={draft}
        editable={adjusting}
        onChange={setDraft}
        durationCopy={body.durationCopy}
      />

      {/* §VI — the floor, and the ONE thing this section draws that is new. */}
      <div
        data-conformance-id="schedule-proposal-floor"
        className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3"
      >
        {reason ? (
          <p
            data-conformance-id="schedule-proposal-restricted-reason"
            className="mr-auto text-sm text-muted-foreground"
          >
            {reason}
          </p>
        ) : null}
        {refusal ? (
          <p
            data-conformance-id="schedule-proposal-refusal"
            role="status"
            className="mr-auto text-sm text-destructive"
          >
            {refusal}
          </p>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-action="adjust-schedule-proposal"
          aria-pressed={adjusting}
          disabled={pending !== null}
          onClick={() => setAdjusting((open) => !open)}
        >
          <Pencil aria-hidden="true" className="size-3.5" />
          Adjust
        </Button>
        <Button
          type="button"
          size="sm"
          data-action="confirm-schedule-proposal"
          disabled={!canConfirm || pending !== null}
          onClick={confirm}
        >
          <Check aria-hidden="true" className="size-3.5" />
          {pending === "confirm" ? "Confirming…" : "Confirm"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EXPIRED — drawn, not dropped (plan §7 step 5, §9.1 row 8; cinatra#2836)
// ---------------------------------------------------------------------------

function ExpiredPhase({
  body,
  onRepropose,
}: {
  body: TriggerScheduleProposalExpiredView;
  onRepropose: (schedule: ProposedSchedule) => Promise<ScheduleDecisionOutcome>;
}): ReactElement {
  const [draft, setDraft] = useState<ProposedSchedule>(body.schedule);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  // NO CONFIRM FLOOR HERE, and that is the whole point of the state: the window
  // closed and the token is unspendable, so the card can hold the schedule
  // without holding a decision. Adjust re-proposes — for free, mutating nothing
  // — and the card swaps to the fresh proposal, back on its live floor.
  const repropose = async () => {
    setRefusal(null);
    setPending(true);
    const outcome = await onRepropose(draft);
    setPending(false);
    if (outcome.kind === "not-permitted" || outcome.kind === "error") {
      setRefusal(outcome.message);
    }
  };

  return (
    <div className="flex w-full flex-col gap-4 rounded-card border border-line bg-surface-strong p-4">
      <p
        data-conformance-id="schedule-proposal-expired"
        className="text-sm text-muted-foreground"
      >
        This schedule proposal expired before it was confirmed. Nothing was
        scheduled — adjust it to propose again.
      </p>
      <ScheduleOptionRows schedule={draft} editable onChange={setDraft} durationCopy={null} />
      <div
        data-conformance-id="schedule-proposal-floor"
        className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3"
      >
        {refusal ? (
          <p
            data-conformance-id="schedule-proposal-refusal"
            role="status"
            className="mr-auto text-sm text-destructive"
          >
            {refusal}
          </p>
        ) : null}
        <Button
          type="button"
          size="sm"
          data-action="adjust-schedule-proposal"
          disabled={pending}
          onClick={repropose}
        >
          <Pencil aria-hidden="true" className="size-3.5" />
          {pending ? "Proposing…" : "Adjust"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SETTLED — "the settled card is the trigger's chrome"
// ---------------------------------------------------------------------------

function SettledPhase({
  body,
  onDecide,
}: {
  body: TriggerScheduleProposalSettledView;
  onDecide: (op: ScheduleDecisionOp) => Promise<ScheduleDecisionOutcome>;
}): ReactElement {
  const [pending, setPending] = useState<null | "cancel" | "release">(null);
  const [confirming, setConfirming] = useState<null | "cancel" | "release">(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  // The deep link into the armed run is COOKIE-BOUND: it is a first-party app
  // route. Outside a real cookie session it is not offered — a widget reader
  // following it would arrive as whoever else is signed in on that browser, or
  // at a sign-in wall. `useCookieSessionSurface` is the only context that
  // answers this correctly, because "declared no credential" is also true of a
  // declaration the provider REFUSED.
  const firstParty = useCookieSessionSurface();

  const act = async (op: "cancel" | "release") => {
    setRefusal(null);
    setConfirming(null);
    setPending(op);
    const outcome = await onDecide(op);
    setPending(null);
    if (outcome.kind === "not-permitted" || outcome.kind === "error") {
      setRefusal(outcome.message);
    }
  };

  return (
    <div
      data-conformance-id="scheduled-run-chrome"
      className="flex w-full flex-col gap-4 rounded-card border border-line bg-surface-strong p-4"
    >
      {/* Trigger configuration — the read-only summary, reproduced from
          Components § Persistent trigger tab. */}
      <div className="flex flex-col gap-2">
        <h3 className="text-base font-semibold text-foreground">Trigger configuration</h3>
        <SummaryRow label="Type" value={body.triggerType} />
        <SummaryRow label="Schedule" value={body.scheduleCopy} />
        <SummaryRow label="Timezone" value={body.timezone} />
      </div>

      {/* Steps held until trigger fires — the same tree the Trigger tab draws,
          and the same sentence when there are none. The body carries an empty
          list rather than a wrong one where the tree has not been read. */}
      <div className="flex flex-col gap-2" data-conformance-id="schedule-gated-steps">
        <h3 className="text-sm font-medium text-foreground">
          Steps held until trigger fires
        </h3>
        {body.gatedSteps.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No side-effect steps detected. The trigger acts as a start gate only —
            the run begins when the trigger fires and runs to completion.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {body.gatedSteps.map((step) => (
              <li key={step.stepId} className="font-mono text-xs">
                {step.agentPath.length > 0 ? `${step.agentPath.join(" › ")} › ` : ""}
                {step.toolName}
                <span className="ml-2 text-[11px] uppercase">{step.inferredOrManual}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The state the controls are withheld for, said out loud rather than
          drawn as two dead buttons. */}
      {body.arming ? (
        <p data-conformance-id="schedule-arming" className="text-sm text-muted-foreground">
          Arming… the schedule is still being installed.
        </p>
      ) : null}
      {body.released ? (
        <p data-conformance-id="schedule-released" className="text-sm text-muted-foreground">
          Released — every held step is eligible now, so there is nothing left to
          cancel.
        </p>
      ) : null}

      {/* §VI — "two quiet right-aligned controls". Each asks first, in the words
          the Trigger tab already asks them in. */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        {refusal ? (
          <p
            data-conformance-id="schedule-proposal-refusal"
            role="status"
            className="mr-auto text-sm text-destructive"
          >
            {refusal}
          </p>
        ) : null}
        {firstParty ? (
          <a
            data-conformance-id="schedule-open-run"
            className="mr-auto text-sm text-muted-foreground underline underline-offset-2"
            href={`/agents/runs/${encodeURIComponent(body.runId)}`}
          >
            Open the run
          </a>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-action="cancel-trigger-schedule"
          disabled={!body.canCancel || pending !== null}
          onClick={() => setConfirming("cancel")}
        >
          {pending === "cancel" ? "Cancelling…" : "Cancel trigger"}
        </Button>
        {body.canRelease ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-action="release-trigger-now"
            disabled={pending !== null}
            onClick={() => setConfirming("release")}
          >
            {pending === "release" ? "Releasing…" : "Release now"}
          </Button>
        ) : null}
      </div>

      {confirming === "cancel" ? (
        <ConfirmStrip
          conformanceId="schedule-cancel-confirm"
          title="Cancel scheduled trigger?"
          description="The run will stay paused. You can re-arm a new trigger from this tab. Already-completed setup steps are preserved."
          dismissLabel="Keep trigger"
          confirmLabel="Cancel trigger"
          onDismiss={() => setConfirming(null)}
          onConfirm={() => void act("cancel")}
        />
      ) : null}
      {confirming === "release" ? (
        <ConfirmStrip
          conformanceId="schedule-release-confirm"
          title="Release trigger now?"
          description="All side-effect steps will become eligible immediately, including any irreversible sends or publishes. This cannot be undone."
          dismissLabel="Cancel"
          confirmLabel="Release now"
          onDismiss={() => setConfirming(null)}
          onConfirm={() => void act("release")}
        />
      ) : null}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

/**
 * The ask-first strip.
 *
 * IN THE CARD, NOT IN A MODAL. The Trigger tab asks through an AlertDialog,
 * which portals to the document body — correct on a page it owns, wrong inside a
 * chat transcript and inside the widget's frame, where a portalled overlay
 * escapes the card's own box and the embed's scroll. The WORDS are the Trigger
 * tab's, verbatim; only the container differs, which is the "host supplies a
 * frame, never a second drawing" rule applied to a confirmation.
 */
function ConfirmStrip({
  conformanceId,
  title,
  description,
  dismissLabel,
  confirmLabel,
  onDismiss,
  onConfirm,
}: {
  conformanceId: string;
  title: string;
  description: string;
  dismissLabel: string;
  confirmLabel: string;
  onDismiss: () => void;
  onConfirm: () => void;
}): ReactElement {
  return (
    <div
      role="alertdialog"
      aria-label={title}
      data-conformance-id={conformanceId}
      className="flex flex-col gap-2 rounded-control border border-line-strong bg-surface-muted p-3"
    >
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-sm text-muted-foreground">{description}</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          {dismissLabel}
        </Button>
        <Button type="button" size="sm" data-action="confirm-destructive" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The three OPTION ROWS — reproduced from Components § Standard scheduling step
// ---------------------------------------------------------------------------

/** The recurring row's defaults, for a reader who switches to it from another
 *  row. Mirrors the scheduling step's own initial selection. */
const DEFAULT_RECURRING: RecurringSelection = {
  frequency: "weekly",
  interval: 1,
  weekdays: [1, 2, 3, 4, 5],
  dayOfMonth: 1,
  monthlyMode: "date",
  nthWeek: 1,
  monthlyWeekday: 1,
  quarterAnchor: "start",
  yearlyMonth: 1,
  hour: 9,
  minute: 0,
};

/** The reader's own zone, for a row that has to name one and has none yet. */
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * "When should this run?" over the three rows, the chosen one taking the indigo
 * edge and tint and owning its fields, then Estimated run duration.
 *
 * NATIVE CONTROLS, DELIBERATELY. The shipped step uses the app's Select, which
 * portals its listbox to the document body. Inside a chat transcript and inside
 * the widget's iframe that overlay escapes the card, so the rows here use the
 * platform's own select and input with the step's classes. The STRUCTURE, the
 * copy and the selection vocabulary are the step's; only the widget primitive
 * differs, for the same reason the confirmation strip is not a modal.
 */
export function ScheduleOptionRows({
  schedule,
  editable,
  onChange,
  durationCopy,
}: {
  schedule: ProposedSchedule;
  editable: boolean;
  onChange: (next: ProposedSchedule) => void;
  durationCopy: string | null;
}): ReactElement {
  const kind = schedule.kind;
  const pick = (next: ProposedSchedule) => {
    if (editable) onChange(next);
  };
  const recurring = schedule.kind === "recurring" ? schedule.selection : DEFAULT_RECURRING;
  const timezone =
    schedule.kind === "immediate" ? browserTimezone() : schedule.timezone;
  const updateRecurring = (patch: Partial<RecurringSelection>) =>
    pick({ kind: "recurring", selection: { ...recurring, ...patch }, timezone });

  return (
    <div data-conformance-id="schedule-option-rows" className="flex flex-col gap-2">
      <p className="text-sm font-medium text-foreground">When should this run?</p>

      <OptionRow
        rowKind="immediate"
        chosen={kind === "immediate"}
        editable={editable}
        label="Run right after setup"
        icon={<Zap aria-hidden="true" className="size-3.5" />}
        onChoose={() => pick({ kind: "immediate" })}
      />

      <OptionRow
        rowKind="scheduled"
        chosen={kind === "scheduled"}
        editable={editable}
        label="Schedule for later"
        icon={<CalendarClock aria-hidden="true" className="size-3.5" />}
        onChoose={() =>
          pick({
            kind: "scheduled",
            runAt: schedule.kind === "scheduled" ? schedule.runAt : defaultRunAt(),
            timezone,
          })
        }
      >
        <div className="ml-7 flex flex-wrap gap-4">
          <Field label="Run at">
            <input
              type="datetime-local"
              data-field="schedule-run-at"
              className={FIELD_CLASS}
              disabled={!editable}
              value={schedule.kind === "scheduled" ? schedule.runAt : defaultRunAt()}
              onChange={(e) =>
                pick({ kind: "scheduled", runAt: e.target.value, timezone })
              }
            />
          </Field>
          <Field label="Timezone">
            <input
              type="text"
              data-field="schedule-timezone"
              className={FIELD_CLASS}
              disabled={!editable}
              value={timezone}
              onChange={(e) =>
                pick({
                  kind: "scheduled",
                  runAt: schedule.kind === "scheduled" ? schedule.runAt : defaultRunAt(),
                  timezone: e.target.value,
                })
              }
            />
          </Field>
        </div>
      </OptionRow>

      <OptionRow
        rowKind="recurring"
        chosen={kind === "recurring"}
        editable={editable}
        label="Recurring"
        icon={<Repeat aria-hidden="true" className="size-3.5" />}
        onChoose={() => pick({ kind: "recurring", selection: recurring, timezone })}
      >
        <div className="ml-7 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Repeat every</span>
            <select
              data-field="recurring-interval"
              aria-label="Repeat every"
              className={FIELD_CLASS}
              disabled={!editable}
              value={String(recurring.interval)}
              onChange={(e) => updateRecurring({ interval: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, 6, 8, 12].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <select
              data-field="recurring-frequency"
              aria-label="Frequency"
              className={FIELD_CLASS}
              disabled={!editable}
              value={recurring.frequency}
              onChange={(e) =>
                updateRecurring({
                  frequency: e.target.value as RecurringSelection["frequency"],
                })
              }
            >
              <option value="daily">day(s)</option>
              <option value="weekly">week(s)</option>
              <option value="monthly">month(s)</option>
              <option value="quarterly">quarter</option>
              <option value="yearly">year</option>
            </select>
          </div>

          {recurring.frequency === "weekly" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">On</span>
              <div className="flex gap-1">
                {WEEKDAY_LABELS.map((label, i) => (
                  <Button
                    key={label}
                    type="button"
                    variant="outline"
                    size="sm"
                    data-field="recurring-weekday"
                    data-weekday={i}
                    aria-pressed={recurring.weekdays.includes(i)}
                    disabled={!editable}
                    className={`h-8 w-10 rounded-control border text-xs font-medium transition-colors ${
                      recurring.weekdays.includes(i)
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-input bg-background text-muted-foreground hover:bg-muted"
                    }`}
                    onClick={() =>
                      updateRecurring({
                        weekdays: recurring.weekdays.includes(i)
                          ? recurring.weekdays.filter((d) => d !== i)
                          : [...recurring.weekdays, i].sort((a, b) => a - b),
                      })
                    }
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">At</span>
            <select
              data-field="recurring-hour"
              aria-label="Hour"
              className={FIELD_CLASS}
              disabled={!editable}
              value={String(recurring.hour)}
              onChange={(e) => updateRecurring({ hour: Number(e.target.value) })}
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>
                  {String(i).padStart(2, "0")}
                </option>
              ))}
            </select>
            <span className="text-muted-foreground">:</span>
            <select
              data-field="recurring-minute"
              aria-label="Minute"
              className={FIELD_CLASS}
              disabled={!editable}
              value={String(recurring.minute)}
              onChange={(e) => updateRecurring({ minute: Number(e.target.value) })}
            >
              {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                <option key={m} value={m}>
                  {String(m).padStart(2, "0")}
                </option>
              ))}
            </select>
          </div>

          <Field label="Timezone">
            <input
              type="text"
              data-field="recurring-timezone"
              className={FIELD_CLASS}
              disabled={!editable}
              value={timezone}
              onChange={(e) =>
                pick({
                  kind: "recurring",
                  selection: recurring,
                  timezone: e.target.value,
                })
              }
            />
          </Field>
        </div>
      </OptionRow>

      {/* §VI — "Estimated run duration / About 45s – 3.4 hr." `null` renders the
          honest "Unavailable." the shipped form already draws. */}
      <div className="flex flex-col gap-1 pt-1">
        <p className="text-sm font-medium text-foreground">Estimated run duration</p>
        <p data-conformance-id="schedule-duration" className="text-sm text-muted-foreground">
          {durationCopy ?? "Unavailable."}
        </p>
      </div>
    </div>
  );
}

const FIELD_CLASS =
  "h-8 rounded-control border border-input bg-background px-2 text-sm text-foreground disabled:opacity-100";

/** A one-off's default moment when the reader switches to that row: an hour out,
 *  as a timezone-NAIVE wall clock, exactly what the form's datetime-local emits
 *  and what the wire schema accepts. */
function defaultRunAt(): string {
  const t = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

function Field({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <label className="flex flex-col gap-1 text-sm text-muted-foreground">
      <span className="font-normal">{label}</span>
      {children}
    </label>
  );
}

/**
 * One option row. The CHOSEN one takes the indigo edge and tint and owns its
 * fields (§VI) — the same `border-primary bg-primary/5` pair the shipped
 * scheduling step marks its selection with.
 */
function OptionRow({
  rowKind,
  chosen,
  editable,
  label,
  icon,
  onChoose,
  children,
}: {
  rowKind: ProposedSchedule["kind"];
  chosen: boolean;
  editable: boolean;
  label: string;
  icon: ReactElement;
  onChoose: () => void;
  children?: ReactElement;
}): ReactElement {
  return (
    <div
      data-schedule-option={rowKind}
      data-chosen={chosen ? "true" : "false"}
      className={`flex flex-col gap-3 rounded-control border px-4 py-3 transition-colors ${
        chosen ? "border-primary bg-primary/5" : "border-input"
      }`}
    >
      <button
        type="button"
        disabled={!editable}
        aria-pressed={chosen}
        onClick={onChoose}
        className="flex items-center gap-3 text-left disabled:cursor-default"
      >
        <span
          className={`flex size-4 shrink-0 items-center justify-center rounded-full border-2 ${
            chosen ? "border-primary" : "border-muted-foreground"
          }`}
        >
          {chosen ? <span className="size-2 rounded-full bg-primary" /> : null}
        </span>
        {icon}
        <span className="text-sm font-medium text-foreground">{label}</span>
      </button>
      {/* The chosen row OWNS ITS FIELDS (§VI): the other rows' fields are not
          drawn at all, so there is never more than one live set of inputs. */}
      {chosen ? children ?? null : null}
    </div>
  );
}
