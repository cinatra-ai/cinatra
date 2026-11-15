// One thread read for the read route and the /chat route's name read (cinatra#4453).
//
// A thread's title is a disclosure, so the /chat route's server render may name
// a thread in its breadcrumb only where the thread read route would return it.
// Both call `readAssistantThreadPayloadForActor`; these cases hold that both
// callers reach it with the same reader, and that it refuses what the read
// route refuses.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  getAuthSession: vi.fn(),
  isPlatformAdmin: vi.fn(() => false),
}));

vi.mock("@/lib/assistant-thread-read", () => ({
  readAssistantThreadPayloadForActor: mocks.read,
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: mocks.getAuthSession,
  isPlatformAdmin: mocks.isPlatformAdmin,
  resolveActorGrantsForUserInOrg: vi.fn(),
}));
vi.mock("@/lib/database", () => ({ upsertChatThreadInDatabase: vi.fn() }));
vi.mock("@/lib/assistant-thread-store", () => ({
  reconstructThreadPayload: vi.fn(),
  listAssistantThreadIdsWithDurableContent: () => [],
  listAssistantThreadSummariesForOwnerInOrg: () => [],
  getAssistantThread: () => null,
}));
vi.mock("@/lib/chat-thread-store", () => ({
  isActorTeamMemberForChat: () => false,
  readChatThreadOwnershipById: () => null,
}));
vi.mock("@/lib/projects-store-dao", () => ({ readProjectById: vi.fn() }));
vi.mock("@/lib/sealed-room", () => ({ assertProjectReadAccess: vi.fn() }));

import { handleGetAssistantThreadById } from "../assistant-thread-http";
import { readChatThreadNameForCurrentActor } from "../chat-route-resolver";

const THREAD_ID = "0f0f4a25-6a0d-4c60-9d3a-2f1a1b1c9d20";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthSession.mockResolvedValue({ user: { id: "u1" }, session: {} });
  mocks.isPlatformAdmin.mockReturnValue(true);
});

describe("the thread read both routes call", () => {
  it("is what the read route answers with, for the signed-in reader", async () => {
    mocks.read.mockReturnValue({ id: THREAD_ID, title: "Quarterly plan", messages: [] });
    const res = await handleGetAssistantThreadById(THREAD_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: "Quarterly plan" });
    expect(mocks.read).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      actorUserId: "u1",
      isPlatformAdmin: true,
    });
  });

  it("is what the /chat route names the thread from, for the same reader", async () => {
    mocks.read.mockReturnValue({ id: THREAD_ID, title: "Quarterly plan", messages: [] });
    await expect(readChatThreadNameForCurrentActor(THREAD_ID)).resolves.toEqual({
      state: "named",
      name: "Quarterly plan",
    });
    expect(mocks.read).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      actorUserId: "u1",
      isPlatformAdmin: true,
    });
  });

  it("makes the read route answer 404 and the /chat route tell nothing, for the same refusal", async () => {
    mocks.read.mockReturnValue(null);
    const res = await handleGetAssistantThreadById(THREAD_ID);
    expect(res.status).toBe(404);
    await expect(readChatThreadNameForCurrentActor(THREAD_ID)).resolves.toEqual({
      state: "unavailable",
    });
  });
});
