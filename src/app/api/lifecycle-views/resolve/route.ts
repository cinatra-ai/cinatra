import "server-only";

import { z } from "zod";

import {
  LIFECYCLE_DATA_PART_VIEW_TYPES,
  LIFECYCLE_VIEW_REF_MAX_LENGTH,
  type LifecycleCardState,
  type LifecycleDataPartViewType,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { decodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import { resolveLifecycleCardState } from "@/lib/lifecycle/lifecycle-card-refetch";
import { attachLifecycleSuggestions } from "@/lib/lifecycle/lifecycle-suggestion-chips";
import { attachLifecycleSettledOutcome } from "@/lib/lifecycle/lifecycle-settled-outcome";
import { resolveTriggerScheduleProposalCard } from "@/lib/lifecycle/trigger-schedule-proposal-card";
import {
  mintWidgetReviewIslandUrl,
  resolveWidgetLifecycleActorContext,
} from "@/lib/lifecycle/widget-lifecycle-actor";
import { resolveAssistantWidgetBinding } from "@/lib/assistant-widget-handles";
import { resolveReviewActorContext } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

// ---------------------------------------------------------------------------
// POST /api/lifecycle-views/resolve — the lifecycle card's authoritative
// refetch (cinatra#2565, epic #2564 S1; extended by #2569 S5).
//
// A card posts the opaque ref it was minted with and gets back the state it may
// draw RIGHT NOW, resolved against the session actor with a per-row access
// re-check. This endpoint is the reason a lifecycle DATA_PART can carry nothing
// but a ref: the transcript stops being a place where anything about a gate is
// readable, and a reload cannot resurrect a stale view of it.
//
// TWO AUTH BRANCHES (cinatra#2577, epic #2564 S8d opened the second).
//
//   · COOKIE SESSION — the first-party hosts, unchanged.
//   · BROKER `cwu_` — the public-site widget. Its actor is built by the S8a
//     module (`resolveWidgetLifecycleActorContext`), which consumes the token at
//     THIS route's audience with the `lifecycle.read` scope required and then
//     resolves the reader's live standing. A widget session that signed in
//     before the grant existed holds neither the audience nor the scope and dies
//     at that consume.
//
// THE BRANCH IS DECIDED BY THE PRESENTED CREDENTIAL, NEVER BY A CLAIM ABOUT THE
// SURFACE, and it does not fall back: a request carrying the widget user-token
// header is a widget request, and a failed widget consume 401s rather than
// dropping to an ambient cookie the iframe's own origin would happily supply.
//
// BOTH BRANCHES RESOLVE THE SAME VIEW SET (corrected 2026-08-11, owner ruling).
// An earlier revision refused two viewTypes on the widget branch from a §IX
// presence matrix; that matrix was invented and is removed. A widget reader is
// the same authenticated person, so the only thing that decides what they see is
// the per-row authorization every branch already runs.
//
// A DENIAL IS A 200 `absent`, NEVER A 403. The status code is as much of an
// oracle as the body: answering 403 for "you may not read this" and 200
// `absent` for "there is nothing here" would let anyone holding a ref probe
// which rows exist. Only a malformed request (400) and no session (401) are
// distinguishable, and neither depends on the ref.
//
// THE ANSWER IS A PER-KIND ENVELOPE (epic S9, slice S9c): `{ kind, state, body }`.
// The state ladder is shared by every kind and unchanged; the BODY is per-kind,
// and the kind selects the one body type that kind may carry. Two of the three
// DATA_PART kinds cannot be drawn without one — the schedule proposal needs its
// option rows, the verification card its reading — and the review card carries
// no body at all, because its target arrives through its own island.
//
// The kind travels back with the answer so a card can check it got an answer to
// ITS question. A client parse that refuses (unknown kind, wrong kind, a body
// beside `absent`, a missing body on a kind that must carry one) leaves the card
// with no state, so it draws nothing — the same posture it holds before the
// first resolve lands.
// ---------------------------------------------------------------------------

const requestSchema = z
  .object({
    viewType: z.enum(
      LIFECYCLE_DATA_PART_VIEW_TYPES as unknown as [
        LifecycleDataPartViewType,
        ...LifecycleDataPartViewType[],
      ],
    ),
    ref: z.string().min(1).max(LIFECYCLE_VIEW_REF_MAX_LENGTH),
  })
  .strict();

/** The `cwu_` proof header — the discriminant for the widget branch. */
const WIDGET_USER_TOKEN_HEADER = "X-Cinatra-Widget-User-Token";
/** The embed-forwarded parent (CMS) origin; re-checked against the token binding. */
const WIDGET_ORIGIN_HEADER = "X-Cinatra-Widget-Origin";
/** The embed-forwarded assistant handle; only a selector — the token is the authority. */
const WIDGET_ASSISTANT_HEADER = "X-Cinatra-Widget-Assistant";

/**
 * The widget branch's answer: the reviewing actor AND the claims the presented
 * `cwu_` was consumed with. The claims are KEPT rather than dropped because the
 * island credential is derived from them and from nothing else — see
 * `mintIslandSrcForWidget` below.
 */
type WidgetBranch = {
  actorCtx: ReviewActorContext;
  claims: Parameters<typeof mintWidgetReviewIslandUrl>[0]["claims"];
};

/**
 * Resolve the widget branch's reviewing actor from the presented `cwu_`.
 * Returns `null` for every failure — a bad handle, a rejected token, a revoked
 * membership — because the caller turns all of them into the same 401 that a
 * missing credential produces.
 */
async function resolveWidgetBranchActor(
  request: Request,
  userToken: string,
): Promise<WidgetBranch | null> {
  // An empty/whitespace bearer is refused HERE rather than left to the door.
  // The door would refuse it too, but a branch that hands an empty string to a
  // token verifier is one rename away from being a branch that hands it to
  // something more forgiving.
  if (userToken.length === 0) return null;
  const handle = request.headers.get(WIDGET_ASSISTANT_HEADER)?.trim().toLowerCase() ?? "";
  const binding = resolveAssistantWidgetBinding(handle);
  if (!binding) return null;
  const resolved = await resolveWidgetLifecycleActorContext({
    token: userToken,
    agentSlug: binding.agentSlug,
    requestOrigin: request.headers.get(WIDGET_ORIGIN_HEADER),
  });
  return resolved.ok ? { actorCtx: resolved.actorCtx, claims: resolved.claims } : null;
}

/**
 * Mint the island URL for a WIDGET reader whose card is about to draw one.
 *
 * WHY THE URL CARRIES IT. The review card frames a same-origin, server-rendered
 * island. On a genuinely third-party page that frame load sends no header and
 * no cookie, so the only place a credential can travel is the URL the card puts
 * in `<iframe src>` — sealed, short-lived and bound to this reader, this gate
 * and this surface. It authenticates and nothing more: the island re-runs the
 * reader's real access from scratch, so a credential that arrives without the
 * standing behind it still paints nothing.
 *
 * ONLY FOR A STATE THAT DRAWS AN ISLAND. `pending` and `restricted` are the two
 * states whose card frames one. A settled or absent answer gets no credential,
 * because a reader whose card draws no island has no use for one and a minted
 * bearer that nothing consumes is a bearer for free.
 *
 * TTL AND RELOAD, THE POLICY IN ONE PLACE. Every resolve mints a FRESH
 * credential; nothing is cached and nothing is stored. Within one resolve the
 * card reuses the URL it was handed — a re-render, an expand/collapse or a
 * repaint keeps the same `src`, and re-minting there would remount the frame
 * under the reader for no reason. Across a RELOAD it is always a re-mint: the
 * card's retry re-resolves before it remounts, and the mount/focus resolves do
 * the same, so a frame never re-fetches with a credential older than the
 * resolve that produced it. That is also why the credentialed frame drops
 * `loading="lazy"` — a URL that expires cannot wait for a scroll.
 */
function mintIslandSrcForWidget(
  branch: WidgetBranch,
  viewType: LifecycleDataPartViewType,
  ref: string,
  state: LifecycleCardState,
): string | null {
  if (viewType !== "artifact_review_gate") return null;
  if (state.state !== "pending" && state.state !== "restricted") return null;
  const gate = decodeLifecycleGateRef(ref);
  if (!gate) return null;
  return mintWidgetReviewIslandUrl({
    claims: branch.claims,
    ref,
    runId: gate.runId,
    reviewTaskId: gate.reviewTaskId,
  });
}

export async function POST(request: Request): Promise<Response> {
  // A presented widget user token SELECTS the widget branch and there is no
  // session fallback behind it: this endpoint is same-origin to the embed
  // iframe, so an ambient Cinatra cookie is exactly the thing a failed widget
  // read must not be rescued by (the auth-confusion guard the turn endpoint and
  // the capabilities route both carry).
  //
  // The discriminant is the header's PRESENCE, not whether its value looks
  // usable (codex round 0, finding 3). Selecting on a trimmed non-empty value
  // would send a request that DID present the widget header — with an empty or
  // whitespace value — down the session branch, where an ambient cookie would
  // answer it as somebody else. A caller that declares itself a widget is a
  // widget, and a widget whose token is unusable is refused.
  const presentedUserToken = request.headers.get(WIDGET_USER_TOKEN_HEADER);
  const isWidgetBranch = presentedUserToken !== null;
  const widgetBranch = isWidgetBranch
    ? await resolveWidgetBranchActor(request, presentedUserToken.trim())
    : null;
  const actorCtx = isWidgetBranch
    ? (widgetBranch?.actorCtx ?? null)
    : await resolveReviewActorContext();
  if (!actorCtx) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw: unknown = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "Invalid lifecycle view request" }, { status: 400 });
  }

  // NO PER-SURFACE VIEWTYPE FILTER (corrected 2026-08-11, owner ruling). This
  // endpoint used to refuse two viewTypes on the widget branch, from a presence
  // matrix that has been removed as invented. Both branches now resolve the same
  // set: the widget reader is the same authenticated person, and what they may
  // see is decided — for every viewType, on every surface — by the per-row
  // authorization below, which is the only thing that ever knew.

  // The schedule proposal resolves state AND body in one pass — they must agree,
  // and resolving twice would both cost a second verify and open a window where
  // a Confirm landing between the two calls produced a `pending` floor over a
  // settled body.
  if (parsed.data.viewType === "trigger_schedule_proposal") {
    const card = await resolveTriggerScheduleProposalCard({
      ref: parsed.data.ref,
      // A principal with no attributable user cannot hold a proposal — the
      // empty string is never a valid binding, so the resolve answers `absent`.
      userId: actorCtx.actor.userId ?? "",
      orgId: actorCtx.orgId,
      // THE READER'S STANDING TRAVELS WITH THE REQUEST (cinatra#3004). A
      // run-addressed card for a run that came from no proposal is read under
      // the RUN's own access control, so the resolver is handed exactly what
      // this route already placed — never a wider claim, and never a role the
      // caller asserted about itself.
      access: { actor: actorCtx.actor, roles: actorCtx.roleHints },
    });
    return Response.json(
      {
        kind: "trigger_schedule_proposal",
        state: card.state,
        body: card.view,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const envelope = await resolveLifecycleCardState({
    viewType: parsed.data.viewType,
    ref: parsed.data.ref,
    actorCtx,
  });

  // §VIII's suggestion chips (cinatra#2572, epic #2564 S6c). Composed HERE, on
  // the one endpoint that draws them, rather than inside the resolver: the
  // resolver is on all five route-locked module budgets through the MCP pull,
  // which uses it as the authorization ladder and never draws a chip.
  //
  // The state above IS the authorization — it is the ladder's own answer for
  // this reader and this ref, and every denial has already collapsed into
  // `absent`, which carries no chips. Nothing is disclosed here that the state
  // did not already entitle its reader to see, and the chips ride the resolve
  // answer rather than the wire payload, so the DATA_PART in the persisted,
  // LLM-visible transcript still carries a ref and nothing else.
  const withChips = await attachLifecycleSuggestions(
    envelope.state,
    parsed.data.viewType,
    parsed.data.ref,
  );

  // §IV's SETTLED READING (cinatra#2855; plan §4.2). Composed HERE for the same
  // reason the chips are, and the reason is the same sentence: the resolver is
  // on all five route-locked module budgets through the MCP pull, which uses it
  // as the authorization ladder and never names a decider.
  //
  // The state is again the authorization — the ladder's own answer for this
  // reader and this ref, with every denial already collapsed into `absent`,
  // which carries no outcome. And the composition ORDER carries nothing: the
  // chips read the gate's suggestion snapshot, the outcome reads the gate row's
  // recorded disposition, and neither reads the other's answer.
  const withOutcome = await attachLifecycleSettledOutcome(
    withChips,
    parsed.data.viewType,
    parsed.data.ref,
  );

  // The island's credential (cinatra#2754) — minted HERE or not at all, and
  // only on the widget arm. A first-party answer omits the key entirely, so the
  // three cookie hosts receive the byte-identical response they received
  // before this slice and keep composing their own island URL.
  const islandSrc = widgetBranch
    ? mintIslandSrcForWidget(widgetBranch, parsed.data.viewType, parsed.data.ref, withOutcome)
    : null;

  return Response.json(
    {
      kind: envelope.kind,
      state: withOutcome,
      body: envelope.body,
      ...(islandSrc ? { islandSrc } : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
