import "server-only";

// ---------------------------------------------------------------------------
// THE REVIEWED TARGET'S HEADER, attached to an already-authorized card state
// (cinatra#3141 item 7).
//
// §IV of the ratified review drawing gives every target a header that "names
// what is under review and fixes it in place: the artifact's display title over
// a mono meta line carrying its type, the pinned representation revision (shown
// as a mono revision id with a pinned marker), and the read-only row facts the
// host authorized". That header was rendered by the ISLAND — the server-rendered
// document the card frames in an iframe — so it existed only once that frame had
// painted. While the preview was still arriving the card drew a bar skeleton,
// and past the island's bounded wait it drew the preview-recovery panel, and
// neither carried a title, a type or a revision. A pending gate on the run page
// drew with no header at all.
//
// So the CARD draws the header now, in every island state, and this module is
// what tells it what the header says.
//
// WHY THIS IS A LEAF AND NOT A BRANCH IN `lifecycle-card-refetch`. Exactly the
// reason `lifecycle-settled-outcome` and `lifecycle-suggestion-chips` give, and
// it applies here unchanged: the resolver is reachable from `lifecycle-pull-mcp`,
// which the app's auth plugins mount, which puts it on the module graph of the
// route-locked routes. The pull uses the resolver purely as the AUTHORIZATION
// LADDER — it reads `state === "absent"` and discards the rest — so composing a
// header from there would drag the artifact read onto those budgets for a
// projection that path never draws. It is the stronger posture as well as the
// cheaper one: no artifact title can reach a tool result, because the code that
// reads one is not on that path at all.
//
// THE STATE IS THE AUTHORIZATION, AND IT IS AN ARGUMENT. This module runs no run
// access check of its own and must never be asked to. It takes the state
// `resolveLifecycleCardState` already answered for THIS reader and THIS ref;
// every denial has already collapsed into `absent`, which carries no header, so
// a reader who may not read the run, a gate that does not exist and a ref that
// does not decode all arrive as a state that cannot carry one and leave
// unchanged. The artifact read below is actor-scoped on top of that, so a row
// this reader could not open on its own detail page is not readable here either.
//
// WHAT THIS DISCLOSES, STATED PLAINLY. To a reader who may READ the run and
// therefore already sees this gate: the pinned target's title, its type, the
// revision the gate froze, and the row facts the host authorizes on the artifact
// page — which is precisely what the island drew to the same reader a moment
// later, out of the same reads. Nothing here widens the audience or the set; it
// moves where the sentence is composed, and it moves it because the old place
// could not be relied on to exist.
//
// A FAILURE COSTS THE HEADER, NEVER THE CARD. A gate row that vanished between
// the two reads, an artifact that is unreadable or tombstoned, and a store that
// threw all mean "this answer cannot name the target". Each yields NO header for
// that target, and the card draws none rather than an invented one — naming the
// wrong artifact over a review is worse than naming none.
// ---------------------------------------------------------------------------

