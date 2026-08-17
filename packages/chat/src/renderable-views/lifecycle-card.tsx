// ---------------------------------------------------------------------------
// The lifecycle CARD stub + its authoritative-refetch seam (cinatra#2565,
// epic #2564 S1). Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` at that commit.
//
// The SHELL the card registry dispatches the not-yet-drawn lifecycle viewTypes
// to. S2 (#2566) took the review gate: `artifact_review_gate` now dispatches to
// `ReviewGateCard`, and this shell holds the two kinds whose own slices draw
// them — the schedule proposal (S5) and the verification card (§VII). S1 owns
// the wire, the producer bind and the state contract, and what is implemented
// here is the part every later slice depends on and none of them should
// re-invent:
//
//  1. THE PAYLOAD IS A REF. The DATA_PART carries `{ viewType, schemaVersion,
//     ref }` and nothing else. Nothing about the gate — not its subject, not
//     its state, not whether it exists — is readable from the transcript.
//
//  2. AUTHORITATIVE REFETCH. The card resolves live state SERVER-SIDE from the
//     ref on mount, on window focus, and (by virtue of a fresh mount) on
//     reload. A persisted turn therefore never shows yesterday's answer: a gate
//     decided after the turn was written renders as settled the moment the
//     thread is reopened.
//
//  3. NOTHING WITHOUT AN AUTHORIZED RESOLVE. Before the first successful
//     resolve the card renders NO DOM — not even a skeleton. A snapshot-
//     restored shell must not assert that something exists before the server
//     has re-authorized the reader, and a placeholder that appears and then
//     vanishes for a reader who may not see the item is exactly the existence
//     oracle §IV's `absent` state forbids ("no card DOM at all").
//
//  4. FAIL-CLOSED SURFACE GATING. The host declares itself via
//     `LifecycleCardSurfaceProvider`. With NO provider there is no host, and a
//     card renders nothing — so a surface that has not been wired for lifecycle
//     cards cannot start drawing them by inheriting a default. That declaration
//     is now the ONLY gate: every declared host draws every kind (cinatra#2577,
//     owner ruling 2026-08-11 — the per-surface restriction matrix is gone).
// ---------------------------------------------------------------------------

import { useCallback, useState, type ReactElement } from "react";

