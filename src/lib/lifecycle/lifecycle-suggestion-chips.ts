import "server-only";

// ---------------------------------------------------------------------------
// The gate's SUGGESTION CHIPS, attached to an already-authorized card state
// (cinatra#2572, epic #2564 S6c; redrawn by cinatra#2852). Design:
// design@60b27dfbb8a2a1594e6e88333cc5c048c244e640
// `specs/app-lifecycle-cards.html` §VIII.
//
// §VIII: "A card may carry per-item suggestions. Each one shows what it would
// change — the current content beside the suggested content … The suggestions
// carry no submit of their own: they ride the review card's one Approve /
// Reject, and a reject simply records them as not taken."
//
// WHY THIS IS A LEAF AND NOT TWO MORE BRANCHES IN `lifecycle-card-refetch`.
// The resolver is reachable from `lifecycle-pull-mcp`, which the app's auth
// plugins mount, which puts it on the module graph of all five ROUTE-LOCKED
// routes (`scripts/audit/route-graph-ratchet`). Reading the snapshot from there
// drags the producer + the two suggestion stores onto every one of them — four
// modules on five locked budgets, for a projection that path does not use: the
// pull calls the resolver purely as the AUTHORIZATION LADDER, reads
// `state === "absent"`, and discards the rest. It is also the stronger posture,
// not merely the cheaper one: nothing about a gate's suggestions can reach a
// tool result, because the code that reads them is not on that path at all.
//
// THE STATE IS THE AUTHORIZATION, AND IT IS AN ARGUMENT. This module runs no
// access check of its own and must never be asked to: it takes the state
// `resolveLifecycleCardState` already answered for THIS reader and THIS ref, and
// only a state that ladder produced can unlock a read. `loading`, `advisory` and
// `absent` return untouched — `absent` is the ladder's collapse of every denial,
// so a reader who may not read the run, a gate that does not exist and a ref
// that does not decode all reach this module as a state that cannot carry chips
// and leave it unchanged. The chips are therefore disclosed on exactly the
// authorization that discloses the target they annotate, and never on less.
//
// A FAILURE COSTS THE CHIPS, NEVER THE CARD. Everywhere else on this path a
// failure collapses to `absent`, because everywhere else the question is
// authorization or existence. Here it is neither: a gate with no snapshot, a
// snapshot whose bytes no longer verify, and a store that threw all mean "there
// are no chips to draw". Turning any of them into `absent` would take a live
// decision floor away from a reviewer entitled to it — failing OPEN on the
// safety property in order to fail closed on a decoration. The reviewer then
// decides with no partition, which is what a gate that never had suggestions
// has always looked like.
//
// THE CHIP CARRIES THE CHANGE ITSELF (cinatra#2852; §VIII redrawn at
// design@60b27dfbb8a2a1594e6e88333cc5c048c244e640). The projection carries the
// pointer, the transform class, the producer's one-line reason AND the
// before/after pair the suggestion would change. The earlier reading kept the
// values off the row in case a chip disclosed more than the target beside it; it
// cannot. `before` is a slice of the SAME disclosed projection the gate's target
// island already renders to this reader, `after` is what the producer derived
// from that slice, and both are read out on exactly the authorization that
// discloses the target — the state this module is handed. Nothing here widens
// what a reader may see; it puts two things they may already read next to each
// other, which is what makes a suggestion decidable at all.
// ---------------------------------------------------------------------------

import {
  projectLifecycleSuggestions,
  type LifecycleCardState,
  type LifecycleDataPartViewType,
  type LifecycleSuggestion,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
// The SAME snapshot the decision core validates a partition against, read
// through the same hash check — so a chip a reviewer can see is, by
// construction, an id the decision core will accept.
import { readGateSuggestionSurface } from "@cinatra-ai/agents/suggestion-decision-store";

import { decodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";

async function readChips(
  ref: string,
  withRecordedMarks: boolean,
): Promise<LifecycleSuggestion[] | undefined> {
  try {
    const payload = decodeLifecycleGateRef(ref);
    if (!payload) return undefined;
    const surface = await readGateSuggestionSurface(
      payload.runId,
      payload.reviewTaskId,
      { withRecordedMarks },
    );
    if (!surface || surface.suggestions.length === 0) return undefined;
    const chips = projectLifecycleSuggestions(surface.suggestions, surface.marks);
    return chips.length > 0 ? chips : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Attach §VIII's chips to a review card state the ladder has already authorized.
 *
 * Returns the state UNCHANGED for every kind and state that cannot carry chips.
 * The three that can:
 *
 *   pending / restricted — the surfaced suggestions with NO marks. A pending
 *     gate has no recorded partition (the marks live on the reviewer's screen
 *     until the one terminal decision carries them), so the ledger is not read
 *     at all. A `restricted` reader gets the same chips: they may read the
 *     target these annotate, and the card draws them without an affordance.
 *
 *   settled — the surfaced suggestions WITH the recorded partition, so the
 *     decision stays inspectable on the surface it was made on rather than only
 *     in an audit table.
 */
export async function attachLifecycleSuggestions(
  state: LifecycleCardState,
  viewType: LifecycleDataPartViewType,
  ref: string,
): Promise<LifecycleCardState> {
  if (viewType !== "artifact_review_gate") return state;
  switch (state.state) {
    case "pending":
    case "restricted": {
      const suggestions = await readChips(ref, false);
      return suggestions ? { ...state, suggestions } : state;
    }
    case "settled": {
      const suggestions = await readChips(ref, true);
      return suggestions ? { ...state, suggestions } : state;
    }
    default:
      return state;
  }
}
