"use client";

// ---------------------------------------------------------------------------
// Functional-acceptance harness for the RECOMMENDATION ROW of the
// in-conversation lifecycle cards (cinatra#3160, epic #3155 W4).
//
// THE MOUNT IS `RecommendationHoldCard`, THE ONE COMPOSER OF THE SHIPPED ROW.
//
// The first cut of this harness mounted `RunRecommendationChipRow` directly and
// handed it a reading per mount — the candidates, the settled answer and the
// reader's rights — because the card takes none of those as props. That is a
// SECOND RENDERER of `recommendation_hold`, which is exactly the class
// scripts/audit/chat-hitl-one-card-gate.mjs rule R2 forbids and exactly the
// defect (D-1) its own history records: a host that draws the interaction itself
// instead of mounting the card is a second place where "confirmed" can come to
// mean something different, however faithful it looks on the day it lands. The
// gate caught it, and the gate was right. Every mount below is the card.
//
// WHAT THE CARD DOES INSTEAD, AND WHAT THAT COSTS THIS HARNESS. The card owns
// WHETHER the row appears, WHICH state it is in and WHEN it re-reads: it
// resolves the run's authoritative hold state itself — the cookie-bound server
// action on a cookie host, the broker read on a credential-declaring one — and
// derives the offer, the settled answer and `canDecide` from that answer alone.
// So a mount does not hand it a reading; it hands it a RUN, and the reading is
// whatever that run resolves to for THIS reader.
//
// The conformance harness route is a dev-only PUBLIC path (see
// src/lib/auth-route-guard.ts) and the design suite drives it with no session,
// so on THIS page the cookie-bound resolve answers "no row for this reader" and
// the card draws nothing. That is the shipped card's own fail-closed reading,
// not a gap in the harness — and it is the same constraint the W0 harness
// already recorded for the review card ("the card as a whole draws no DOM before
// an authorised server resolve", lifecycle-card-fixtures.tsx). It is why the
// thirteen recommendation surfaces are NOT driven in
// tests/e2e/design/conformance/functional-acceptance.spec.ts and are named on
// this wave's readiness list instead: their manifest stays unpinned, no
// allowlist entry was added, and no driver claims coverage this harness cannot
// honestly reach. The readings themselves are proven where a real reader and a
// real held run exist — tests/e2e/chat-hitl-held-turn/held-turn.spec.ts — and,
// through the shipped card and the shipped row, in
// __tests__/lifecycle-recommendation-fixture.test.tsx, which answers the card's
// OWN resolve with the authoritative state each run stands for and asserts
// nothing about how that reading is drawn.
//
// NOTHING IS INTERCEPTED HERE. There is no transport substitution of any kind on
// this page: no fetch wrapper, no route stub, no seeded server answer and no
// `submit` prop. The card resolves through its real transport and draws whatever
// that answers.
//
// Kept OFF the pixel-diffed /design-fixtures index page (same convention as the
// other conformance fixtures).
// ---------------------------------------------------------------------------

import type { ReactElement } from "react";

import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import { RecommendationHoldCard } from "@cinatra-ai/agents/run-recommendation-chip-row";

import {
  LIFECYCLE_RECOMMENDATION_AGENT,
  LIFECYCLE_RECOMMENDATION_READINGS,
  LIFECYCLE_RECOMMENDATION_READING_RUN,
  LIFECYCLE_RECOMMENDATION_RUN,
} from "./lifecycle-recommendation-fixture-data";

/**
 * One mount: the shipped card, under the CHAT-THREAD host declaration, for one
 * run. The declaration is what makes this the in-conversation reading rather
 * than the run panel's — and `chat_thread` is a cookie host, so it declares no
 * credential (the runtime's closed list refuses the mismatch either way).
 */
function RecommendationCardInThread({ runId }: { runId: string }): ReactElement {
  return (
    <LifecycleCardSurfaceProvider host="chat_thread">
      <RecommendationHoldCard runId={runId} agentPackageName={LIFECYCLE_RECOMMENDATION_AGENT} />
    </LifecycleCardSurfaceProvider>
  );
}

/**
 * The in-conversation recommendation card, one mount per reading the drawing
 * draws. A reading is selected by the RUN the card is handed, never by a prop:
 * the card resolves what that run is, and the row draws what the card resolved.
 */
export function LifecycleRecommendationFixtures(): ReactElement {
  return (
    <div className="flex flex-col gap-10">
      {/* The card in the assistant's turn, on a run held at the gate. */}
      <div data-surface-id="recommendation-paused">
        <RecommendationCardInThread runId={LIFECYCLE_RECOMMENDATION_RUN.held} />
      </div>

      {/* A held run that was offered NO candidate. "A row with every box clear is
          still the whole card" — the row keeps its place and states its own
          emptiness; nothing stands in for it. */}
      <div data-surface-id="recommendation-empty">
        <RecommendationCardInThread runId={LIFECYCLE_RECOMMENDATION_RUN.empty} />
      </div>

      {/* The drawing's side-by-side example: one row, three readings — each one a
          run whose resolved state IS that reading. `before-start` is the SAME
          held run as the turn above, because the drawing draws one live parked
          hold twice rather than two product states. */}
      <div data-surface-id="recommendation-readings" className="flex flex-col gap-6">
        {LIFECYCLE_RECOMMENDATION_READINGS.map((reading) => (
          <div key={reading} data-reading={reading}>
            <RecommendationCardInThread runId={LIFECYCLE_RECOMMENDATION_READING_RUN[reading]} />
          </div>
        ))}
      </div>
    </div>
  );
}
