import { NextResponse } from "next/server";
import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import { AuthzError } from "@/lib/authz";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import {
  deriveRunHitlContext,
  readAgentRunById,
  readAgentRunMessages,
  readAgentTemplateById,
  type ActorRoleHints,
} from "@cinatra-ai/agents";
// The RUN'S OWN REVIEW SLOT (cinatra#2997). A dedicated SUBPATH import, never
// the barrel: the gate store reaches the host review cores, and this route is
// the only consumer here — see the barrel's own note on why it is not
// re-exported. The read runs AFTER the run has been authorized below, so it is
// a plain run-scoped read behind this route's own door.
import {
  isParkedOnProducedReview,
  readRunReviewSlot,
} from "@cinatra-ai/agents/artifact-review-gate-store";
import { encodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import {
  authenticateWidgetConversationRequest,
  isWidgetBranchRequest,
} from "@/lib/widget-conversation-door";
import { WIDGET_AGENT_RUN_SEED_GRANT } from "@/lib/widget-conversation-grants";

// ---------------------------------------------------------------------------
// GET /api/agents/runs/<runId> — the inline run panel's SEED.
//
// The chat transcript knows a run id and nothing else; this endpoint answers
// with the run state, its messages and the template metadata the panel needs to
// mount. It is the panel's FIRST read and the only one this slice opens.
//
// TWO AUTH BRANCHES (cinatra#2902).
//
//   · COOKIE SESSION — the first-party hosts (`/chat`), unchanged to the byte.
//   · BROKER `cwu_`  — the embedded site widget. Its actor is built by the ONE
//     conversation door, consumed at THIS route's audience under
//     `conversation.read`, and the run is then bound to that credential by the
//     SAME per-run authorization ladder the first-party read runs.
//
// THE BRANCH IS DECIDED BY THE PRESENTED CREDENTIAL, NEVER BY A CLAIM ABOUT THE
// SURFACE, and it does not fall back. This route is same-origin to the embed
// frame, so an ambient Cinatra cookie is exactly what a failed widget consume
// must not be rescued by — it would hand the frame whoever else is signed in on
// that browser, and a run is somebody's work.
//
// THE WIDGET BRANCH'S REFUSAL IS UNIFORM ACROSS RUN OUTCOMES, which is the
// property that matters and is narrower than "one answer to everything". A run
// that does not exist, a run in another tenant and a run this reader may not see
// all answer with the SAME 404 and the SAME body, and none of them reads a
// message or a template first — so no answer here distinguishes "no such run"
// from "not yours", and existence is never disclosed across tenants.
//
// A REJECTED CREDENTIAL IS A SEPARATE 401 `{"error":"Unauthorized"}`, deliberately
// NOT folded into that 404. It is an answer about the CALLER, not about any run:
// it is returned before any run is read, so it distinguishes nothing about which
// runs exist, and collapsing it into the 404 would tell a widget whose token
// merely expired that its run had vanished. Both refusals are pinned by
// `route.widget-branch.test.ts`.
//
// The first-party branch keeps its 403/404 split,
// which is a distinction its caller is already entitled to; on a third-party
// page that same split is an existence oracle for runs the asker has no standing
// to learn about.
//
// SCOPE, STATED NARROWLY. The seed and the render. The panel's live transports —
// the run's stream (`./stream`) and its creation-progress notifications — remain
// session-only and are deliberately NOT opened here, which is why the guard's
// matcher terminates at this path and the grant declares this audience alone.
// ---------------------------------------------------------------------------

type RouteContext = { params: Promise<{ runId: string }> };

/**
 * `requireAuthSession()` answers an unauthenticated caller by calling Next's
 * `redirect()`, which does not return — it THROWS a control-flow signal carrying
 * a `NEXT_REDIRECT` digest. That is right for a page and wrong for this route:
 * caught by the handler's generic error arm it became a 500 whose body was the
 * framework's own signal string, so an ordinary unauthenticated poll of the seed
 * read as a server fault and leaked an internal token to the caller.
 *
 * Recognised here by the digest contract rather than by an instanceof, because
 * the signal is a plain Error the framework tags — and answered as the 401 it
 * actually is.
 */
function isNextRedirectSignal(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "digest" in err &&
    typeof (err as { digest?: unknown }).digest === "string" &&
    ((err as { digest: string }).digest === "NEXT_REDIRECT" ||
      (err as { digest: string }).digest.startsWith("NEXT_REDIRECT;"))
  );
}

/** The one answer to an unauthenticated caller, on either branch. */
function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/** The widget branch's ONE answer to every refusal. */
function widgetRefusal(): NextResponse {
  return NextResponse.json({ error: "Run not found" }, { status: 404 });
}

