import "server-only";

import { z } from "zod";

import { LIFECYCLE_VIEW_REF_MAX_LENGTH } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { enforceReviewRunAccess } from "@cinatra-ai/agents/artifact-review-gate-store";
import { readReviewGatePinnedTargets } from "@/app/artifacts/[id]/review-gate-ports";
import { resolveAssistantWidgetBinding } from "@/lib/assistant-widget-handles";
import { decodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";
import { readArtifactForDetail } from "@/lib/artifacts/artifact-service";
import { buildActorContextFromPrimitive } from "@/lib/authz/build-actor-context";
import { reviewTypeLabel } from "@/lib/artifacts/review-surface-model";
import {
  ACTION_CAPABILITY_PURPOSE_DECIDE,
  ACTION_CAPABILITY_DECIDE_ROUTE_PATH,
  decisionPayloadDigest,
  isActionCapabilityDisposition,
  pinnedTargetsDigest,
  WIDGET_COMMENT_MAX_CHARS,
} from "@/lib/lifecycle/widget-action-capability";
import { requestActionCapability } from "@/lib/lifecycle/widget-action-capability-store";
import {
  WIDGET_LIFECYCLE_DECIDE_REQUEST_GRANT,
  resolveWidgetLifecycleActorContext,
} from "@/lib/lifecycle/widget-lifecycle-actor";
import {
  WIDGET_DECISION_CONFIRM_PATH,
  WIDGET_DECISION_REQUEST_QUERY_PARAM,
} from "@/lib/widget-lifecycle-scope";

// ---------------------------------------------------------------------------
// POST /api/lifecycle-views/action-capability — a widget session ASKS for a
// decision to be confirmed (cinatra#2575, epic #2564 S8b).
//
// THIS ENDPOINT AUTHORIZES NOTHING. It writes down what a confirmation would be
// about and hands back an opaque row id. Nothing here can change a gate, and the
// id it returns cannot be presented anywhere: the ONLY thing that consumes it is
// the hosted confirmation page, which requires the person's own Cinatra session
// on Cinatra's own origin, and the only thing that page produces is a sealed
// capability delivered to the window that opened it.
//
// SO WHY IS IT GUARDED AT ALL. Because the request DISCLOSES: it names a gate,
// it re-derives that gate's pinned representation revisions, and it fails
// differently for a gate that exists and one that does not unless every refusal
// is uniform. It is therefore held to the same bar as a lifecycle READ — the
// same actor, the same run-access check, the same single refusal — and it
// additionally requires the DECIDE grant, so a session consented before this
// slice existed cannot even ask.
//
// THE BINDING IS FIXED HERE, NOT AT CONFIRMATION TIME. Everything the sealed
// capability will carry is computed from SERVER state at this moment: the
// principal and site come from the token the verifier just validated, the gate
// comes from the server-minted ref, the representation revisions come from the
// live gate, and the decision digest is taken over the body as received. The
// confirmation page can then only say yes or no to what is already written down
// — it cannot widen, retarget or re-word it. That is what makes the sentence the
// person reads and the request that lands the same thing.
//
// A REFUSAL IS ONE ANSWER. A ref that does not decode, a gate the caller may not
// read, a gate with no pinned set, and a store that would not take the row are
// all the same `not-permitted` outcome at 200. Only a rejected credential (401,
// with the re-login marker the widget already understands) and a malformed body
// (400) are distinguishable, and neither depends on the gate.
// ---------------------------------------------------------------------------

/** The per-user `cwu_` bearer header (cinatra#408 — the dual-token identity). */
const USER_TOKEN_HEADER = "X-Cinatra-Widget-User-Token";
/** The embed's forwarded CMS parent origin (Lane A #1998 seam, chat-route note):
 * the browser cannot send it — the iframe is same-origin to Cinatra — and it is
 * validated INTRINSICALLY by the token consume, which is the authority. */
const WIDGET_ORIGIN_HEADER = "X-Cinatra-Widget-Origin";
/** Emitted on a fail-closed 401 so the widget can swap to the login window
 * rather than showing a generic error. */
const WIDGET_AUTH_REQUIRED_HEADER = "X-Cinatra-Widget-Auth";

const requestSchema = z
  .object({
    /** The widget assistant handle — the G9 handle↔token binding, closed set. */
    assistant: z.string().min(1).max(64),
    /** The SERVER-MINTED gate ref the card was drawn from. A client cannot mint
     * one and gains nothing by replaying one: every check runs from scratch. */
    ref: z.string().min(1).max(LIFECYCLE_VIEW_REF_MAX_LENGTH),
    disposition: z.enum(["approve", "reject", "comment"]),
    comment: z.string().max(WIDGET_COMMENT_MAX_CHARS).nullable().optional(),
    // NO per-item suggestion partition, and `.strict()` makes sending one a
    // 400 rather than dropping it silently. The
    // widget path deliberately carries no per-item suggestion partition in this
    // slice: a confirmation is worth only what its window can SHOW, and this
    // window cannot render suggestion labels (they live in the gate's pinned
    // snapshot, and the component that draws them is the card — S8d's, on the
    // widget). Accepting a partition here would authorize invisible per-item
    // choices on the strength of a click about something else. See
    // `decisionPayloadDigest`.
  })
  .strict();

/** How many pinned items the subject line names before it counts the rest. */
const SUBJECT_NAMED_ITEMS = 3;
/** Ceiling on the stored subject line. */
const SUBJECT_MAX_CHARS = 400;

/**
 * WHAT is under review, in the person's own words.
 *
 * Derived HERE rather than on the confirmation page, and from a read the caller
 * has already been authorized for: run READ has passed, and each artifact is
 * read through `readArtifactForDetail`, which enforces `object.read` for this
 * same actor. An artifact this actor may not read contributes its type, never
 * its title — the subject line is a confirmation aid, not a disclosure channel.
 *
 * It exists because a window that says "Approve this review" about a review it
 * cannot NAME is a window whose subject can be substituted: the site holds the
 * widget bearer, so it can ask for a capability on any gate the person may read
 * and then open this window itself. Naming the subject is what lets the person
 * see that the thing in front of them is not the thing they meant.
 */
function subjectLabelFor(
  targets: readonly { artifactId: string; representationRevisionId: string }[],
  ctx: ReviewActorContext,
): string {
  const kernelActor = buildActorContextFromPrimitive(ctx.actor, ctx.orgId, ctx.roleHints);
  const names: string[] = [];
  for (const target of targets.slice(0, SUBJECT_NAMED_ITEMS)) {
    let name = "An item";
    try {
      const access = readArtifactForDetail({
        artifactId: target.artifactId,
        orgId: ctx.orgId,
        actor: kernelActor,
      });
      if (access.kind === "ok") {
        // The TYPE rides alongside the title, never instead of it: two decoys
        // are easier to tell apart by "Blog post" vs "Email draft" than by two
        // titles somebody chose to make look alike.
        const type = reviewTypeLabel(access.artifact.objectType);
        const title = access.artifact.title?.trim();
        name = title ? `${title} (${type})` : type;
      }
    } catch {
      /* a read that failed names nothing — the generic word stands */
    }
    names.push(name);
  }
  const rest = targets.length - names.length;
  const listed = rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", ");
  // The COUNT is stated outright rather than left to be inferred from the list,
  // so a gate of one and a gate of four never read alike.
  const line =
    targets.length === 1 ? listed : `${targets.length} items: ${listed}`;
  return (line.trim() || "An item").slice(0, SUBJECT_MAX_CHARS);
}

