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
//     card renders nothing — so a surface that has not been reviewed for
//     lifecycle cards (the site widget, whose enablement is S8d's) cannot start
//     drawing them by inheriting a default. §IX's presence matrix is then
//     consulted per (kind, host).
// ---------------------------------------------------------------------------

import { type ReactElement } from "react";

import {
  LIFECYCLE_CARD_PRESENCE,
  type LifecycleCardState,
  type LifecycleDataPartViewType,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
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
  useLifecycleCardState,
} from "@cinatra-ai/agents/lifecycle-card-runtime";

export {
  LIFECYCLE_VIEW_RESOLVE_PATH,
  LifecycleCardSurfaceProvider,
  useLifecycleCardHost,
  useLifecycleCardState,
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
 * The registry's component for every lifecycle viewType. Renders nothing until
 * an authorized resolve says otherwise; renders nothing, ever, for `absent`.
 */
export function LifecycleCard({
  view,
}: {
  view: { viewType: LifecycleDataPartViewType; schemaVersion: number; ref: string };
}): ReactElement | null {
  const host = useLifecycleCardHost();
  // §IX presence: no declared host, or a host this kind does not appear on →
  // the card is not part of this surface at all.
  const present = host !== null && LIFECYCLE_CARD_PRESENCE[view.viewType][host];
  const state = useLifecycleCardState({
    viewType: view.viewType,
    ref: view.ref,
    enabled: present,
  });

  if (!present || state === null) return null;
  const line = stateLine(state);
  if (line === null) return null; // `absent` — no card DOM at all (§IV)

  return (
    <div
      className="my-3 rounded-lg border border-line bg-surface-muted p-3 text-xs text-muted-foreground"
      data-lifecycle-card={view.viewType}
      data-lifecycle-card-state={state.state}
    >
      <div className="font-semibold text-foreground">{CARD_TITLES[view.viewType]}</div>
      <div className="mt-1">{line}</div>
    </div>
  );
}
