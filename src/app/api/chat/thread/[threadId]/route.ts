import { loadChatThreadForActorAccess } from "@/lib/chat-thread-store";
import { evaluateChatThreadAccess } from "@/lib/chat-thread-access";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ threadId: string }> }
) {
  const session = await getAuthSession();
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { threadId } = await params;
  const actorUserId = session.user.id;
  const admin = isPlatformAdmin(session);

  // Tenant-scoped read. The DB layer resolves the ownership axes (+ team-org
  // membership); the pure decision helper then allows the thread only for its
  // owner, a member of its owning team's organization, a platform admin, or a
  // legacy unowned thread. A missing row or a denial both surface as 404 so a
  // thread's existence is not disclosed across tenants.
  const info = loadChatThreadForActorAccess({ threadId, actorUserId, isPlatformAdmin: admin });
  const allowed =
    info !== null &&
    evaluateChatThreadAccess({
      ownerUserId: info.ownerUserId,
      teamId: info.teamId,
      actorUserId,
      isPlatformAdmin: admin,
      isActorTeamMember: info.isActorTeamMember,
    });

  if (!info || !allowed) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  return Response.json(info.payload);
}
