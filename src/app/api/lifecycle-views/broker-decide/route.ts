import "server-only";

import { z } from "zod";

import { enforceReviewRunAccess } from "@cinatra-ai/agents/artifact-review-gate-store";
import { readReviewGatePinnedTargets } from "@/app/artifacts/[id]/review-gate-ports";
import { submitReviewDecisionAction } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions";
import { resolveAssistantWidgetBinding } from "@/lib/assistant-widget-handles";
import {
  ACTION_CAPABILITY_HEADER,
  ACTION_CAPABILITY_MAX_LENGTH,
  ACTION_CAPABILITY_PURPOSE_DECIDE,
  ACTION_CAPABILITY_DECIDE_ROUTE_PATH,
  actionCapabilityBindingDigest,
  decisionPayloadDigest,
  pinnedTargetsDigest,
  verifyActionCapability,
  WIDGET_COMMENT_MAX_CHARS,
} from "@/lib/lifecycle/widget-action-capability";
import {
  actionCapabilityRowBinding,
  consumeActionCapability,
} from "@/lib/lifecycle/widget-action-capability-store";
import {
  WIDGET_LIFECYCLE_DECIDE_GRANT,
  resolveWidgetLifecycleActorContext,
} from "@/lib/lifecycle/widget-lifecycle-actor";

// ---------------------------------------------------------------------------
// POST /api/lifecycle-views/broker-decide — the WIDGET decision entry
// (cinatra#2575, epic #2564 S8b).
//
// THIS IS NOT A SECOND DECISION PATH. It is a third ENTRY to the one that
// already exists. Once the credentials have been checked, the body is handed to
// `submitReviewDecisionAction` — the same helper the review page's route-bound
// action and the first-party gate-scoped entry call — which enforces the same
// order it always has: run access for the decision op, then the frozen pinned
// set read from the gate, then the #1807 core's re-validation (pinned-set
// membership, revision membership, gate CAS, provenance re-derived from the
// artifact type). Nothing about the decision is re-implemented here, nothing is
// relaxed, and the race outcomes a widget reviewer sees — idempotent retry,
// conflict, no-longer-pending — are the same values, produced by the same CAS,
// as the ones the review page shows.
//
// WHAT IS DIFFERENT IS ONLY WHO IS ASKING, and that is the whole slice. The
// first-party entries authenticate a Cinatra cookie session. This one cannot:
// its caller is an iframe whose session credential is a `cwu_` bearer that the
// CMS backend possesses by design. So the bearer authorizes NOTHING here on its
// own — it identifies the widget session and nothing more — and the authority to
// decide comes from a FRESH, SINGLE-USE ACTION CAPABILITY minted in a
// cinatra-origin window the site can neither script nor read.
//
// THE LADDER, cheapest and least-disclosing first. No rung touches a store on
// behalf of a caller who has not passed the previous one:
//
//   1. THE SEALED CAPABILITY — present, ours, unexpired, minted for THIS purpose
//      and THIS endpoint. A request without one is refused before anything else
//      happens, which is the AC-2 property: a `cwu_` replayed server-side, as a
//      hostile site can trivially do, reaches exactly this refusal.
//   2. THE LIVE WIDGET SESSION — the presented `cwu_` consumed under the DECIDE
//      grant by the ONE verifier (S8a), which re-checks expiry, agent, audience,
//      scope, the token-bound site origin, the live connect site and its
//      credential generation, and then resolves the person's REAL org standing.
//   3. THE BINDING — every axis the capability sealed must still agree with the
//      live session: principal, org, widget session id, site, CMS client,
//      canonical instance, agent. Disagreement REFUSES rather than downgrading
//      to the live values, because disagreement means the binding moved
//      underneath the confirmation, which is exactly when a decision must stop.
//   4. THE BODY — the decision payload presented must digest to the value the
//      capability sealed. The confirmation window named the act and showed the
//      rationale; a body that says something else was never confirmed.
//   5. THE BURN — the single-use consume edge. Two concurrent redemptions of one
//      capability contend on one row and exactly one proceeds. This happens
//      BEFORE the decision runs: a credential is spent by being PRESENTED, not
//      by succeeding, so a caller who provokes a failure does not keep a live
//      decision credential.
//   6. RUN READ — the same precondition the first-party card entry restored, in
//      the same position, against the same one actor context the decision-op
//      check will use.
//   7. THE GATE — the pinned representation revisions must still digest to what
//      the capability sealed. A settled gate is deliberately NOT refused here:
//      its pinned set is immutable and still readable, so the decision core gets
//      to answer with idempotent-success or conflict rather than this route
//      short-circuiting to a false "blocked".
//
// EVERY "NO" AFTER THE CREDENTIAL IS THE SAME `not-permitted` OUTCOME AT 200 —
// the decision helper's own refusal shape, verbatim. An unauthorized caller, a
// replayed capability and a gate that no longer exists must be indistinguishable.
// Only a rejected credential (401, carrying the re-login marker the widget
// already understands) and a malformed body (400) are distinguishable, and
// neither depends on the gate.
//
// COOKIES ARE NEVER READ HERE. The widget fetches this endpoint with
// `credentials: "omit"` and this module names no session module: a route that
// could fall back to an ambient Cinatra cookie would decide as whoever happened
// to be signed in on that browser, which on a public CMS page is not the person
// the widget authenticated. The structural confinement suite pins that.
// ---------------------------------------------------------------------------

