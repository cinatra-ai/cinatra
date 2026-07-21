import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Route-handler regression test for the first-class assistants persistence
// surface (cinatra#1218): GET /api/assistants/threads (list) and
// POST /api/assistants/threads (save). These assert the SAME authz matrix the
// legacy /api/chat/{threads,save} subroutes enforce — the client migrated onto
// this surface, so the ownership-spoof / cross-user-overwrite IDOR guarantees
// must hold identically here:
//   - overwriting another user's personal thread is denied (403, NO write);
//   - a body-supplied ownerUserId can never spoof ownership (server derives it);
//   - team-owned threads are writable only by a direct team member, preserved;
//   - a denial NEVER calls upsertChatThreadInDatabase;
//   - the list shows only the caller's own + legacy-unowned threads.
// ---------------------------------------------------------------------------

const getAuthSession = vi.fn();
const isPlatformAdmin = vi.fn();
const readChatThreadOwnershipById = vi.fn();
const isActorTeamMemberForChat = vi.fn();
const loadChatThreadForActorAccess = vi.fn();
const upsertChatThreadInDatabase = vi.fn();
const readChatThreadsFromDatabase = vi.fn();
const listAssistantThreadIdsWithDurableContent = vi.fn();
const listAssistantThreadSummariesForOwnerInOrg = vi.fn();
const getAssistantThread = vi.fn();
const reconstructThreadPayload = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  isPlatformAdmin: (s: unknown) => isPlatformAdmin(s),
}));
vi.mock("@/lib/database", () => ({
  upsertChatThreadInDatabase: (...a: unknown[]) => upsertChatThreadInDatabase(...a),
  readChatThreadsFromDatabase: () => readChatThreadsFromDatabase(),
}));
// PR2 CUTOVER (cinatra#1037): the list handler now intersects the legacy
// visibility axes with the structured durable-content gate, so this seam must be
// stubbed alongside the legacy read.
vi.mock("@/lib/assistant-thread-store", () => ({
  listAssistantThreadIdsWithDurableContent: () => listAssistantThreadIdsWithDurableContent(),
  listAssistantThreadSummariesForOwnerInOrg: (o: string, u: string) =>
    listAssistantThreadSummariesForOwnerInOrg(o, u),
  getAssistantThread: (id: string) => getAssistantThread(id),
  reconstructThreadPayload: (...a: unknown[]) => reconstructThreadPayload(...a),
}));
vi.mock("@/lib/chat-thread-store", () => ({
  readChatThreadOwnershipById: (id: string) => readChatThreadOwnershipById(id),
  isActorTeamMemberForChat: (t: string, u: string) => isActorTeamMemberForChat(t, u),
  loadChatThreadForActorAccess: (i: unknown) => loadChatThreadForActorAccess(i),
}));
vi.mock("@/lib/chat-thread-access", () => ({
  evaluateChatThreadAccess: () => true,
}));

import { GET, POST } from "../route";

