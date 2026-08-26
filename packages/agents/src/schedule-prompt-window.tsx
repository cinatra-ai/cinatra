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

/** The renderer id the assist endpoint is already tuned for on this subject.
 *  The same string the Trigger tab sends, so one prompt understands one
 *  schedule however the reader reached it. */
const SCHEDULE_ASSIST_RENDERER = "trigger-tab";

export function SchedulePromptWindow({
  templateId,
  readOnly = false,
}: {
  /** The template the assist call is scoped to. The schedule itself is never
   *  named here: this window answers, it does not act. */
  templateId: string;
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
  const [conversation, setConversation] = useState<HitlConversationEntry[]>([]);
  const convIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // A QUESTION IN FLIGHT WHEN THE SCHEDULE ENDS IS DROPPED (cinatra#3004).
  // Withdrawing the window hides the panel; it does not stop the request the
  // reader had already sent. Without this, a Cancel schedule landing mid-answer
  // would leave a live call whose reply is appended to a conversation nobody
  // can see any more. The abort's own path appends nothing and clears the
  // pending flag in its `finally`, so nothing else has to be undone here.
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
      setConversation((prev) => [
        ...prev,
        { id: ++convIdRef.current, role: "user", content: prompt },
      ]);
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
        const json = (await res.json()) as { message?: string | null };
        setConversation((prev) => [
          ...prev,
          {
            id: ++convIdRef.current,
            role: "assistant",
            content: json.message?.trim() || "Done.",
          },
        ]);
      } catch (err) {
        // An ABORT is this component replacing its own in-flight question, not a
        // failure the reader has to read about.
        if (ctrl.signal.aborted) return;
        console.warn(
          "[schedule-prompt-window] assist failed",
          err instanceof Error ? err.message : String(err),
        );
        setConversation((prev) => [
          ...prev,
          {
            id: ++convIdRef.current,
            role: "assistant",
            content: "Could not fetch suggestions — please try again.",
          },
        ]);
      } finally {
        setPromptPending(false);
      }
    },
    [templateId],
  );

  return (
    <div
      data-conformance-id="schedule-prompt-window"
      data-schedule-prompt-window=""
      ref={setMount}
    >
      <HitlConversationPanel
        portalTarget={mount}
        visible={!readOnly && !!templateId && !!mount}
        conversation={conversation}
        promptPending={promptPending}
        storageKey={`cinatra_schedule_assist_${templateId}_step`}
        onSubmit={handlePromptSubmit}
      />
    </div>
  );
}
