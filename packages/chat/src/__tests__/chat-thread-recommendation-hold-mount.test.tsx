// @vitest-environment jsdom
/**
 * THE §V RECOMMENDATION HOLD IS DECIDED IN THE CONVERSATION.
 *
 * A chat-started run can PARK on the run-start recommendation hold. The
 * decision then belongs where the person is — in the transcript — and a
 * sentence telling them to go somewhere else is a pointer standing in for an
 * implementation, not an implementation.
 *
 * So this file pins the mount STRUCTURALLY, in the shape the evidence for this
 * slice is read in, and every assertion is one a pointer cannot satisfy:
 *
 *   • the card is INSIDE `[data-conversation-list]`;
 *   • it sits in a wrapper marked `data-chat-thread-recommendation-hold`;
 *   • that wrapper contains the chip row and BOTH action anchors;
 *   • and the wrapper is OUTSIDE the inline run panel's subtree, because the
 *     panel is the separate `run_card` host and a card nested inside it would
 *     make "which host drew this" unanswerable.
 *
 * The card is mounted through the REAL transcript renderer on the REAL
 * conversation column. Only the cookie-bound state action and the run panel are
 * replaced — the first because it reaches a server action, the second because
 * its own rendering is pinned in the agents package and mounting it here would
 * put the run_card host inside this test for no reason.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/chat-thread-recommendation-hold-mount.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, waitFor } from "@testing-library/react";

// The column loads the message list behind a lazy boundary. Alone that resolves
// in milliseconds; inside the full package run it competes with ~57 other files
// and can exceed testing-library's 1s default, which would fail the mount for a
// reason that has nothing to do with the card.
configure({ asyncUtilTimeout: 15_000 });

import type { UiMessage } from "../types";

// The composer this column mounts reads `window.localStorage` on mount. jsdom
// under Node 25 exposes the property without its methods, which throws before
// any assertion here runs — a runtime quirk, not a fact about the code under
// test. Installed ONLY when the environment is missing it, so a working
// localStorage (CI's Node 24) is untouched and this file is verifiable on both.
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

const RUN_ID = "764eb973-3f5f-4592-96c2-891f160a92d6";
const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";

// The card's own authority. The REAL `RecommendationHoldCard` renders against
// whatever this returns, so the held/decided shapes below are the only stand-in.
const holdState = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
  calls: [] as unknown[],
}));
// The card imports these by relative path inside the agents package; vitest
// resolves a relative mock specifier to the same module id, so this replaces
// exactly the module the real component reaches.
vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async (input: unknown) => {
    holdState.calls.push(input);
    return holdState.current;
  },
  confirmRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
  skipRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
}));
// The chip row prefetches the agent's assignable skills while a hold is live.
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: async () => [],
}));

// The run panel is the OTHER host. Stubbed with a marked subtree so the
// outside-the-run_card-subtree assertion has something concrete to measure.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => (
    <div data-testid="inline-run-panel" data-run-card-host="" data-run-id={runId} />
  ),
}));

// The chip row refreshes the router after a decision.
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

import { mountSurface } from "./conversation-column-harness";

/** The assistant turn a parked chat dispatch actually produces: one `agent_run`
 *  tool call with the server-pinned run id, and the dispatch line beside it. */
function dispatchTurn(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: `run cinatra_blog-draft-writer-agent for me` },
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
        {
          kind: "text",
          content: `Dispatched \`${PACKAGE}\` (runId: \`${RUN_ID}\`, status: \`pending_input\`). The run is paused for your decision on the recommended skills.`,
        },
      ],
    } as unknown as UiMessage,
  ];
}

const HELD = {
  state: "held",
  runId: RUN_ID,
  agentPackageName: PACKAGE,
  promptText: "draft a blog post",
  recommendations: [
    { skillId: "@cinatra-ai/chat:blog-content", skillRevisionId: "rev-1", name: "blog-content", recommended: true },
  ],
  holdRef: "hold-ref-1",
};

beforeEach(() => {
  holdState.current = HELD;
  holdState.calls = [];
});
afterEach(cleanup);

async function mountHeldTurn() {
  const result = await mountSurface("chat", { messages: dispatchTurn() });
  await waitFor(() => {
    if (!result.container.querySelector("[data-chat-thread-recommendation-hold]")) {
      throw new Error("no chat_thread recommendation-hold wrapper");
    }
  });
  return result;
}

