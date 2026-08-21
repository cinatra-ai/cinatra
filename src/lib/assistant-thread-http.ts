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
  // `actorUserId` is the SESSION's user, never the body — the truncation
  // tombstone authorizes against it and would hand back its whole self-harm
  // boundary to a spoofable field. On a team or legacy-unowned thread this
  // caller is one writer among several, and the tombstone refuses itself there.
  upsertChatThreadInDatabase(thread, {
    orgId,
    assistantMirrorOrgId: orgId,
    actorUserId: callerId,
  });
  return Response.json({ ok: true });
}

/**
 * POST /api/assistants/threads — the SAME upsert, for a WIDGET principal
 * (cinatra#2683, epic #2564 S8f item 1, WRITE HALF).
 *
 * WHY IT EXISTS. The read half restored a widget's transcript after a reload —
 * and restored nothing, because nothing had ever been written. A widget turn
 * streams, renders, and then the frame reloads and the conversation is gone: the
 * turn's own durable rows are the RUN's rows (`run_id` set), and the payload
 * reconstruction reads only the legacy-mirror rows (`id LIKE 'legacy:%' AND
 * run_id IS NULL`) that this upsert writes. `/chat` writes them on every turn
 * through its cookie-bound writer; the widget could not, because the embed frame
 * is same-origin to the Cinatra app and a cookie request from it is answered as
 * whoever else is signed in on that browser. So the reader's own conversation was
 * the last thing the widget could show but not keep.
 *
 * ONE PAYLOAD CONTRACT, ONE PERSISTENCE CALL. The body is the same object
 * `/chat` posts and the persistence is the same `upsertChatThreadInDatabase` with
 * the same mirror anchoring, so the rows this produces are the rows the
 * reconstruction already knows how to assemble. Nothing about the read changed to
 * accommodate the writer — which is the point: the read is proven, and this makes
 * it have something to answer with.
 *
 * WHAT IS NARROWER THAN THE FIRST-PARTY WRITER, and deliberately:
 *
 *   · PLATFORM STANDING IS FLOORED. There is no admin branch at all. A platform
 *     admin writing through a widget writes as a member — the same floor every
 *     other widget path imposes, and the floor can only narrow.
 *   · THE TOKEN'S ORG IS A HARD WALL, and it is EXTRA. A `cwu_` is minted for ONE
 *     org and cannot leave it, so a thread anchored in another org is refused
 *     even when its owner is this very person. Mirrors the read exactly.
 *   · ONLY THE CALLER'S OWN PERSONAL THREAD. A team-owned thread mirrors with a
 *     NULL org anchor by policy and is therefore not READABLE through a widget;
 *     it is not writable either. A legacy UNOWNED thread is public to read, so
 *     letting a widget append to one would let a site-embedded surface put text
 *     into a conversation anybody can read. Both are refused rather than
 *     inherited — the narrowing direction, stated rather than discovered.
 *   · IT CANNOT CREATE A THREAD (codex round 0, MEDIUM 2). An id with no row is
 *     refused, exactly like an id with somebody else's row — which is what makes
 *     the refusals INDISTINGUISHABLE. The first draft created on an absent row,
 *     and that made the endpoint a clean existence oracle: POST a guessed id,
 *     read 404 for "taken by someone else" and 200 for "free, and now yours".
 *     Nothing is lost by refusing, because the TURN already created the row —
 *     `streamAgUiChatTurn` binds the structured row before the first token, with
 *     this same principal and this same org — so by the time there is a
 *     transcript to keep, there is a row to keep it on. A conversation is
 *     started by talking, never by saving.
 *   · THE BODY IS AN ALLOW-LIST, not a strip-list (codex round 0, LOW). Only the
 *     six transcript fields are forwarded. A deny-list left every OTHER
 *     server-decided column the mirror reads — `projectId`, `contextId`,
 *     `instanceId`, `assistantPackage`, `titleSlug` — writable from a public
 *     website, and each new column would have silently joined them.
 *   · A REFUSAL IS A 404, not a 403. The first-party writer answers 403 because
 *     its caller already proved they hold a session in this tenant. This caller
 *     did not, so distinguishing "exists but not yours" from "does not exist"
 *     would make the endpoint an oracle for other people's thread ids — exactly
 *     what the widget READ refuses to be. One answer for every refusal.
 *
 * NO AMBIENT FALLBACK: the route decides the branch from the presented
 * credential, and a failed consume 401s at the door rather than dropping to a
 * cookie. This function never reads a session at all — it cannot, there is no
 * `getAuthSession()` in it, which is the property the guard test pins.
 *
 * THE RESIDUALS, STATED.
 *
 *   · THE READ AND THE WRITE ARE TWO ROUND TRIPS (codex round 0, HIGH; round 1
 *     confirmed it as narrowed rather than closed). What the gap can still carry
 *     is ONE case and it is remote: the row this caller owns is DELETED and a
 *     different principal recreates the same thread id in the window between
 *     them. It cannot carry the case codex first constructed — a row appearing
 *     where there was none — because an absent row is refused rather than
 *     created, and it cannot carry an ownership change, because `owner_user_id`
 *     and the mirror's `org_id` anchor are SET-ONCE on an existing row. Closing
 *     it properly means one atomic authorize-and-write, which is a change to the
 *     SHARED upsert both surfaces use; it is not smuggled in behind a widget.
 *   · A TURN THAT NEVER REACHED THE SERVER LEAVES NOTHING TO KEEP (codex round
 *     1). The row is bound by the turn, so a turn that failed before it was
 *     accepted — no provider, an unreachable app, an immediate abort — has no
 *     row, and this refuses the save with the same 404. On screen the reader
 *     still sees their message and the error; after a reload, neither is there.
 *     That is the honest reading of "a conversation is started by talking": if
 *     the talking never arrived, there is no conversation to restore. It is
 *     stated rather than papered over with a create path, because the create
 *     path is exactly what made this endpoint an existence oracle.
 */
