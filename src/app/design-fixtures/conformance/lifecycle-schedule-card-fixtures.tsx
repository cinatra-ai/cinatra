"use client";

// ---------------------------------------------------------------------------
// Functional-acceptance harness for the SCHEDULE CARD of the in-conversation
// lifecycle drawing (cinatra#3161, epic #3155 W5).
//
// Renders the REAL `ScheduleProposalCardBody` — the shipped drawn card of the
// one schedule renderer, exported from its own owner module and composed by
// `ScheduleProposalCard` itself — so the assertions in
// tests/e2e/design/conformance/contract.ts run against the shipped five
// readings, the shipped floors, the shipped control names and the shipped words
// after a landed decision, never against a stand-in.
//
// WHY THE DRAWN CARD AND NOT THE WHOLE CARD. `ScheduleProposalCard` draws no DOM
// at all before an authorized server resolve: it posts its opaque ref to
// /api/lifecycle-views/resolve and is answered against the session actor. This
// harness is SESSIONLESS by contract — the design-conformance route is on the
// dev-only public list precisely so the checker reaches the handler rather than
// the sign-in redirect — so there is no session for that resolve to be answered
// against, and no seeding road that would create one under the production-shaped
// standalone build the suite runs on. What the harness therefore composes is the
// part of the card that begins after the answer, and it composes the SHIPPED
// one: the host frame, the card's own attributes and the phase router are all
// the owner module's, and nothing about the card is reimplemented around them.
//
// WHAT THE HARNESS SUPPLIES, AND WHY IT IS NOT A PRESENTATION. Three things a
// server would have said, all in the protocol's own types: the resolved STATE
// and BODY the card is drawn from, the two halves of the ANSWER that travel
// beside the body rather than inside it (the firing the fired readings are
// elected by, and the rendered estimated-duration line), and the ONE ANSWER its
// decision endpoint gives. That is the whole substitution — the transport, never
// the composition.
// The harness computes nothing from an answer and re-derives no body from it:
// which phase is drawn, which controls the floor offers, what they are named,
// when they go quiet, what the card says in flight, what it says once a save
// lands and whether the rows still take a change are ALL computed by the shipped
// component. If the harness ever started deciding one of those, the unit test
// beside this file is red.
//
// WHAT THE DECISION LOG IS FOR. A card's part of an outcome is the request it
// composes — a proposal is single-use, so an unedited Confirm spends the ref it
// was drawn from and an edited one re-proposes first, and an expired card can
// never take a bare confirm at all. The harness records what the shipped
// component ASKED FOR and draws it under `data-harness-id`, deliberately NOT a
// `data-conformance-id`: it is the checker's own instrument, not an anchor of
// the drawing.
//
// Kept OFF the pixel-diffed /design-fixtures index page (same convention as the
// other conformance fixtures): coverage here is assertion-based —
// tests/e2e/design/conformance/functional-acceptance.spec.ts.
// ---------------------------------------------------------------------------

import { useCallback, useState, type ReactElement } from "react";

import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import {
  ScheduleProposalCardBody,
  type ScheduleDecisionOp,
  type ScheduleDecisionOutcome,
} from "@cinatra-ai/agents/schedule-proposal-card";
import type { ProposedSchedule } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import {
  LIFECYCLE_SCHEDULE_CARD_FIXTURES,
  type LifecycleScheduleCardFixture,
} from "./lifecycle-schedule-card-fixture-data";

/** One thing the shipped card asked the decision endpoint for. */
type RecordedRequest = {
  /** The op the card composed. `adjust-and-confirm` and `repropose` are the two
   *  COMPOSITE roads the card takes rather than single ops. */
  road: ScheduleDecisionOp | "adjust-and-confirm" | "repropose";
  /** The rows the card carried, if it carried any. */
  schedule: ProposedSchedule | null;
};

function ScheduleCardFixture({
  fixture,
}: {
  fixture: LifecycleScheduleCardFixture;
}): ReactElement {
  const [requests, setRequests] = useState<readonly RecordedRequest[]>([]);

  const answer = useCallback(
    async (
      road: RecordedRequest["road"],
      schedule: ProposedSchedule | undefined,
    ): Promise<ScheduleDecisionOutcome> => {
      setRequests((current) => [...current, { road, schedule: schedule ?? null }]);
      if (fixture.answerDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, fixture.answerDelayMs));
      }
      return fixture.answer;
    },
    [fixture],
  );

  return (
    <div data-surface-id={fixture.surfaceId} className="flex flex-col gap-4">
      {/* The IN-THREAD host. Section VI's five readings are the conversation's,
          and the declaration is what makes this mount the in-conversation one —
          the card reads the host from it rather than being told. */}
      <LifecycleCardSurfaceProvider host="chat_thread">
        <ScheduleProposalCardBody
          state={fixture.state}
          body={fixture.body}
          firedOnce={fixture.firedOnce}
          durationCopy={fixture.durationCopy}
          onDecide={(op, schedule) => answer(op, schedule)}
          onAdjustAndConfirm={(schedule) => answer("adjust-and-confirm", schedule)}
          onRepropose={(schedule) => answer("repropose", schedule)}
        />
      </LifecycleCardSurfaceProvider>
      {/* THE CHECKER'S INSTRUMENT, NOT A PART OF THE DRAWING. */}
      <ol data-harness-id="schedule-decision-log">
        {requests.map((request, index) => (
          <li
            // The list only ever grows, so the index IS the request's identity.
            key={`${index}-${request.road}`}
            data-harness-road={request.road}
            data-harness-carried-rows={request.schedule === null ? "none" : "the-reader-s-rows"}
            data-harness-rows={JSON.stringify(request.schedule)}
          />
        ))}
      </ol>
    </div>
  );
}

/**
 * The in-conversation schedule card, one fixture row per manifest surface the
 * family covers — nine surfaces over the drawing's five readings, because the
 * drawing annotates each reading twice: once for the card, once for the floor
 * beneath it.
 */
export function LifecycleScheduleCardFixtures(): ReactElement {
  return (
    <div className="flex flex-col gap-10">
      {LIFECYCLE_SCHEDULE_CARD_FIXTURES.map((fixture) => (
        <ScheduleCardFixture key={fixture.surfaceId} fixture={fixture} />
      ))}
    </div>
  );
}