import {
  LIFECYCLE_TARGET_HEADERS_MAX,
  LIFECYCLE_TARGET_HEADER_FACTS_MAX,
  LIFECYCLE_TARGET_HEADER_MAX_TEXT,
  type LifecycleCardState,
  type LifecycleDataPartViewType,
  type LifecycleTargetHeader,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { readReviewGate } from "@cinatra-ai/agents/artifact-review-gate-store";

import { buildActorContextFromPrimitive } from "@/lib/authz/build-actor-context";
import {
  readArtifactForDetail,
  readArtifactForSettledReview,
} from "@/lib/artifacts/artifact-service";
import { artifactKindLabelFor } from "@/lib/artifacts/artifact-kind-label";
import { reviewTargetRowFacts } from "@/lib/artifacts/review-surface-model";
import { decodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

/**
 * The header(s) for the pinned target(s) of ONE review gate, or `null` when this
 * answer cannot name them.
 *
 * `null` is not a signal and never distinguishes a denial from an absence: the
 * three states that can carry a header are exactly the three the card draws a
 * target under, and every other state — `absent` above all — leaves here with
 * nothing, which is what the card already draws for an answer composed before
 * this field existed.
 */
export async function readReviewTargetHeaders(input: {
  viewType: LifecycleDataPartViewType;
  ref: string;
  state: LifecycleCardState;
  actorCtx: ReviewActorContext;
}): Promise<LifecycleTargetHeader[] | null> {
  const { viewType, ref, state, actorCtx } = input;
  // Only the review kind has a target, and only the three states that draw one
  // may carry its header. `absent` carries nothing beside itself.
  if (viewType !== "artifact_review_gate") return null;
  if (state.state !== "pending" && state.state !== "restricted" && state.state !== "settled") {
    return null;
  }
  // A SETTLED STATE WITH NO RECOGNIZED OUTCOME PRESENTS NO TARGET, so it may
  // carry no header either. The card is explicit about it — a gate resolved
  // before the outcome travelled, and a disposition this build cannot read,
  // both draw the generic "no longer open" panel and no island, because a card
  // that cannot say what was decided may not present the reviewed work as
  // decided. Composing a header for that answer would put the target's title,
  // type and row facts on a response whose own surface has refused to show
  // them; the answer stops where the drawing stops.
  if (state.state === "settled" && state.outcome === undefined) return null;
  try {
    const payload = decodeLifecycleGateRef(ref);
    if (!payload) return null;
    const gate = await readReviewGate(payload.runId, payload.reviewTaskId);
    if (!gate || gate.pinnedTargets.length === 0) return null;

    const actor = buildActorContextFromPrimitive(
      actorCtx.actor,
      actorCtx.orgId,
      actorCtx.roleHints,
    );
    const headers: LifecycleTargetHeader[] = [];
    for (const target of gate.pinnedTargets) {
      // WHICH READING, AND WHY THE TWO ARE NOT INTERCHANGEABLE. Both carry the
      // same authorization — the same actor-scoped ownership filter and the same
      // canonical read decision, so a row this reader may not read answers
      // `denied` under either — and they differ in exactly one thing: whether a
      // TOMBSTONED row still resolves.
      //
      //   settled → the HISTORICAL read. A gate holds its decision to the
      //     revision it pinned, and enabler 0.9's sentence is that a target
      //     tombstoned after the fact must still name what was reviewed.
      //
      //   pending / restricted → the LIVE read, which is what the ordinary
      //     target preparation uses on those readings: it floors a tombstone at
      //     `unknown-or-tombstoned` and shows no title, type, ownership,
      //     visibility, MIME or update time for it. The header is composed for
      //     the same reader on the same reading, so it must withhold exactly
      //     what that reading withholds — a header is not a side door onto a
      //     deleted row.
      const read =
        state.state === "settled"
          ? readArtifactForSettledReview({
              artifactId: target.artifactId,
              orgId: actorCtx.orgId,
              actor,
            })
          : readArtifactForDetail({
              artifactId: target.artifactId,
              orgId: actorCtx.orgId,
              actor,
            });
      if (read.kind !== "ok") continue;
      const artifact = read.artifact;
      headers.push({
        title: clamp(artifact.title ?? artifact.artifactId, artifact.artifactId),
        typeLabel: artifact.objectType
          ? clamp(artifactKindLabelFor(artifact.objectType), "Artifact")
          : "Artifact",
        objectType: (artifact.objectType ?? "").slice(0, LIFECYCLE_TARGET_HEADER_MAX_TEXT),
        revisionId: clamp(target.representationRevisionId, "—"),
        // Worded by the SURFACE MODEL, not here: the card owns no artifact
        // vocabulary, and the island's own header reads the same function, so
        // the two cannot word the same fact differently.
        facts: reviewTargetRowFacts({
          ownerLevel: artifact.ownerLevel,
          visibility: artifact.visibility,
          mime: artifact.mime,
          updatedAt: artifact.updatedAt,
        })
          .slice(0, LIFECYCLE_TARGET_HEADER_FACTS_MAX)
          .map((fact) => clamp(fact, "—")),
      });
      if (headers.length === LIFECYCLE_TARGET_HEADERS_MAX) break;
    }
    return headers.length > 0 ? headers : null;
  } catch {
    // The reading is lost, never the card.
    return null;
  }
}

/**
 * COMPOSE INSIDE THE WIRE'S OWN BOUNDS, never outside them.
 *
 * The answer's schema is strict and bounded, and the parser refuses the WHOLE
 * envelope for one field it cannot accept — which is right for a hostile shape
 * and wrong as a way to lose a card. An artifact title is authored up to 500
 * characters while one header's text is bounded at
 * {@link LIFECYCLE_TARGET_HEADER_MAX_TEXT}, so a perfectly legal title would
 * otherwise refuse the envelope and blank the gate the reader came to decide.
 * A header trimmed at the bound is a small loss of wording; a refused envelope
 * is the loss of the whole review. The empty string is not a legal value on this
 * wire either, so a row that words a field as nothing falls back rather than
 * composing a value the parser must reject.
 */
function clamp(value: string, fallback: string): string {
  const trimmed = value.slice(0, LIFECYCLE_TARGET_HEADER_MAX_TEXT);
  if (trimmed.length > 0) return trimmed;
  const fallbackTrimmed = fallback.slice(0, LIFECYCLE_TARGET_HEADER_MAX_TEXT);
  return fallbackTrimmed.length > 0 ? fallbackTrimmed : "—";
}
