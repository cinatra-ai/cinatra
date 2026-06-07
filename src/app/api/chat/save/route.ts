import { upsertChatThreadInDatabase } from "@/lib/database";
import { getAuthSession } from "@/lib/auth-session";

export async function POST(request: Request) {
  const session = await getAuthSession();
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const thread = await request.json() as { id: string } & Record<string, unknown>;
  if (!thread?.id || typeof thread.id !== "string") {
    return Response.json({ error: "Missing thread id" }, { status: 400 });
  }

  // Pass the auth-derived orgId so
  // `upsertChatThreadInDatabase` syncs the artifact_refs pin table
  // for any attachments embedded in this thread's messages. Without
  // orgId the ref-sync is skipped, pinned attachments would not be
  // recorded, and tombstone cleanup could immediately garbage-collect
  // them.
  const orgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;
  upsertChatThreadInDatabase(thread, { orgId });
  return Response.json({ ok: true });
}
