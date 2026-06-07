import { readChatThreadsFromDatabase } from "@/lib/database";
import { getAuthSession } from "@/lib/auth-session";

type ThreadSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export async function GET() {
  const session = await getAuthSession();
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const threads = readChatThreadsFromDatabase();

  const result: ThreadSummary[] = threads
    .filter((t) => {
      const ownerUserId = t.ownerUserId as string | undefined;
      const teamId = t.teamId as string | undefined;
      // Legacy thread (no ownerUserId, no teamId) — always show
      if (!ownerUserId && !teamId) return true;
      // User's own thread
      if (ownerUserId === userId) return true;
      // Team threads belong in the team panel, not the thread list
      if (teamId) return false;
      return false;
    })
    .map((t) => ({
      id: t.id as string,
      title: t.title as string,
      createdAt: t.createdAt as string,
      updatedAt: t.updatedAt as string,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return Response.json(result);
}
