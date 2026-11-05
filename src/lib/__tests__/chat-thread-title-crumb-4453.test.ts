// The chat thread's name reaches the breadcrumb from the server (cinatra#4453).
//
// The components drawing, Breadcrumb section: "Names come from the owning
// page's server render, strictly after its access checks; the shell never
// fetches a name from the client after paint."
//
// The route guard proves that a thread lives in the addressed container. It does
// not apply the thread's reader rule, and a title is a disclosure, so the name is
// read through THE read the thread read route calls
// (`readAssistantThreadPayloadForActor`, the real module here): its access matrix
// and its durable-content gate. Only the stores below it are stood in for.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  isPlatformAdmin: vi.fn(() => false),
  loadChatThreadForActorAccess: vi.fn(),
  reconstructThreadPayload: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: mocks.getAuthSession,
  isPlatformAdmin: mocks.isPlatformAdmin,
}));
vi.mock("@/lib/chat-thread-store", () => ({
  loadChatThreadForActorAccess: mocks.loadChatThreadForActorAccess,
}));
vi.mock("@/lib/assistant-thread-store", () => ({
  reconstructThreadPayload: mocks.reconstructThreadPayload,
}));

import { readChatThreadNameForCurrentActor } from "../chat-route-resolver";

const THREAD_ID = "0f0f4a25-6a0d-4c60-9d3a-2f1a1b1c9d20";
const UNAVAILABLE = { state: "unavailable" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isPlatformAdmin.mockReturnValue(false);
  mocks.getAuthSession.mockResolvedValue({ user: { id: "u1" }, session: {} });
  mocks.loadChatThreadForActorAccess.mockReturnValue({
    ownerUserId: "u1",
    teamId: null,
    isActorTeamMember: false,
  });
  mocks.reconstructThreadPayload.mockReturnValue({ id: THREAD_ID, title: "Quarterly plan" });
});

describe("readChatThreadNameForCurrentActor", () => {
  it("names the thread for its owner, and asks about this thread and this reader", async () => {
    await expect(readChatThreadNameForCurrentActor(THREAD_ID)).resolves.toEqual({
      state: "named",
      name: "Quarterly plan",
    });
    expect(mocks.loadChatThreadForActorAccess).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      actorUserId: "u1",
      isPlatformAdmin: false,
    });
    expect(mocks.reconstructThreadPayload).toHaveBeenCalledWith(THREAD_ID);
  });

  it("names the thread for a platform admin on a thread another user owns", async () => {
    mocks.isPlatformAdmin.mockReturnValue(true);
    mocks.loadChatThreadForActorAccess.mockReturnValue({
      ownerUserId: "someone-else",
      teamId: null,
      isActorTeamMember: false,
    });
    await expect(readChatThreadNameForCurrentActor(THREAD_ID)).resolves.toEqual({
      state: "named",
      name: "Quarterly plan",
    });
    expect(mocks.loadChatThreadForActorAccess).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      actorUserId: "u1",
      isPlatformAdmin: true,
    });
  });

  it("names a team thread for a member of the team", async () => {
    mocks.loadChatThreadForActorAccess.mockReturnValue({
      ownerUserId: null,
      teamId: "team-1",
      isActorTeamMember: true,
    });
    await expect(readChatThreadNameForCurrentActor(THREAD_ID)).resolves.toEqual({
      state: "named",
      name: "Quarterly plan",
    });
  });

  it("names a legacy thread with no owner and no team that has durable content, as the read route does", async () => {
    mocks.loadChatThreadForActorAccess.mockReturnValue({
      ownerUserId: null,
      teamId: null,
      isActorTeamMember: false,
    });
    await expect(readChatThreadNameForCurrentActor(THREAD_ID)).resolves.toEqual({
      state: "named",
      name: "Quarterly plan",
    });
  });

  it("tells nothing of a thread with no durable content, which the read route does not return", async () => {
    mocks.loadChatThreadForActorAccess.mockReturnValue({
      ownerUserId: null,
      teamId: null,
      isActorTeamMember: false,
    });
    mocks.reconstructThreadPayload.mockReturnValue(null);
    await expect(readChatThreadNameForCurrentActor(THREAD_ID)).resolves.toEqual(UNAVAILABLE);
  });

  it("tells a reader who does not own the thread nothing, and reads no content", async () => {
    mocks.loadChatThreadForActorAccess.mockReturnValue({
      ownerUserId: "someone-else",
      teamId: null,
      isActorTeamMember: false,
    });
    await expect(readChatThreadNameForCurrentActor(THREAD_ID)).resolves.toEqual(UNAVAILABLE);
    expect(mocks.reconstructThreadPayload).not.toHaveBeenCalled();
  });

  it("tells a reader who is not on the thread's team nothing", async () => {
    mocks.loadChatThreadForActorAccess.mockReturnValue({
      ownerUserId: null,
      teamId: "team-1",
      isActorTeamMember: false,
    });
    await expect(readChatThreadNameForCurrentActor(THREAD_ID)).resolves.toEqual(UNAVAILABLE);
    expect(mocks.reconstructThreadPayload).not.toHaveBeenCalled();
  });

  it("tells nothing with no session, with a session that names no user, and with no thread", async () => {
    mocks.getAuthSession.mockResolvedValueOnce(null);
    await expect(readChatThreadNameForCurrentActor(THREAD_ID)).resolves.toEqual(UNAVAILABLE);
    mocks.getAuthSession.mockResolvedValueOnce({ user: { id: "" }, session: {} });
    await expect(readChatThreadNameForCurrentActor(THREAD_ID)).resolves.toEqual(UNAVAILABLE);
    mocks.loadChatThreadForActorAccess.mockReturnValue(null);
    await expect(readChatThreadNameForCurrentActor(THREAD_ID)).resolves.toEqual(UNAVAILABLE);
    expect(mocks.reconstructThreadPayload).not.toHaveBeenCalled();
  });

  it("answers blank for a readable thread whose title is empty or only spaces", async () => {
    mocks.reconstructThreadPayload.mockReturnValueOnce({ id: THREAD_ID, title: "   " });
    await expect(readChatThreadNameForCurrentActor(THREAD_ID)).resolves.toEqual({ state: "blank" });
    mocks.reconstructThreadPayload.mockReturnValueOnce({ id: THREAD_ID, title: "" });
    await expect(readChatThreadNameForCurrentActor(THREAD_ID)).resolves.toEqual({ state: "blank" });
  });

  it("tells nothing when a read fails", async () => {
    mocks.loadChatThreadForActorAccess.mockImplementation(() => {
      throw new Error("database down");
    });
    await expect(readChatThreadNameForCurrentActor(THREAD_ID)).resolves.toEqual(UNAVAILABLE);
    mocks.loadChatThreadForActorAccess.mockReturnValue({
      ownerUserId: "u1",
      teamId: null,
      isActorTeamMember: false,
    });
    mocks.reconstructThreadPayload.mockImplementation(() => {
      throw new Error("database down");
    });
    await expect(readChatThreadNameForCurrentActor(THREAD_ID)).resolves.toEqual(UNAVAILABLE);
  });
});
