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

import { useCallback, useMemo, useState, type ReactElement } from "react";
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
  TriggerScheduleProposalViewBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

// The recurring reading a read-only row draws is the SAME renderer the
// settled card's own plain-language line comes from (cinatra#3174 fix leg
// 1). Tier-neutral: pure functions, no React, no server-only import, no DB.
import { describeRecurrence } from "./trigger-recurrence";

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
  useReportSettledSchedule,
  useReportScheduleReading,
  type LifecycleCardAuth,
} from "./lifecycle-card-runtime";
import { WEEKDAY_LABELS } from "./trigger-recurrence";

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

/** The section's own five readings, as the names it gives them. */
export type ScheduleReading =
  | "first-shown"
  | "configured"
  | "expired"
  | "fired-one-off"
  | "fired-recurring";

/**
 * The five readings the card's own section names, and nothing else:
 *
 *   first shown     nothing exists yet          editable    Confirm
 *   configured      the schedule as it stands   editable    Save changes
 *   expired         nothing was scheduled       editable    Confirm
 *   fired, one-off  the schedule was spent      read-only   none at all
 *   fired, recurring runs still to come         editable    Save changes ·
 *                                                           Cancel schedule
 *
 * READ OFF THE DURABLE SIGNAL, not off a control. `firedOnce` is the server's
 * whole answer — the tick's own stamp for a recurring schedule, and the gate
 * stamp READ TOGETHER WITH THE RUN'S OWN ROW for a one-off (see
 * `scheduleFiredOnce`) — and it stays true after **Cancel schedule** is
 * pressed, which is exactly where `canCancel` stops being able to answer this
 * question.
 *
 * `released` IS NO LONGER CONSULTED HERE, and that is cinatra#3174 fix leg 1.
 * It marks the side-effect gate opening, not the firing: the first graded proof
 * round drew "Fired, one-off — the schedule was spent" over a run whose gate
 * had opened and which then FAILED without ever starting. Section VI gives the
 * spent reading read-only rows and no floor at all, and a schedule whose run
 * never happened has neither earned that reading nor lost its own form. So the
 * one signal decides, on both families, and a server that predates it says
 * "not fired" — which draws the configured reading, form intact, rather than a
 * spent one that cannot be corrected.
 */
