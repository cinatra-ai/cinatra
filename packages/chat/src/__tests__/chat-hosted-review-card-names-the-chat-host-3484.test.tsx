// @vitest-environment jsdom
/**
 * THE CHAT ARM of cinatra#3484 — the conversation's own column, the card a
 * reader meets in it, and the ONE host declaration that card publishes.
 *
 * THE DRAWING'S OWN SENTENCE, `specs/app-lifecycle-cards.html` §IX: "Four
 * hosts, one card set … Only the frame changes — the thread, the widget's
 * panel, the run card's detail column, the gate region of the review page."
 *
 * THE RECORDER'S OWN RULE, `scripts/audit/lib/chat-hitl-capture-recorder.mjs`:
 * a chat_thread cell needs the `/chat` URL class AND the card root's own
 * `data-lifecycle-card-host="chat_thread"`, which
 * `scripts/audit/chat-hitl-anchor-contract.json` carries as a required anchor on
 * every chat_thread card row. That anchor is what this file measures, on the
 * REAL conversation column rather than on a harness of its own.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT, stated plainly because it decides what the
 * three arms below are worth:
 *
 *   · REAL — the conversation column `/chat` mounts (through the shared surface
 *     harness), its `chat_thread` declaration, the turn carrying a finished
 *     agent run, the shipped `ReviewGateCard` and the shipped
 *     `LifecycleCardSurfaceProvider`. The host attribute read below is written
 *     by the shipped card root, under the declaration the shipped column makes.
 *   · NOT REAL — the run panel's own module. The chat tier CANNOT load it: the
 *     panel's graph reaches the app's server modules through specifiers this
 *     package's vitest config does not alias. Probed twice in this worktree:
 *     importing `../inline-agent-run-card` failed with `Failed to resolve import
 *     "@cinatra-ai/agents/builtin-assistant-template" from
 *     "src/lib/assistant-agent-registration.ts"`, and with the app's auth module
 *     stubbed it failed again with `Failed to resolve import
 *     "@cinatra-ai/extensions/permissions-store" from
 *     "packages/agents/src/store.ts"`. Every chat suite that touches the inline
 *     run card mocks it for that reason, and this one does the same.
 *
 * SO THE PANEL'S OWN HALF IS PINNED WHERE IT CAN BE PINNED, and in two places
 * rather than one: the shipped panel's DOM behaviour is measured in the agents
 * tier (`packages/agents/src/__tests__/chat-hosted-review-card-names-the-chat-host-3484.test.tsx`,
 * which renders the SHIPPED panel under a `chat_thread` declaration), and the
 * third arm here reads the panel's SOURCE for the composition link the column
 * arms depend on — that the review slot offers a mount OUTSIDE any literal
 * `run_card` declaration, while one literal `run_card` block composing
 * `ReviewGateCard` survives for the run page. That lexical reading is the same
 * technique the repository's own host-parity ratchet uses
 * (`src/lib/lifecycle/lifecycle-host-parity-ratchet.ts`), and it is the arm that
 * is RED before this change: at the branch base the slot had ONE unconditional
 * literal and no conversation mount at all.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/chat-hosted-review-card-names-the-chat-host-3484.test.tsx
 */
import React from "react";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";

// --- the column's own graph, stubbed exactly as its sibling suites stub it ---

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Check", "ChevronDown", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
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

/**
 * THE RUN SLOT'S SHAPE, switched per arm. `inherited` is what the panel does
 * inside a conversation since cinatra#3484 — the card is mounted under NO
 * declaration of its own, so the nearest one is the transcript's. `nested`
 * is the shape the defect had: a `run_card` declaration minted inside the
 * thread, which is the negative control below.
 */
const slot = vi.hoisted(() => ({ shape: "inherited" as "inherited" | "nested" }));

const REVIEW_REF = "lcr-opaque-3484";
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';

vi.mock("../inline-agent-run-card", async () => {
  const { ReviewGateCard, LIFECYCLE_VIEW_SCHEMA_VERSION } = await import(
    "@cinatra-ai/agents/review-gate-card"
  );
  const { LifecycleCardSurfaceProvider } = await import(
    "@cinatra-ai/agents/lifecycle-card-runtime"
  );
  return {
    InlineAgentRunCard: ({ runId }: { runId: string }) => {
      const card = (
        <ReviewGateCard
          view={{
            viewType: "artifact_review_gate" as const,
            schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
            ref: REVIEW_REF,
          }}
          runId={runId}
        />
      );
      return slot.shape === "nested" ? (
        <LifecycleCardSurfaceProvider host="run_card">{card}</LifecycleCardSurfaceProvider>
      ) : (
        card
      );
    },
  };
});

// Some Node builds expose a global `localStorage` that SHADOWS jsdom's and
// throws on use, which the composer's prompt field reads on mount. Repaired only
// when actually broken, so the suite behaves identically on CI's runtime.
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

import { mountSurface, parityAgentRunMessages } from "./conversation-column-harness";

/** The gate a reader may still decide — the state CELL1 is drawn in. */
const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

const realFetch = globalThis.fetch;

