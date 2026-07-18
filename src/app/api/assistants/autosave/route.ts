import "server-only";
import {
  handleGetChatCaptureConfig,
  handlePatchChatCaptureConfig,
} from "@/lib/assistant-chat-capture-http";

// GET   /api/assistants/autosave — read the chat-capture ("autosave") config.
// PATCH /api/assistants/autosave — update the app-wide switch and/or the
//                                  caller's own chat-capture preference.
//
// First-class chat-capture config on the assistants surface (cinatra#1218).
// Same authz/audit/same-origin semantics as the legacy GET/PATCH
// /api/chat/autosave subroute (deleted in the #1218 delete stage — this route
// is its sole replacement). See @/lib/assistant-chat-capture-http.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return handleGetChatCaptureConfig();
}

export function PATCH(request: Request) {
  return handlePatchChatCaptureConfig(request);
}