/**
 * The seed body. ONE serializer for both branches, so the widget cannot drift
 * into showing more (or less) of a run than the app shows for the same reader.
 */
async function seedResponse(
  run: NonNullable<Awaited<ReturnType<typeof readAgentRunById>>>,
): Promise<NextResponse> {
  const messages = await readAgentRunMessages(run.id);

  // Fetch the template once and reuse it in BOTH the hitlContext derivation
  // AND the inline-card metadata response below.
  const template = await readAgentTemplateById(run.templateId);

  // Shared derivation (also used by the A2A snapshot path — see
  // packages/agents/src/hitl-context.ts): persisted AG-UI INTERRUPT first
  // (bounded Redis Streams reverse read — the SSE stream can open AFTER the
  // worker emitted the INTERRUPT and miss it), then the synthetic
  // wayflow-<a2aTaskId> / setup-<runId> gate-identity fallbacks.
  const hitlContext = await deriveRunHitlContext(run, { template });

  // WHAT THE RUN CARD DRAWS WHERE THE REVIEW SCREEN GOES (cinatra#2997).
  //
  // The card is a placeholder for the review screen while the agent works and
  // becomes that screen when the work opens one, so the run's own seed has to
  // carry the answer — the card must not have to ask a model, and a person must
  // not have to ask for it in a new turn. Two values and nothing else:
  //
  //   `ref`      — the SERVER-MINTED opaque ticket for this run's own review
  //                gate, minted here exactly as the run screen mints it, from
  //                (runId, reviewTaskId). The card is only ever addressed by
  //                one of these, and it re-authorizes itself on resolve — so
  //                this is a pointer the reader already cleared the door for,
  //                never a projection of the gate.
  //   `awaiting` — the run produced something whose review question is still
  //                open in the outbox. It is what holds the placeholder up
  //                between `completed` and the gate row existing.
  //
  // An instance with no app secret cannot mint a ref; the field is then null and
  // the card draws its terminal rendering, which is the same answer this route
  // gave before this field existed.
  // FAIL-SOFT, and deliberately so. This field tells the run card which of its
  // readings to draw; the SEED is what mounts the card at all. A slot read that
  // throws must therefore cost the reader the placeholder's precision, never the
  // panel — so the failure answers "no review here", which is exactly the seed
  // this route served before the field existed, and the card's own read tries
  // again a moment later.
  const reviewSlot = await readRunReviewSlot(run.id).catch(() => ({
    reviewTaskId: null,
    awaiting: false,
    parkedOnProducedReview: false,
  }));
  // AND THE PARK IS READ OFF THE RUN ROW THIS RESPONSE IS ABOUT (cinatra#3046).
  //
  // NOT from the slot, though the slot answers it too, and the difference is a
  // real seam rather than a preference. This body serves ONE snapshot of the run
  // — its `status` and its gate context come from the row read above — and the
  // slot is a SECOND read taken a moment later. A run released in between would
  // be serialized with the parked status and the answered gate from the first
  // read beside "not parked" from the second, which is the exact combination that
  // puts a live Continue back on a question the run has moved past.
  //
  // It also means a slot read that THREW costs the card the two gate facts (which
  // is the fail-soft this route always had) and none of this one.
  const producedReviewPark = isParkedOnProducedReview(run);
  const reviewGateRef = reviewSlot.reviewTaskId
    ? encodeLifecycleGateRef({ runId: run.id, reviewTaskId: reviewSlot.reviewTaskId })
    : null;

  // Surface the template+run metadata fields the chat-inline
  // <AgenticRunPanel> wrapper needs (templateId for HITL-assist endpoints,
  // agentPackageName for renderer override resolution, agUiEnabled to pick
  // SSE-vs-poll, a2aTaskId for cancel logic, traceId for trace links).
  // These are SSR-loaded directly from the DB on the run-detail page; the
  // chat wrapper has to fetch via this REST endpoint. The template is
  // already loaded above (reused — single DB round-trip).
  return NextResponse.json({
    status: run.status,
    error: run.error,
    inputParams: run.inputParams ?? {},
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    completedAt: run.completedAt ? run.completedAt.toISOString() : null,
    templateId: run.templateId,
    agentPackageName: template?.packageName ?? null,
    agUiEnabled: run.agUiEnabled ?? null,
    taskId: run.a2aTaskId ?? null,
    traceId: run.traceId ?? null,
    // THE RUN'S OWN STATED MOMENT (cinatra#2930, epic #2926 W3). The plan:
    // "No screen re-derives a moment from a task id or from the shape of a
    // pause." A screen can only read the row if the row reaches it, and this is
    // the endpoint every chat-inline run panel reads a run through — so the
    // moment rides with the status it belongs to rather than being inferred
    // from `hitlContext` beside it.
    lifecycleMoment: run.lifecycleMoment ?? null,
    messages: messages.map((m) => ({
      id: m.id,
      runId: m.runId,
      sequence: m.sequence,
      role: m.role,
      messageType: m.messageType,
      toolCallId: m.toolCallId,
      toolName: m.toolName,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    })),
    hitlContext,
    reviewGate: {
      ref: reviewGateRef,
      awaiting: reviewSlot.awaiting,
      // THE RUN IS PARKED ON THIS REVIEW (cinatra#3046). A third fact about the
      // same slot, and the one that says the pause belongs to the review rather
      // than to a question: a run whose output opened a review does not reach a
      // terminal status until that review is decided, so while it waits its
      // status reads `pending_approval` and it carries no gate interrupt of its
      // own. Without this the card cannot tell that pause from an unanswered
      // setup field, so it redrew the field the run had already moved past and
      // drew no review at all. Row-grounded and fail-soft with the two beside it:
      // a slot read that throws answers `false`, which is the reading this route
      // gave before the field existed.
      producedReviewPark,
    },
  });
}

