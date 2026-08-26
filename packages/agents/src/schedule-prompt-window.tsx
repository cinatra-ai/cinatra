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
// second prompt window, this is the same panel (`HitlConversationPanel`), the
// same endpoint and the same `xRenderer` that tab already sent, mounted where
// the plan asks for it — and, since cinatra#3004, mounted by BOTH surfaces from
// here, so the run detail's step and the run's schedule tab ask their questions
// through one window.
//
// IT PORTALS INTO ITS OWN MOUNT, NOT INTO `<main>`. `HitlConversationPanel`
// takes its portal target from the parent, and the retired tab handed it
// `document.querySelector("main")` — which puts the window at the END of the
// page, not under anything in particular. Here the target is a div this
// component renders itself, so the window lands exactly where the plan puts it:
// immediately below the scheduler form. That is a composition decision, not a
// change to the shared panel — no other surface moves.
//
// IT CHANGES NOTHING BY ITSELF. The assist endpoint answers in the panel; it
// does not write the schedule. cinatra#2853 owns making a typed instruction act
// on the card, and `schedule-proposal-card.tsx` already exports the act it will
// call (`submitScheduleDecision` / `adjustAndConfirmSchedule`). This slice adds
// the window the plan asks for and nothing behind it.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import {
  HitlConversationPanel,
  type HitlConversationEntry,
} from "./hitl-conversation-panel";
import { useRunWindowConversation } from "./use-run-window-conversation";

/** The renderer id the assist endpoint is already tuned for on this subject.
 *  The same string the Trigger tab sends, so one prompt understands one
 *  schedule however the reader reached it. */
const SCHEDULE_ASSIST_RENDERER = "trigger-tab";

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
   * The window's own invitation is "Ask Cinatra to suggest edits to the fields
   * above", and a schedule that is over has no fields anybody can edit — so the
   * invitation would be one the surface cannot keep. The composer follows the
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
  /**
   * THE PLATFORM'S OWN LINE ABOUT THE FORM FILL — not the conversation.
   *
   * The assist call below is a SECOND job beside the run's conversation: it
   * fills THIS FORM's fields. When it fails, the fields are not filled, and a
   * reader who is told nothing reads the run's own answer as if the form had
   * been filled too. So the failure is still said out loud.
   *
   * It is NOT a parallel transcript, which is the thing this slice removed from
   * every window: nothing is written here on the success path, the run's stored
   * exchange is still the only record of what was asked and answered, and this
   * line is shown after it. The review page's window already carries its
   * platform outcome exactly this way.
   */
  const [outcomeLines, setOutcomeLines] = useState<HitlConversationEntry[]>([]);
  // Offset well past the stored positions so a platform line can never take a
  // stored entry's React key.
  const outcomeIdRef = useRef(1_000_000);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // A FORM FILL IN FLIGHT WHEN THE SCHEDULE ENDS IS DROPPED (cinatra#3004).
  // Withdrawing the window hides the panel; it does not stop the request the
  // reader had already sent. Without this, a Cancel schedule landing mid-answer
  // would leave a live call still trying to fill fields nobody can change any
  // more. The abort's own path appends nothing and clears the pending flag in
  // its `finally`, so nothing else has to be undone here.
  //
  // WHAT IS NOT DROPPED, stated rather than left to be discovered: the RUN's
  // conversation turn (cinatra#2933). It is a stored turn — the whole point of
  // the per-run window is that what was asked is still there after a reload and
  // from the schedule's other host — so once it is accepted it stands, and a
  // schedule ending afterwards does not reach back and unsay it. Only the form
  // fill, which has become pointless, is cancelled.
  useEffect(() => {
    if (!readOnly) return;
    abortRef.current?.abort();
    abortRef.current = null;
  }, [readOnly]);

  const handlePromptSubmit = useCallback(
    async (prompt: string) => {
      if (!templateId) return;
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      // The run's own conversation carries what was typed and what came back.
      // The assist call below still fills THIS FORM's fields, which is a
      // different job and is retired by #2934 together with the fill.
      void sendRunWindowTurn(prompt);
      setPromptPending(true);
      try {
        const res = await fetch(
          `/api/agents/builder/${encodeURIComponent(templateId)}/hitl-assist`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: ctrl.signal,
            body: JSON.stringify({
              prompt,
              xRenderer: SCHEDULE_ASSIST_RENDERER,
              // cinatra#2933 -- the run the schedule belongs to, so the route
              // asks the RUN's access rather than the platform tier.
              ...(runId ? { runId } : {}),
              schemaProperties: [
                "triggerType",
                "scheduledAt",
                "timezone",
                "cronExpression",
              ],
            }),
          },
        );
        if (!res.ok) throw new Error(`hitl-assist: ${res.status}`);
        // The answer the reader sees is the STORED one -- `runWindow.send`
        // above re-reads the run's exchange when the turn lands. Appending the
        // assist reply here as well would put a second, unstored copy of the
        // answer on the screen, which is the parallel transcript this slice
        // removed from every window.
        void (await res.json());
      } catch (err) {
        // An ABORT is this component replacing its own in-flight question, not a
        // failure the reader has to read about.
        if (ctrl.signal.aborted) return;
        console.warn(
          "[schedule-prompt-window] assist failed",
          err instanceof Error ? err.message : String(err),
        );
        setOutcomeLines((prev) => [
          ...prev,
          {
            id: ++outcomeIdRef.current,
            role: "assistant",
            content: "Could not fetch suggestions — please try again.",
          },
        ]);
      } finally {
        setPromptPending(false);
      }
    },
    [templateId, runId, sendRunWindowTurn],
  );

  return (
    <div
      data-conformance-id="schedule-prompt-window"
      data-schedule-prompt-window=""
      ref={setMount}
    >
      <HitlConversationPanel
        portalTarget={mount}
        // Two independent reasons for there to be no box, and both still hold:
        // the schedule is over so there is nothing to edit (cinatra#3004), or
        // the run would refuse this person's message (cinatra#2933).
        visible={
          !readOnly &&
          canRespondInWindow !== false &&
          !!templateId &&
          !!mount
        }
        conversation={[...runWindow.entries, ...outcomeLines]}
        promptPending={promptPending || runWindow.pending}
        storageKey={`cinatra_schedule_assist_${templateId}_step`}
        onSubmit={handlePromptSubmit}
      />
    </div>
  );
}
