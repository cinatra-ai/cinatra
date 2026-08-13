import "server-only";

import { requireAuthSession, resolveOrgRoleForSession } from "@/lib/auth-session";
import { actorFromSession } from "@/lib/authz/build-actor-context";
import { recentUndoableChangeSetFor } from "@/lib/chat/undo-candidate-surface";
import {
  authenticateWidgetConversationRequest,
  isWidgetBranchRequest,
} from "@/lib/widget-conversation-door";
import { WIDGET_UNDO_CANDIDATE_GRANT } from "@/lib/widget-conversation-grants";

// ---------------------------------------------------------------------------
// GET /api/chat/undo-candidate?runId=… — "did this run leave a change set I am
// still allowed to undo?" (cinatra#2683, epic #2564 S8f.)
//
// The chip's read, reachable with EITHER credential. `/chat` keeps its server
// action; the widget presents its `cwu_` here. Both answer through
// `@/lib/chat/undo-candidate-surface`, which runs the ONE §VI per-object
// eligibility gate — no administrator bypass, on either surface.
//
// THE ANSWER IS A CHANGE-SET ID OR NOTHING, and the two are indistinguishable by
// design: an ineligible reader and a run that changed nothing both get
// `{ changeSetId: null }`. That is what keeps the chip from being an existence
// oracle for change-sets the reader may not touch.
//
// THIS ROUTE CANNOT UNDO ANYTHING. It reads. The restore itself lives on the
// first-party surface the chip deep-links to, and runs its own per-event
// authorization on open and on confirm — under the reader's own session, in a
// new tab, because a sandboxed widget frame cannot become an app page.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The empty answer. Byte-identical for "nothing to undo" and "not yours". */
const NO_CANDIDATE = { changeSetId: null } as const;

const noStore = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request): Promise<Response> {
  const runId = new URL(request.url).searchParams.get("runId")?.trim() ?? "";

  if (isWidgetBranchRequest(request)) {
    const authed = await authenticateWidgetConversationRequest(
      request,
      WIDGET_UNDO_CANDIDATE_GRANT,
    );
    // No session fallback behind a failed widget consume — this route is
    // same-origin to the embed frame, which is exactly where an ambient cookie
    // would answer as somebody else.
    if (!authed) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!runId) return Response.json(NO_CANDIDATE, { headers: noStore });
    const found = await recentUndoableChangeSetFor({
      runId,
      // The org the TOKEN is bound to — never a session's active org, which a
      // widget request has no business reading.
      orgId: authed.claims.orgId,
      actor: authed.actorCtx.actor,
      roleHints: authed.actorCtx.roleHints,
    });
    return Response.json(found ?? NO_CANDIDATE, { headers: noStore });
  }

  const session = await requireAuthSession().catch(() => null);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId || !runId) return Response.json(NO_CANDIDATE, { headers: noStore });
  const orgRole = await resolveOrgRoleForSession(session);
  const found = await recentUndoableChangeSetFor({
    runId,
    orgId,
    actor: actorFromSession(session),
    roleHints: orgRole ? { orgRole } : undefined,
  });
  return Response.json(found ?? NO_CANDIDATE, { headers: noStore });
}