/** The one refusal a caller ever sees for "not yours" / "not there". */
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
  const presented = request.headers.get(USER_TOKEN_HEADER)?.trim() ?? "";
  const forwardedOrigin = request.headers.get(WIDGET_ORIGIN_HEADER);

  const raw: unknown = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "Invalid action-capability request" }, { status: 400 });
  }

  // The handle resolves the CLOSED widget binding. An unknown or forged handle
  // (including the built-in "cinatra" assistant) has no widget agent to bind a
  // token to, so it fails exactly like a rejected credential — there is no gate
  // read on this path for it to probe.
  const binding = resolveAssistantWidgetBinding(parsed.data.assistant.trim().toLowerCase());
  const unauthorized = (): Response =>
    new Response("Unauthorized (widget login required)", {
      status: 401,
      headers: { ...NO_STORE, [WIDGET_AUTH_REQUIRED_HEADER]: "required" },
    });
  if (!binding || presented.length === 0) return unauthorized();

  // THE ONE DOOR (S8a). The token is consumed under the DECIDE-REQUEST grant —
  // its own audience, and BOTH the read and decide scopes — and the actor comes
  // back fully resolved, with the person's real teams and projects and their
  // platform standing floored. A token minted before this grant existed carries
  // neither the audience nor the scope and dies inside.
  const resolved = await resolveWidgetLifecycleActorContext({
    token: presented,
    agentSlug: binding.agentSlug,
    requestOrigin: forwardedOrigin,
    grant: WIDGET_LIFECYCLE_DECIDE_REQUEST_GRANT,
  });
  if (!resolved.ok) return unauthorized();
  const { actorCtx, claims } = resolved;

  const payload = decodeLifecycleGateRef(parsed.data.ref);
  if (!payload) return refuse();

  // RUN READ FIRST, before the gate is touched — the same order the first-party
  // gate-scoped entry uses, so gate existence is never side-channelled.
  const read = await enforceReviewRunAccess(
    payload.runId,
    actorCtx.actor,
    "read",
    actorCtx.roleHints,
  ).catch(() => ({ ok: false }) as const);
  if (!read.ok) return refuse();

  // The gate's PINNED set, read from the frozen gate. It is the representation
  // -revision binding the capability carries: the person confirms a decision on
  // the revisions that were pinned at this moment, and the broker endpoint
  // re-derives the digest from the live gate at redeem. A gate that no longer
  // has a pinned set has nothing to confirm.
  const pinnedTargets = await readReviewGatePinnedTargets(
    payload.runId,
    payload.reviewTaskId,
  ).catch(() => null);
  if (!pinnedTargets) return refuse();

  const disposition = parsed.data.disposition;
  if (!isActionCapabilityDisposition(disposition)) return refuse();

  const comment = parsed.data.comment ?? null;
  const capabilityId = await requestActionCapability({
    purpose: ACTION_CAPABILITY_PURPOSE_DECIDE,
    audience: ACTION_CAPABILITY_DECIDE_ROUTE_PATH,
    orgId: claims.orgId,
    userId: claims.userId,
    widgetJti: claims.jti,
    siteId: claims.siteId,
    client: claims.client,
    instanceId: claims.instanceId,
    agentSlug: claims.agentSlug,
    runId: payload.runId,
    reviewTaskId: payload.reviewTaskId,
    disposition,
    targetsDigest: pinnedTargetsDigest(pinnedTargets),
    decisionDigest: decisionPayloadDigest({ disposition, comment }),
    subjectLabel: subjectLabelFor(pinnedTargets, actorCtx),
    commentText: comment,
  });
  if (!capabilityId) return refuse();

  return Response.json(
    {
      outcome: { kind: "confirmation-required" as const },
      // The path, assembled server-side, so the widget never composes a Cinatra
      // URL out of parts it chose. It opens exactly what it is handed.
      confirmPath: `${WIDGET_DECISION_CONFIRM_PATH}?${WIDGET_DECISION_REQUEST_QUERY_PARAM}=${encodeURIComponent(capabilityId)}`,
    },
    { headers: NO_STORE },
  );
}