describe("the §V card is mounted in the conversation transcript", () => {
  it("renders the wrapper INSIDE the conversation list", async () => {
    const { container } = await mountHeldTurn();

    const list = container.querySelector("[data-conversation-list]");
    expect(list).not.toBeNull();
    const wrapper = list?.querySelector("[data-chat-thread-recommendation-hold]");
    expect(wrapper).not.toBeNull();
    expect(wrapper?.getAttribute("data-run-id")).toBe(RUN_ID);
  });

  it("puts the chip row and BOTH action anchors inside that wrapper", async () => {
    const { container } = await mountHeldTurn();
    const wrapper = container.querySelector("[data-chat-thread-recommendation-hold]");

    await waitFor(() => {
      if (!wrapper?.querySelector("[data-run-recommendation-chip-row]")) {
        throw new Error("chip row not drawn inside the wrapper");
      }
    });
    expect(wrapper?.querySelector('[data-action="confirm-run-recommendation"]')).not.toBeNull();
    expect(wrapper?.querySelector('[data-action="skip-run-recommendation"]')).not.toBeNull();
  });

  it("keeps the card OUTSIDE the inline run panel's subtree", async () => {
    // The panel is the `run_card` host and mounts its own copy of the same
    // component. A card nested inside it would be that host's card, not this
    // one, and the evidence for this slice could not tell them apart.
    const { container } = await mountHeldTurn();

    const panel = container.querySelector("[data-run-card-host]");
    const wrapper = container.querySelector("[data-chat-thread-recommendation-hold]");
    expect(panel).not.toBeNull();
    expect(wrapper).not.toBeNull();
    expect(panel?.contains(wrapper as Node)).toBe(false);
    expect(wrapper?.contains(panel as Node)).toBe(false);
  });

  it("carries the three §V root attributes, host-correct for THIS mount", async () => {
    // The identity lives on the CARD's own root, not on either mount's wrapper,
    // so both authorized mounts get host-correct values by construction. Here
    // the declared host is the transcript's, so the card must say so itself.
    const { container } = await mountHeldTurn();
    const wrapper = container.querySelector("[data-chat-thread-recommendation-hold]");
    const root = wrapper?.querySelector('[data-lifecycle-card="recommendation_hold"]');

    expect(root).not.toBeNull();
    expect(root?.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
    expect(root?.getAttribute("data-lifecycle-card-state")).toBe("held");
    // The chip row is INSIDE that root, so the anchor set reads as one card.
    expect(root?.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull();
  });

  it("moves the root's state attribute with the decision", async () => {
    holdState.current = { state: "confirmed", runId: RUN_ID, skillNames: ["blog-content"] };
    const result = await mountSurface("chat", { messages: dispatchTurn() });

    await waitFor(() => {
      if (!result.container.querySelector('[data-lifecycle-card-state="confirmed"]')) {
        throw new Error("root state did not settle to confirmed");
      }
    });
    const root = result.container.querySelector('[data-lifecycle-card="recommendation_hold"]');
    expect(root?.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
  });

  it("asks the card's own authority for THIS run", async () => {
    await mountHeldTurn();
    expect(holdState.calls).toContainEqual({ runId: RUN_ID });
  });

  it("draws NOTHING when the run carries no live hold", async () => {
    // The negative control. Every `agent_run` turn mounts the card; a run that
    // is not held must add no card DOM at all, or the wrapper would be a
    // permanent empty fixture rather than evidence of a hold.
    holdState.current = { state: "none" };
    const result = await mountSurface("chat", { messages: dispatchTurn() });

    await waitFor(() => {
      if (holdState.calls.length === 0) throw new Error("hold state not resolved");
    });
    expect(
      result.container.querySelector("[data-run-recommendation-chip-row]"),
    ).toBeNull();
  });
});

describe("the decided card settles in the same conversation", () => {
  it("shows the confirmed summary in place, still inside the wrapper", async () => {
    holdState.current = {
      state: "confirmed",
      runId: RUN_ID,
      skillNames: ["blog-content"],
    };
    const result = await mountSurface("chat", { messages: dispatchTurn() });

    await waitFor(() => {
      if (!result.container.querySelector('[data-run-recommendation-decision="confirmed"]')) {
        throw new Error("settled summary not drawn");
      }
    });
    const wrapper = result.container.querySelector("[data-chat-thread-recommendation-hold]");
    expect(wrapper?.querySelector('[data-run-recommendation-decision="confirmed"]')).not.toBeNull();
    // Settled means settled: the live controls are gone, in place, with no
    // navigation and nothing else taking over the turn.
    expect(wrapper?.querySelector('[data-action="confirm-run-recommendation"]')).toBeNull();
    expect(wrapper?.querySelector('[data-action="skip-run-recommendation"]')).toBeNull();
  });

  it("shows the skipped summary in place", async () => {
    holdState.current = { state: "skipped", runId: RUN_ID };
    const result = await mountSurface("chat", { messages: dispatchTurn() });

    await waitFor(() => {
      if (!result.container.querySelector('[data-run-recommendation-decision="skipped"]')) {
        throw new Error("skipped summary not drawn");
      }
    });
    const wrapper = result.container.querySelector("[data-chat-thread-recommendation-hold]");
    expect(wrapper?.querySelector('[data-run-recommendation-decision="skipped"]')).not.toBeNull();
  });
});