/** The per-user `cwu_` bearer header (cinatra#408 — the dual-token identity). */
const USER_TOKEN_HEADER = "X-Cinatra-Widget-User-Token";
/** The embed's forwarded CMS parent origin — validated intrinsically by the
 * token consume, which is the authority (the chat route's Lane A seam). */
const WIDGET_ORIGIN_HEADER = "X-Cinatra-Widget-Origin";
/** Emitted on a fail-closed 401 so the widget can swap to the login window. */
const WIDGET_AUTH_REQUIRED_HEADER = "X-Cinatra-Widget-Auth";

const requestSchema = z
  .object({
    /** The widget assistant handle — the G9 handle↔token binding, closed set. */
    assistant: z.string().min(1).max(64),
    // NO `ref` AND NO `disposition`. Both are SEALED in the capability, which is
    // what makes the confirmation meaningful: the body cannot name a gate or an
    // act, so there is nothing for a caller to vary between the window the
    // person read and the request that lands.
    // Bounded to the same ceiling the ASK half accepts (the widget window shows
    // the WHOLE rationale, so the cap is what a window can honestly present).
    // A longer body cannot match any digest anyway; refusing it at the schema
    // means the mismatch is a 400 rather than an indistinguishable refusal.
    comment: z.string().max(WIDGET_COMMENT_MAX_CHARS).nullable().optional(),
    // NO per-item suggestion partition either, and `.strict()` makes sending
    // one a 400.
    // The ASK half refuses a partition because the confirmation window cannot
    // show one; this half refuses it because a body that carries something the
    // confirmation never covered is exactly what the digest check exists to
    // stop, and refusing it at the schema is one layer earlier and one fewer
    // thing to reason about. The partition joins in S8d, with the screen that
    // can name it.
  })
  .strict();

/** The one refusal a caller ever sees for "not yours" / "not there" / "spent". */
const UNIFORM_REFUSAL = {
  kind: "not-permitted" as const,
  message:
    "You do not have the run access this decision needs — a terminal decision requires approve access, a comment requires respond access.",
};

const NO_STORE = { "Cache-Control": "no-store" } as const;

function refuse(): Response {
  return Response.json({ outcome: UNIFORM_REFUSAL }, { headers: NO_STORE });
}