export function scheduleReadingOf(
  body: TriggerScheduleProposalViewBody,
  /** The fired signal, off the resolve answer's own aside (cinatra#3193) — see
   *  `LifecycleCardAsideByKind` for why it does not travel inside the body.
   *  Absent, from a server that predates the reading, means "not fired", which
   *  leaves the one-off family reading exactly off `released` as it always
   *  did. */
  firedOnce: boolean = false,
): ScheduleReading {
  if (body.phase === "proposal") return "first-shown";
  if (body.phase === "expired") return "expired";
  if (body.triggerType === "recurring") {
    return firedOnce ? "fired-recurring" : "configured";
  }
  return firedOnce ? "fired-one-off" : "configured";
}

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
  // THE FIRED READING, OFF THE ANSWER'S OWN ASIDE (cinatra#3193). It is the
  // resolver's whole answer, exactly as it was when it rode the body — what
  // changed is only which half of the answer carries it, and why.
  const firedOnce = resolved?.aside?.firedOnce === true;

  // THE TURN IS TOLD WHAT IT IS CARRYING (cinatra#3174, criteria 1 and 2).
  //
  // Only the card knows this: the reading comes back from the authoritative
  // resolve above, and the payload the transcript carries is a ref. Reported
  // unconditionally - a hook may not sit behind the early returns below - and
  // reported as FALSE for every other reading, so a card that leaves the
  // settled reading gives the turn back.
  //
  // A NO-OP WHERE NOBODY IS LISTENING. The run page and the review page declare
  // no register, so this changes nothing on them.
  useReportSettledSchedule(wireRef, present && body !== null && body.phase === "settled");
  // THE CARD TELLS THE TURN WHAT IT IS READING (cinatra#3044).
  //
  // The line above this card was minted at dispatch and frozen into the turn,
  // and the ratified drawing's section VI gives the spent one-off its own
  // words. Only this card can say the reading is that one, and it says it
  // through the SAME election the rows and the floor are drawn from
  // (cinatra#3174 fix leg 1) -- one call, so the sentence, the rows and the
  // floor cannot come to three answers. What decides it is the server's durable
  // reading, never the gate stamp: a gate that opened over a run that then
  // failed is not a firing, and `triggerType` is what keeps a RECURRING
  // schedule out -- it "is never spent by firing: its past runs are history and
  // its runs still to come stay changeable".
  //
  // REPORTED IN EVERY STATE, including the ones that draw nothing, so the turn
  // hears the neutral reading rather than keeping a stale one. Called before
  // this component's own early returns for the ordinary reason: a hook may not
  // be skipped.
  useReportScheduleReading(
    body !== null && scheduleReadingOf(body, firedOnce) === "fired-one-off"
      ? "spent-one-off"
      : "other",
  );

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
        // THE EXPIRED READING DRAWS THE LINE TOO (§VI's third picture). It
        // rides the ANSWER rather than the body for the same reason `firedOnce`
        // does: the expired body is a `.strict()`, version-1 schema and a new
        // key in it blanks the card on every bundle that has not reloaded.
        durationCopy={resolved?.aside?.durationCopy ?? null}
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
      <SettledPhase
        body={body}
        host={host}
        onDecide={decide}
        firedOnce={firedOnce}
        durationCopy={resolved?.aside?.durationCopy ?? null}
      />
    );

  return (
    <div
      className={HOST_FRAME[host]}
      data-lifecycle-card="trigger_schedule_proposal"
      data-lifecycle-card-state={state.state}
      data-lifecycle-card-host={host}
      data-lifecycle-card-phase={body.phase}
      // WHICH OF THE SECTION'S FIVE READINGS THIS IS (cinatra#3174).
      //
      // "One card, five readings, and never a second card." The phase mark
      // above answers three of them at best: both fired readings and the
      // configured one share `settled`, and the two that differ most in what
      // the reader is told — a recurring schedule that has fired against one
      // that never has — were until now indistinguishable from outside the
      // card.
      //
      // REPORTED, NEVER DRAWN. The same section rules out saying it on screen:
      // "No summary box is ever drawn, no status label, and nothing stands
      // between the reader and the form." So this is a passive attribute,
      // exactly like the marks beside it: it names the reading for a test and
      // for a rendered reading of the screen, and it draws nothing.
      data-schedule-reading={scheduleReadingOf(body, firedOnce)}
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
    // TWO SUBJECTS, TWO ROADS, ONE CONTROL (cinatra#3044).
    //
    // A WAITING RUN takes ONE request carrying the rows. There is no token to
    // re-mint and no run to create — the run already exists and is parked at its
    // schedule step — so the press goes straight onto the run-trigger path with
    // whatever the reader has in front of them. Asking for a re-propose first
    // would ask it of a proposal that never existed, and the press would die on
    // that leg; the server refuses the composite on this ref for the same
    // reason. Edited or not is not a question here: the rows always travel, so
    // the server never has to guess what the reader was looking at.
    //
    // AN EDITED PROPOSAL IS RE-PROPOSED BEFORE IT IS CONFIRMED, in that order,
    // on the new ref — the same composite §2.2's typed "…and confirm" performs.
    // A proposal is single-use, so confirming the ORIGINAL ref would arm the
    // schedule the reader just corrected away from. This is what replaced the
    // Adjust button: the re-propose still happens, and the reader never has to
    // know it did.
    const outcome = body.runPending
      ? await onDecide("confirm", draft)
      : edited
        ? await onAdjustAndConfirm(draft)
        : await onDecide("confirm");
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
  durationCopy,
  onRepropose,
}: {
  body: TriggerScheduleProposalExpiredView;
  durationCopy: string | null;
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
      <ScheduleOptionRows
        schedule={draft}
        editable
        onChange={setDraft}
        durationCopy={durationCopy}
      />
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
  firedOnce,
  durationCopy,
}: {
  body: TriggerScheduleProposalSettledView;
  host: LifecycleCardHost;
  onDecide: (op: ScheduleDecisionOp, schedule?: ProposedSchedule) => Promise<ScheduleDecisionOutcome>;
  /** The server's durable firing reading, off the answer's own aside. The ONE
   *  signal this phase's frozen rows and absent floor are decided by
   *  (cinatra#3174 fix leg 1). */
  firedOnce: boolean;
  /** The estimated-duration line, already rendered, or `null` for a template
   *  with no history — which draws no line at all. */
  durationCopy: string | null;
}): ReactElement {
  const [draft, setDraft] = useState<ProposedSchedule>(body.schedule);
  // THE CARD'S OWN READING OF WHAT IS ARMED — the schedule `draft` started from
  // and the ONE thing an edit is measured against (cinatra#3053).
  const [baseline, setBaseline] = useState<ProposedSchedule>(body.schedule);
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

  // AN EDIT IS THE READER'S, AND THE THREAD DOES NOT GET A VOTE (cinatra#3053).
  //
  // This used to read `draft` against `body.schedule` — a PROP the conversation
  // refreshes underneath a card that is never remounted. `useLifecycleCardResolve`
  // re-reads on the window `focus` event, which is THREAD-WIDE: every mounted
  // lifecycle card shares it, so a SECOND run dispatched into the same thread
  // re-resolved this settled card too. And a re-resolve does not have to answer
  // byte-alike for one unchanged armed schedule — `selectionsFromInstalled`
  // re-derives a one-off's `runAt` off the clock whenever the installed row
  // carries no instant. So a benign refresh moved `body.schedule` out from under
  // a `draft` seeded once at mount, `edited` went true with nothing touched, and
  // an untouched card drew **Save changes** at full strength: the card claiming
  // unsaved changes the reader never made.
  //
  // The comparison is now against the card's OWN baseline: the reading this card
  // opened on, moved by ONE thing only — this card's own landed save. Nothing
  // that merely arrives in the thread can reach it, and a refresh is not allowed
  // to rewrite the rows under the reader either: the draft is left exactly where
  // it was, as it always has been on this phase, so a re-derived read-back can
  // neither invent an edit nor churn a run time the reader is looking at
  // (cinatra#3053 convergence).
  const edited = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(baseline),
    [draft, baseline],
  );

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
  // A FROZEN CARD DRAWS NO FLOOR AT ALL: not a disabled Save changes, and not a
  // disabled Cancel schedule either. There is nothing left to change or stop,
  // and a control that exists only to refuse is the card offering what the plan
  // withdrew. The rows simply stand.
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
  // THE ONE ELECTION, READ ONCE (cinatra#3174 fix leg 1). This used to key on
  // `body.released` — the gate stamp — which is how a one-off whose run FAILED
  // without ever starting froze into the spent reading and lost a form the
  // server was still authorizing. It now reads exactly what the card reports
  // and what the turn's own sentence is chosen by.
  const frozen = scheduleReadingOf(body, firedOnce) === "fired-one-off" || body.stopped === true;

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
    if (outcome.kind === "saved") {
      setSaved(true);
      // WHAT WAS SAVED IS WHAT IS ARMED. The re-resolve confirms it, but the
      // baseline moves here so the control goes quiet the moment the save lands
      // rather than waiting on a read that may answer with a re-derived field.
      setBaseline(draft);
    } else if (outcome.kind === "not-permitted" || outcome.kind === "error") {
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
      {/* THE ONE TRANSIENT THE CARD STILL SAYS OUT LOUD: a schedule still being
          installed, which is a moment rather than a reading, and which is
          withheld from a frozen card because a frozen card has no control left
          to explain. */}
      {body.arming && !frozen ? (
        <p data-conformance-id="schedule-arming" className="text-sm text-muted-foreground">
          Arming… the schedule is still being installed.
        </p>
      ) : null}
      {/* AND NO "RELEASED —" LABEL, ON ANY READING (cinatra#3174 fix leg 1,
          converge round). §VI: "No summary box is ever drawn, no status label,
          and nothing stands between the reader and the form — the rows are the
          reading." The line was only ever reachable on a card whose gate had
          opened, and it reached the reader as a status label because the
          election above no longer freezes such a card when its run never ran.
          A label over the CONFIGURED reading is exactly what the section
          removes; the floor beneath the rows already says what may be done. */}

      {/* THE SAME OPTION ROWS AS THE PROPOSAL — one component, drawing the armed
          selections the resolver read back off the installed row. */}
      {/* A FROZEN CARD HAS NO DRAFT. `draft` is the reader's local edit, and it
          outlives a re-resolve because `SettledPhase` is not remounted — so a
          one-off that fires, or a recurring schedule stopped, under half-typed
          rows would otherwise stand there read-only, showing times that were
          never armed. That is the same dishonesty §7.2's "shows the schedule as
          it stands" rules out, so the terminal card draws the server's schedule
          and only that. */}
      {/* THE ROWS GO READ-ONLY, NOT MERELY DEAD (cinatra#3174 fix leg 1). §VI:
          "the rows go read-only — the values still legible, the pickers gone".
          `editable={false}` disables a picker; it does not take it away, and
          the first graded proof round measured exactly that — a spent one-off
          drawn as a live form with every control still standing. `readOnly`
          draws the values instead of the controls, which is the record the
          section calls the card once it has fired. */}
      <ScheduleOptionRows
        schedule={frozen ? body.schedule : draft}
        editable={body.canSave}
        readOnly={frozen}
        onChange={(next) => {
          setSaved(false);
          setDraft(next);
        }}
        durationCopy={durationCopy}
      />

      {frozen ? null : (
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
  onChange,
  durationCopy,
  readOnly = false,
}: {
  schedule: ProposedSchedule;
  editable: boolean;
  onChange: (next: ProposedSchedule) => void;
  durationCopy: string | null;
  /**
   * THE ROWS ARE THE RECORD, NOT THE FORM (cinatra#3174 fix leg 1).
   *
   * §VI, on the reading a spent one-off settles into: "the rows go read-only —
   * the values still legible, the pickers gone". This is not `editable`
   * inverted. A disabled picker is still a picker: the select chrome, the
   * datetime spinner and the pressable row all stay on screen, offering a
   * control that refuses, which is what the first graded round measured. Under
   * `readOnly` the values are drawn as text in the same fields' places, the
   * chosen row keeps its indigo edge and its filled marker, and there is
   * nothing on the card to press.
   */
  readOnly?: boolean;
}): ReactElement {
  const kind = schedule.kind;
  const live = editable && !readOnly;
  const pick = (next: ProposedSchedule) => {
    if (live) onChange(next);
  };
  const recurring = schedule.kind === "recurring" ? schedule.selection : DEFAULT_RECURRING;
  const timezone =
    schedule.kind === "immediate" ? browserTimezone() : schedule.timezone;
  const updateRecurring = (patch: Partial<RecurringSelection>) =>
    pick({ kind: "recurring", selection: { ...recurring, ...patch }, timezone });

  return (
    <div
      data-conformance-id="schedule-option-rows"
      // The rows the reading's radios belong to, and only in that reading: the
      // live rows are pressable buttons and are announced as they always were.
      role={readOnly ? "radiogroup" : undefined}
      aria-readonly={readOnly ? true : undefined}
      className="flex flex-col gap-2"
    >
      <p className="text-sm font-medium text-foreground">When should this run?</p>

      <OptionRow
        rowKind="immediate"
        chosen={kind === "immediate"}
        editable={live}
        readOnly={readOnly}
        label="Run right after setup"
        icon={<Zap aria-hidden="true" className="size-3.5" />}
        onChoose={() => pick({ kind: "immediate" })}
      />

      <OptionRow
        rowKind="scheduled"
        chosen={kind === "scheduled"}
        editable={live}
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
              <ReadOnlyValue
                value={schedule.kind === "scheduled" ? readableRunAt(schedule.runAt) : ""}
              />
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
              <ReadOnlyValue value={timezone} />
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
        editable={live}
        readOnly={readOnly}
        label="Recurring"
        icon={<Repeat aria-hidden="true" className="size-3.5" />}
        onChoose={() => pick({ kind: "recurring", selection: recurring, timezone })}
      >
        <div className="ml-7 flex flex-col gap-3">
          {readOnly ? (
            <>
              <Field label="Repeats">
                <ReadOnlyValue value={describeRecurringRows(recurring)} />
              </Field>
              <Field label="Timezone">
                <ReadOnlyValue value={timezone} />
              </Field>
            </>
          ) : (
          <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Repeat every</span>
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
          </div>

          {recurring.frequency === "weekly" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">On</span>
              {/* WRAPS. The rail step's panel is narrower than a chat turn, and
                  a fixed row clipped the last weekday chip off the right edge
                  there — a control the reader could see but not press. */}
              <div className="flex flex-wrap gap-1">
                {WEEKDAY_LABELS.map((label, i) => (
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
          </div>

          <Field label="Timezone">
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
          </Field>
          </>
          )}
        </div>
      </OptionRow>

      {/* §VI — "Estimated run duration / About 45s – 3.4 hr.", DRAWN ONLY WHERE
          THERE IS ONE (cinatra#3174 fix leg 1). This used to answer a missing
          estimate with the literal "Unavailable." — a sentence the drawing
          never draws, in any of the section's five pictures, and the one the
          first graded round measured on every frame. The scheduling step this
          card reproduces already withdrew that same wording (cinatra#3182 item
          5): where the drawing gives nothing, nothing is drawn. */}
      {durationCopy === null ? null : (
        <div className="flex flex-col gap-1 pt-1">
          <p className="text-sm font-medium text-foreground">Estimated run duration</p>
          <p data-conformance-id="schedule-duration" className="text-sm text-muted-foreground">
            {durationCopy}
          </p>
        </div>
      )}
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

/**
 * A VALUE WHERE A FIELD STOOD (cinatra#3174 fix leg 1).
 *
 * §VI's fired one-off draws its two fields as plain bordered readings — the
 * same box, the same measure, the muted ink, and no control inside it. It is
 * not an input with `readonly` on it: a reader may not focus it, tab into it or
 * be offered a spinner by the platform, because there is nothing here to
 * change.
 */
function ReadOnlyValue({ value }: { value: string }): ReactElement {
  return (
    <div
      data-schedule-value
      className="flex h-9 w-56 items-center rounded-control border border-input bg-background px-3 text-sm text-muted-foreground"
    >
      {value}
    </div>
  );
}

/**
 * THE MOMENT, STILL LEGIBLE (§VI, the fired one-off).
 *
 * The wire carries a timezone-NAIVE wall clock ("2026-07-14T09:00") because
 * that is what the form's `datetime-local` emits and what the schema accepts.
 * A picker renders it in the reader's own locale; the drawing's fired example
 * draws it the same way, beside a Timezone row that names the zone. So the
 * read-only reading formats the same wall clock in the same locale rather than
 * putting the wire string on screen, and NO timezone conversion is applied —
 * the clock is the one that was armed.
 *
 * A value this cannot read is returned untouched: a reading is never blanked
 * for being unfamiliar.
 */
function readableRunAt(runAt: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(runAt);
  if (parts === null) return runAt;
  const [year, month, day, hour, minute] = parts.slice(1).map(Number);
  const at = new Date(year, month - 1, day, hour, minute);
  if (Number.isNaN(at.getTime())) return runAt;
  // AND ONLY WHERE THE CLOCK SURVIVES THE ROUND TRIP (converge round). The wire
  // schema accepts any digit-shaped value, and the component constructor
  // OVERFLOWS the ones that are not real moments — "2026-02-31T09:00" becomes
  // the third of March, "2026-07-14T29:00" the next day — so an unreadable
  // value would be redrawn as a DIFFERENT schedule rather than left alone.
  // Reading the components back is what separates the two.
  const roundTrips =
    at.getFullYear() === year &&
    at.getMonth() === month - 1 &&
    at.getDate() === day &&
    at.getHours() === hour &&
    at.getMinutes() === minute;
  if (!roundTrips) return runAt;
  return at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The recurring selection as one legible line, for the rows that have gone
 *  read-only. It is the SAME renderer the settled card's own plain-language
 *  line comes from, so the record and the prose cannot describe one schedule
 *  two ways. */
function describeRecurringRows(recurring: RecurringSelection): string {
  return describeRecurrence({
    frequency: recurring.frequency,
    interval: recurring.interval,
    weekdays: recurring.weekdays,
    dayOfMonth: recurring.dayOfMonth,
    monthlyMode: recurring.monthlyMode,
    nthWeek: recurring.nthWeek,
    monthlyWeekday: recurring.monthlyWeekday,
    quarterAnchor: recurring.quarterAnchor,
    yearlyMonth: recurring.yearlyMonth,
    hour: recurring.hour,
    minute: recurring.minute,
  });
}

function Field({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <Label className="font-normal">{label}</Label>
      {children}
    </div>
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
  readOnly = false,
}: {
  rowKind: ProposedSchedule["kind"];
  chosen: boolean;
  editable: boolean;
  label: string;
  icon: ReactElement;
  onChoose: () => void;
  children?: ReactElement;
  /** The row is a reading, not a choice (§VI, the fired one-off): the marker
   *  and the label stand, and the button around them is gone rather than
   *  disabled. */
  readOnly?: boolean;
}): ReactElement {
  return (
    <div
      data-schedule-option={rowKind}
      data-chosen={chosen ? "true" : "false"}
      // THE CHOSEN ROW IS READABLE WITHOUT EYES (cinatra#3174 fix leg 1,
      // converge). The live row carries its state on the button's
      // `aria-pressed`; the read-only row has no button to carry it, and the
      // indigo edge and the filled marker are not readings a screen reader can
      // make. So the reading row is a radio that cannot be moved: the state is
      // stated, and the row says it is not a choice any more.
      role={readOnly ? "radio" : undefined}
      aria-checked={readOnly ? chosen : undefined}
      aria-disabled={readOnly ? true : undefined}
      className={`flex flex-col gap-3 rounded-control border px-4 py-3 transition-colors ${
        chosen ? "border-primary bg-primary/5" : "border-input"
      }`}
    >
      {readOnly ? (
        <div className="flex items-center gap-3 text-left">
          <span
            aria-hidden="true"
            className={`flex size-4 shrink-0 items-center justify-center rounded-full border-2 ${
              chosen ? "border-primary" : "border-muted-foreground"
            }`}
          >
            {chosen ? <span className="size-2 rounded-full bg-primary" /> : null}
          </span>
          {icon}
          <span className="text-sm font-medium text-foreground">{label}</span>
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          disabled={!editable}
          aria-pressed={chosen}
          onClick={onChoose}
          className="h-auto justify-start gap-3 p-0 text-left hover:bg-transparent disabled:cursor-default disabled:opacity-100"
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
        </Button>
      )}
      {/* The chosen row OWNS ITS FIELDS (§VI): the other rows' fields are not
          drawn at all, so there is never more than one live set of inputs. */}
      {chosen ? children ?? null : null}
    </div>
  );
}
