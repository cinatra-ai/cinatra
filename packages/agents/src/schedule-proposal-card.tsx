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
// and the confirm action had zero UI callers on any surface. A schedule stated
// in a conversation could not be confirmed in that conversation, or anywhere else.
// This file is that card, and the shell is retired for this kind.
//
// ONE RENDERER, EVERY HOST. The same component draws the stated schedule in the chat
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
//              tint and owning its fields, then Estimated run duration, then the
//              floor — Confirm, and nothing else. Nothing exists yet.
//   settled  → THE SAME CARD AND THE SAME ROWS, showing the schedule as it
//              stands, with Save changes to re-arm. NO label above it and NO
//              summary box beside it: plan (A) §7.2 as amended 2026-08-23 —
//              "the same card, with the same option rows, shows the schedule as
//              it stands — no label, no summary box", and for the two pages,
//              "The schedule step on the run page and the review page shows the
//              same form and nothing else — no summary box, no status label".
//              On the run page and the review page — where this card IS the
//              schedule step in the rail — the same body additionally carries
//              the ONE operation the plan leaves it: Cancel schedule, and only
//              for a recurring schedule that has fired once (cinatra#2972).
//              A ONE-OFF, AN IMMEDIATE, AND A STOPPED SCHEDULE DRAW NO FLOOR AT
//              ALL: "once a run set to Run right after setup or Schedule for
//              later has fired, its schedule cannot be changed any more", and
//              Cancel schedule "stops the recurring schedule and then makes the
//              scheduler non-editable" (§7.2, amended 2026-08-25).
//   expired  → the held schedule's thirty minutes ran out with nobody pressing
//              anything. It STAYS VISIBLE and EDITABLE, with Confirm to set the
//              schedule again (plan (A) §7.2 step 2; §9.1 row 8). Not an error, and
//              emphatically not `absent` — that rung is reserved for a reader
//              who may not see the subject at all, and answering it deleted the
//              card, and the question it asked, out of the reader's transcript.
//
// THREE THINGS THE PLAN FIXES THAT THIS CARD IS THE WHOLE IMPLEMENTATION OF:
//
//   1. NO ADJUST STEP. "The option rows are editable as they stand: until you
//      confirm, you change the schedule directly on the card — the rows are
//      never locked behind a separate step. The floor is **Confirm**" (§7.2).
//      There is no `Adjust` control on any phase. The re-propose it used to open
//      still happens — a proposal is single-use, so EDITED rows are re-proposed
//      and then confirmed, on the new ref — but it is an implementation of one
//      press, not a step the reader has to find.
//   2. NO SECOND CARD AFTER CONFIRM. "No second card is drawn for the confirmed
//      state: the same card, with the same option rows, now shows the armed
//      schedule; to change it you return to the card, change the rows and press
//      **Save changes**, which re-arms the trigger" (§7.2). The settled body
//      therefore carries the armed SELECTIONS, read back from the installed row,
//      and the rows are the same component in both phases.
//   3. THE OPERATION IS NOT IN THE CONVERSATION. Cancel schedule belongs to the
//      page's schedule step and not to the conversation (§7.2). That is the ONE
//      thing this renderer reads its host for, and it reads it through a total
//      map so a new host cannot be added without deciding the question.
//   4. THERE IS NO RUN NOW (cinatra#2972). §7.2 as amended 2026-08-25 says so in
//      those words. The control, its confirmation, its `release` op and the
//      service behind it are all removed — not hidden behind a role.
//
//      THE READ-ONLY CHROME THAT USED TO RIDE WITH THEM IS GONE ENTIRELY
//      (PR #2939): no Trigger configuration summary, no held-steps tree, no
//      "Armed ·" line, on any host. The plan clause quoted in the phase table
//      above is the authority; the run page's own Trigger tab still carries the
//      full chrome and is untouched by this card.
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
// THIS CARD DRAWS NO COOKIE-BOUND AFFORDANCE. It used to carry one — a deep
// link into the armed run — and that link is gone (maintainer, PR #2939): the
// card shows the schedule and the controls that change it, and nothing that
// navigates away. So there is no first-party/widget split left to gate here,
// and `useCookieSessionSurface` is no longer read by this module.
//
// THE ROWS ARE REPRODUCED, THE FLOOR IS NEW. The plan says so in as many words:
// "the same scheduling step everywhere else arms its trigger directly on
// **Continue**, because there the thing already exists. Nothing exists here
// until you confirm; **Confirm** arms the schedule you stated" (§7.2). So
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
// WHERE THE DRAWING AND THE PLAN DISAGREE, THE PLAN WINS. The ratified §VI
// drawing still shows an `Adjust · Confirm` floor and a settled card that is the
// trigger's chrome wherever it is drawn. The plan page supersedes both readings
// (§7.2, §7.4 "As designed", §9), and the design page needs the amendment — the
// same shape §9.1 already records for the chip row and the pinned capture pair.
// It is named here rather than silently implemented around.
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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { CalendarClock, Check, Repeat, Zap } from "lucide-react";

