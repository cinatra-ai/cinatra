import "server-only";
import {
  handleGetAssistantThreadById,
  handleGetAssistantThreadByIdForWidget,
} from "@/lib/assistant-thread-http";
import {
  authenticateWidgetConversationRequest,
  isWidgetBranchRequest,
} from "@/lib/widget-conversation-door";
import { WIDGET_THREAD_HISTORY_GRANT } from "@/lib/widget-conversation-grants";

// GET /api/assistants/threads/[threadId] — tenant-scoped single-thread read.
//
// First-class structured-thread persistence on the assistants surface
// (cinatra#1218). Same authz/session semantics as the legacy
// GET /api/chat/thread/[threadId] subroute (deleted in the #1218 delete stage
// — this route is its sole replacement). The legacy-content read decision is
// deferred behind resolveThreadReadPayload() — see @/lib/assistant-thread-http.
//
// TWO AUTH BRANCHES (cinatra#2683, epic #2564 S8f opened the second), on the
// pattern `/api/lifecycle-views/resolve` established:
//
//   · COOKIE SESSION — the first-party surfaces, unchanged.
//   · BROKER `cwu_` — the site widget, restoring its own transcript after the
//     frame reloads. Its actor is the S8a FULL actor, consumed at THIS route's
//     audience with `conversation.read` required; the per-row ownership matrix
//     behind it is the same one, run with the widget principal.
//
// THE BRANCH IS DECIDED BY THE PRESENTED CREDENTIAL AND NEVER FALLS BACK: this
// route is same-origin to the embed frame, so a failed widget consume must 401
// rather than drop to whatever Cinatra cookie that browser happens to hold —
// which would hand the frame somebody else's conversation.
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  if (isWidgetBranchRequest(request)) {
    const authed = await authenticateWidgetConversationRequest(
      request,
      WIDGET_THREAD_HISTORY_GRANT,
    );
    if (!authed) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return handleGetAssistantThreadByIdForWidget(threadId, {
      userId: authed.claims.userId,
      // The org the TOKEN is bound to — the wall the handler adds on top of the
      // shared ownership matrix. Never a session's active org.
      orgId: authed.claims.orgId,
    });
  }
  return handleGetAssistantThreadById(threadId);
}
