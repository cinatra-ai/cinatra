import "server-only";

import { z } from "zod";

import {
  LIFECYCLE_DATA_PART_VIEW_TYPES,
  LIFECYCLE_VIEW_REF_MAX_LENGTH,
  type LifecycleDataPartViewType,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { resolveLifecycleCardState } from "@/lib/lifecycle/lifecycle-card-refetch";
import { attachLifecycleSuggestions } from "@/lib/lifecycle/lifecycle-suggestion-chips";
import { resolveReviewActorContext } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor";

// ---------------------------------------------------------------------------
// POST /api/lifecycle-views/resolve — the lifecycle card's authoritative
// refetch (cinatra#2565, epic #2564 S1).
//
// A card posts the opaque ref it was minted with and gets back the state it may
// draw RIGHT NOW, resolved against the session actor with a per-row access
// re-check. This endpoint is the reason a lifecycle DATA_PART can carry nothing
// but a ref: the transcript stops being a place where anything about a gate is
// readable, and a reload cannot resurrect a stale view of it.
//
// COOKIE SESSION ONLY. The broker-authenticated widget branch is deliberately
// not served here: the widget's lifecycle enablement, its read scope and its
// decide-time confirmation are S8d/S8a/S8b's, and serving it early would ship
// the read half of a surface whose write half has no confirmation step yet.
//
// A DENIAL IS A 200 `absent`, NEVER A 403. The status code is as much of an
// oracle as the body: answering 403 for "you may not read this" and 200
// `absent` for "there is nothing here" would let anyone holding a ref probe
// which rows exist. Only a malformed request (400) and no session (401) are
// distinguishable, and neither depends on the ref.
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

export async function POST(request: Request): Promise<Response> {
  const actorCtx = await resolveReviewActorContext();
  if (!actorCtx) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw: unknown = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "Invalid lifecycle view request" }, { status: 400 });
  }

  const state = await resolveLifecycleCardState({
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
    state,
    parsed.data.viewType,
    parsed.data.ref,
  );

  return Response.json({ state: withChips }, { headers: { "Cache-Control": "no-store" } });
}
