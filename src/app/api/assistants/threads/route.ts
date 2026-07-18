import "server-only";
import {
  handleListAssistantThreads,
  handleSaveAssistantThread,
} from "@/lib/assistant-thread-http";

// GET  /api/assistants/threads — the caller's own + legacy-unowned thread list.
// POST /api/assistants/threads — upsert (save) a chat thread.
//
// First-class structured-thread persistence on the assistants surface
// (cinatra#1218). Same authz/session semantics as the legacy
// GET /api/chat/threads + POST /api/chat/save subroutes (deleted in the #1218
// delete stage — this route is their sole replacement). See
// @/lib/assistant-thread-http.
export const dynamic = "force-dynamic";

export function GET() {
  return handleListAssistantThreads();
}

export function POST(request: Request) {
  return handleSaveAssistantThread(request);
}