function sessionFor(userId: string, orgId: string | null) {
  return { user: { id: userId }, session: { activeOrganizationId: orgId } };
}
function saveReq(body: unknown): Request {
  return new Request("https://app.test/api/assistants/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function persistedThread() {
  return upsertChatThreadInDatabase.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe("POST /api/assistants/threads (save)", () => {
  beforeEach(() => {
    isPlatformAdmin.mockReturnValue(false);
    isActorTeamMemberForChat.mockReturnValue(false);
  });
  afterEach(() => vi.clearAllMocks());

  it("401s with no session and never writes", async () => {
    getAuthSession.mockResolvedValue(null);
    const res = await POST(saveReq({ id: "t1" }));
    expect(res.status).toBe(401);
    expect(upsertChatThreadInDatabase).not.toHaveBeenCalled();
  });

  it("400s when the thread id is missing", async () => {
    getAuthSession.mockResolvedValue(sessionFor("user-self", "org-1"));
    const res = await POST(saveReq({ title: "no id" }));
    expect(res.status).toBe(400);
    expect(upsertChatThreadInDatabase).not.toHaveBeenCalled();
  });

  it("DENIES overwriting a thread owned by another user (403, no write)", async () => {
    getAuthSession.mockResolvedValue(sessionFor("user-self", "org-1"));
    readChatThreadOwnershipById.mockReturnValue({ ownerUserId: "user-other", teamId: null });
    const res = await POST(saveReq({ id: "t1", title: "hijack", ownerUserId: "user-other" }));
    expect(res.status).toBe(403);
    expect(upsertChatThreadInDatabase).not.toHaveBeenCalled();
  });

  it("strips a spoofed body ownerUserId when the caller owns the thread", async () => {
    getAuthSession.mockResolvedValue(sessionFor("user-self", "org-1"));
    readChatThreadOwnershipById.mockReturnValue({ ownerUserId: "user-self", teamId: null });
    const res = await POST(saveReq({ id: "t1", title: "mine", ownerUserId: "user-other" }));
    expect(res.status).toBe(200);
    expect(persistedThread().ownerUserId).toBe("user-self");
  });

  it("claims ownership for the caller on a new thread, ignoring a spoofed body owner", async () => {
    getAuthSession.mockResolvedValue(sessionFor("user-self", "org-1"));
    readChatThreadOwnershipById.mockReturnValue(null);
    const res = await POST(saveReq({ id: "t-new", title: "new", ownerUserId: "user-other" }));
    expect(res.status).toBe(200);
    const t = persistedThread();
    expect(t.ownerUserId).toBe("user-self");
    expect(t.teamId).toBeUndefined();
  });

  it("DENIES writing a team thread when the caller is not a team member (403, no write)", async () => {
    getAuthSession.mockResolvedValue(sessionFor("user-self", "org-1"));
    readChatThreadOwnershipById.mockReturnValue({ ownerUserId: null, teamId: "team-1" });
    isActorTeamMemberForChat.mockReturnValue(false);
    const res = await POST(saveReq({ id: "t1", title: "x", teamId: "team-1" }));
    expect(res.status).toBe(403);
    expect(upsertChatThreadInDatabase).not.toHaveBeenCalled();
  });

  it("preserves team ownership when an org member writes a team thread", async () => {
    getAuthSession.mockResolvedValue(sessionFor("user-self", "org-1"));
    readChatThreadOwnershipById.mockReturnValue({ ownerUserId: null, teamId: "team-1" });
    isActorTeamMemberForChat.mockReturnValue(true);
    const res = await POST(saveReq({ id: "t1", title: "x", ownerUserId: "user-self" }));
    expect(res.status).toBe(200);
    const t = persistedThread();
    expect(t.teamId).toBe("team-1");
    expect(t.ownerUserId).toBeUndefined();
    expect(isActorTeamMemberForChat).toHaveBeenCalledWith("team-1", "user-self");
  });

  it("gives owner precedence over teamId: a team member cannot overwrite another user's owned thread", async () => {
    getAuthSession.mockResolvedValue(sessionFor("user-self", "org-1"));
    readChatThreadOwnershipById.mockReturnValue({ ownerUserId: "user-other", teamId: "team-1" });
    isActorTeamMemberForChat.mockReturnValue(true);
    const res = await POST(saveReq({ id: "t1", title: "x" }));
    expect(res.status).toBe(403);
    expect(upsertChatThreadInDatabase).not.toHaveBeenCalled();
  });

  it("lets a platform admin save another user's thread (owner preserved)", async () => {
    getAuthSession.mockResolvedValue(sessionFor("admin-1", "org-1"));
    isPlatformAdmin.mockReturnValue(true);
    readChatThreadOwnershipById.mockReturnValue({ ownerUserId: "user-other", teamId: null });
    const res = await POST(saveReq({ id: "t1", title: "edit" }));
    expect(res.status).toBe(200);
    expect(persistedThread().ownerUserId).toBe("user-other");
  });

  it("passes the auth-derived org as both pin-sync and assistant-mirror anchor", async () => {
    getAuthSession.mockResolvedValue(sessionFor("user-self", "org-9"));
    readChatThreadOwnershipById.mockReturnValue(null);
    await POST(saveReq({ id: "t-new", title: "new" }));
    expect(upsertChatThreadInDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t-new" }),
      { orgId: "org-9", assistantMirrorOrgId: "org-9" },
    );
  });
});

describe("GET /api/assistants/threads (list) — #134 org-scoped listing contract", () => {
  beforeEach(() => {
    isPlatformAdmin.mockReturnValue(false);
  });
  afterEach(() => vi.clearAllMocks());

  it("401s with no session and never queries", async () => {
    getAuthSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(listAssistantThreadSummariesForOwnerInOrg).not.toHaveBeenCalled();
  });

  it("returns the caller's own IN-ORG durable-content threads (the store op resolves org+owner+content)", async () => {
    getAuthSession.mockResolvedValue(sessionFor("user-self", "org-1"));
    // PR2 CUTOVER: the non-admin list is served entirely by the structured store
    // op, which already applies the #134 org+owner scope, the ownerless
    // quarantine, the team exclusion and the durable-content EXISTS gate (covered
    // exhaustively by assistant-thread-store tests). The route handler just maps +
    // sorts what the op returns and passes (activeOrgId, userId).
    listAssistantThreadSummariesForOwnerInOrg.mockReturnValue([
      { id: "mine-old", title: "A", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string }>;
    expect(list.map((t) => t.id)).toEqual(["mine-old"]);
    expect(listAssistantThreadSummariesForOwnerInOrg).toHaveBeenCalledWith("org-1", "user-self");
  });

  it("a platform admin bypasses org scope and sees ownerless legacy rows (quarantine visibility), newest first", async () => {
    getAuthSession.mockResolvedValue(sessionFor("admin-1", "org-1"));
    isPlatformAdmin.mockReturnValue(true);
    // Admin path enumerates the durable-content threads and resolves ownership
    // from the structured mirror row via getAssistantThread.
    listAssistantThreadIdsWithDurableContent.mockReturnValue(new Set(["mine-otherorg", "legacy", "team"]));
    const rows: Record<string, Record<string, unknown>> = {
      "mine-otherorg": { id: "mine-otherorg", title: "E", createdAt: "2026-01-05", updatedAt: "2026-01-05", ownerUserId: "admin-1", teamId: null },
      "legacy": { id: "legacy", title: "D", createdAt: "2026-01-02", updatedAt: "2026-01-02", ownerUserId: null, teamId: null },
      "team": { id: "team", title: "C", createdAt: "2026-01-04", updatedAt: "2026-01-04", ownerUserId: null, teamId: "team-1" },
    };
    getAssistantThread.mockImplementation((id: string) => rows[id] ?? null);
    const res = await GET();
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string }>;
    // team still hidden (team panel); own + ownerless-legacy shown, newest first.
    expect(list.map((t) => t.id)).toEqual(["mine-otherorg", "legacy"]);
  });

  it("PR2 CUTOVER: a pre-cutover thread with no durable content is excluded (the store op's content gate)", async () => {
    getAuthSession.mockResolvedValue(sessionFor("user-self", "org-1"));
    // mine-new is a pre-cutover shadow (no durable content) → the store op's
    // durable-content EXISTS gate drops it; only mine-old comes back.
    listAssistantThreadSummariesForOwnerInOrg.mockReturnValue([
      { id: "mine-old", title: "A", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string }>;
    expect(list.map((t) => t.id)).toEqual(["mine-old"]);
  });
});
