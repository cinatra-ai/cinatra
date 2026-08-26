"use client";

// ---------------------------------------------------------------------------
// THE SCHEDULE SURFACE ON THE AGENT'S PAGE (cinatra#3004).
//
// The plan's sentence, and the whole of this file's reason to exist: "The
// schedule surface on the agent's page shows the schedule form itself in its
// respective state — never a 'Trigger configuration' card — the same form as in
// the chat and on the run page."
//
// WHAT THIS FILE IS. The agent page's ADAPTER for `ScheduleProposalCard`, the
// one renderer of this kind on every host — exactly what `ScheduleRailStep` is
// for the run page and the review page. It declares the host, supplies the box,
// and draws nothing of the schedule itself. The surface it replaces drew a
// second thing from the same facts: a summary of the configuration, a tree of
// held steps, and a Cancel that DELETED the row instead of ending the schedule.
//
// THE HOST IS `run_card`, AND IT IS DECLARED BY NAME. This surface is a region
// of the RUN's own page — the same run the run detail shows, reached through the
// tab strip rather than through the step rail — so it draws on the run's host.
// Two readers depend on a LITERAL declaration and neither can follow a prop: the
// one-card gate's R3 check that a module mounting a card carries a provider, and
// the host-parity ratchet's composition scan. The two `run_card` adapters are
// exclusive by route, and `runScheduleAdapterFor` in `instance-screens.tsx` is
// the picker that says which one a screen draws.
//
// NO RAIL ROW HERE, deliberately. The run page's schedule step is a row in that
// page's step rail because the run detail HAS a rail; the schedule tab is its
// own page region with nothing to be a row of, so drawing one would be chrome
// the plan does not describe. What both surfaces share is the form.
//
// AND THE PROMPT WINDOW UNDER IT, on the same terms as the run page's step
// (cinatra#2972): "the prompt window shows below the scheduler", so it is drawn
// after the card and only where there IS a scheduler to be below — the card
// renders no DOM at all for a run its resolver answers `absent` for.
// ---------------------------------------------------------------------------

import { useState, type ReactElement } from "react";

import { LifecycleCardSurfaceProvider } from "./lifecycle-card-runtime";
import { ScheduleProposalCard } from "./schedule-proposal-card";
import { SchedulePromptWindow } from "./schedule-prompt-window";
import { useSchedulerDrawn } from "./schedule-rail-step";
import { LIFECYCLE_VIEW_SCHEMA_VERSION } from "./review-gate-card";

export function RunScheduleTab({
  cardRef,
  promptWindowTemplateId = null,
}: {
  /** The run-scoped schedule ref, minted server-side by the page. */
  cardRef: string;
  /**
   * The template the schedule surface's PROMPT WINDOW asks its questions about.
   * `null` draws no window — the same choice the review page's schedule step
   * makes.
   */
  promptWindowTemplateId?: string | null;
}): ReactElement {
  const [cardHost, setCardHost] = useState<HTMLElement | null>(null);
  const schedulerDrawn = useSchedulerDrawn(cardHost);

  return (
    <div
      data-conformance-id="run-schedule-tab"
      data-run-schedule-tab=""
      className="flex w-full flex-col gap-4"
    >
      <div data-schedule-card-host="" ref={setCardHost}>
        <LifecycleCardSurfaceProvider host="run_card">
          <ScheduleProposalCard
            view={{
              viewType: "trigger_schedule_proposal",
              schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
              ref: cardRef,
            }}
          />
        </LifecycleCardSurfaceProvider>
      </div>
      {promptWindowTemplateId && schedulerDrawn ? (
        <SchedulePromptWindow templateId={promptWindowTemplateId} />
      ) : null}
    </div>
  );
}
