import { readChatThreadsFromDatabase } from "@/lib/database";
import { getAuthSession } from "@/lib/auth-session";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const session = await getAuthSession();
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { threadId } = await params;
  const threads = readChatThreadsFromDatabase();
  const thread = threads.find((t) => t.id === threadId) ?? null;

  return Response.json(thread);
}