function stubFetch() {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/lifecycle-views/resolve")) {
      return new Response(JSON.stringify(RESOLVE_PENDING), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** The card root — the ONE element the recorder reads host and state off. */
async function cardRoot(container: HTMLElement): Promise<Element> {
  return waitFor(
    () => {
      const el = container.querySelector(REVIEW_CARD);
      if (!el) throw new Error("the review card did not arrive in the thread");
      return el;
    },
    { timeout: 20_000 },
  );
}

/** Every host declaration that GOVERNS this card: the root itself and every
 *  drawn ancestor that declares one. The recorder wants exactly one, on the
 *  root. */
function governingDeclarations(container: HTMLElement, card: Element): Element[] {
  return [...container.querySelectorAll("[data-lifecycle-card-host]")].filter(
    (el) => el === card || el.contains(card),
  );
}

beforeEach(() => {
  slot.shape = "inherited";
  stubFetch();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("cinatra#3484 — the card in the real conversation column", () => {
  it("publishes exactly ONE host declaration for the card, and it reads chat_thread", async () => {
    const { container } = await mountSurface("chat", { messages: parityAgentRunMessages() });
    const card = await cardRoot(container);

    // C7 — read off the card's OWN root, never off an ancestor.
    expect(card.getAttribute("data-lifecycle-card")).toBe("artifact_review_gate");
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
    // C8 — the state is on that SAME element, so the recorder reads both from
    // one node rather than from a pair it has to correlate.
    const state = card.getAttribute("data-lifecycle-card-state");
    expect(state).not.toBeNull();
    expect(state).not.toBe("");

    // The recorder's anchor, and ONE declaration governing it: the thread's.
    const governing = governingDeclarations(container, card);
    expect(governing).toHaveLength(1);
    expect(governing[0]).toBe(card);
    expect(card.closest('[data-lifecycle-card-host="run_card"]')).toBeNull();
    expect(container.querySelector('[data-lifecycle-card-host="chat_thread"]')).toBe(card);
  }, 30_000);

  it("NEGATIVE CONTROL — a run_card declaration minted inside the thread is what the recorder refused", async () => {
    // The defect's own shape. Nothing about the column changes; the card's root
    // simply names a frame the reader is not in, and the page then carries NO
    // `data-lifecycle-card-host="chat_thread"` anchor for this card at all — so
    // the chat_thread cell could not be concluded on, which is cinatra#3484's
    // "refuses the card twice".
    slot.shape = "nested";
    const { container } = await mountSurface("chat", { messages: parityAgentRunMessages() });
    const card = await cardRoot(container);

    expect(card.getAttribute("data-lifecycle-card-host")).toBe("run_card");
    const governing = governingDeclarations(container, card);
    expect(governing).toHaveLength(1);
    expect(governing[0]).toBe(card);
  }, 30_000);

  it("the shipped panel offers the conversation mount the column arms depend on", async () => {
    // THE COMPOSITION LINK, read lexically from the shipped source because this
    // tier cannot load that module (see the header). Two readings, and the
    // second is as load-bearing as the first:
    //
    //   1. the review slot mounts `ReviewGateCard` OUTSIDE any literal
    //      `run_card` declaration — the conversation branch. RED at the branch
    //      base, where the slot was one unconditional literal.
    //   2. a literal `<LifecycleCardSurfaceProvider host="run_card">` block
    //      composing `ReviewGateCard` SURVIVES — the run page's own frame, and
    //      the exact shape the host-parity ratchet's lexical scanner collects.
    const source = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../agents/src/agentic-run-panel.tsx",
      ),
      "utf8",
    );
    // The panel's prose ABOUT this shape quotes the shape, so the reading is
    // taken from the code alone: a comment line is not a declaration.
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");

    const OPEN = '<LifecycleCardSurfaceProvider host="run_card">';
    const CLOSE = "</LifecycleCardSurfaceProvider>";
    const blocks: Array<[number, number]> = [];
    for (let at = code.indexOf(OPEN); at !== -1; at = code.indexOf(OPEN, at + 1)) {
      const end = code.indexOf(CLOSE, at);
      expect(end).toBeGreaterThan(at);
      blocks.push([at, end + CLOSE.length]);
    }
    expect(blocks.length).toBeGreaterThan(0);

    const mounts: number[] = [];
    for (let at = code.indexOf("<ReviewGateCard"); at !== -1; at = code.indexOf("<ReviewGateCard", at + 1)) {
      mounts.push(at);
    }
    const insideRunCard = (at: number) => blocks.some(([from, to]) => at > from && at < to);

    // 1 — the conversation branch exists, and it is REACHED BY THE AMBIENT
    //     HOST rather than by some unrelated unwrapped mount: the unwrapped
    //     card sits inside the ternary the chat-thread reading opens.
    const unwrapped = mounts.filter((at) => !insideRunCard(at));
    expect(unwrapped).not.toHaveLength(0);
    const decision = code.indexOf('ambientLifecycleHost === "chat_thread"');
    expect(decision).toBeGreaterThan(-1);
    expect(unwrapped.filter((at) => at > decision)).not.toHaveLength(0);
    // 2 — the run page's literal declaration survives, composing the card.
    expect(mounts.filter(insideRunCard)).not.toHaveLength(0);

    // 3 — THE RATCHET'S OWN READING, taken the way the ratchet takes it:
    //     over the WHOLE source, comments included, because
    //     `scanHostCompositionOwners` does not strip them. A sentence that
    //     spells the provider's opening tag out opens a match of its own and
    //     drags the tags below it into the run page's owner set. The owners
    //     read here must therefore carry the card and nothing that only prose
    //     put there.
    const OPEN_TAG = new RegExp(
      `<LifecycleCardSurfaceProvider\\b[^>]*host=(?:"|')run_card(?:"|')[^>]*>`,
      "g",
    );
    const owners = new Set<string>();
    for (let m = OPEN_TAG.exec(source); m !== null; m = OPEN_TAG.exec(source)) {
      const from = m.index + m[0].length;
      const to = source.indexOf(CLOSE, from);
      if (to === -1) continue;
      for (const tag of source.slice(from, to).matchAll(/<([A-Z][A-Za-z0-9_]*)\b/g)) {
        owners.add(tag[1]!);
      }
    }
    expect(owners.has("ReviewGateCard")).toBe(true);
    expect(owners.has("LifecycleCardSurfaceProvider")).toBe(false);
  });
});
