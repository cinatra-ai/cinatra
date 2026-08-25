"use client";

// ---------------------------------------------------------------------------
// THE RUN PAGE'S PROMPT WINDOW, UNDER THE SCHEDULER (cinatra#2972).
//
// Plan: PLAN: Agents Lifecycle (A) §7.2 as amended 2026-08-25 — "The run page's
// prompt window shows below the scheduler." §7.4's "Today" step 8 describes the
// window itself: "You type into the prompt window under the tab ('Ask Cinatra
// to suggest edits to the fields above…') — for example 'reschedule to 9 on
// weekdays' — and the assistant answers in the panel — today the answer does
// not change the schedule for you."
//
// WHY THIS FILE EXISTS. The prompt window shipped on the run's persistent
// schedule tab, whose own drawing was a summary of the configuration rather than
// the form; the run page's schedule STEP drew the scheduler and nothing under
// it. The plan puts the window on the step. Rather than give the product a
// second prompt window, this is the same panel (`HitlConversationPanel`),
// mounted where the plan asks for it — and, since cinatra#3004, mounted by BOTH
// surfaces from here, so the run detail's step and the run's schedule tab ask
// their questions through one window.
//
// IT PORTALS INTO ITS OWN MOUNT, NOT INTO `<main>`. `HitlConversationPanel`
// takes its portal target from the parent, and the retired tab handed it
// `document.querySelector("main")` — which puts the window at the END of the
// page, not under anything in particular. Here the target is a div this
// component renders itself, so the window lands exactly where the plan puts it:
// immediately below the scheduler form. That is a composition decision, not a
// change to the shared panel — no other surface moves.
//
// IT CHANGES NOTHING BY ITSELF. What is typed here goes into the run's own
// conversation with the assistant and nowhere else; the schedule above it is
// changed by the form's own controls. cinatra#2853 owns making a typed
// instruction act on the card, and `schedule-proposal-card.tsx` already exports
// the act it will call (`submitScheduleDecision` / `adjustAndConfirmSchedule`).
// ---------------------------------------------------------------------------

import { useCallback, useState, type ReactElement } from "react";

import { HitlConversationPanel } from "./hitl-conversation-panel";
import { useRunWindowConversation } from "./use-run-window-conversation";

export function SchedulePromptWindow({
  templateId,
  runId,
  canRespondInWindow,
  readOnly = false,
}: {
  /** The template the assist call is scoped to. The schedule itself is never
   *  named here: this window answers, it does not act. */
  templateId: string;
  /**
   * THE RUN THIS WINDOW BELONGS TO (cinatra#2933, lifecycle-b W5b).
   *
   * This is one of the five windows outside the chat, so what is typed here is
   * the RUN's conversation: read on mount, appended server side per turn, and
   * still there after a reload. Both hosts of this window -- the run detail's
   * schedule step and the run's schedule tab -- name the same run, which is why
   * they read as one exchange however the reader arrived.
   */
  runId?: string | null;
  /**
   * May this person type here? Server-derived from the RUN's own access, the
   * same answer the other four windows are given: no window is shown to a
   * person whose message it would refuse. Absent means shown, for a host with
   * no run to ask about.
   */
  canRespondInWindow?: boolean;
  /**
   * IS THE SCHEDULE ABOVE THIS WINDOW OVER? (cinatra#3004)
   *
   * The window's own invitation on this surface is "Ask Cinatra to change this
   * schedule, or ask about it…" (§X), and a schedule that is over can be
   * changed by nobody — so the invitation would be one the surface cannot keep. The composer follows the
   * form: present and live while the schedule can still be changed, gone once
   * the run is over.
   *
   * ABSENT RATHER THAN DISABLED, because that is what the shipped panel offers:
   * `HitlConversationPanel` takes one `visible` boolean and has no read-only
   * reading of its own, and `visible={!readOnly && …}` is the pattern this
   * product already uses for exactly this state. A dead composer would be the
   * same "control that exists only to refuse" the card itself removed.
   *
   * The surfaces that mount this window MEASURE the state off the card's own
   * DOM rather than predicting it (`useScheduleSurfaceReading`).
   */
  readOnly?: boolean;
}): ReactElement {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const [promptPending, setPromptPending] = useState(false);
  // THE EXCHANGE IS THE RUN'S, not this component's (cinatra#2933). The window
  // keeps no parallel copy it could show instead; the store is the state.
  const runWindow = useRunWindowConversation({ runId, surface: "armed-trigger" });
  const sendRunWindowTurn = runWindow.send;
  const handlePromptSubmit = useCallback(
    async (prompt: string) => {
      // ONE ROAD, AND ONLY ONE MODEL (cinatra#2934, lifecycle-b W5c). This box
      // used to do a SECOND job beside the run's conversation: it asked the
      // field-assist route to fill this form's fields, and that route ran a
      // second, hidden model over the same sentence the assistant was already
      // reading. The route is gone, and with it this window's private path —
      // what is typed here reaches the run's own conversation and nothing else.
      //
      // WHAT WENT WITH IT, named rather than left to be noticed: the platform's
      // own line about a failed fill, and the abort that dropped a fill still in
      // flight when the schedule ended (cinatra#3004). Both existed for that
      // second call. The RUN's turn is not one of them and never was: it is
      // stored, so once it is accepted it stands, and a schedule ending
      // afterwards does not reach back and unsay it.
      //
      // CHANGING THE ARMED SCHEDULE FROM THIS BOX still needs the scheduler
      // form in its armed state. The plan: "On an armed schedule only the
      // scheduler form is shown, in its different states, and the assistant
      // fills that form's own fields — never a trigger configuration card."
      // That form is the screens epic's own slice (cinatra#2788); the server
      // rule that accepts the change (`updateRunTriggerScheduleForActor`)
      // already exists, so the fill road reaches it the moment it is drawn
      // under this window.
      setPromptPending(true);
      try {
        await sendRunWindowTurn(prompt);
      } finally {
        setPromptPending(false);
      }
    },
    [sendRunWindowTurn],
  );

  return (
    <div
      data-conformance-id="schedule-prompt-window"
      data-schedule-prompt-window=""
      ref={setMount}
    >
      <HitlConversationPanel
        portalTarget={mount}
        // WHICH READING OF THE ONE WINDOW THIS IS (design `458fb7ffce6c`,
        // `app-artifact-review.html` §X): the mount names its surface and the
        // window reads the drawing's own sentence for it.
        surface="armed-trigger"
        // Two independent reasons for there to be no box, and both still hold:
        // the schedule is over so there is nothing to edit (cinatra#3004), or
        // the run would refuse this person's message (cinatra#2933).
        visible={
          !readOnly &&
          canRespondInWindow !== false &&
          !!templateId &&
          !!mount
        }
        conversation={runWindow.entries}
        promptPending={promptPending || runWindow.pending}
        storageKey={`cinatra_schedule_assist_${templateId}_step`}
        onSubmit={handlePromptSubmit}
      />
    </div>
  );
}
