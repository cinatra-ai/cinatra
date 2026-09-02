"use client";

// ---------------------------------------------------------------------------
// Functional-acceptance harness for the RECOMMENDATION ROW of the
// in-conversation lifecycle cards (cinatra#3160, epic #3155 W4).
//
// Renders the REAL `RunRecommendationChipRow` — the one shipped renderer of
// `recommendation_hold`, the same component the run panel, the chat transcript
// and the widget each mount — inside the REAL chat-thread host declaration, so
// the assertions in tests/e2e/design/conformance/contract.ts run against the
// shipped row, the shipped pill, the shipped read-only reading and the shipped
// restricted reading rather than against a stand-in.
//
// NOTHING IS INTERCEPTED. There is no transport substitution of any kind here:
// no fetch wrapper, no route stub, no seeded server answer, and no `submit`
// prop. Every reading below is reached by handing the row the props its shipped
// hosts hand it — the candidates the run offers, the run's settled answer, and
// whether THIS reader may shape the run — which is why no driver in this family
// presses a decision control: the row's decision controls submit to the real
// server actions, and a harness that answered them for the product would be
// asserting the harness.
//
// THE READINGS, AND WHERE EACH ONE COMES FROM in the drawing's §V:
//
//   PAUSED / BEFORE START — "the row is drawn in the assistant's turn, after
//     the assistant has started the run ... the run is dispatched and held at
//     that gate"; and "for as long as the run has not started, a reader who
//     comes back to the Skills step is shown the same pills". Those are ONE
//     product reading — a live parked hold — and the drawing draws it twice, so
//     the harness mounts it twice: once as the turn, once inside the
//     three-readings example.
//   RUNNING — "once the run is running, the selection is fixed and the row is
//     read-only: each pill states in its own box whether that skill was applied
//     to the run. No Continue is left beneath it, and nothing is left to press."
//     That is the shipped SETTLED row, built from the run's durable evidence.
//   RESTRICTED — "shaping this run needs run access on it. Every box, and the
//     Continue beneath them, stays on screen disabled." That is the shipped
//     `canDecide={false}` reading.
//
// WHAT THE HARNESS DOES NOT DO. It names no drawn state. The chip a started run
// draws for a skill with no decision row is drawn `skipped` because the shipped
// `settledChipsForRow` derives it; the loading line and the no-candidates line
// are the component's own; whether a control is disabled is the component's own.
// The harness hands inputs and nothing else — pinned by
// __tests__/lifecycle-recommendation-fixture.test.tsx.
//
// Kept OFF the pixel-diffed /design-fixtures index page (same convention as the
// other conformance fixtures): coverage here is assertion-based —
// tests/e2e/design/conformance/functional-acceptance.spec.ts.
// ---------------------------------------------------------------------------

import type { ReactElement } from "react";

import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import { RunRecommendationChipRow } from "@cinatra-ai/agents/run-recommendation-chip-row";

import {
  LIFECYCLE_RECOMMENDATION_AGENT,
  LIFECYCLE_RECOMMENDATION_APPLIED_KINDS,
  LIFECYCLE_RECOMMENDATION_CANDIDATES,
  LIFECYCLE_RECOMMENDATION_RUN_ID,
  LIFECYCLE_RECOMMENDATION_SKILL_ID,
  LIFECYCLE_RECOMMENDATION_SKILL_NAME,
  type LifecycleRecommendationDecision,
} from "./lifecycle-recommendation-fixture-data";

/**
 * The run's settled answer for the reading where the run has already started.
 *
 * `decided` is the run's DURABLE EVIDENCE — one entry per skill that ended with
 * a selection row, carrying the mark that row RECORDED — and `candidates` is the
 * offer the hold asked about. The recorded mark is an input the resolver reads,
 * not a reading this file draws: what the row DRAWS from it (the box treatment,
 * the outcome line) is the shipped component's. The third skill is in the offer
 * and in no decision row, and the shipped `settledChipsForRow` is what turns
 * that into the chip the drawing draws with its box clear — nothing here says
 * "skipped", and the harness unit test asserts that over THIS object.
 *
 * Exported so that test can read the real object rather than a restatement of it.
 */
