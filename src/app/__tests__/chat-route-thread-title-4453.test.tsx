// The /chat route reads the thread's name in its server render, after its route
// guard, and hands it to the page (cinatra#4453).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  readTitle: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: vi.fn(async () => ({ user: { id: "u1" }, session: {} })),
}));
vi.mock("@/lib/chat-widget-catalog.server", () => ({
  resolveChatWidgetCatalog: vi.fn(async () => ({ widgets: [], manifests: [] })),
}));
vi.mock("@/lib/chat-views-catalog.server", () => ({
  resolveChatViewCatalog: vi.fn(async () => ({})),
}));
vi.mock("@/lib/chat-route-resolver", () => ({
  resolveChatRouteForCurrentActor: mocks.resolve,
  readChatThreadTitleForCurrentActor: mocks.readTitle,
}));
vi.mock("@/lib/assistants-directory.server", () => ({
  resolveRemoteChatForBoundRoute: vi.fn(async () => null),
}));
vi.mock("@cinatra-ai/chat/chat-page", () => ({ ChatPage: () => null }));

import ChatPageMount from "../chat/[[...slug]]/page";

const THREAD_ID = "0f0f4a25-6a0d-4c60-9d3a-2f1a1b1c9d20";
const ASSISTANT = { packageName: "@cinatra-ai/cinatra-assistant", remoteCapable: false };

async function mount() {
  const element = await ChatPageMount({
    params: Promise.resolve({ slug: ["cinatra-ai", "cinatra-assistant", "a-thread"] }),
  });
  return (element as unknown as { props: Record<string, unknown> }).props;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the /chat route and the thread's name", () => {
  it("hands the page the name read for the thread the guard resolved", async () => {
    mocks.resolve.mockResolvedValue({
      kind: "resolved",
      route: { instance: null },
      assistant: ASSISTANT,
      threadId: THREAD_ID,
    });
    mocks.readTitle.mockResolvedValue("Quarterly plan");
    const props = await mount();
    expect(mocks.readTitle).toHaveBeenCalledWith(THREAD_ID);
    expect(props.initialThreadId).toBe(THREAD_ID);
    expect(props.initialThreadTitle).toBe("Quarterly plan");
  });

  it("reads no name for a new chat", async () => {
    mocks.resolve.mockResolvedValue({
      kind: "resolved",
      route: { instance: null },
      assistant: ASSISTANT,
      threadId: null,
    });
    const props = await mount();
    expect(mocks.readTitle).not.toHaveBeenCalled();
    expect(props.initialThreadTitle).toBeNull();
  });

  it("reads no name when the guard answers not-found", async () => {
    mocks.resolve.mockResolvedValue({ kind: "not-found" });
    await expect(mount()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.readTitle).not.toHaveBeenCalled();
  });
});
