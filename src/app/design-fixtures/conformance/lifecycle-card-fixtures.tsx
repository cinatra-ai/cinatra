"use client";

// ---------------------------------------------------------------------------
// Functional-acceptance harness for the IN-CONVERSATION REVIEW DECISION FLOOR
// (cinatra#3156, epic #3155 W0).
//
// Renders the REAL `ReviewDecisionBar` — the one decision floor every first-party
// host draws at the foot of a review gate — inside the REAL chat-thread host
// declaration, so the assertions in tests/e2e/design/conformance/contract.ts run
// against the shipped affordances, the shipped subordinate rationale field and
// the shipped outcome notices rather than against a stand-in.
//
// ONE SUBSTITUTION, AND IT IS THE SEAM THE FLOOR ALREADY HAS. The floor takes
// the host's BOUND decision action as a prop — the review page passes its own
// route-bound one — so the harness passes a deterministic one. That is the same
// single substitution the extension listing-card fixtures make for their install
// action (see card-fixtures.tsx: "the ONLY substitution is the bound server
// action"), and it is the whole of what this file stands in for.
//
// THE OUTCOME IS NOT WRITTEN HERE. The harness action hands back the DECISION
// CORE's typed result for a committed decision, and the PRODUCT's own pure
// mapper — `mapSubmitResultToOutcome`, the same function the review page's
// server action calls — decides what that means on screen. So "press Comment ->
// the floor says the comment is recorded and the gate stays open" is the shipped
// mapping and the shipped presentation end to end; nothing in this file names
// the outcome the driver asserts.
//
// NOTHING IS INTERCEPTED. There is no transport substitution of any kind here:
// no fetch wrapper, no route stub, no seeded server answer. The floor is a
// props-only component, so mounting it needs none.
//
// Kept OFF the pixel-diffed /design-fixtures index page (same convention as the
// other conformance fixtures): coverage here is assertion-based —
// tests/e2e/design/conformance/functional-acceptance.spec.ts.
// ---------------------------------------------------------------------------

import type { ReactElement } from "react";

import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import {
  ReviewDecisionBar,
  type SubmitReviewDecisionAction,
} from "@cinatra-ai/agents/review-decision-bar";

import type { SubmitDecisionResult } from "@/lib/artifacts/artifact-review-decision";
import {
  mapSubmitResultToOutcome,
  type ReviewDecisionPermissions,
} from "@/lib/artifacts/review-surface-model";

import {
  LIFECYCLE_REVIEW_FLOOR_FIXTURES,
  type LifecycleReviewFloorFixture,
} from "./lifecycle-card-fixture-data";

/**
 * What the decision core answers when a decision COMMITS: the shape
 * `submitReviewDecisionCore` returns on its success path, with a fixed
 * fingerprint because the harness re-runs it and a fingerprint is an identity,
 * not an outcome.
 *
 * This is the ONLY thing the harness decides. `plan: null` is the no-effect
 * commit plan a comment produces; whether that reads as "annotated", "decided"
 * or a block is the product mapper's call, not this file's.
 */
const HARNESS_COMMITTED_DECISION: SubmitDecisionResult = {
  ok: true,
  idempotent: false,
  fingerprint: "conformance-harness-review-floor",
  plan: null,
};

/** The host-bound decision action one mounted floor submits through. */
function harnessSubmitAction(): SubmitReviewDecisionAction {
  return async ({ disposition }) =>
    mapSubmitResultToOutcome(HARNESS_COMMITTED_DECISION, disposition);
}

function ReviewFloorFixture({ fixture }: { fixture: LifecycleReviewFloorFixture }): ReactElement {
  // The row's standing, read as the product's own type: a drift in
  // `ReviewDecisionPermissions` is a typecheck failure here rather than a
  // silently half-declared reader.
  const permissions: ReviewDecisionPermissions = fixture.permissions;
  return (
    <div data-surface-id={fixture.surfaceId} className="flex flex-col gap-4">
      {/* The IN-THREAD host. The floor is host-independent by design (one bar,
          the same component on every first-party host), and the declaration is
          what makes this mount the in-conversation one rather than an
          undeclared surface. */}
      <LifecycleCardSurfaceProvider host="chat_thread">
        <ReviewDecisionBar permissions={permissions} submitAction={harnessSubmitAction()} />
      </LifecycleCardSurfaceProvider>
    </div>
  );
}

/**
 * The in-conversation review decision floors, one fixture row per manifest
 * surface the family covers.
 */
export function LifecycleReviewFloorFixtures(): ReactElement {
  return (
    <div className="flex flex-col gap-10">
      {LIFECYCLE_REVIEW_FLOOR_FIXTURES.map((fixture) => (
        <ReviewFloorFixture key={fixture.surfaceId} fixture={fixture} />
      ))}
    </div>
  );
}
