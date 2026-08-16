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
 * conversation column. Only the cookie-bound state action and the run panel's
 * CHROME are replaced — the first because it reaches a server action, the
 * second because its own rendering is pinned in the agents package.
 *
 * The panel stub is not opaque, and that matters. It keeps the panel's own
 * mount RULE (`runCardOwnsLifecycleCopy`, called rather than re-expressed) and
 * mounts the same card the panel would, so this file can count how many cards a
 * turn actually shows. An opaque stub is why a duplicate settled card survived
 * a review round here: it hid the second mount instead of measuring it.
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

// The run panel is the OTHER host, and it is the one that used to draw a SECOND
// copy of this card in the same turn.
//
// The stub is no longer opaque. An opaque one is exactly why the duplication
// went unseen here: it rendered a marked div, so the transcript could be
// asserted for the chat card while the panel's own mount stayed invisible to
// this file. Now the stub does what the panel does — it declares the `run_card`
// host and mounts the SAME card — but it takes the mount decision from
// `runCardOwnsLifecycleCopy`, the very function the panel calls, rather than
// from a second copy of the condition. So this file measures the real rule: if
// the panel ever starts drawing its copy inside a transcript again, the
// one-card assertions below go red.
//
// What stays stubbed is the panel's chrome and its data fetch, which belong to
// the agents package's own tests.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => {
    const ambientHost = useLifecycleCardHost();
    return (
      <div data-testid="inline-run-panel" data-run-card-host="" data-run-id={runId}>
        {runCardOwnsLifecycleCopy(ambientHost) ? (
          <LifecycleCardSurfaceProvider host="run_card">
            <RecommendationHoldCard runId={runId} wireRef={null} />
          </LifecycleCardSurfaceProvider>
        ) : null}
      </div>
    );
  },
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

// The panel's OWN mount rule and the host declaration it uses, imported rather
// than re-expressed, so the stub above and the real panel cannot disagree.
import {
  LifecycleCardSurfaceProvider,
  runCardOwnsLifecycleCopy,
  useLifecycleCardHost,
} from "../../../agents/src/lifecycle-card-runtime";
import { RecommendationHoldCard } from "@cinatra-ai/agents/run-recommendation-card";

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
    // The marker rides the card's OWN root, so it exists exactly when the card
    // draws — there is no wrapper of the transcript's to find when unheld.
    const wrapper = list?.querySelector("[data-chat-thread-recommendation-hold]");
    expect(wrapper).not.toBeNull();
    expect(wrapper?.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");
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
    // The marker and the identity are the SAME element: the card's root.
    const root = container.querySelector("[data-chat-thread-recommendation-hold]");

    expect(root).not.toBeNull();
    expect(root?.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");
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

  it("FAILS OPEN: an unheld turn adds no node at all", async () => {
    // The load-bearing negative control. Every `agent_run` turn mounts the card,
    // so a run that is NOT held must leave the transcript byte-identical to what
    // it drew before this mount existed. If the marker were a wrapper the
    // transcript rendered, it would sit in every such turn as an empty fixture
    // and every DOM-shape pin on this column would move.
    holdState.current = { state: "none" };
    const result = await mountSurface("chat", { messages: dispatchTurn() });

    await waitFor(() => {
      if (holdState.calls.length === 0) throw new Error("hold state not resolved");
    });
    expect(result.container.querySelector("[data-chat-thread-recommendation-hold]")).toBeNull();
    expect(result.container.querySelector('[data-lifecycle-card="recommendation_hold"]')).toBeNull();
    expect(result.container.querySelector("[data-run-recommendation-chip-row]")).toBeNull();
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

// ---------------------------------------------------------------------------
// ONE CARD PER TURN, IN EVERY STATE.
//
// The transcript mount and the inline run panel are siblings resolving the SAME
// run, so an unconditional mount on both draws the card TWICE in one turn. The
// defect survived a review round because it showed only in the SETTLED states:
// the held card self-gated to one turn, which made the duplication read as a
// settled-only quirk rather than the missing rule it was.
//
// The rule is that inside a `chat_thread` the chat card owns this run's
// recommendation and the panel withholds its copy — held and settled alike.
// These pins count card roots, so a second mount cannot come back quietly.
// ---------------------------------------------------------------------------
describe("the turn shows exactly one recommendation card", () => {
  async function countCardRoots(state: Record<string, unknown>) {
    holdState.current = state;
    const result = await mountSurface("chat", { messages: dispatchTurn() });
    await waitFor(() => {
      if (!result.container.querySelector('[data-lifecycle-card="recommendation_hold"]')) {
        throw new Error("no recommendation card drawn at all");
      }
    });
    return result.container.querySelectorAll('[data-lifecycle-card="recommendation_hold"]');
  }

  it("draws one HELD card, on the chat_thread host", async () => {
    const roots = await countCardRoots(HELD);

    expect(roots).toHaveLength(1);
    expect(roots[0].getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
  });

  it("draws one CONFIRMED summary, not one per host", async () => {
    const roots = await countCardRoots({
      state: "confirmed",
      runId: RUN_ID,
      skillNames: ["blog-content"],
    });

    expect(roots).toHaveLength(1);
    expect(roots[0].getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
  });

  it("draws one SKIPPED summary — the state the duplication showed up in", async () => {
    const roots = await countCardRoots({ state: "skipped", runId: RUN_ID });

    expect(roots).toHaveLength(1);
    expect(roots[0].getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
  });

  it("leaves the panel's own copy alone where no chat host owns the card", async () => {
    // The run page: no outer lifecycle host, so the panel keeps its copy. The
    // rule is a function, so this is the same call the panel makes.
    expect(runCardOwnsLifecycleCopy(null)).toBe(true);
    expect(runCardOwnsLifecycleCopy("run_card")).toBe(true);
    expect(runCardOwnsLifecycleCopy("chat_thread")).toBe(false);
  });
});
