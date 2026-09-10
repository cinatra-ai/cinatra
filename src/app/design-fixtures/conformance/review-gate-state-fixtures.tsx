"use client";

// ---------------------------------------------------------------------------
// Functional-acceptance harness for the REVIEW GATE STATES (cinatra#3163, epic
// #3155 W7).
//
// Renders the REAL `ReviewGateLoading` and `ReviewGateBlocked` — the shipped
// gate-state components of the one review renderer, exported from their own
// owner module — so the assertions in
// tests/e2e/design/conformance/contract.ts run against the shipped skeleton, the
// shipped blocked panel, the shipped closed-set reason attribute and the shipped
// refresh control rather than against a stand-in.
//
// WHY THESE TWO PARTS OF THE FAMILY. They are the parts of the review-target /
// decision-floor family that a harness can mount as the product mounts them. The
// decision floor may not be composed outside the card at all (the one-card gate
// bans a page-direct decision composition, and rightly: a second place that
// composes the floor is a second place a decision could come to mean something
// different), and that ban covers the disabled reason and the prompt window with
// it, because both are drawn inside the modules it fences. The two gate states
// have neither constraint — the same gate explicitly does NOT ban the blocked
// panel, because the review page already draws its own route-level absence with
// the shipped component, and banning it would force a second absence panel into
// existence, which is the duplication that gate exists to prevent.
//
// NOTHING IS INTERCEPTED. There is no transport substitution of any kind here:
// no fetch wrapper, no route stub, no seeded server answer. Both components are
// props-only, so mounting them needs none.
//
// THE HARNESS NAMES NOTHING. A mount carries a surface id and a reading. What a
// blocked gate is titled, what its one-line body says, and what its control is
// called are all resolved by the product from the closed blocked axis.
//
// Kept OFF the pixel-diffed /design-fixtures index page (same convention as the
// other conformance fixtures): coverage here is assertion-based —
// tests/e2e/design/conformance/functional-acceptance.spec.ts.
// ---------------------------------------------------------------------------

import type { ReactElement } from "react";

import { ReviewGateBlocked, ReviewGateLoading } from "@cinatra-ai/agents/review-gate-states";

import {
  REVIEW_GATE_BLOCKED_FIXTURE_REASON,
  REVIEW_GATE_STATE_FIXTURES,
  type ReviewGateStateFixture,
} from "./review-gate-state-fixture-data";

function ReviewGateStateFixtureMount({ fixture }: { fixture: ReviewGateStateFixture }): ReactElement {
  return (
    <div data-surface-id={fixture.surface} data-variant={fixture.variant} className="flex flex-col gap-4">
      {fixture.surface === "review-gate-loading" ? (
        <ReviewGateLoading />
      ) : (
        // The card-local refresh seam is passed so the harness never navigates:
        // the control the driver reads is the shipped one either way, and the
        // component decides what it is called and whether it is drawn at all.
        <ReviewGateBlocked reason={REVIEW_GATE_BLOCKED_FIXTURE_REASON} onRefresh={() => {}} />
      )}
    </div>
  );
}

/**
 * The review gate's loading and blocked readings, one mount per (surface,
 * reading) the manifest declares.
 */
export function ReviewGateStateConformanceFixtures(): ReactElement {
  return (
    <div className="flex flex-col gap-10">
      {REVIEW_GATE_STATE_FIXTURES.map((fixture) => (
        <ReviewGateStateFixtureMount key={`${fixture.surface}:${fixture.variant}`} fixture={fixture} />
      ))}
    </div>
  );
}
