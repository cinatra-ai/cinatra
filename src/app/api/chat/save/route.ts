import { upsertChatThreadInDatabase } from "@/lib/database";
import {
  isActorTeamMemberForChat,
  readChatThreadOwnershipById,
} from "@/lib/chat-thread-store";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";

export async function POST(request: Request) {
  const session = await getAuthSession();
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as { id: string } & Record<string, unknown>;
  if (!body?.id || typeof body.id !== "string") {
    return Response.json({ error: "Missing thread id" }, { status: 400 });
  }

  const callerId = session.user.id;
  const isAdmin = isPlatformAdmin(session);
  const orgId = session.session?.activeOrganizationId ?? null;

  // Tenant/owner authorization is derived from the EXISTING persisted row, never
  // from the request body — otherwise a caller could set an arbitrary
  // `ownerUserId`/`teamId` to overwrite another user's thread or spoof ownership.
  const existing = readChatThreadOwnershipById(body.id);

  // The ownership axes actually persisted: taken from the existing row on an
  // update, or claimed for the caller on a create.
  let ownerUserId: string | null;
  let teamId: string | null;

  if (existing) {
    // Owner identity takes precedence over teamId — the SAME order the read
    // path uses (evaluateChatThreadAccess), so a caller can never write a thread
    // they could not read.
    if (existing.ownerUserId) {
      // Personal thread — only the owner (or a platform admin) may overwrite it.
      if (existing.ownerUserId !== callerId && !isAdmin) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      ownerUserId = existing.ownerUserId;
      teamId = existing.teamId; // preserve the row's shape as-is
    } else if (existing.teamId) {
      // Team-owned thread — writable by a member of the team's owning org (or a
      // platform admin). Team ownership is preserved (never made personal).
      if (!isAdmin && !isActorTeamMemberForChat(existing.teamId, callerId)) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      ownerUserId = null;
      teamId = existing.teamId;
    } else {
      // Legacy unowned thread — stays unowned (public); a body owner is dropped.
      ownerUserId = null;
      teamId = null;
    }
  } else {
    // Create — the authenticated caller owns the new thread. A body-supplied
    // `teamId` is honored only when the caller is a member of that team's org.
    const requestedTeamId =
      typeof body.teamId === "string" ? body.teamId : null;
    if (requestedTeamId && isActorTeamMemberForChat(requestedTeamId, callerId)) {
      ownerUserId = null;
      teamId = requestedTeamId;
    } else {
      ownerUserId = callerId;
      teamId = null;
    }
  }

  // Persist with server-derived ownership axes overriding whatever the body
  // carried — any client-supplied `ownerUserId`/`teamId` is dropped first so it
  // can never spoof ownership. Pass the auth-derived orgId so
  // `upsertChatThreadInDatabase` syncs the artifact_refs pin table for any
  // attachments embedded in this thread's messages (without orgId the ref-sync
  // is skipped and pinned attachments would not be recorded).
  const thread: { id: string } & Record<string, unknown> = {
    ...body,
    id: body.id,
  };
  delete thread.ownerUserId;
  delete thread.teamId;
  if (ownerUserId) thread.ownerUserId = ownerUserId;
  if (teamId) thread.teamId = teamId;

  // `assistantMirrorOrgId` anchors the structured assistant_threads mirror row
  // (cinatra#1037 P2b) to the caller's auth-derived org — deliberately a
  // distinct option from the pin-sync `orgId` (see upsertChatThreadInDatabase).
  // Team-owned threads mirror with a NULL org regardless (resolved centrally
  // from the payload; team→org anchoring is decided at the #1216 S2 cutover).
  upsertChatThreadInDatabase(thread, { orgId, assistantMirrorOrgId: orgId });
  return Response.json({ ok: true });
}
