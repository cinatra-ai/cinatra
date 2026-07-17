import "server-only";

import { upsertChatThreadInDatabase, readChatThreadsFromDatabase } from "@/lib/database";
import {
  isActorTeamMemberForChat,
  readChatThreadOwnershipById,
  loadChatThreadForActorAccess,
} from "@/lib/chat-thread-store";
import { evaluateChatThreadAccess } from "@/lib/chat-thread-access";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";

// ---------------------------------------------------------------------------
// First-class structured-thread persistence handlers on the ASSISTANTS surface
// (cinatra#1218, epic #1216 S2 — predecessor 1 of the bespoke-wire delete
// stage). These back GET/POST /api/assistants/threads and
// GET /api/assistants/threads/[threadId].
//
// WHY A NEW SURFACE, LEGACY LEFT INTACT. The AG-UI /chat client still persists
// every thread through the LEGACY /api/chat/{save,threads,thread/:id}
// subroutes, which are delete targets. Those cannot be removed while the kept
// AG-UI path calls them, so this module reproduces their authz/session
// semantics VERBATIM on the assistants surface; the client migrates onto these
// handlers and the legacy subroutes are then deletable (a later stage — they
// stay in place, untouched, until then). The authorization primitives are the
// SAME lib helpers the legacy routes import, so the ownership/tenant matrix is
// byte-identical (personal → owner-or-admin; team → member-of-owning-org-or-
// admin; legacy unowned → public; missing/denied read → 404, existence not
// disclosed across tenants).
// ---------------------------------------------------------------------------

type ThreadSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

/** POST /api/assistants/threads — upsert (save) a chat thread.
 *
 * Ownership axes are derived from the EXISTING persisted row (never from the
 * request body) so a caller can never spoof `ownerUserId`/`teamId` to overwrite
 * or hijack another user's thread. Mirrors POST /api/chat/save exactly. */
export async function handleSaveAssistantThread(request: Request): Promise<Response> {
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

  // Authorization derives from the existing row, never the body — same order
  // the read path (evaluateChatThreadAccess) uses, so a caller can never write
  // a thread they could not read.
  const existing = readChatThreadOwnershipById(body.id);

  let ownerUserId: string | null;
  let teamId: string | null;

  if (existing) {
    if (existing.ownerUserId) {
      // Personal thread — only the owner (or a platform admin) may overwrite it.
      if (existing.ownerUserId !== callerId && !isAdmin) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      ownerUserId = existing.ownerUserId;
      teamId = existing.teamId;
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
    // teamId is honored only when the caller is a member of that team's org.
    const requestedTeamId = typeof body.teamId === "string" ? body.teamId : null;
    if (requestedTeamId && isActorTeamMemberForChat(requestedTeamId, callerId)) {
      ownerUserId = null;
      teamId = requestedTeamId;
    } else {
      ownerUserId = callerId;
      teamId = null;
    }
  }

  // Persist with server-derived ownership axes overriding the body — any
  // client-supplied ownerUserId/teamId is dropped first so it can never spoof.
  const thread: { id: string } & Record<string, unknown> = { ...body, id: body.id };
  delete thread.ownerUserId;
  delete thread.teamId;
  if (ownerUserId) thread.ownerUserId = ownerUserId;
  if (teamId) thread.teamId = teamId;

  // assistantMirrorOrgId anchors the structured assistant_threads mirror row
  // (cinatra#1037 P2b) to the caller's auth-derived org — distinct from the
  // pin-sync orgId. Team-owned threads mirror with a NULL org regardless (the
  // team→org anchoring decision is flagged on #1218, set-once/repairable).
  upsertChatThreadInDatabase(thread, { orgId, assistantMirrorOrgId: orgId });
  return Response.json({ ok: true });
}

/** GET /api/assistants/threads — the caller's own + legacy-unowned thread list.
 * Mirrors GET /api/chat/threads. Team threads belong in the team panel, not
 * this list. */
export async function handleListAssistantThreads(): Promise<Response> {
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
      if (!ownerUserId && !teamId) return true; // legacy unowned — always show
      if (ownerUserId === userId) return true; // user's own thread
      if (teamId) return false; // team threads live in the team panel
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

// ---------------------------------------------------------------------------
// READ-SOURCE SEAM (cinatra#1218 delete stage, Residual-3 — owner-routed).
//
// The historical legacy-content read decision — read-shim over the legacy
// thread payload vs a structured assistant_turns content migration — is
// deliberately NOT taken here (routed to the owner). This route reads the SAME
// legacy payload store the legacy GET /api/chat/thread/[id] reads, so NEW
// threads (written through handleSaveAssistantThread) and pre-cutover threads
// both resolve identically today — compatible with EITHER future ruling. When
// the ruling lands, ONLY this resolver body changes: a read-shim keeps it as
// the identity over the legacy payload; a migration swaps it to reconstruct
// content from the structured assistant_turns keyed by run_id. No CALLER and no
// SIGNATURE changes either way — the seam already receives the trusted,
// authorized `threadId` (the only key a structured reconstruction needs) and is
// async so an event-log read can be awaited in place. The `info` also carries
// the resolved ownership axes should a migration path need them.
// ---------------------------------------------------------------------------
async function resolveThreadReadPayload(
  threadId: string,
  info: { payload: unknown; ownerUserId: string | null; teamId: string | null },
): Promise<unknown> {
  // read-shim (current ruling-agnostic default): the legacy payload as-is. The
  // trusted `threadId` is intentionally unused today — it is the seam contract
  // a future content-migration reconstruction keys on (reads assistant_turns by
  // run_id), so wiring it now keeps the ruling a one-function change.
  void threadId;
  return info.payload;
}

/** GET /api/assistants/threads/[threadId] — tenant-scoped single-thread read.
 * Mirrors GET /api/chat/thread/[threadId]: a missing row or a denial both
 * surface as 404 so a thread's existence is not disclosed across tenants. */
export async function handleGetAssistantThreadById(threadId: string): Promise<Response> {
  const session = await getAuthSession();
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const actorUserId = session.user.id;
  const admin = isPlatformAdmin(session);

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

  return Response.json(await resolveThreadReadPayload(threadId, info));
}