export const STARTED_RUN_DECISION: LifecycleRecommendationDecision = {
  kind: "confirmed",
  skillNames: [],
  decided: LIFECYCLE_RECOMMENDATION_APPLIED_KINDS.map((kind) => ({
    skillId: LIFECYCLE_RECOMMENDATION_SKILL_ID[kind],
    name: LIFECYCLE_RECOMMENDATION_SKILL_NAME[kind],
    mark: "confirmed" as const,
  })),
  candidates: LIFECYCLE_RECOMMENDATION_CANDIDATES.map((candidate) => ({
    skillId: candidate.skillId,
    name: candidate.name,
  })),
};

/** A LIVE parked hold — the reading the drawing draws in the assistant's turn. */
function HeldRow({ canDecide }: { canDecide: boolean }): ReactElement {
  return (
    <RunRecommendationChipRow
      runId={LIFECYCLE_RECOMMENDATION_RUN_ID}
      agentPackageName={LIFECYCLE_RECOMMENDATION_AGENT}
      initialRecommendations={[...LIFECYCLE_RECOMMENDATION_CANDIDATES]}
      decision={{ kind: "pending" }}
      canDecide={canDecide}
      variant="inline"
    />
  );
}

/**
 * The in-conversation recommendation row, one mount per reading the drawing
 * draws. Every mount declares the CHAT-THREAD host, which is what makes these
 * the in-conversation readings rather than the run panel's.
 */
export function LifecycleRecommendationFixtures(): ReactElement {
  return (
    <div className="flex flex-col gap-10">
      {/* The row in the assistant's turn, on a run held at the gate. */}
      <div data-surface-id="recommendation-paused">
        <LifecycleCardSurfaceProvider host="chat_thread">
          <HeldRow canDecide />
        </LifecycleCardSurfaceProvider>
      </div>

      {/* The same live row, offered NO candidate. "A row with every box clear is
          still the whole card" — the row keeps its place and states its own
          emptiness; nothing stands in for it. */}
      <div data-surface-id="recommendation-empty">
        <LifecycleCardSurfaceProvider host="chat_thread">
          <RunRecommendationChipRow
            runId={LIFECYCLE_RECOMMENDATION_RUN_ID}
            agentPackageName={LIFECYCLE_RECOMMENDATION_AGENT}
            initialRecommendations={[]}
            decision={{ kind: "pending" }}
            variant="inline"
          />
        </LifecycleCardSurfaceProvider>
      </div>

      {/* The same live row BEFORE its candidates have been read. The row is given
          no prefetched offer, which is exactly what the chat mount does, and the
          reading it draws until the read answers is the component's own. */}
      <div data-surface-id="recommendation-loading">
        <LifecycleCardSurfaceProvider host="chat_thread">
          <RunRecommendationChipRow
            runId={LIFECYCLE_RECOMMENDATION_RUN_ID}
            agentPackageName={LIFECYCLE_RECOMMENDATION_AGENT}
            decision={{ kind: "pending" }}
            variant="inline"
          />
        </LifecycleCardSurfaceProvider>
      </div>

      {/* The drawing's side-by-side example: one row, three readings. */}
      <div data-surface-id="recommendation-readings" className="flex flex-col gap-6">
        <div data-reading="before-start">
          <LifecycleCardSurfaceProvider host="chat_thread">
            <HeldRow canDecide />
          </LifecycleCardSurfaceProvider>
        </div>
        <div data-reading="running">
          <LifecycleCardSurfaceProvider host="chat_thread">
            <RunRecommendationChipRow
              runId={LIFECYCLE_RECOMMENDATION_RUN_ID}
              agentPackageName={LIFECYCLE_RECOMMENDATION_AGENT}
              initialRecommendations={[...LIFECYCLE_RECOMMENDATION_CANDIDATES]}
              decision={STARTED_RUN_DECISION}
              variant="inline"
            />
          </LifecycleCardSurfaceProvider>
        </div>
        <div data-reading="restricted">
          <LifecycleCardSurfaceProvider host="chat_thread">
            <HeldRow canDecide={false} />
          </LifecycleCardSurfaceProvider>
        </div>
      </div>
    </div>
  );
}
