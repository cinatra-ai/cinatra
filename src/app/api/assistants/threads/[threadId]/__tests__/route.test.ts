import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Route-handler regression test for GET /api/assistants/threads/[threadId]
// (cinatra#1218). The DB loader (loadChatThreadForActorAccess) is mocked; the
// REAL pure decision (evaluateChatThreadAccess) runs, so these cases exercise
// the actual tenant matrix through the assistants surface exactly as the legacy
// GET /api/chat/thread/[threadId] does. A missing row OR a denial must both
// surface as 404 (existence not disclosed across tenants).
// ---------------------------------------------------------------------------

const getAuthSession = vi.fn();
const isPlatformAdmin = vi.fn();
const loadChatThreadForActorAccess = vi.fn();
const reconstructThreadPayload = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  isPlatformAdmin: (s: unknown) => isPlatformAdmin(s),
}));
vi.mock("@/lib/chat-thread-store", () => ({
  loadChatThreadForActorAccess: (i: unknown) => loadChatThreadForActorAccess(i),
  readChatThreadOwnershipById: () => null,
  isActorTeamMemberForChat: () => false,
}));
// PR2 CUTOVER (cinatra#1037): the handler no longer returns info.payload verbatim
// — once access is granted it reconstructs the body from the structured store.
// The access matrix (the point of this test) is unchanged; this seam is stubbed
// to ECHO the granted thread's payload so a granted read still yields that body,
// while a pre-cutover (content-less) thread reconstructs to null → 404.
vi.mock("@/lib/assistant-thread-store", () => ({
  reconstructThreadPayload: (id: string) => reconstructThreadPayload(id),
}));

import { GET } from "../route";

function ctx(threadId: string) {
  return { params: Promise.resolve({ threadId }) };
}
function req() {
  return new Request("https://app.test/api/assistants/threads/t1");
}

describe("GET /api/assistants/threads/[threadId]", () => {
  beforeEach(() => {
    isPlatformAdmin.mockReturnValue(false);
    getAuthSession.mockResolvedValue({ user: { id: "user-self" } });
    // A granted read reconstructs the body from the structured store; echo the
    // granted thread's payload so each case's expected body is unchanged. Denied
    // /missing reads 404 before this runs.
    reconstructThreadPayload.mockImplementation(
      () => loadChatThreadForActorAccess.mock.results.at(-1)?.value?.payload ?? null,
    );
  });
  afterEach(() => vi.clearAllMocks());

  it("401s with no session and never queries", async () => {
    getAuthSession.mockResolvedValue(null);
    const res = await GET(req(), ctx("t1"));
    expect(res.status).toBe(401);
    expect(loadChatThreadForActorAccess).not.toHaveBeenCalled();
  });

  it("forwards the caller identity to the loader", async () => {
    loadChatThreadForActorAccess.mockReturnValue({
      payload: { id: "t1" }, ownerUserId: "user-self", teamId: null, isActorTeamMember: false,
    });
    await GET(req(), ctx("t1"));
    expect(loadChatThreadForActorAccess).toHaveBeenCalledWith({
      threadId: "t1", actorUserId: "user-self", isPlatformAdmin: false,
    });
  });

  it("404s when the row does not exist", async () => {
    loadChatThreadForActorAccess.mockReturnValue(null);
    const res = await GET(req(), ctx("t1"));
    expect(res.status).toBe(404);
  });

  it("returns the owner's own thread (200)", async () => {
    loadChatThreadForActorAccess.mockReturnValue({
      payload: { id: "t1", title: "mine" }, ownerUserId: "user-self", teamId: null, isActorTeamMember: false,
    });
    const res = await GET(req(), ctx("t1"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: "t1", title: "mine" });
  });

  it("404s a thread owned by another user (cross-user IDOR, real matrix)", async () => {
    loadChatThreadForActorAccess.mockReturnValue({
      payload: { id: "t1", secret: "theirs" }, ownerUserId: "user-other", teamId: null, isActorTeamMember: false,
    });
    const res = await GET(req(), ctx("t1"));
    expect(res.status).toBe(404);
  });

  it("returns a team thread to a member of the team's org (200)", async () => {
    loadChatThreadForActorAccess.mockReturnValue({
      payload: { id: "t1", teamId: "team-1" }, ownerUserId: null, teamId: "team-1", isActorTeamMember: true,
    });
    const res = await GET(req(), ctx("t1"));
    expect(res.status).toBe(200);
  });

  it("404s a team thread for a non-member of the team's org", async () => {
    loadChatThreadForActorAccess.mockReturnValue({
      payload: { id: "t1", teamId: "team-1" }, ownerUserId: null, teamId: "team-1", isActorTeamMember: false,
    });
    const res = await GET(req(), ctx("t1"));
    expect(res.status).toBe(404);
  });

  it("returns a legacy unowned thread to any authenticated caller (200)", async () => {
    loadChatThreadForActorAccess.mockReturnValue({
      payload: { id: "t1" }, ownerUserId: null, teamId: null, isActorTeamMember: false,
    });
    const res = await GET(req(), ctx("t1"));
    expect(res.status).toBe(200);
  });

  it("lets a platform admin read another user's thread (200)", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "admin-1" } });
    isPlatformAdmin.mockReturnValue(true);
    loadChatThreadForActorAccess.mockReturnValue({
      payload: { id: "t1" }, ownerUserId: "user-other", teamId: null, isActorTeamMember: false,
    });
    const res = await GET(req(), ctx("t1"));
    expect(res.status).toBe(200);
  });
});