import type {
  LifecycleCardHost,
  LifecycleCardState,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type {
  ProposedSchedule,
  RecurringSelection,
  TriggerScheduleProposalPendingView,
  TriggerScheduleProposalSettledView,
  TriggerScheduleProposalExpiredView,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  useLifecycleCardAuth,
  useLifecycleCardHost,
  useLifecycleCardResolve,
  type LifecycleCardAuth,
} from "./lifecycle-card-runtime";
import {
  WEEKDAY_LABELS,
  applyArmedScheduleFill,
  // The SERVER'S OWN sentences for a schedule that can no longer be changed
  // (cinatra#2934), from the leaf both sides already share — so this card draws
  // the words the write guard answers with and no second wording exists.
} from "./trigger-recurrence";

/**
 * A FILL THE WINDOW UNDER THIS CARD PLACED (cinatra#2934, the armed-trigger
 * tab).
 *
 * THE OBJECT IS THE TURN. Its host mints a NEW one per accepted turn and never
 * mutates it, so the same values placed twice are two fills and the rows move
 * both times. It carries no timestamp: a clock reading is not an identity — two
 * turns landing in one millisecond would read as one and the second change
 * would be silently dropped.
 */
export type ArmedScheduleFill = {
  readonly values: Record<string, unknown>;
};

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

/**
 * Does THIS host draw the settled schedule's ONE operation — Cancel schedule?
 *
 * ONLY THE TWO PAGE HOSTS: §7.4's as-designed step 6 puts Cancel schedule on
 * the page and Save changes in the conversation, and on those two hosts this
 * card IS the page's schedule step (§7.2 step 5, §7.4 step 7), so they have
 * nowhere else to live.
 *
 * THE NAME IS HISTORICAL. This map once also gated a read-only chrome block —
 * the Trigger configuration summary and the held-steps tree — which PR #2939
 * removed from every host, and a second operation, Run now, which cinatra#2972
 * removed from the product. What it gates now is Cancel schedule alone.
 *
 * A TOTAL MAP, like `HOST_FRAME`, for the same reason: this is the one question
 * this renderer answers differently per host, so a new host cannot be added
 * without someone deciding it. It is not a second drawing — the rows, the
 * duration line and the Save-changes floor are byte-identical on all four hosts;
 * a page host draws an ADDITIONAL region the conversation is ruled not to have.
 */
const HOST_SHOWS_TRIGGER_CHROME: Record<LifecycleCardHost, boolean> = {
  chat_thread: false,
  site_widget: false,
  run_card: true,
  page_gate_region: true,
};

// ---------------------------------------------------------------------------
// The ACTION SURFACE — exported so #2853's prompt window calls the card's own
// act rather than inventing a second one.
// ---------------------------------------------------------------------------

/** What one press (or one typed instruction) asks for.
 *
 *  `adjust` is not a control any more — the rows are editable as they stand
 *  (plan (A) §7.2) — but it is still the OP the server takes to re-propose, and
 *  an edited Confirm composes with it. `save` is plan §7.2's "Save changes,
 *  which re-arms the trigger": the armed card's own floor. */
export type ScheduleDecisionOp = "confirm" | "adjust" | "save" | "cancel";

/** What the endpoint answers. `reproposed` carries the NEW ref: Adjust mints a
 *  fresh proposal and the card swaps to it, because a proposal is single-use. */
export type ScheduleDecisionOutcome =
  | { kind: "confirmed"; runId: string; alreadyConfirmed: boolean }
  | { kind: "reproposed"; ref: string; expiresAt: number }
  | { kind: "saved"; runId: string }
  | { kind: "cancelled" }
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
  armedFill = null,
}: {
  view: { viewType: "trigger_schedule_proposal"; schemaVersion: number; ref: string };
  /**
   * WHAT THE PROMPT WINDOW UNDER THIS CARD PLACED IN ITS ROWS (cinatra#2934).
   *
   * The window is a SIBLING of this card, not a child of it, so a fill reaches
   * the rows the only way it can: through the host that draws both. It moves the
   * SETTLED phase's draft and nothing else — a proposal's rows are the
   * conversation's, and a frozen card has no draft at all.
   */
  armedFill?: ArmedScheduleFill | null;
}): ReactElement | null {
  const host = useLifecycleCardHost();
  const auth = useLifecycleCardAuth();
  const present = host !== null;

  // Adjust RE-PROPOSES, so the ref this card is drawn from can change under it
  // without the turn changing. The wire ref is the starting point; a successful
  // adjust replaces it and the card re-resolves against the new proposal.
  const [liveRef, setLiveRef] = useState(view.ref);
  // The WIRE ref changed — a different turn, a different proposal. Adjusted
  // during render rather than in an effect: an effect would let one paint go out
  // with the previous proposal's ref still live, and this card's ref is what
  // every decision is taken against.
  const [wireRef, setWireRef] = useState(view.ref);
  if (wireRef !== view.ref) {
    setWireRef(view.ref);
    setLiveRef(view.ref);
  }
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
        outcome.kind === "saved" ||
        outcome.kind === "cancelled"
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
        // A re-resolve that brings a DIFFERENT proposal remounts the phase, so
        // the rows always show what the server says was proposed and a stale
        // local edit can never survive into another proposal's floor.
        key={JSON.stringify(body.schedule)}
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
        // CONFIRM ON AN EXPIRED CARD PROPOSES AGAIN AND CONFIRMS THE REPLACEMENT
        // (plan (A) §7.2 step 2). The expired token is unspendable, so a bare
        // confirm could never land; the composite is what makes one press mean
        // what the plan says it means. It is the SAME composite an edited live
        // proposal performs, on the same endpoint, under the same authorization.
        onRepropose={async (schedule) => {
          const outcome = await adjustAndConfirmSchedule({ ref: liveRef, schedule, auth });
          if (outcome.kind === "reproposed") setLiveRef(outcome.ref);
          if (outcome.kind === "confirmed") refresh();
          return outcome;
        }}
      />
    ) : (
      <SettledPhase body={body} host={host} onDecide={decide} armedFill={armedFill} />
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
// THE STATED SCHEDULE — the standard scheduling step, then the Confirm floor
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
  // THE ROWS ARE EDITABLE AS THEY STAND. Plan (A) §7.2: "until you confirm, you
  // change the proposal directly on the card — the rows are never locked behind
  // a separate step." There is no `adjusting` flag any more, and no control that
  // would set one: `editable` is simply true, and the reader's edits accumulate
  // in `draft` until they press the one thing on the floor.
  const [draft, setDraft] = useState<ProposedSchedule>(body.schedule);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  // §IV: a reader who may see the proposal but not confirm it gets a DRAWN card
  // with a disabled floor and the reason on screen — never a dropped one. The
  // rows stay read-only for them for the same reason the floor is dead: editing
  // a proposal they cannot confirm would be an offer the server refuses.
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
    setPending(true);
    // AN EDITED PROPOSAL IS RE-PROPOSED BEFORE IT IS CONFIRMED, in that order,
    // on the new ref — the same composite §2.2's typed "…and confirm" performs.
    // A proposal is single-use, so confirming the ORIGINAL ref would arm the
    // schedule the reader just corrected away from. This is what replaced the
    // Adjust button: the re-propose still happens, and the reader never has to
    // know it did.
    const outcome = edited ? await onAdjustAndConfirm(draft) : await onDecide("confirm");
    setPending(false);
    if (outcome.kind === "not-permitted" || outcome.kind === "error") {
      setRefusal(outcome.message);
    }
  };

  return (
    <div className="flex w-full flex-col gap-4 rounded-card border border-line bg-surface-strong p-4">
      <ScheduleOptionRows
        schedule={draft}
        editable={canConfirm}
        onChange={setDraft}
        durationCopy={body.durationCopy}
      />

      {/* The floor — Confirm and nothing else (plan (A) §7.2). */}
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
          size="sm"
          data-action="confirm-schedule-proposal"
          disabled={!canConfirm || pending}
          onClick={confirm}
        >
          <Check aria-hidden="true" className="size-3.5" />
          {pending ? "Confirming…" : "Confirm"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EXPIRED — drawn, editable, and still on its Confirm floor
// (plan (A) §7.2 step 2 and §7.4 as-designed step 5; §9.1 row 8; cinatra#2836)
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

  // THE SAME FLOOR AS THE LIVE CARD. "An expired card **stays visible**, still
  // editable, with **Confirm** to set the schedule again" (§7.2 step 2). The window
  // closed and the token is unspendable, so the press cannot be a bare confirm:
  // it re-proposes on the expired ref and confirms the replacement, which is the
  // same composite an EDITED live proposal performs. The reader sees one
  // control doing one thing.
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
        This schedule expired before it was confirmed. Nothing was scheduled —
        change it if you like, then confirm it again.
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
          data-action="confirm-schedule-proposal"
          disabled={pending}
          onClick={repropose}
        >
          <Check aria-hidden="true" className="size-3.5" />
          {pending ? "Confirming…" : "Confirm"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SETTLED — the same card, the same rows, the armed schedule, Save changes
// ---------------------------------------------------------------------------

function SettledPhase({
  body,
  host,
  onDecide,
  armedFill = null,
}: {
  body: TriggerScheduleProposalSettledView;
  host: LifecycleCardHost;
  onDecide: (op: ScheduleDecisionOp, schedule?: ProposedSchedule) => Promise<ScheduleDecisionOutcome>;
  armedFill?: ArmedScheduleFill | null;
}): ReactElement {
  const [draft, setDraft] = useState<ProposedSchedule>(body.schedule);
  const [pending, setPending] = useState<null | "save" | "cancel">(null);
  const [confirming, setConfirming] = useState<null | "cancel">(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The one host-dependent region, decided by a total map rather than by a
  // condition someone can forget to extend. What it now gates is the ONE
  // operation Cancel schedule: the read-only summary box and the held-steps
  // tree it used to gate were removed on the maintainer's reading of PR #2939,
  // and Run now was withdrawn by cinatra#2972 — plan (A) §7.2, "the schedule
  // step … shows the same form and nothing else — no summary box, no status
  // label; its one control is **Cancel schedule** … there is no Run now".
  const showsChrome = HOST_SHOWS_TRIGGER_CHROME[host];

  const edited = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(body.schedule),
    [draft, body.schedule],
  );

  // A DESCRIBED CHANGE MOVES THESE ROWS (cinatra#2934, the armed-trigger tab).
  //
  // It is written into `draft` — the SAME state every control on this card
  // writes — through `applyArmedScheduleFill`, the one function that says what a
  // placed value does to a selection, so a change typed into the window under
  // this card and the same change made with the mouse leave the form in the same
  // place. Nothing is saved by it: **Save changes** lights up because the draft
  // now differs from what is armed, and the person presses it.
  //
  // THE TURN IS THE KEY, and the turn is the FILL OBJECT ITSELF: the same values
  // placed twice are two turns and must move the rows twice. Applied in an effect rather than during
  // render because it is an event from a sibling, and only while the card can
  // still be changed — a frozen card draws the server's schedule and keeps no
  // draft at all.
  const appliedFill = useRef<ArmedScheduleFill | null>(null);
  useEffect(() => {
    if (!armedFill || !body.canSave) return;
    if (appliedFill.current === armedFill) return;
    appliedFill.current = armedFill;
    setSaved(false);
    setDraft((prev) => applyArmedScheduleFill(prev, armedFill.values));
  }, [armedFill, body.canSave]);

  // WHEN THE SCHEDULER STOPS BEING EDITABLE (plan (A) §7.2 and §7.4 as-designed
  // step 6, both as amended 2026-08-25 — cinatra#2972).
  //
  // TWO WAYS IN, AND ONLY TWO:
  //
  //   1. A run set to **Run right after setup** or **Schedule for later** HAS
  //      FIRED. "once a run set to Run right after setup or Schedule for later
  //      has fired, its schedule cannot be changed any more." `released` IS
  //      that firing for both: the release job opens the gate through
  //      `markTriggerReleased`, which stamps `releasedAt`, and the resolver
  //      reads `released` straight off that stamp. Nothing is inferred from a
  //      clock.
  //   2. A RECURRING schedule was STOPPED with **Cancel schedule**. "it stops
  //      the recurring schedule and then makes the scheduler non-editable."
  //
  // A FIRED RECURRING SCHEDULE IS NOT ONE OF THEM, and that is the change this
  // issue lands: "a run set to **Recurring** that has fired keeps its scheduler
  // editable — the same rows and **Save changes**, and a change applies to its
  // future runs — and shows **Cancel schedule**." `released` is not even
  // consulted for a recurring schedule: a tick opens the COPY's gate, never
  // this run's, so the stamp says nothing about whether it has fired. Its
  // firing is `canCancel`'s business, read server-side off the tick's own stamp.
  //
  // A FROZEN CARD CARRIES NO FLOOR AT ALL (cinatra#2934, the FOURTH graded
  // capture) — the ratified drawing at the pin this pull request records, read
  // against §7.2's own words.
  //
  // THE TWO READINGS THIS STATE HAS HAD, and why neither of the first two is
  // this one. It first drew NO floor and NO window, so a fired one-off stood
  // with its rows locked and no sentence anywhere: the reader was told nothing
  // rather than told why. It then drew the floor DEAD — Save changes present
  // and disabled, the state's own sentence inside the form — which the fourth
  // capture graded against the drawing and against §7.2 and both refuse: the
  // drawing gives this exact state no floor, no hairline and nothing to press,
  // and §7.2 says the surface "shows the same form and nothing else — no
  // summary box, no status label".
  //
  // BOTH THINGS ARE TRUE AT ONCE, and that is the whole reading: the CARD is
  // the form and nothing else, and the ANSWER lives in the prompt window below
  // the scheduler, which stays present and disabled and says in its own block
  // that the schedule can no longer be changed. Nothing is withheld from the
  // reader; it is simply drawn where the drawing puts it.
  //
  // AND THE SURFACES READ THE FLOOR'S PRESENCE AGAIN, as they always did before
  // the dead-floor reading made presence ambiguous.
  //
  // WHAT THIS DELIBERATELY DOES NOT CATCH. A one-off whose moment has passed
  // while the release job has not drained yet has NOT fired — its gate is still
  // shut and the server still authorizes what it authorized. The server does
  // refuse a SAVE there (`canSaveInstalled` wants a future instant), so that
  // card keeps its floor with Save changes dead. Widening "fired" to cover it
  // would take away an operation the server is still granting.
  //
  // AND WHY `arming` IS NOT CONSULTED. The installer exposes the schedule to
  // the scheduler BEFORE it marks the intent done, so a near-term one-off can
  // fire while the intent still reads as arming. A rule that required `!arming`
  // would leave the floor standing on a schedule that had already run.
  const frozen =
    (body.triggerType !== "recurring" && body.released) || body.stopped === true;

  // WHY **Save changes** IS WITHHELD FROM THIS READER, when the reason is about
  // the READER (cinatra#2934, the fourth graded capture). Plan (A) §1.2: a card
  // a person "may see but not act on" is "drawn in full with its buttons
  // disabled and the reason on the card". The sentence is the SERVER's, carried
  // on the body, and it is sent only for that case — a schedule that is over
  // sends none, because that card has no floor for one to sit on.
  const readerRefusal = body.saveRefusal ?? null;

  const act = async (op: "cancel") => {
    setRefusal(null);
    setConfirming(null);
    setPending(op);
    const outcome = await onDecide(op);
    setPending(null);
    if (outcome.kind === "not-permitted" || outcome.kind === "error") {
      setRefusal(outcome.message);
    }
  };

  // SAVE CHANGES RE-ARMS (plan (A) §7.2 step 6). Nothing is drawn optimistically:
  // the card re-resolves and reads the new schedule back off the installed row,
  // so what the rows show after a save is what the scheduler actually holds.
  const save = async () => {
    setRefusal(null);
    setSaved(false);
    setPending("save");
    const outcome = await onDecide("save", draft);
    setPending(null);
    if (outcome.kind === "saved") setSaved(true);
    else if (outcome.kind === "not-permitted" || outcome.kind === "error") {
      setRefusal(outcome.message);
    }
  };

  return (
    <div className="flex w-full flex-col gap-4 rounded-card border border-line bg-surface-strong p-4">
      {/* NOTHING IS DRAWN ABOVE THE ROWS for an ordinary settled card, and an
          ADJUSTED-THEN-CONFIRMED one is an ordinary settled card. Plan (A)
          §7.2: "the same card, with the same option rows, shows the schedule as
          it stands — no label, no summary box". The card re-opens on the
          SETTLED rows and says nothing over them.

          `superseded` STAYS A RESOLVER ANSWER (cinatra#2859) and stops being
          chrome. It answers whether THIS card's own proposal token holds the
          rows the family settled on — a question the resolver has to ask
          because Confirm refuses on it, and the rows it guards are already
          right: they are read back off the installed row, not off the token.
          The plan defines no drawing for it, so the renderer draws none rather
          than inventing a line the reader was never promised. `scheduleCopy`
          has no reader here for the same reason the "Armed ·" line has none —
          the settled card is the form, and a form does not restate itself in
          prose. */}
      {/* The state the controls are withheld for, said out loud rather than
          drawn as dead buttons. Both hosts draw these: a reader in the
          conversation whose Save changes is disabled is owed the reason too.
          NEITHER IS DRAWN ON A FROZEN CARD. Both lines exist to explain a
          withheld control, and a frozen card has none left to explain — the
          released/arming race can reach this card, and a status line standing
          over rows that simply stand is the label §7.2 removes. */}
      {body.arming && !frozen ? (
        <p data-conformance-id="schedule-arming" className="text-sm text-muted-foreground">
          Arming… the schedule is still being installed.
        </p>
      ) : null}
      {body.released && !frozen ? (
        <p data-conformance-id="schedule-released" className="text-sm text-muted-foreground">
          Released — every held step is eligible now, so there is nothing left to
          cancel.
        </p>
      ) : null}

      {/* THE SAME OPTION ROWS AS THE PROPOSAL — one component, drawing the armed
          selections the resolver read back off the installed row. */}
      {/* A FROZEN CARD HAS NO DRAFT. `draft` is the reader's local edit, and it
          outlives a re-resolve because `SettledPhase` is not remounted — so a
          one-off that fires, or a recurring schedule stopped, under half-typed
          rows would otherwise stand there read-only, showing times that were
          never armed. That is the same dishonesty §7.2's "shows the schedule as
          it stands" rules out, so the terminal card draws the server's schedule
          and only that. */}
      <ScheduleOptionRows
        schedule={frozen ? body.schedule : draft}
        editable={body.canSave}
        // A SCHEDULE THAT IS OVER IS NOT A REFUSED READER (cinatra#2934, the
        // fifth graded proof set). Both states arrive here with `canSave: false`,
        // and until now both drew the same DOM — every control present and
        // greyed. The drawing gives them two different readings: the frozen
        // card is "read-only, with no controls at all" while the refused reader
        // keeps "its buttons disabled and the reason on the card". `frozen` is
        // already the predicate that separates them, so it is what decides
        // whether the rows carry controls.
        readOnly={frozen}
        onChange={(next) => {
          setSaved(false);
          setDraft(next);
        }}
        durationCopy={null}
      />

      {/* NO FLOOR ON A SCHEDULE THAT IS OVER — see the note above `frozen`. The
          form, locked, and nothing else; the window below the scheduler is
          where this state says what it says. */}
      {frozen ? null : (
        <div
          data-conformance-id="schedule-proposal-floor"
          className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3"
        >
          {/* THE READER-SHAPED REASON, beside the control it explains (plan (A)
              §1.2). It stands where a live refusal would, and only one of the
              two is ever on the floor at a time — a card that just refused a
              press is showing that refusal. */}
          {!refusal && readerRefusal ? (
            <p
              data-conformance-id="schedule-proposal-refusal"
              role="status"
              className="mr-auto text-sm text-muted-foreground"
            >
              {readerRefusal}
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
          {saved && !refusal ? (
            <p
              data-conformance-id="schedule-saved"
              role="status"
              className="mr-auto text-sm text-muted-foreground"
            >
              Saved — the trigger is re-armed on these rows.
            </p>
          ) : null}
          <Button
            type="button"
            size="sm"
            data-action="save-schedule-changes"
            disabled={!body.canSave || !edited || pending !== null}
            onClick={save}
          >
            <Check aria-hidden="true" className="size-3.5" />
            {pending === "save" ? "Saving…" : "Save changes"}
          </Button>
          {/* CANCEL SCHEDULE IS THE PAGE STEP'S, NOT THE CONVERSATION'S — and
              it is drawn only where the plan puts it: "shown only for a
              recurring schedule that has fired once" (§7.2, amended
              2026-08-25). `canCancel` IS that whole reading, resolved
              server-side, so the control is ABSENT rather than disabled
              wherever the plan does not put it — a one-off, a recurring
              schedule that has not fired yet, and one already stopped. There is
              no Run now beside it any more (cinatra#2972). */}
          {showsChrome && body.canCancel ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-action="cancel-trigger-schedule"
              disabled={pending !== null}
              onClick={() => setConfirming("cancel")}
            >
              {pending === "cancel" ? "Stopping…" : "Cancel schedule"}
            </Button>
          ) : null}
        </div>
      )}

      {/* THE WORDS SAY WHAT THE ACT NOW IS (cinatra#2972). The old copy — "The
          run will stay paused" — described the DELETE this control used to
          perform, and the plan withdrew both halves of it: Cancel schedule
          "never deletes the schedule or pauses the run". */}
      {!frozen && confirming === "cancel" ? (
        <ConfirmStrip
          conformanceId="schedule-cancel-confirm"
          title="Stop this recurring schedule?"
          description="No further runs will start from it. The runs it has already started are not affected, and this run is not changed. The schedule stays here, and you will not be able to change it afterwards."
          dismissLabel="Keep schedule"
          confirmLabel="Cancel schedule"
          onDismiss={() => setConfirming(null)}
          onConfirm={() => void act("cancel")}
        />
      ) : null}
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
function ScheduleOptionRows({
  schedule,
  editable,
  readOnly = false,
  onChange,
  durationCopy,
}: {
  schedule: ProposedSchedule;
  editable: boolean;
  /**
   * THE SCHEDULE IS OVER (cinatra#2934, the fifth graded proof set) — a spent
   * one-off, or a recurring schedule that was stopped.
   *
   * `editable` and `readOnly` are two different answers and the drawing draws
   * them differently. `editable: false` alone is the reader who "may see but
   * not act on" the card: every control stays on screen, disabled, with the
   * reason beside it. `readOnly` is the schedule that is over: "the rows go
   * read-only — the values still legible, the pickers gone — and the card
   * carries no floor at all". So this flag removes the CONTROLS, not the
   * values, and it is set only where the card is frozen.
   */
  readOnly?: boolean;
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
        readOnly={readOnly}
        label="Run right after setup"
        icon={<Zap aria-hidden="true" className="size-3.5" />}
        onChoose={() => pick({ kind: "immediate" })}
      />

      <OptionRow
        rowKind="scheduled"
        chosen={kind === "scheduled"}
        editable={editable}
        readOnly={readOnly}
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
            {readOnly ? (
              <ReadOnlyValue field="schedule-run-at">
                {schedule.kind === "scheduled" ? schedule.runAt : defaultRunAt()}
              </ReadOnlyValue>
            ) : (
              <Input
                type="datetime-local"
                data-field="schedule-run-at"
                className="w-56"
                disabled={!editable}
                value={schedule.kind === "scheduled" ? schedule.runAt : defaultRunAt()}
                onChange={(e) =>
                  pick({ kind: "scheduled", runAt: e.target.value, timezone })
                }
              />
            )}
          </Field>
          <Field label="Timezone">
            {readOnly ? (
              <ReadOnlyValue field="schedule-timezone">{timezone}</ReadOnlyValue>
            ) : (
              <Input
                type="text"
                data-field="schedule-timezone"
                className="w-56"
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
            )}
          </Field>
        </div>
      </OptionRow>

      <OptionRow
        rowKind="recurring"
        chosen={kind === "recurring"}
        editable={editable}
        readOnly={readOnly}
        label="Recurring"
        icon={<Repeat aria-hidden="true" className="size-3.5" />}
        onChoose={() => pick({ kind: "recurring", selection: recurring, timezone })}
      >
        <div className="ml-7 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Repeat every</span>
            {readOnly ? (
              <>
                <ReadOnlyValue field="recurring-interval" width="w-20" label="Repeat every">
                  {String(recurring.interval)}
                </ReadOnlyValue>
                <ReadOnlyValue field="recurring-frequency" width="w-32" label="Frequency">
                  {FREQUENCY_LABELS[recurring.frequency]}
                </ReadOnlyValue>
              </>
            ) : (
              <>
            <Select
              disabled={!editable}
              value={String(recurring.interval)}
              onValueChange={(v) => updateRecurring({ interval: Number(v) })}
            >
              <SelectTrigger data-field="recurring-interval" aria-label="Repeat every" className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4, 6, 8, 12].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              disabled={!editable}
              value={recurring.frequency}
              onValueChange={(v) =>
                updateRecurring({ frequency: v as RecurringSelection["frequency"] })
              }
            >
              <SelectTrigger data-field="recurring-frequency" aria-label="Frequency" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">day(s)</SelectItem>
                <SelectItem value="weekly">week(s)</SelectItem>
                <SelectItem value="monthly">month(s)</SelectItem>
                <SelectItem value="quarterly">quarter</SelectItem>
                <SelectItem value="yearly">year</SelectItem>
              </SelectContent>
            </Select>
              </>
            )}
          </div>

          {recurring.frequency === "weekly" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">On</span>
              {/* WRAPS. The rail step's panel is narrower than a chat turn, and
                  a fixed row clipped the last weekday chip off the right edge
                  there — a control the reader could see but not press. */}
              <div className="flex flex-wrap gap-1">
                {readOnly
                  ? WEEKDAY_LABELS.map((label, i) => (
                      <ReadOnlyWeekday
                        key={label}
                        label={label}
                        weekday={i}
                        selected={recurring.weekdays.includes(i)}
                      />
                    ))
                  : WEEKDAY_LABELS.map((label, i) => (
                  <Button
                    key={label}
                    type="button"
                    // THE SELECTED DAYS HAVE TO BE LEGIBLE ON BOTH GROUNDS, and
                    // the variant is what decides that rather than the class
                    // list. `variant="outline"` carries its own `dark:bg-input-fill/30`,
                    // which tailwind-merge keeps beside a caller's unprefixed
                    // `bg-primary` (different modifier, different group) and
                    // which therefore PAINTS OVER the selection in the dark
                    // theme: every weekday chip rendered identically muted and
                    // the reader could not see which days the card was
                    // proposing. Caught by looking at the dark capture, not by
                    // review. A selected day is the `default` variant — the same
                    // one Confirm draws with, legible on both grounds — and it
                    // keeps its fill when the rows are read-only, because in
                    // that state the chip is the SCHEDULE being shown rather
                    // than a control being offered.
                    variant={recurring.weekdays.includes(i) ? "default" : "outline"}
                    size="sm"
                    data-field="recurring-weekday"
                    data-weekday={i}
                    aria-pressed={recurring.weekdays.includes(i)}
                    disabled={!editable}
                    className={`h-8 w-10 rounded-control border text-xs font-medium transition-colors ${
                      recurring.weekdays.includes(i)
                        ? "border-primary bg-primary text-primary-foreground disabled:opacity-100"
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
            {readOnly ? (
              <>
                <ReadOnlyValue field="recurring-hour" width="w-20" label="Hour">
                  {String(recurring.hour).padStart(2, "0")}
                </ReadOnlyValue>
                <span className="text-muted-foreground">:</span>
                <ReadOnlyValue field="recurring-minute" width="w-20" label="Minute">
                  {String(recurring.minute).padStart(2, "0")}
                </ReadOnlyValue>
              </>
            ) : (
              <>
            <Select
              disabled={!editable}
              value={String(recurring.hour)}
              onValueChange={(v) => updateRecurring({ hour: Number(v) })}
            >
              <SelectTrigger data-field="recurring-hour" aria-label="Hour" className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {String(i).padStart(2, "0")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground">:</span>
            <Select
              disabled={!editable}
              value={String(recurring.minute)}
              onValueChange={(v) => updateRecurring({ minute: Number(v) })}
            >
              <SelectTrigger data-field="recurring-minute" aria-label="Minute" className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {String(m).padStart(2, "0")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
              </>
            )}
          </div>

          <Field label="Timezone">
            {readOnly ? (
              <ReadOnlyValue field="recurring-timezone">{timezone}</ReadOnlyValue>
            ) : (
              <Input
                type="text"
                data-field="recurring-timezone"
                className="w-56"
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
            )}
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
    <div className="flex flex-col gap-1">
      <Label className="font-normal">{label}</Label>
      {children}
    </div>
  );
}

/** The words the frequency picker itself draws, so a spent schedule reads back
 *  in exactly the vocabulary the live row offered. Kept beside the picker it
 *  mirrors — one list, two readings. */
const FREQUENCY_LABELS: Readonly<Record<RecurringSelection["frequency"], string>> = {
  daily: "day(s)",
  weekly: "week(s)",
  monthly: "month(s)",
  quarterly: "quarter",
  yearly: "year",
};

/**
 * A FIELD OF A SPENT SCHEDULE — "the values still legible, the pickers gone"
 * (cinatra#2934, the fifth graded proof set).
 *
 * The ratified drawing draws a schedule that is over with its value in a plain
 * box of the field's own size and NOTHING to press: same edge, same ground,
 * the value in the muted secondary colour. It is deliberately NOT a disabled
 * input — a disabled input is the drawing's OTHER reading, the one a reader who
 * "may see but not act on" the card is owed, and drawing both the same way
 * would erase the difference between a schedule that is over and a reader who
 * is refused. See `readOnly` on `ScheduleOptionRows`.
 */
function ReadOnlyValue({
  field,
  width,
  label,
  children,
}: {
  field: string;
  width?: string;
  /**
   * The name the LIVE control carried (convergence round). Four of these boxes
   * replace a picker whose only name was its `aria-label` — *Repeat every*,
   * *Frequency*, *Hour*, *Minute* — and a bare box of digits says nothing about
   * which of them it is. The two that sit in a `Field` carry its visible label
   * already and pass none.
   */
  label?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      data-readonly-field={field}
      className={`flex h-9 items-center rounded-control border border-input bg-background px-3 text-sm text-muted-foreground ${width ?? "w-56"}`}
    >
      {label ? <span className="sr-only">{label}: </span> : null}
      {children}
    </div>
  );
}

/** A weekday of a spent recurring schedule. The chip KEEPS its fill — in this
 *  state it is the schedule being shown, not a control being offered — so the
 *  same two paints are used, on a span rather than a button. */
function ReadOnlyWeekday({
  label,
  selected,
  weekday,
}: {
  label: string;
  selected: boolean;
  weekday: number;
}): ReactElement {
  return (
    <span
      data-readonly-field="recurring-weekday"
      data-weekday={weekday}
      className={`inline-flex h-8 w-10 items-center justify-center rounded-control border text-xs font-medium ${
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-background text-muted-foreground"
      }`}
    >
      {label}
      {/* THE SAME REASON AS THE OPTION ROW (convergence round): the live chip is
          a button carrying `aria-pressed`, and losing the button must not lose
          the day. Seven abbreviations with nothing but a fill to tell them apart
          is not a legible reading of which days the schedule ran on. */}
      <span className="sr-only">{selected ? " selected" : " not selected"}</span>
    </span>
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
  readOnly = false,
  label,
  icon,
  onChoose,
  children,
}: {
  rowKind: ProposedSchedule["kind"];
  chosen: boolean;
  editable: boolean;
  readOnly?: boolean;
  label: string;
  icon: ReactElement;
  onChoose: () => void;
  children?: ReactElement;
}): ReactElement {
  // THE EDGE AND THE TINT DO NOT CHANGE WHEN THE SCHEDULE IS OVER. The drawing's
  // spent card carries the same border, the same ground and the same radio as
  // the live one — measured row for row against the armed card, the ONLY
  // difference is that the row does not take a press. So nothing here is
  // dimmed; the control itself is what goes away.
  const marker = (
    <>
      <span
        className={`flex size-4 shrink-0 items-center justify-center rounded-full border-2 ${
          chosen ? "border-primary" : "border-muted-foreground"
        }`}
      >
        {chosen ? <span className="size-2 rounded-full bg-primary" /> : null}
      </span>
      {icon}
      <span className="text-sm font-medium text-foreground">{label}</span>
      {/* THE CHOICE IS STILL A CHOICE WHEN THE FORM IS A READING (convergence
          round). The live row is a button carrying `aria-pressed`, so which of
          the three options the schedule stands on is announced. Drawing the
          spent row as a plain row took the control away and took that SEMANTIC
          with it: a reader who cannot see the indigo edge and tint met three
          schedule options with nothing saying which one had been armed — and a
          spent *Run right after setup* row has no fields beneath it to give the
          answer away. "The values still legible" has to hold for that reader
          too, so the state is said in words where the paint says it in colour.
          Only in the reading: the live row's `aria-pressed` already says it. */}
      {readOnly ? (
        <span className="sr-only">{chosen ? "Selected" : "Not selected"}</span>
      ) : null}
    </>
  );
  return (
    <div
      data-schedule-option={rowKind}
      data-chosen={chosen ? "true" : "false"}
      data-readonly={readOnly ? "true" : "false"}
      className={`flex flex-col gap-3 rounded-control border px-4 py-3 transition-colors ${
        chosen ? "border-primary bg-primary/5" : "border-input"
      }`}
    >
      {readOnly ? (
        /* "read-only, with no controls at all" — a spent schedule's row is a
           plain row. NOT a disabled button: a disabled button is still a
           control, is still announced as one, and is the drawing's reading for
           the reader who may not act rather than for the schedule that is
           over. */
        <div className="flex items-center gap-3 text-left">{marker}</div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          disabled={!editable}
          aria-pressed={chosen}
          onClick={onChoose}
          className="h-auto justify-start gap-3 p-0 text-left hover:bg-transparent disabled:cursor-default disabled:opacity-100"
        >
          {marker}
        </Button>
      )}
      {/* The chosen row OWNS ITS FIELDS (§VI): the other rows' fields are not
          drawn at all, so there is never more than one live set of inputs. */}
      {chosen ? children ?? null : null}
    </div>
  );
}
