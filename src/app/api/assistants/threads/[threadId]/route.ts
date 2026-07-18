import "server-only";
import { handleGetAssistantThreadById } from "@/lib/assistant-thread-http";

// GET /api/assistants/threads/[threadId] — tenant-scoped single-thread read.
//
// First-class structured-thread persistence on the assistants surface
// (cinatra#1218). Same authz/session semantics as the legacy
// GET /api/chat/thread/[threadId] subroute (deleted in the #1218 delete stage
// — this route is its sole replacement). The legacy-content read decision is
// deferred behind resolveThreadReadPayload() — see @/lib/assistant-thread-http.
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  return handleGetAssistantThreadById(threadId);
}
