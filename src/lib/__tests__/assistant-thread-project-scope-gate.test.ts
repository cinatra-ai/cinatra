// ---------------------------------------------------------------------------
// THE CONVERSATION'S PROJECT IS CHECKED BEFORE IT IS FROZEN (cinatra#2815 S3).
// ---------------------------------------------------------------------------
// The mirror freezes a conversation's assignment scopes as it creates the row,
// and the project it freezes comes from the request body. Nothing checked that
// the project belonged to the caller's organization or that the caller could
// read it, so a person could name a project of another tenant and have that
// project's assignments delivered to their own conversation for as long as it
// lives. The snapshot is written once and a later turn cannot correct it.
//
// The gate is the SAME pair an agent-run surface applies to a supplied project:
// the project row must belong to the acting organization (the tenancy half) and
// the caller must hold a read grant on it (the readability half, which a
// platform administrator bypasses). A project that fails either half is
// REFUSED, with the sealed-room answer that does not disclose whether the id
// names a real row. It is never dropped and never frozen.
//
// The same handler also carries the CREATOR'S TEAMS into the freeze, from the
// membership read this route already has to perform, because the mirror froze
// an empty team list and lost every skill assigned at the creator's team.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAuthSession = vi.fn();
const isPlatformAdmin = vi.fn();
const resolveActorGrantsForUserInOrg = vi.fn();
const readProjectById = vi.fn();
const upsertChatThreadInDatabase = vi.fn();
const readChatThreadOwnershipById = vi.fn();

vi.mock("@/lib/assistant-thread-store", () => ({
  getAssistantThread: () => null,
  reconstructThreadPayload: () => null,
  listAssistantThreadIdsWithDurableContent: () => [],
  listAssistantThreadSummariesForOwnerInOrg: () => [],
}));
vi.mock("@/lib/chat-thread-store", () => ({
  loadChatThreadForActorAccess: () => null,
  isActorTeamMemberForChat: () => false,
  readChatThreadOwnershipById: (...a: unknown[]) => readChatThreadOwnershipById(...a),
}));
vi.mock("@/lib/chat-thread-access", () => ({ evaluateChatThreadAccess: () => true }));
vi.mock("@/lib/database", () => ({
  upsertChatThreadInDatabase: (...a: unknown[]) => upsertChatThreadInDatabase(...a),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  isPlatformAdmin: (...a: unknown[]) => isPlatformAdmin(...a),
  resolveActorGrantsForUserInOrg: (...a: unknown[]) => resolveActorGrantsForUserInOrg(...a),
}));
vi.mock("@/lib/projects-store-dao", () => ({
  readProjectById: (...a: unknown[]) => readProjectById(...a),
}));

const post = (body: unknown) =>
  new Request("https://app.test/api/assistants/threads", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthSession.mockResolvedValue({
    user: { id: "u1" },
    session: { activeOrganizationId: "org-A" },
  });
  isPlatformAdmin.mockReturnValue(false);
  readChatThreadOwnershipById.mockReturnValue(null);
  // The caller belongs to team-A of org-A and holds a read grant on proj-A.
  resolveActorGrantsForUserInOrg.mockResolvedValue({
    projectGrants: [{ projectId: "proj-A", role: "read", source: "org" }],
    teamIds: ["team-A"],
  });
  readProjectById.mockResolvedValue({ id: "proj-A", organizationId: "org-A" });
});