export async function handleSaveAssistantThreadForWidget(
  request: Request,
  principal: { userId: string; orgId: string },
): Promise<Response> {
  if (!principal.userId || !principal.orgId) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  let body: ({ id?: unknown } & Record<string, unknown>) | null = null;
  try {
    body = (await request.json()) as { id?: unknown } & Record<string, unknown>;
  } catch {
    return Response.json({ error: "Missing thread id" }, { status: 400 });
  }
  const threadId = typeof body?.id === "string" ? body.id : "";
  if (!threadId) {
    return Response.json({ error: "Missing thread id" }, { status: 400 });
  }

  // The EXISTING row decides, never the body — the same order the first-party
  // writer and the read path use, so a caller can never write a thread they
  // could not read. ALL FOUR refusals below answer identically.
  const anchored = getAssistantThread(threadId);
  const writable =
    anchored !== null &&
    // The org wall: a `cwu_` is minted for ONE org and cannot leave it.
    anchored.orgId === principal.orgId &&
    // Personal AND this caller's. An ownerless row is the legacy-unowned shape
    // (public to read); a row carrying a team is team-owned even when an owner
    // axis is also set, and neither is a widget's to write.
    anchored.teamId === null &&
    anchored.ownerUserId === principal.userId;
  if (!writable) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // OMISSION IS A MUTATION HERE, so the fields this caller does not own are
  // CARRIED FORWARD rather than left out (codex round 1). The mirror upsert
  // writes `project_id` and `scalars` WHOLESALE from the payload — they are
  // projections, not set-once axes — so a body that simply omitted them would
  // NULL the thread's project and erase its `/chat` render state (the tagged
  // assistants, the Slack mode) on every widget turn. The values come from the
  // PERSISTED row, never from the request: the caller cannot set them and
  // cannot clear them.
  const persisted = reconstructThreadPayload(threadId);
  const carried: Record<string, unknown> = {};
  if (anchored.projectId) carried.projectId = anchored.projectId;
  if (Array.isArray(persisted?.taggedAssistantUserIds)) {
    carried.taggedAssistantUserIds = persisted.taggedAssistantUserIds;
  }
  if (typeof persisted?.slackMode === "boolean") carried.slackMode = persisted.slackMode;

  // THE ALLOW-LIST. Everything the mirror reads and this caller does not decide
  // is simply not carried: ownership, org anchoring and container scope are the
  // server's, and a field that is never forwarded cannot be spoofed by a body
  // that names it.
  const thread: { id: string } & Record<string, unknown> = {
    ...carried,
    id: threadId,
    ownerUserId: principal.userId,
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(Array.isArray(body.messages) ? { messages: body.messages } : {}),
    ...(typeof body.createdAt === "string" ? { createdAt: body.createdAt } : {}),
    ...(typeof body.updatedAt === "string" ? { updatedAt: body.updatedAt } : {}),
    ...(typeof body.activeAssistantHandle === "string"
      ? { activeAssistantHandle: body.activeAssistantHandle }
      : {}),
    // THE TRUNCATION INTENT (cinatra#2823 S9j). Forwarded, because this surface
    // really does truncate: the shared column's `onEditAndResend` rewrites a
    // message and drops every successor, and the save that follows carries the
    // truncated transcript. Without the assertion the reconcile DELETE takes the
    // removed turns' mirror rows while their run-bound rows — minted when each
    // run started — survive, and the reload folds them back in above the edited
    // prompt. A widget reader's edit would come undone on every reload.
    //
    // ADDING IT TO THE ALLOW-LIST IS SAFE BECAUSE THE TOMBSTONE AUTHORIZES
    // ITSELF, and this route cannot widen that. The statement reaches a
    // run-bound row only on a thread the acting writer PERSONALLY OWNS
    // (`buildSupersedeRunBoundTurnsQuery`), checked against the thread row
    // inside the write's own transaction — and the `writable` gate above has
    // ALREADY proved exactly that for this principal, so the predicate re-states
    // what was authorized rather than trusting this body. What the body decides
    // is only WHICH of the caller's own turns to drop, which is the one thing
    // the caller is entitled to decide about their own thread.
    //
    // SHAPE-VALIDATED HERE, not just downstream. `extractRemovedMessageIdsFromThread`
    // is defensive and would drop the garbage anyway; validating at the edge
    // keeps a public-website body from reaching the mirror builder as a shape it
    // has to be defensive ABOUT. A non-array is no assertion at all, so it is
    // omitted rather than passed through empty.
    ...(Array.isArray(body.removedMessageIds)
      ? {
          removedMessageIds: body.removedMessageIds.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
        }
      : {}),
  };

  // BOTH orgs are the TOKEN's org: the pin-sync scope and the structured
  // mirror's set-once anchor. The anchor already equals this value (the check
  // above proved it), so this states the invariant rather than moving anything.
  upsertChatThreadInDatabase(thread, {
    orgId: principal.orgId,
    assistantMirrorOrgId: principal.orgId,
    // The token-verified widget principal. The write already proved this thread
    // is personally owned BY that principal (the `writable` check above), so the
    // tombstone's own ownership predicate simply re-states what was authorized.
    actorUserId: principal.userId,
  });
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
  return readAssistantThreadForActor({
    threadId,
    actorUserId: session.user.id,
    isPlatformAdmin: isPlatformAdmin(session),
  });
}

