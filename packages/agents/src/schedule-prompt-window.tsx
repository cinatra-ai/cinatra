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
// AND IT CHANGES THE SCHEDULE ABOVE IT (cinatra#2934, the armed-trigger tab).
// This box used to do nothing but talk: what was typed reached the run's
// conversation and the form above it never moved, which is the deviation this
// pull request recorded and the maintainer refused. The plan's own sentence for
// the surface is "Fills the scheduler form's own rows … whether the schedule is
// being set for the first time or changed once it stands. The person presses the
// form's own button", and the second half is what lands here:
//
//   · a described change comes back as this turn's own FILL and is written into
//     the card's rows — its `draft`, the same state its controls write — so the
//     person sees it and nothing is saved;
//   · a message that ALSO plainly asks for it to be saved is pressed by the
//     assistant through the card's own save, and the card is re-drawn from the
//     server so the rows show what was actually armed;
//   · a schedule that can no longer be changed refuses in the server's own
//     words, and the window touches nothing.
//
// THE WINDOW DECIDES NONE OF THAT. It relays this turn's effect to its host,
// which owns the card; which road a sentence took is the server's answer, read
// off the turn (`effect.fill` / `effect.acted`), never guessed at here.
// ---------------------------------------------------------------------------

import { useCallback, useState, type ReactElement } from "react";

import { HitlConversationPanel } from "./hitl-conversation-panel";
import { useRunWindowConversation } from "./use-run-window-conversation";

/**
 * WHAT THE WINDOW SAYS when the schedule above it can no longer be changed
 * (cinatra#2934; plan (A) §7.2).
 *
 * THE PLATFORM'S OWN SENTENCE, in the family the other windows already use for
 * a window that cannot do what it invites (`RUN_WINDOW_TOOL_LESS_NOTICE`): what
 * is no longer possible, what the surface still is, and what to do instead. It
 * is deliberately NOT the card's reason — the card draws that, from the
 * server's own table, right above this line — so the two say one thing between
 * them rather than the same thing twice.
 */
export const SCHEDULE_WINDOW_OVER_NOTICE =
  "This schedule can no longer be changed — the form above shows it as it " +
  "stands, and nothing typed here would change it. Start a new run to " +
  "schedule it again.";

export function SchedulePromptWindow({
  templateId,
  runId,
  canRespondInWindow,
  readOnly = false,
  onFill,
  onActed,
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
   * IS THE SCHEDULE ABOVE THIS WINDOW OVER? (cinatra#3004, as amended by
   * cinatra#2934)
   *
   * The window's own invitation on this surface is "Ask Cinatra to change this
   * schedule, or ask about it…" (§X), and a schedule that is over can be
   * changed by nobody — so the invitation is one the surface cannot keep. The
   * COMPOSER therefore follows the form: present and live while the schedule
   * can still be changed, gone once the run is over. `HitlConversationPanel`
   * takes one `visible` boolean and has no read-only reading of its own, and a
   * dead composer would be the same "control that exists only to refuse" the
   * card itself withheld.
   *
   * THE WINDOW ITSELF STAYS, AND THAT IS THE PART THIS PULL REQUEST GOT WRONG.
   * It used to go with the composer, so a fired one-off drew a locked form and
   * then nothing at all — no box, no sentence, no reason. Plan (A) §7.2 asks
   * this state to ANSWER: the schedule "cannot be changed any more", said in
   * the same platform's-own-words family as the other windows' notices. So the
   * window is mounted, it says so, and the card beside it carries the server's
   * own reason for the state.
   *
   * The surfaces that mount this window MEASURE the state off the card's own
   * DOM rather than predicting it (`useScheduleSurfaceReading`).
   */
  readOnly?: boolean;
  /**
   * THIS TURN PLACED VALUES IN THE FORM ABOVE (cinatra#2934). Handed up
   * unchanged, for the host to write into the card's own rows — the window draws
   * no schedule and holds no draft, exactly as the scheduling step's window
   * hands its fill to that form's `applyScheduleValues`.
   */
  onFill?: (values: Record<string, unknown>) => void;
  /**
   * THIS TURN PRESSED SOMETHING. The card is re-resolved rather than re-drawn
   * from what was asked for: "whatever it did, the server is the only thing that
   * knows what the card now shows".
   */
  onActed?: () => void;
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
      // AND IT IS THE ONE ROAD THAT CHANGES THE ARMED SCHEDULE TOO
      // (cinatra#2934, the armed-trigger tab). The turn is bound to the ARMED
      // scheduler form — the server mints its ref from the run this box sits
      // under — so the same send that answers the question is the send that
      // fills the rows and, when the person plainly asks, presses the card's own
      // Save changes.
      setPromptPending(true);
      try {
        const effect = await sendRunWindowTurn(prompt);
        // A turn that PRESSED writes no fields: the card re-resolves and shows
        // what the server actually armed, never the values optimistically.
        if (effect.acted) onActed?.();
        else if (effect.fill) onFill?.(effect.fill.values);
      } finally {
        setPromptPending(false);
      }
    },
    [sendRunWindowTurn, onActed, onFill],
  );

  // THE WINDOW ANSWERS RATHER THAN VANISHING (cinatra#2934; plan (A) §7.2). The
  // panel is not mounted at all here: it exists to be typed into, and there is
  // nothing to type. What stands in its place is one sentence, in the window's
  // own region, so the reader finds the answer where the box used to be.
  if (readOnly) {
    return (
      <div
        data-conformance-id="schedule-prompt-window"
        data-schedule-prompt-window=""
      >
        <p
          data-conformance-id="schedule-window-over"
          role="status"
          className="text-sm text-muted-foreground"
        >
          {SCHEDULE_WINDOW_OVER_NOTICE}
        </p>
      </div>
    );
  }

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
        visible={canRespondInWindow !== false && !!templateId && !!mount}
        conversation={runWindow.entries}
        promptPending={promptPending || runWindow.pending}
        storageKey={`cinatra_schedule_assist_${templateId}_step`}
        onSubmit={handlePromptSubmit}
      />
    </div>
  );
}
