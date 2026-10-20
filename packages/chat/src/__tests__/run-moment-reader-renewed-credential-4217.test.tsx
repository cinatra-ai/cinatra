// @vitest-environment jsdom
/**
 * THE RUN'S MOMENT READER ASKS WITH THE CREDENTIAL THE FRAME HOLDS NOW
 * (cinatra#4217).
 *
 * The conversation's run container reads the run's own row to learn which
 * lifecycle moment it stands at, and it keeps looking while the conversation
 * stays open. The embed frame renews its sign-in while it stays open too: the
 * declaration stays the same and the tokens behind its header callback change.
 * So every look must build its headers again. A look that sent the headers the
 * reader was built with would present a spent user token after the first
 * renewal, and the moment would stop reaching the open page.
 *
 * RED BEFORE THE CURE: the reader built its request once, when the slot
 * mounted, and every later look sent those headers.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/run-moment-reader-renewed-credential-4217.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, waitFor } from "@testing-library/react";

configure({ asyncUtilTimeout: 15_000 });

import type { UiMessage } from "../types";

// The composer reads `window.localStorage` on mount; jsdom under Node 25 can
// expose the property without its methods. Installed only when it is missing.
if (typeof globalThis.window !== "undefined" &&
    typeof window.localStorage?.getItem !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const RUN_ID = "4217a5e1-0c3b-4d2e-9f6a-7b8c9d0e1f2a";
const RUN_URL = `/api/agents/runs/${RUN_ID}`;

vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async () => ({ state: "none" }),
  confirmRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
  skipRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
}));
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: async () => ({ state: "none" }),
}));
vi.mock("../../../agents/src/hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: async () => [],
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => null,
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));
// The run panel reads the same route on its own; it is stubbed so every call to
// the run's URL below is the moment reader's.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => <div data-inline-run-card={runId} />,
}));

import {
  installWidgetServiceStub,
  mountSurface,
  WIDGET_LIFECYCLE_SURFACE,
} from "./conversation-column-harness";

/** The run, still working: no moment, so the watch keeps looking. */
const RUN_WORKING = {
  status: "running",
  error: null,
  messages: [],
  lifecycleMoment: null,
  lifecycleCard: null,
};

function runTurn(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "run the blog draft writer for me" },
    {
      id: "a1",
      role: "assistant",
      content: "",
      parts: [
        {
          kind: "tool_call",
          id: "explicit_dispatch_pre_router",
          name: "agent_run",
          status: "completed",
          runId: RUN_ID,
          result: JSON.stringify({ runId: RUN_ID, status: "pending_input" }),
        },
      ],
    } as unknown as UiMessage,
  ];
}

function userTokenOf(init: RequestInit): string | undefined {
  const raw = (init.headers ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(raw)) {
    if (k.toLowerCase() === "x-cinatra-widget-user-token") return v;
  }
  return undefined;
}

let stub: { calls: Array<{ url: string; init: RequestInit }>; restore: () => void } | null = null;

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = null;
  vi.restoreAllMocks();
});

describe("the run's moment reader on the widget (cinatra#4217)", () => {
  it("a look after a renewal carries the renewed token, never the first one", async () => {
    let userToken = "cwu_first";
    // The frame's declaration stays the same object; only the tokens behind its
    // header callback change, exactly as the embed's renewal does.
    vi.spyOn(WIDGET_LIFECYCLE_SURFACE.auth, "headers").mockImplementation(() => ({
      Authorization: "Bearer cit_site",
      "X-Cinatra-Widget-User-Token": userToken,
      "X-Cinatra-Widget-Assistant": "wordpress",
      "X-Cinatra-Widget-Origin": "https://blog.example.com",
    }));
    stub = installWidgetServiceStub({ runSeed: () => RUN_WORKING });
    await mountSurface("widget", { messages: runTurn() });

    const runLooks = () => stub!.calls.filter((c) => c.url === RUN_URL);
    // The first look is immediate and carries the token the frame holds now.
    await waitFor(() => {
      if (runLooks().length === 0) throw new Error("the moment reader has not looked yet");
    });
    expect(userTokenOf(runLooks()[0]!.init)).toBe("cwu_first");
    // Let the first look land, so the next one is a fresh look.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The frame renews.
    userToken = "cwu_renewed";
    const before = runLooks().length;
    // The person comes back to the tab: one more look, right away.
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      if (runLooks().length <= before) throw new Error("no look after the renewal");
    });

    const after = runLooks().slice(before);
    expect(after.length).toBeGreaterThan(0);
    for (const call of after) {
      expect(userTokenOf(call.init)).toBe("cwu_renewed");
      expect(call.init.credentials).toBe("omit");
    }
  });
});