/**
 * The thread read for a WIDGET principal (cinatra#2683, epic #2564 S8f).
 *
 * WHY IT EXISTS. Reloading the frame used to empty the widget's transcript: the
 * shared column seeds from `initialMessages`, and the only way to fill them is
 * this read — which was cookie-bound, so the widget could not ask. Restoring the
 * conversation is the last thing the widget did differently from `/chat`.
 *
 * IT IS THE SAME MATRIX, NOT A WIDGET MATRIX. The ownership/tenant evaluation
 * below is the shared one, run with the widget principal as the actor: personal
 * → owner-only; team → member of the owning org; a missing row and a denial are
 * both 404 so a thread's existence is never disclosed across tenants. The widget
 * turn already binds its threads with exactly this principal
 * (`authorizeThreadForTurn`, `isAdmin: false`), so a reader gets back precisely
 * the threads they were allowed to create.
 *
 * PLATFORM STANDING IS FLOORED, matching every other widget path: a platform
 * admin reading through a widget reads as a member. The floor can only narrow.
 */
export async function handleGetAssistantThreadByIdForWidget(
  threadId: string,
  principal: { userId: string; orgId: string },
): Promise<Response> {
  if (!principal.userId || !principal.orgId) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // THE TOKEN'S ORG IS A HARD WALL, and it is EXTRA — the shared matrix runs
  // first and this can only refuse more (codex round 1, finding 1 on the routes).
  //
  // A cookie session has an active org it can switch; a `cwu_` is minted for ONE
  // org and cannot leave it. Without this, a person who belongs to two orgs
  // could read a thread anchored in org B through a widget signed in for org A —
  // the reader is entitled to that thread IN THE APP, but not through a
  // credential bound elsewhere, and the site framing that widget has standing in
  // neither.
  //
  // A thread with NO org anchor is refused rather than allowed: the anchor is
  // what proves the row belongs to this token's org, and a widget's own threads
  // always carry one (its turns bind the mirror to the widget principal's org).
  // Team-owned threads mirror with a NULL anchor by policy, so they are not
  // readable through a widget — the narrowing direction, stated rather than
  // discovered.
  const anchored = getAssistantThread(threadId);
  if (!anchored || anchored.orgId !== principal.orgId) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return readAssistantThreadForActor({
    threadId,
    actorUserId: principal.userId,
    isPlatformAdmin: false,
  });
}

/**
 * THE read, for whichever actor proved themselves at the door. One access
 * evaluation and one reconstruction, so the two credentials cannot drift into
 * disagreeing about who may read a thread.
 */
async function readAssistantThreadForActor(input: {
  threadId: string;
  actorUserId: string;
  isPlatformAdmin: boolean;
}): Promise<Response> {
  const { threadId, actorUserId, isPlatformAdmin: admin } = input;
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
