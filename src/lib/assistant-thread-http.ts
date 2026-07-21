import "server-only";

import { upsertChatThreadInDatabase } from "@/lib/database";
import {
  reconstructThreadPayload,
  listAssistantThreadIdsWithDurableContent,
  listAssistantThreadSummariesForOwnerInOrg,
  getAssistantThread,
} from "@/lib/assistant-thread-store";
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
 * or hijack another user's thread. Mirrors the deleted legacy POST
 * /api/chat/save exactly. */
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

/** GET /api/assistants/threads — the caller's own, ORG-SCOPED thread list.
 * Mirrors the deleted legacy GET /api/chat/threads. Team threads belong in the
 * team panel, not this list.
 *
 * ─── THE #134 LISTING CONTRACT (cinatra#1037 P5.6 PR2 CUTOVER) ───────────────
 * Owner ruling relayed on cinatra#1037 (2026-07-20, "#134" listing contract):
 * "The per-assistant conversation history list is bound to the access scope of
 * the assistant."
 * DURABLE per-assistant contract for #1873 W3: each thread list is scoped to the
 * AUDIENCE of the assistant whose history it is — the assistant's audience
 * binding (workspace / org / team / user) is the tenancy boundary of its list.
 *
 * INTERIM (this flat, single-built-in-assistant list): the built-in Cinatra
 * assistant is a WORKSPACE-audience assistant, so its audience is the acting
 * ORG. The list is therefore ORG-SCOPED to `activeOrganizationId` via the
 * structured mirror's `org_id` anchor (chat_threads has no org column). When
 * #1873 W3 lands per-assistant audiences, replace the org-scope here with the
 * acting assistant's resolved audience predicate — the seam is this function.
 *
 * OWNERLESS QUARANTINE: legacy rows with NO owner and NO team predate per-thread
 * ownership and carry no tenancy anchor; they were previously shown to EVERY
 * caller cross-org (codex: a latent tenant leak). They are now ADMIN-QUARANTINED
 * — visible only to a platform admin, never to a regular member.
 */
export async function handleListAssistantThreads(): Promise<Response> {
  const session = await getAuthSession();
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const isAdmin = isPlatformAdmin(session);
  const activeOrgId = session.session?.activeOrganizationId ?? null;

  // PR2 CUTOVER (cinatra#1037 P5.6): served ENTIRELY from the structured store —
  // ZERO chat_threads reads. The durable-content gate, the #134 org+owner
  // scoping, the ownerless-quarantine and the team exclusion are all resolved
  // against the structured mirror.
  let result: ThreadSummary[];
  if (isAdmin) {
    // Platform admin bypasses the org scope AND additionally sees the
    // ownerless-quarantined legacy rows; team threads still live in the team
    // panel. Enumerate the durable-content threads and resolve the ownership
    // axes from the structured mirror row.
    const admin: ThreadSummary[] = [];
    for (const id of listAssistantThreadIdsWithDurableContent()) {
      const t = getAssistantThread(id);
      if (!t) continue;
      const isOwn = !!t.ownerUserId && t.ownerUserId === userId;
      const isOwnerless = !t.ownerUserId && !t.teamId;
      if (!isOwn && !isOwnerless) continue; // another user's or a team thread — excluded
      admin.push({ id: t.id, title: t.title ?? "", createdAt: t.createdAt, updatedAt: t.updatedAt });
    }
    result = admin;
  } else if (activeOrgId) {
    // Non-admin: the caller's own durable-content threads anchored to the acting
    // org (team + ownerless + cross-org rows are excluded by the store op's
    // owner+org predicate + durable-content EXISTS gate).
    result = listAssistantThreadSummariesForOwnerInOrg(activeOrgId, userId).map((t) => ({
      id: t.id,
      title: t.title ?? "",
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));
  } else {
    // No active org — fail-closed to an empty list.
    result = [];
  }

  // Sidebar ordering PINNED createdAt DESC (cinatra#1037 PR2 hardening) — the
  // legacy sidebar sorts by creation, never updated_at (that would be drift).
  result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return Response.json(result);
}

// ---------------------------------------------------------------------------
// READ-SOURCE SEAM — PR2 CUTOVER (cinatra#1037 P5.6 drop-history).
//
// The structured store is now the AUTHORITATIVE read AND write source: the
// payload is reconstructed from `assistant_threads` + the durable
// `assistant_turns.content` + `assistant_thread_pause_state`
// (reconstructThreadPayload), NOT the legacy `chat_threads.payload`. The final
// teardown DROPPED the legacy chat_threads INSERT (the structured mirror is the
// SOLE writer) and ARMED the DB fence (any stray chat_threads INSERT/UPDATE
// fail-closes), so the reconstruction is faithful for every post-cutover thread.
//
// PRE-CUTOVER EXCLUSION: a thread with no durable turn content (a content-less
// mirror shadow minted before PR1 EXPAND, or an empty thread) reconstructs to
// null and is treated as NOT FOUND — the caller 404s, matching the list-path
// exclusion. `info` is unused now (access is already decided by the caller); the
// signature is retained so the caller is unchanged.
// ---------------------------------------------------------------------------
async function resolveThreadReadPayload(
  threadId: string,
  info: { ownerUserId: string | null; teamId: string | null },
): Promise<unknown> {
  void info;
  // null == absent-from-structured-store OR pre-cutover (content-less) → 404.
  return reconstructThreadPayload(threadId);
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

  // PR2 CUTOVER: reconstruct from the structured store. A pre-cutover thread
  // (no durable content) reconstructs to null → 404 (existence not disclosed,
  // same as a denied/missing read).
  const payload = await resolveThreadReadPayload(threadId, info);
  if (payload === null) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json(payload);
}