/**
 * The WIDGET branch: authenticate the presented credential per call, then bind
 * the run to it.
 *
 * The binding is not a second rule written here — it is `readAgentRunById` run
 * with the widget principal and the org the TOKEN is bound to, which is the same
 * owner / co-owner / same-org / platform-admin ladder the first-party read runs.
 * A run outside it never reaches the serializer, so no run field, no message and
 * no template ever leaves this branch on a failed binding.
 */
async function widgetSeed(request: Request, decodedRunId: string): Promise<NextResponse> {
  const authed = await authenticateWidgetConversationRequest(
    request,
    WIDGET_AGENT_RUN_SEED_GRANT,
  );
  // No session fallback behind a failed widget consume.
  if (!authed) return unauthorized();

  let run: Awaited<ReturnType<typeof readAgentRunById>>;
  try {
    run = await readAgentRunById(
      decodedRunId,
      authed.actorCtx.actor,
      // The org the TOKEN is bound to travels on these hints — never a session's
      // active org, which a widget request has no business reading.
      authed.actorCtx.roleHints,
    );
  } catch (err) {
    if (err instanceof AuthzError) return widgetRefusal();
    throw err;
  }
  if (!run) return widgetRefusal();
  return seedResponse(run);
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { runId } = await context.params;
    const decodedRunId = decodeURIComponent(runId);

    // The discriminant is the header's PRESENCE, not whether its value looks
    // usable: a request that DID declare itself a widget — with an empty value —
    // must not fall through to the session branch, where an ambient cookie would
    // answer it as somebody else.
    if (isWidgetBranchRequest(request)) {
      return await widgetSeed(request, decodedRunId);
    }

    // A first-party poll with NO cookie reaches here (the guard admits the path
    // cookieless for the widget's sake, so this branch — not the guard — is what
    // refuses it). Catch the redirect signal explicitly so it becomes the 401
    // this is, never the generic 500 below.
    let session: Awaited<ReturnType<typeof requireAuthSession>>;
    try {
      session = await requireAuthSession();
    } catch (err) {
      if (isNextRedirectSignal(err)) return unauthorized();
      throw err;
    }
    const actorUserId = session?.user?.id ?? null;
    if (!actorUserId) {
      return unauthorized();
    }

    // Thread the caller through readAgentRunById so enforceRunAccess runs the
    // real per-run authorization: owner / co-owner / same-org / platform-admin.
    // This closes the cross-tenant read gap for unowned (runBy: null) runs,
    // which the previous hand-rolled guard let through to ALLOW. AuthzError is
    // mapped to 404 (hidden) or 403 (forbidden); messages are fetched only after
    // the access check succeeds so a denied caller never receives them.
    const actor: PrimitiveActorContext = {
      actorType: "human",
      source: "route",
      userId: actorUserId,
    };
    const roles: ActorRoleHints = {
      platformRole: isPlatformAdmin(session) ? "platform_admin" : "member",
      actorOrganizationId: session?.session?.activeOrganizationId ?? undefined,
    };

    let run: Awaited<ReturnType<typeof readAgentRunById>>;
    try {
      run = await readAgentRunById(decodedRunId, actor, roles);
    } catch (err) {
      if (err instanceof AuthzError) {
        return NextResponse.json(
          { error: err.statusCode === 404 ? "Run not found" : "Forbidden" },
          { status: err.statusCode },
        );
      }
      throw err;
    }

    if (!run) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }

    return await seedResponse(run);
  } catch (err) {
    // Backstop: no redirect signal may reach the 500 arm from ANY depth, because
    // that arm echoes `err.message` and would put framework text in the body.
    if (isNextRedirectSignal(err)) return unauthorized();
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}