import {
  type LifecycleCardState,
  type LifecycleDataPartViewType,
  type LifecycleResolveEnvelope,
  type TriggerScheduleProposalExpiredView,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { TriggerScheduleProposalExpired } from "./trigger-schedule-proposal-expired";
// The host declaration + the authoritative-refetch hook MOVED to
// `@cinatra-ai/agents/lifecycle-card-runtime` (cinatra#2566, epic #2564 S2) and
// are re-exported here unchanged. They had to sit at a package the RUN CARD can
// reach too — `@cinatra-ai/chat` depends on `@cinatra-ai/agents`, never the other
// way round — and there must stay exactly ONE of each. Every S1 import path
// still resolves.
import {
  LIFECYCLE_VIEW_RESOLVE_PATH,
  LifecycleCardSurfaceProvider,
  useLifecycleCardHost,
  useLifecycleCardResolve,
} from "@cinatra-ai/agents/lifecycle-card-runtime";

export {
  LIFECYCLE_VIEW_RESOLVE_PATH,
  LifecycleCardSurfaceProvider,
  useLifecycleCardHost,
  useLifecycleCardResolve,
};

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

const CARD_TITLES: Record<LifecycleDataPartViewType, string> = {
  artifact_review_gate: "Review",
  verification_summary: "Verification",
  trigger_schedule_proposal: "Schedule proposal",
};

/**
 * The one-line summary per state. Deliberately identifier-free: the shell says
 * what the reader can do, never what the item is. These lines are the floor of
 * the never-blank ladder for a card whose renderer is not built yet; the review
 * card left them behind in S2 when it gained its drawn target + floor.
 */
function stateLine(state: LifecycleCardState): string | null {
  switch (state.state) {
    case "loading":
      return "Loading…";
    case "pending":
      return "Waiting for your decision.";
    case "restricted":
      return state.reason;
    case "settled":
      return "No longer open.";
    case "advisory":
      return "Advisory reading.";
    case "absent":
      return null;
  }
}

/**
 * The EXPIRED proposal's body, if that is what this card resolved to.
 *
 * Reads it straight off the resolve ENVELOPE (epic S9, slice S9c). The envelope
 * was already parsed at the protocol's one seam, against the kind this card
 * asked for, so there is nothing left for the shell to validate: a body that
 * did not satisfy this kind's schema never became an envelope at all, and the
 * card drew nothing. All that is left here is the two questions the shell is
 * entitled to ask — is this the proposal kind, and is its body the expired
 * phase. Any other phase (or no body) answers `null` and the shell draws its
 * ordinary state line, so a reading this build has no design for degrades to
 * S1's floor rather than to a blank card.
 */
function expiredProposalBody(
  envelope: LifecycleResolveEnvelope,
): TriggerScheduleProposalExpiredView | null {
  if (envelope.kind !== "trigger_schedule_proposal") return null;
  const body = envelope.body;
  if (body === null || body.phase !== "expired") return null;
  return body;
}

/**
 * The registry's component for every lifecycle viewType. Renders nothing until
 * an authorized resolve says otherwise; renders nothing, ever, for `absent`.
 */
export function LifecycleCard({
  view,
}: {
  view: { viewType: LifecycleDataPartViewType; schemaVersion: number; ref: string };
}): ReactElement | null {
  const host = useLifecycleCardHost();
  // The proposal this card is CURRENTLY showing. It starts as the transcript's
  // own ref and changes exactly once: when Adjust re-proposes an expired card,
  // the fresh token becomes the identity the runtime re-resolves under, so the
  // reader watches the card come back to life in place. It is local by design —
  // a proposal has no server record until Confirm, so there is nothing to
  // persist, and a reload honestly returns to the expired reading.
  const [adjustedRef, setAdjustedRef] = useState<string | null>(null);
  const activeRef = adjustedRef ?? view.ref;
  const onReproposed = useCallback((token: string) => setAdjustedRef(token), []);
  // The one surface gate: a subtree that declared no host is not a lifecycle
  // surface, so the card is not part of it. Every DECLARED host draws every
  // kind — the per-surface restriction matrix is gone (owner ruling 2026-08-11).
  const present = host !== null;
  // The shell draws from the state for every kind whose own renderer is not
  // built yet. The ONE exception is the expired proposal, whose reading IS this
  // change: it is taken from the envelope's per-kind body, already parsed
  // against this kind's schema at the one seam (S9c), so the shell validates
  // nothing itself and can never draw a body it has no design for.
  const resolved = useLifecycleCardResolve({
    viewType: view.viewType,
    ref: activeRef,
    enabled: present,
  });

  if (!present || resolved === null) return null;
  const { state } = resolved;
  const line = stateLine(state);
  if (line === null) return null; // `absent` — no card DOM at all (§IV)
  const expired = expiredProposalBody(resolved);

  return (
    <div
      className="my-3 rounded-lg border border-line bg-surface-muted p-3 text-xs text-muted-foreground"
      data-lifecycle-card={view.viewType}
      data-lifecycle-card-state={state.state}
    >
      <div className="font-semibold text-foreground">{CARD_TITLES[view.viewType]}</div>
      {expired === null ? (
        <div className="mt-1">{line}</div>
      ) : (
        // §VI's expired reading REPLACES the shell's "No longer open." line: the
        // two are the same rung of S1's ladder, and only one of them is true
        // here. A proposal that timed out was never decided.
        <TriggerScheduleProposalExpired
          view={expired}
          cardRef={activeRef}
          onReproposed={onReproposed}
        />
      )}
    </div>
  );
}
