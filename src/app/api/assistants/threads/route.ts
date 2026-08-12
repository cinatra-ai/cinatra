import "server-only";
import {
  handleListAssistantThreads,
  handleSaveAssistantThread,
  handleSaveAssistantThreadForWidget,
} from "@/lib/assistant-thread-http";
import {
  authenticateWidgetConversationRequest,
  isWidgetBranchRequest,
} from "@/lib/widget-conversation-door";
import { WIDGET_THREAD_WRITE_GRANT } from "@/lib/widget-conversation-grants";

// GET  /api/assistants/threads — the caller's own + legacy-unowned thread list.
// POST /api/assistants/threads — upsert (save) a chat thread.
//
// First-class structured-thread persistence on the assistants surface
// (cinatra#1218). Same authz/session semantics as the legacy
// GET /api/chat/threads + POST /api/chat/save subroutes (deleted in the #1218
// delete stage — this route is their sole replacement). See
// @/lib/assistant-thread-http.
//
// POST HAS TWO AUTH BRANCHES (cinatra#2683, epic #2564 S8f item 1, WRITE HALF),
// on the pattern `/api/lifecycle-views/resolve` established and the sibling
// `[threadId]` read already follows:
//
//   · COOKIE SESSION — the first-party surfaces, unchanged.
//   · BROKER `cwu_` — the site widget, KEEPING the conversation the sibling read
//     restores. Its actor is the S8a FULL actor, consumed at THIS route's
//     audience under `conversation.write` — the read half consumes the same
//     audience under `conversation.read`, so a session granted only the read can
//     restore a transcript and cannot append to one.
//
// THE BRANCH IS DECIDED BY THE PRESENTED CREDENTIAL AND NEVER FALLS BACK: this
// route is same-origin to the embed frame, so a failed widget consume must 401
// rather than drop to whatever Cinatra cookie that browser happens to hold —
// which would write the widget's turns into somebody else's conversation.
//
// GET (the thread LIST) has NO widget branch and keeps its cookie-only handler.
// A list is an enumeration of everything this person has ever discussed with the
// assistant, across every surface; the widget needs the ONE thread it is showing,
// which the `[threadId]` read already answers. Not opened because it was not
// needed is the narrowing direction — the middleware entry admits the path, and
// this handler is what keeps the list closed.
export const dynamic = "force-dynamic";

export function GET() {
  return handleListAssistantThreads();
}

export async function POST(request: Request) {
  if (isWidgetBranchRequest(request)) {
    const authed = await authenticateWidgetConversationRequest(
      request,
      WIDGET_THREAD_WRITE_GRANT,
    );
    if (!authed) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return handleSaveAssistantThreadForWidget(request, {
      userId: authed.claims.userId,
      // The org the TOKEN is bound to — the wall the handler adds on top of the
      // ownership check, and the anchor a thread it creates is written with.
      // Never a session's active org.
      orgId: authed.claims.orgId,
    });
  }
  return handleSaveAssistantThread(request);
}