export async function POST(request: Request): Promise<Response> {
  const unauthorized = (): Response =>
    new Response("Unauthorized (widget login required)", {
      status: 401,
      headers: { ...NO_STORE, [WIDGET_AUTH_REQUIRED_HEADER]: "required" },
    });

  const presentedCapability = request.headers.get(ACTION_CAPABILITY_HEADER)?.trim() ?? "";
  const presentedToken = request.headers.get(USER_TOKEN_HEADER)?.trim() ?? "";
  const forwardedOrigin = request.headers.get(WIDGET_ORIGIN_HEADER);

  const raw: unknown = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "Invalid broker decision request" }, { status: 400 });
  }

  // --- 1. THE SEALED CAPABILITY ------------------------------------------
  // Bounded before it is opened so an oversized header cannot be a decrypt
  // workload, and refused as `not-permitted` rather than 401: a caller holding a
  // valid session but no confirmation has not failed to authenticate, they have
  // failed to be authorized, and the two must not be told apart by anyone
  // probing with a bearer they already hold.
  if (presentedCapability.length === 0 || presentedCapability.length > ACTION_CAPABILITY_MAX_LENGTH) {
    return refuse();
  }
  const capability = verifyActionCapability(presentedCapability, {
    audience: ACTION_CAPABILITY_DECIDE_ROUTE_PATH,
    purpose: ACTION_CAPABILITY_PURPOSE_DECIDE,
  });
  if (!capability) return refuse();

  // --- 2. THE LIVE WIDGET SESSION ----------------------------------------
  const binding = resolveAssistantWidgetBinding(parsed.data.assistant.trim().toLowerCase());
  if (!binding || presentedToken.length === 0) return unauthorized();

  const resolved = await resolveWidgetLifecycleActorContext({
    token: presentedToken,
    agentSlug: binding.agentSlug,
    requestOrigin: forwardedOrigin,
    grant: WIDGET_LIFECYCLE_DECIDE_GRANT,
  });
  if (!resolved.ok) return unauthorized();
  const { actorCtx, claims } = resolved;

  // --- 3. THE BINDING ----------------------------------------------------
  // Every axis, compared for equality against the live session. This is what
  // makes the capability un-portable: it cannot be spent by another person, in
  // another org, from another site or CMS client, against another canonical
  // instance, under another widget agent, or inside a DIFFERENT widget session
  // of the same person.
  if (
    capability.userId !== claims.userId ||
    capability.orgId !== claims.orgId ||
    capability.jti !== claims.jti ||
    capability.siteId !== claims.siteId ||
    capability.client !== claims.client ||
    capability.instanceId !== claims.instanceId ||
    capability.agentSlug !== claims.agentSlug
  ) {
    return refuse();
  }

  // --- 4. THE BODY -------------------------------------------------------
  const comment = parsed.data.comment ?? null;
  const presentedDigest = decisionPayloadDigest({
    disposition: capability.disposition,
    comment,
  });
  if (presentedDigest !== capability.decisionDigest) return refuse();

  // --- 5. THE BURN -------------------------------------------------------
  // Single-use, arbitrated by the database. The row's stored binding must also
  // agree with the sealed one: the seal is authenticated, so this cannot catch a
  // forgery the AEAD missed, but it does catch a row and a capability that are
  // not the same fact — the shape a key-reuse or a store-level mix-up would take.
  const burned = await consumeActionCapability(capability.capabilityId);
  if (!burned) return refuse();
  if (
    actionCapabilityBindingDigest(actionCapabilityRowBinding(burned)) !==
      actionCapabilityBindingDigest(capability) ||
    burned.capabilityId !== capability.capabilityId
  ) {
    return refuse();
  }

  // --- 6. RUN READ -------------------------------------------------------
  // Before the decision op, against the SAME actor context the decision-op check
  // inside the helper will use. Resolving twice would let the two authorization
  // decisions be taken against two separate reads of this actor's standing.
  const read = await enforceReviewRunAccess(
    capability.runId,
    actorCtx.actor,
    "read",
    actorCtx.roleHints,
  ).catch(() => ({ ok: false }) as const);
  if (!read.ok) return refuse();

  // --- 7. THE GATE -------------------------------------------------------
  // The pinned representation revisions must still be the ones the confirmation
  // was about. A SETTLED gate still has its immutable pinned set, so this passes
  // for a response-lost retry and the decision core gets to answer idempotent-
  // success or conflict — which is exactly the S6b semantics this path must
  // inherit rather than pre-empt.
  const pinnedTargets = await readReviewGatePinnedTargets(
    capability.runId,
    capability.reviewTaskId,
  ).catch(() => null);
  if (!pinnedTargets) return refuse();
  if (pinnedTargetsDigest(pinnedTargets) !== capability.targetsDigest) return refuse();

  // --- THE ONE DECISION MODULE -------------------------------------------
  const outcome = await submitReviewDecisionAction(
    capability.runId,
    capability.reviewTaskId,
    capability.disposition,
    comment,
    actorCtx,
    // NO suggestion partition on the widget path in this slice (see the schema
    // note above). Passed explicitly rather than omitted so the absence is a
    // decision a reader can see, not a forgotten argument.
    null,
  );

  return Response.json({ outcome }, { headers: NO_STORE });
}
