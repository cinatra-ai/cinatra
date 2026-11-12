// The /chat route names a thread only where the thread read route returns it
// (cinatra#4453).
//
// The route's server render reads the thread's name for the breadcrumb. A title
// is a disclosure, so the render must not hand the page a name the thread read
// route would refuse. A legacy thread with no owner and no team passes the
// access matrix, but the read route returns 404 for it while it holds no durable
// content. Only the stores, the session and the route guard are stood in for:
// the name read and the thread read are the real ones.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  loadChatThreadForActorAccess: vi.fn(),
  getAssistantThread: vi.fn(),
  reconstructThreadPayload: vi.fn(),
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
  getAuthSession: vi.fn(async () => ({ user: { id: "u1" }, session: {} })),
  isPlatformAdmin: () => false,
}));
vi.mock("@/lib/chat-widget-catalog.server", () => ({
  resolveChatWidgetCatalog: vi.fn(async () => ({ widgets: [], manifests: [] })),
}));
vi.mock("@/lib/chat-views-catalog.server", () => ({
  resolveChatViewCatalog: vi.fn(async () => ({})),
}));
vi.mock("@/lib/chat-route-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat-route-resolver")>()),
  resolveChatRouteForCurrentActor: mocks.resolve,
}));
vi.mock("@/lib/chat-thread-store", () => ({
  loadChatThreadForActorAccess: mocks.loadChatThreadForActorAccess,
}));
vi.mock("@/lib/assistant-thread-store", () => ({
  getAssistantThread: mocks.getAssistantThread,
  reconstructThreadPayload: mocks.reconstructThreadPayload,
}));
vi.mock("@/lib/assistants-directory.server", () => ({
  resolveRemoteChatForBoundRoute: vi.fn(async () => null),
}));
vi.mock("@cinatra-ai/chat/chat-page", () => ({ ChatPage: () => null }));

import ChatPageMount from "../chat/[[...slug]]/page";

const THREAD_ID = "0f0f4a25-6a0d-4c60-9d3a-2f1a1b1c9d20";
const ASSISTANT = { packageName: "@cinatra-ai/cinatra-assistant", remoteCapable: false };

async function mountProps() {
  const element = await ChatPageMount({
    params: Promise.resolve({ slug: ["cinatra-ai", "cinatra-assistant", "a-thread"] }),
  });
  return (element as unknown as { props: Record<string, unknown> }).props;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({
    kind: "resolved",
    route: { instance: null },
    assistant: ASSISTANT,
    threadId: THREAD_ID,
  });
  // A legacy thread: no owner, no team.
  mocks.loadChatThreadForActorAccess.mockReturnValue({
    ownerUserId: null,
    teamId: null,
    isActorTeamMember: false,
  });
  mocks.getAssistantThread.mockReturnValue({ id: THREAD_ID, title: "Secret plan" });
});

describe("the /chat route's thread name and the thread read route", () => {
  it("hands the page no name of a thread with no durable content, which the read route refuses", async () => {
    mocks.reconstructThreadPayload.mockReturnValue(null);
    const props = await mountProps();
    expect(props.initialThreadId).toBe(THREAD_ID);
    expect(JSON.stringify(props)).not.toContain("Secret plan");
  });

  it("hands the page the name of the same thread once the read route returns it", async () => {
    mocks.reconstructThreadPayload.mockReturnValue({ id: THREAD_ID, title: "Secret plan", messages: [] });
    const props = await mountProps();
    expect(JSON.stringify(props)).toContain("Secret plan");
  });

  it("hands the page the blank answer for a readable thread whose title is only spaces", async () => {
    mocks.reconstructThreadPayload.mockReturnValue({ id: THREAD_ID, title: "   ", messages: [] });
    const props = await mountProps();
    expect(props.initialThreadName).toEqual({ state: "blank" });
  });
});
