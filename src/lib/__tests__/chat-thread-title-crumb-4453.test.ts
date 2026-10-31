// The chat thread's name reaches the breadcrumb from the server (cinatra#4453).
//
// The components drawing, Breadcrumb section: "Names come from the owning
// page's server render, strictly after its access checks; the shell never
// fetches a name from the client after paint."
//
// The route guard proves that a thread lives in the addressed container. It does
// not apply the thread's reader rule, and a title is a disclosure, so this read
// repeats the rule the thread read route applies. A refusal, a missing thread and
// any failure all answer null, so the crumb draws no thread name.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  isPlatformAdmin: vi.fn(() => false),
  loadChatThreadForActorAccess: vi.fn(),
  getAssistantThread: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: mocks.getAuthSession,
  isPlatformAdmin: mocks.isPlatformAdmin,
}));
vi.mock("@/lib/chat-thread-store", () => ({
  loadChatThreadForActorAccess: mocks.loadChatThreadForActorAccess,
}));
vi.mock("@/lib/assistant-thread-store", () => ({
  getAssistantThread: mocks.getAssistantThread,
}));

import { readChatThreadTitleForCurrentActor } from "../chat-route-resolver";

const THREAD_ID = "0f0f4a25-6a0d-4c60-9d3a-2f1a1b1c9d20";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isPlatformAdmin.mockReturnValue(false);
  mocks.getAuthSession.mockResolvedValue({ user: { id: "u1" }, session: {} });
  mocks.loadChatThreadForActorAccess.mockReturnValue({
    ownerUserId: "u1",
    teamId: null,
    isActorTeamMember: false,
  });
  mocks.getAssistantThread.mockReturnValue({ id: THREAD_ID, title: "Quarterly plan" });
});

describe("readChatThreadTitleForCurrentActor", () => {
  it("answers the title for the thread's owner, and asks about this thread and this reader", async () => {
    await expect(readChatThreadTitleForCurrentActor(THREAD_ID)).resolves.toBe("Quarterly plan");
    expect(mocks.loadChatThreadForActorAccess).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      actorUserId: "u1",
      isPlatformAdmin: false,
    });
  });

  it("answers null for a reader who does not own the thread, and never reads the title", async () => {
    mocks.loadChatThreadForActorAccess.mockReturnValue({
      ownerUserId: "someone-else",
      teamId: null,
      isActorTeamMember: false,
    });
    await expect(readChatThreadTitleForCurrentActor(THREAD_ID)).resolves.toBeNull();
    expect(mocks.getAssistantThread).not.toHaveBeenCalled();
  });

  it("answers null for a team thread when the reader is not a member", async () => {
    mocks.loadChatThreadForActorAccess.mockReturnValue({
      ownerUserId: null,
      teamId: "team-1",
      isActorTeamMember: false,
    });
    await expect(readChatThreadTitleForCurrentActor(THREAD_ID)).resolves.toBeNull();
    expect(mocks.getAssistantThread).not.toHaveBeenCalled();
  });

  it("answers null with no session and with no thread", async () => {
    mocks.getAuthSession.mockResolvedValueOnce(null);
    await expect(readChatThreadTitleForCurrentActor(THREAD_ID)).resolves.toBeNull();
    mocks.loadChatThreadForActorAccess.mockReturnValue(null);
    await expect(readChatThreadTitleForCurrentActor(THREAD_ID)).resolves.toBeNull();
    expect(mocks.getAssistantThread).not.toHaveBeenCalled();
  });

  it("answers null when a read fails, and for a blank title", async () => {
    mocks.getAssistantThread.mockReturnValueOnce({ id: THREAD_ID, title: "   " });
    await expect(readChatThreadTitleForCurrentActor(THREAD_ID)).resolves.toBeNull();
    mocks.loadChatThreadForActorAccess.mockImplementation(() => {
      throw new Error("database down");
    });
    await expect(readChatThreadTitleForCurrentActor(THREAD_ID)).resolves.toBeNull();
  });
});
