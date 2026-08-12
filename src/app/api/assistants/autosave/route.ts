import "server-only";
import {
  handleGetChatCaptureConfig,
  handlePatchChatCaptureConfig,
} from "@/lib/assistant-chat-capture-http";
import {
  authenticateWidgetConversationRequest,
  isWidgetBranchRequest,
} from "@/lib/widget-conversation-door";
import {
  WIDGET_CHAT_SETTINGS_READ_GRANT,
  WIDGET_CHAT_SETTINGS_WRITE_GRANT,
} from "@/lib/widget-conversation-grants";
import type { WidgetTokenGrant } from "@/lib/lifecycle/widget-lifecycle-actor";

// GET   /api/assistants/autosave — read the chat-capture ("autosave") config.
// PATCH /api/assistants/autosave — update the app-wide switch and/or the
//                                  caller's own chat-capture preference.
//
// First-class chat-capture config on the assistants surface (cinatra#1218).
// Same authz/audit/same-origin semantics as the legacy GET/PATCH
// /api/chat/autosave subroute (deleted in the #1218 delete stage — this route
// is its sole replacement). See @/lib/assistant-chat-capture-http.
//
// TWO AUTH BRANCHES (cinatra#2683, epic #2564 S8f opened the second). The
// widget's prompt-options flyout draws the SAME Skill-autosave row, writing the
// SAME account setting through the SAME handler and the SAME `can()` check — so
// a widget reader may change exactly what they may change in the app, and a
// non-platform actor is refused on both surfaces by one rule.
//
// ONE ROUTE, TWO OPERATIONS, TWO SCOPES. The audience admits the surface; the
// scope admits the verb. GET consumes under `conversation.read`, PATCH under
// `conversation.write`, so a session granted only the read cannot flip a setting.
//
// The branch is decided by the presented credential and never falls back.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The S8a full actor for a widget caller, in the kernel shape this handler's
 *  `can()` check consumes — or null, which the caller turns into a 401. */
async function brokeredActor(request: Request, grant: WidgetTokenGrant) {
  const authed = await authenticateWidgetConversationRequest(request, grant);
  return authed?.kernelActor ?? null;
}

const unauthorized = () =>
  new Response(JSON.stringify({ error: "Authentication required." }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

export async function GET(request: Request) {
  if (isWidgetBranchRequest(request)) {
    const actor = await brokeredActor(request, WIDGET_CHAT_SETTINGS_READ_GRANT);
    if (!actor) return unauthorized();
    return handleGetChatCaptureConfig(actor);
  }
  return handleGetChatCaptureConfig();
}

export async function PATCH(request: Request) {
  if (isWidgetBranchRequest(request)) {
    const actor = await brokeredActor(request, WIDGET_CHAT_SETTINGS_WRITE_GRANT);
    if (!actor) return unauthorized();
    return handlePatchChatCaptureConfig(request, actor);
  }
  return handlePatchChatCaptureConfig(request);
}
