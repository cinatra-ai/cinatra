// @vitest-environment jsdom
/**
 * THE CRUMB HAS THE THREAD'S NAME BEFORE THE CLIENT'S LIST ARRIVES (cinatra#4453).
 *
 * The components drawing, Breadcrumb section: "Names come from the owning page's
 * server render, strictly after its access checks; the shell never fetches a name
 * from the client after paint." The page used to take the name only from the
 * thread list it fetches after mount, so these cases hold that list open.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import { getCurrentChatThreadTitle, publishChatThreadTitle } from "@/lib/chat-shell-bus";

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: null, isPending: false }) },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../actions", () => ({
  resolveMessageRouting: vi.fn(async () => ({ shouldCallLlm: true })),
  setAssistantPauseState: vi.fn(async () => undefined),
  extractHitlGateValuesAction: vi.fn(async () => ({})),
}));
vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: vi.fn(async () => ({ state: "none" })),
}));
vi.mock("../../../agents/src/hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  getSkillsForAgentAction: vi.fn(async () => []),
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => ({ changeSetId: null }),
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));
vi.mock("../inline-agent-run-card", () => ({ InlineAgentRunCard: () => null }));

if (typeof window !== "undefined" && typeof window.localStorage?.getItem !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const THREAD_ID = "thr-4453";
const SUMMARY = {
  id: THREAD_ID,
  title: "Renamed on the client",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

// Every list request made before the release waits for it and answers the
// thread; a request made after it answers `listAfterRelease` (the page polls).
let releaseList: () => void = () => {};
let listGate: Promise<void> = Promise.resolve();
let released = false;
let listRequested = false;
let listAfterRelease: (typeof SUMMARY)[] = [SUMMARY];

function installNetwork() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/assistants/threads" && init?.method !== "POST") {
        if (released) return new Response(JSON.stringify(listAfterRelease));
        listRequested = true;
        await listGate;
        return new Response(JSON.stringify([SUMMARY]));
      }
      if (u.startsWith("/api/assistants/threads/")) {
        return new Response(JSON.stringify({ ...SUMMARY, messages: [] }));
      }
      if (u === "/api/assistants/list") return new Response(JSON.stringify([]));
      return new Response("{}");
    }),
  );
}

async function mountPage(props: Record<string, unknown>) {
  const { ChatPage } = await import("../chat-page");
  render(<ChatPage userId="u-1" {...props} />);
  await waitFor(() => expect(listRequested).toBe(true), { timeout: 15_000 });
}

beforeEach(() => {
  released = false;
  listRequested = false;
  listAfterRelease = [SUMMARY];
  listGate = new Promise<void>((resolve) => {
    releaseList = () => {
      released = true;
      resolve();
    };
  });
  publishChatThreadTitle(null);
  installNetwork();
});

afterEach(() => {
  cleanup();
  publishChatThreadTitle(null);
  vi.unstubAllGlobals();
});

describe("the chat page's thread name for the crumb (cinatra#4453)", () => {
  it("publishes the name the server read while the client's list is still open", async () => {
    await mountPage({ initialThreadId: THREAD_ID, initialThreadTitle: "Quarterly plan" });
    expect(getCurrentChatThreadTitle()).toBe("Quarterly plan");
  });

  it("lets the client's list win once it has arrived, so a rename still shows", async () => {
    await mountPage({ initialThreadId: THREAD_ID, initialThreadTitle: "Quarterly plan" });
    await act(async () => {
      releaseList();
    });
    await waitFor(() => expect(getCurrentChatThreadTitle()).toBe("Renamed on the client"), {
      timeout: 15_000,
    });
  });

  it("publishes no name for a new chat", async () => {
    await mountPage({ initialThreadTitle: null });
    expect(getCurrentChatThreadTitle()).toBeNull();
  });

  it("publishes no server name when the page has no thread of its own", async () => {
    await mountPage({ initialThreadTitle: "Quarterly plan" });
    expect(getCurrentChatThreadTitle()).toBeNull();
  });

  it("publishes no server name for another thread the reader switches to", async () => {
    await mountPage({ initialThreadId: THREAD_ID, initialThreadTitle: "Quarterly plan" });
    expect(getCurrentChatThreadTitle()).toBe("Quarterly plan");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("cinatra:chat:select", { detail: { threadId: "thr-other" } }));
    });
    await waitFor(() => expect(getCurrentChatThreadTitle()).toBeNull(), { timeout: 15_000 });
  });

  it("shows no stale server name after the list held the thread and then dropped it", async () => {
    await mountPage({ initialThreadId: THREAD_ID, initialThreadTitle: "Quarterly plan" });
    await act(async () => {
      releaseList();
    });
    await waitFor(() => expect(getCurrentChatThreadTitle()).toBe("Renamed on the client"), {
      timeout: 15_000,
    });
    listAfterRelease = [];
    // The page polls its list every five seconds; the next answer drops the thread.
    await waitFor(() => expect(getCurrentChatThreadTitle()).toBeNull(), { timeout: 15_000 });
  }, 30_000);
});
