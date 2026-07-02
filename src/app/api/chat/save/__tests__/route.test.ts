import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Route-handler regression test for POST /api/chat/save.
// Asserts the write-authorization rules that close the ownership-spoof /
// cross-user-overwrite IDOR:
//   - overwriting another user's personal thread is denied (403, NO write);
//   - a body-supplied ownerUserId can never spoof ownership (server derives it);
//   - team-owned threads are writable only by a direct team member, and their
//     team ownership is preserved (never converted to a personal thread);
//   - a denial NEVER calls upsertChatThreadInDatabase.
// Non-owner/non-member actors are non-admin and in a different identity so a
// platform-admin bypass cannot mask the checks.
// ---------------------------------------------------------------------------

const getAuthSession = vi.fn();
const isPlatformAdmin = vi.fn();
const readChatThreadOwnershipById = vi.fn();
const isActorTeamMemberForChat = vi.fn();
const upsertChatThreadInDatabase = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  isPlatformAdmin: (s: unknown) => isPlatformAdmin(s),
}));
vi.mock("@/lib/database", () => ({
  upsertChatThreadInDatabase: (...a: unknown[]) => upsertChatThreadInDatabase(...a),
}));
vi.mock("@/lib/chat-thread-store", () => ({
  readChatThreadOwnershipById: (id: string) => readChatThreadOwnershipById(id),
  isActorTeamMemberForChat: (t: string, u: string) => isActorTeamMemberForChat(t, u),
}));

import { POST } from "../route";

function sessionFor(userId: string, orgId: string | null) {
  return { user: { id: userId }, session: { activeOrganizationId: orgId } };
}
function saveReq(body: unknown): Request {
  return new Request("https://app.test/api/chat/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function persistedThread() {
  // The thread object passed to upsertChatThreadInDatabase (first arg).
  return upsertChatThreadInDatabase.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe("POST /api/chat/save", () => {
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
    readChatThreadOwnershipById.mockReturnValue(null); // create

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
    expect(t.ownerUserId).toBeUndefined(); // NOT converted to a personal thread
    expect(isActorTeamMemberForChat).toHaveBeenCalledWith("team-1", "user-self");
  });

  it("gives owner precedence over teamId (matches the read path): a team member cannot overwrite another user's owned thread", async () => {
    getAuthSession.mockResolvedValue(sessionFor("user-self", "org-1"));
    // Ambiguous row carrying BOTH axes; owner wins.
    readChatThreadOwnershipById.mockReturnValue({ ownerUserId: "user-other", teamId: "team-1" });
    isActorTeamMemberForChat.mockReturnValue(true); // even a team member is denied

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
});
