// @vitest-environment jsdom
/**
 * THE CRUMB NAMES THE ACTIVE THREAD, AND KEEPS NAMING IT RIGHTLY (cinatra#4453).
 *
 * The components drawing, Breadcrumb section: "Names come from the owning page's
 * server render, strictly after its access checks; the shell never fetches a name
 * from the client after paint", and "While a name is genuinely unavailable, the
 * crumb shows the id's first eight characters plus an ellipsis". The page used to
 * take the name only from the thread list it fetches after mount, and a rename
 * or a deletion could leave the old name standing. These cases hold the page's
 * reads open and release them one by one.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import {
  CHAT_THREAD_RENAMED_EVENT,
  getCurrentChatThreadTitle,
  publishChatThreadTitle,
} from "@/lib/chat-shell-bus";

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

const THREAD_ID = "0f0f4a25-6a0d-4c60-9d3a-2f1a1b1c9d20";
const PLACEHOLDER = "0f0f4a25…";

function summary(title: string) {
  return {
    id: THREAD_ID,
    title,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

// The page's two reads, each held open until a test releases it:
//   - the thread LIST, answering `listAnswer` (the page polls it every 5 s);
//   - the per-thread READ (the load when a thread opens, then a poll every 3 s),
//     answering `readAnswers[id]`: a title, or `null` for the read route's 404.
//     The answer is taken when the request is made, so a read on its way keeps
//     the answer of the moment it was asked.
let listAnswer: ReturnType<typeof summary>[] = [];
let readAnswers: Record<string, string | null> = {};
let releaseList: () => void = () => {};
let releaseReads: () => void = () => {};
let listGate: Promise<void> = Promise.resolve();
let readGate: Promise<void> = Promise.resolve();
let listRequested = false;
let readRequests = 0;

function installNetwork() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/assistants/threads" && init?.method !== "POST") {
        listRequested = true;
        await listGate;
        return new Response(JSON.stringify(listAnswer));
      }
      if (u.startsWith("/api/assistants/threads/")) {
        const id = decodeURIComponent(u.slice("/api/assistants/threads/".length));
        const title = id in readAnswers ? readAnswers[id] : null;
        readRequests += 1;
        await readGate;
        if (title === null || title === undefined) {
          return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
        }
        return new Response(JSON.stringify({ ...summary(title), id, messages: [] }));
      }
      if (u === "/api/assistants/list") return new Response(JSON.stringify([]));
      return new Response("{}");
    }),
  );
}

function holdList() {
  listGate = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
}

function holdReads() {
  readGate = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
}

async function mountPage(props: Record<string, unknown>) {
  const { ChatPage } = await import("../chat-page");
  render(<ChatPage userId="u-1" {...props} />);
  await waitFor(() => expect(listRequested).toBe(true), { timeout: 15_000 });
}

function crumb() {
  return getCurrentChatThreadTitle();
}

async function crumbBecomes(value: string | null) {
  await waitFor(() => expect(crumb()).toBe(value), { timeout: 15_000 });
}

beforeEach(() => {
  listRequested = false;
  readRequests = 0;
  listAnswer = [summary("From the list")];
  readAnswers = { [THREAD_ID]: "Read for this reader" };
  holdList();
  holdReads();
  publishChatThreadTitle(null);
  installNetwork();
});

afterEach(() => {
  releaseList();
  releaseReads();
  cleanup();
  publishChatThreadTitle(null);
  vi.unstubAllGlobals();
});

const NAMED = { state: "named", name: "Quarterly plan" };

describe("the chat page's thread name for the crumb (cinatra#4453)", () => {
  it("publishes the name the server read while no read of the page has arrived", async () => {
    await mountPage({ initialThreadId: THREAD_ID, initialThreadName: NAMED });
    expect(crumb()).toBe("Quarterly plan");
  });

  it("draws the server's blank answer as the id's first eight characters plus an ellipsis", async () => {
    await mountPage({ initialThreadId: THREAD_ID, initialThreadName: { state: "blank" } });
    expect(crumb()).toBe(PLACEHOLDER);
  });

  it("publishes no name for the server's unavailable answer", async () => {
    await mountPage({ initialThreadId: THREAD_ID, initialThreadName: { state: "unavailable" } });
    expect(crumb()).toBeNull();
  });

  it("lets the page's own read of the thread win over the list and the server", async () => {
    await mountPage({ initialThreadId: THREAD_ID, initialThreadName: NAMED });
    await act(async () => {
      releaseList();
      releaseReads();
    });
    await crumbBecomes("Read for this reader");
  });

  it("lets the list name the thread while no read has answered", async () => {
    await mountPage({ initialThreadId: THREAD_ID, initialThreadName: NAMED });
    await act(async () => {
      releaseList();
    });
    await crumbBecomes("From the list");
  });

  it("draws a blank title from the list as the id's first eight characters plus an ellipsis", async () => {
    listAnswer = [summary("")];
    await mountPage({ initialThreadId: THREAD_ID, initialThreadName: NAMED });
    await act(async () => {
      releaseList();
    });
    await crumbBecomes(PLACEHOLDER);
  });

  it("draws a blank title from the read as the id's first eight characters plus an ellipsis", async () => {
    readAnswers = { [THREAD_ID]: "  " };
    await mountPage({ initialThreadId: THREAD_ID, initialThreadName: NAMED });
    await act(async () => {
      releaseReads();
    });
    await crumbBecomes(PLACEHOLDER);
  });

  it("publishes no name for a new chat", async () => {
    await mountPage({});
    expect(crumb()).toBeNull();
  });

  it("publishes no server name when the page has no thread of its own", async () => {
    await mountPage({ initialThreadName: NAMED });
    expect(crumb()).toBeNull();
  });

  it("publishes no server name for another thread the reader switches to", async () => {
    await mountPage({ initialThreadId: THREAD_ID, initialThreadName: NAMED });
    expect(crumb()).toBe("Quarterly plan");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("cinatra:chat:select", { detail: { threadId: "thr-other" } }));
      releaseReads();
    });
    await crumbBecomes(null);
  });

  it("shows a rename made on this page at once, and a read already on its way cannot undo it", async () => {
    listAnswer = [summary("Quarterly plan")];
    readAnswers = { [THREAD_ID]: "Quarterly plan" };
    await mountPage({ initialThreadId: THREAD_ID, initialThreadName: NAMED });
    await act(async () => {
      releaseList();
    });
    await crumbBecomes("Quarterly plan");
    // The load of the thread was asked before the rename and is still on its way.
    expect(readRequests).toBeGreaterThan(0);
    readAnswers = { [THREAD_ID]: "Annual plan" };
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(CHAT_THREAD_RENAMED_EVENT, {
          detail: { threadId: THREAD_ID, title: "Annual plan" },
        }),
      );
    });
    expect(crumb()).toBe("Annual plan");
    await act(async () => {
      releaseReads();
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(crumb()).toBe("Annual plan");
  });

  it("follows a rename by another writer of a thread the list never holds", async () => {
    listAnswer = [];
    readAnswers = { [THREAD_ID]: "Quarterly plan" };
    await mountPage({ initialThreadId: THREAD_ID, initialThreadName: NAMED });
    await act(async () => {
      releaseList();
      releaseReads();
    });
    await crumbBecomes("Quarterly plan");
    // Another writer renames it; the page polls its read every three seconds.
    readAnswers = { [THREAD_ID]: "Annual plan" };
    await crumbBecomes("Annual plan");
  }, 30_000);

  it("clears the name of a thread the list never holds once it is deleted", async () => {
    listAnswer = [];
    readAnswers = { [THREAD_ID]: "Quarterly plan" };
    await mountPage({ initialThreadId: THREAD_ID, initialThreadName: NAMED });
    await act(async () => {
      releaseList();
      releaseReads();
    });
    await crumbBecomes("Quarterly plan");
    readAnswers = {};
    await crumbBecomes(null);
  }, 30_000);

  it("shows no stale server name after the list held the thread and then dropped it", async () => {
    // The reads stay open, so only the list spends the server's answer.
    await mountPage({ initialThreadId: THREAD_ID, initialThreadName: NAMED });
    await act(async () => {
      releaseList();
    });
    await crumbBecomes("From the list");
    listAnswer = [];
    // The page polls its list every five seconds; the next answer drops the thread.
    await crumbBecomes(null);
  }, 30_000);

  it("shows no stale server name after a read has answered and the thread is then gone", async () => {
    await mountPage({ initialThreadId: THREAD_ID, initialThreadName: NAMED });
    await act(async () => {
      releaseList();
      releaseReads();
    });
    await crumbBecomes("Read for this reader");
    listAnswer = [];
    readAnswers = {};
    await crumbBecomes(null);
  }, 30_000);
});