describe("a body project is checked before the conversation freezes it", () => {
  it("REFUSES a project of another organization and writes nothing", async () => {
    const { handleSaveAssistantThread } = await import("@/lib/assistant-thread-http");
    readProjectById.mockResolvedValue({ id: "proj-B", organizationId: "org-B" });
    resolveActorGrantsForUserInOrg.mockResolvedValue({
      // The caller even claims a grant: the tenancy half still refuses.
      projectGrants: [{ projectId: "proj-B", role: "read", source: "org" }],
      teamIds: [],
    });
    const res = await handleSaveAssistantThread(
      post({ id: "new-thread", projectId: "proj-B", messages: [] }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Project not found" });
    expect(upsertChatThreadInDatabase).not.toHaveBeenCalled();
  });

  it("REFUSES a project of the caller's own organization they hold no grant on", async () => {
    const { handleSaveAssistantThread } = await import("@/lib/assistant-thread-http");
    readProjectById.mockResolvedValue({ id: "proj-X", organizationId: "org-A" });
    const res = await handleSaveAssistantThread(
      post({ id: "new-thread", projectId: "proj-X", messages: [] }),
    );
    expect(res.status).toBe(404);
    expect(upsertChatThreadInDatabase).not.toHaveBeenCalled();
  });

  it("REFUSES a project id that names no row at all", async () => {
    const { handleSaveAssistantThread } = await import("@/lib/assistant-thread-http");
    readProjectById.mockResolvedValue(null);
    const res = await handleSaveAssistantThread(
      post({ id: "new-thread", projectId: "proj-A", messages: [] }),
    );
    expect(res.status).toBe(404);
    expect(upsertChatThreadInDatabase).not.toHaveBeenCalled();
  });

  it("REFUSES another organization's project even for a platform administrator", async () => {
    // Standing lets an administrator read across projects; it does not make a
    // project of another tenant coherent with THIS conversation's organization.
    const { handleSaveAssistantThread } = await import("@/lib/assistant-thread-http");
    isPlatformAdmin.mockReturnValue(true);
    readProjectById.mockResolvedValue({ id: "proj-B", organizationId: "org-B" });
    const res = await handleSaveAssistantThread(
      post({ id: "new-thread", projectId: "proj-B", messages: [] }),
    );
    expect(res.status).toBe(404);
    expect(upsertChatThreadInDatabase).not.toHaveBeenCalled();
  });

  it("ACCEPTS the caller's own readable project and freezes it", async () => {
    const { handleSaveAssistantThread } = await import("@/lib/assistant-thread-http");
    const res = await handleSaveAssistantThread(
      post({ id: "new-thread", projectId: "proj-A", messages: [] }),
    );
    expect(res.status).toBe(200);
    expect(upsertChatThreadInDatabase).toHaveBeenCalledTimes(1);
    expect(upsertChatThreadInDatabase.mock.calls[0][0]).toMatchObject({
      projectId: "proj-A",
    });
  });

  it("ACCEPTS a project of the caller's own organization for an administrator with no grant", async () => {
    // Standing bypasses the grant half and only that half. The project is in
    // the acting organization, so the conversation may be created in it.
    const { handleSaveAssistantThread } = await import("@/lib/assistant-thread-http");
    isPlatformAdmin.mockReturnValue(true);
    resolveActorGrantsForUserInOrg.mockResolvedValue({ projectGrants: [], teamIds: [] });
    readProjectById.mockResolvedValue({ id: "proj-A", organizationId: "org-A" });
    const res = await handleSaveAssistantThread(
      post({ id: "new-thread", projectId: "proj-A", messages: [] }),
    );
    expect(res.status).toBe(200);
    expect(upsertChatThreadInDatabase).toHaveBeenCalledTimes(1);
  });

  it("asks nothing about a project when the body names none", async () => {
    const { handleSaveAssistantThread } = await import("@/lib/assistant-thread-http");
    const res = await handleSaveAssistantThread(post({ id: "new-thread", messages: [] }));
    expect(res.status).toBe(200);
    expect(readProjectById).not.toHaveBeenCalled();
    expect(upsertChatThreadInDatabase).toHaveBeenCalledTimes(1);
  });
});

describe("the save carries the creator's teams into the freeze", () => {
  it("hands the mirror the membership read under the conversation's organization", async () => {
    const { handleSaveAssistantThread } = await import("@/lib/assistant-thread-http");
    await handleSaveAssistantThread(post({ id: "new-thread", messages: [] }));
    expect(resolveActorGrantsForUserInOrg).toHaveBeenCalledWith("u1", "org-A");
    expect(upsertChatThreadInDatabase.mock.calls[0][1]).toMatchObject({
      creatorTeamIds: ["team-A"],
    });
  });

  it("takes the teams from the membership read, never from the body", async () => {
    const { handleSaveAssistantThread } = await import("@/lib/assistant-thread-http");
    await handleSaveAssistantThread(
      post({ id: "new-thread", messages: [], creatorTeamIds: ["team-Z"], teamIds: ["team-Z"] }),
    );
    expect(upsertChatThreadInDatabase.mock.calls[0][1]).toMatchObject({
      creatorTeamIds: ["team-A"],
    });
  });

  it("carries none when the caller has no active organization to read under", async () => {
    const { handleSaveAssistantThread } = await import("@/lib/assistant-thread-http");
    getAuthSession.mockResolvedValue({ user: { id: "u1" }, session: {} });
    await handleSaveAssistantThread(post({ id: "new-thread", messages: [] }));
    expect(upsertChatThreadInDatabase.mock.calls[0][1]).toMatchObject({
      creatorTeamIds: [],
    });
  });
});
