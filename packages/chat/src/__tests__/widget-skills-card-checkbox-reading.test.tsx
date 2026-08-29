// @vitest-environment jsdom
/**
 * THE SKILLS CARD INSIDE A THIRD-PARTY PAGE (cinatra#3062, acceptance item 3).
 *
 * The widget arm of the ONE conversation column, driven end to end: the card is
 * mounted by the same line that mounts it in `/chat`, it reads and decides
 * through the widget's OWN credential with cookies omitted, and it draws the
 * reading the ratified drawing gives every host.
 *
 * §V, at the contract's pin: "one pill per skill, each carrying a checkbox in
 * front of its label … The row and its Continue are the whole card. There is no
 * heading plate above the row, and a pill carries nothing to press — no Confirm,
 * no Adjust, no Skip." §IX: "Every card appears on every host, and it is the
 * same card wherever it appears … Only the frame changes — the thread, the
 * widget's panel, the run card's detail column, the gate region of the review
 * page."
 *
 * WHAT IS DRIVEN HERE, and each of it on the REAL column rather than on the card
 * alone — the card composed by the widget arm is what a person on a third-party
 * page actually gets:
 *
 *   1. the PENDING card: checkbox pills, one Continue, nothing per pill;
 *   2. it is its OWN TURN: one card root, in the dispatch part's own container,
 *      after the assistant's dispatch line, with no run progress card stacked
 *      above it while the question is open;
 *   3. Continue decides through the BROKER, once per run, with the widget's own
 *      proof and `credentials: "omit"`;
 *   4. the SETTLED card: the same pills, read-only, no Continue;
 *   5. and it is STILL THERE AFTER A RELOAD — a fresh mount of the persisted
 *      transcript re-reads the authority and draws the same settled row.
 *
 * Run:
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/widget-skills-card-checkbox-reading.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, fireEvent, render, waitFor } from "@testing-library/react";

configure({ asyncUtilTimeout: 15_000 });

import type { UiMessage } from "../types";

// The composer reads `window.localStorage` on mount; jsdom under Node 25 exposes
// the property without its methods. Installed ONLY when it is missing, exactly
// as the chat arm's own suite installs it.
if (
  typeof globalThis.window !== "undefined" &&
  typeof window.localStorage?.getItem !== "function"
) {
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

const RUN_ID = "8f2a1c44-64f1-4f4e-9a3b-2ad6c7e15b90";
const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";

// The cookie-bound roads. They are mocked so the module graph resolves — and
// asserted NEVER CALLED, which is the half that keeps "the widget decided under
// its own credential" from passing on a card that quietly used a session.
const cookieConfirm = vi.fn(async () => ({ ok: true, dispatched: true }));
const cookieSkip = vi.fn(async () => ({ ok: true, dispatched: true }));
const cookieHoldRead = vi.fn(async () => ({ state: "none" }) as Record<string, unknown>);
vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: () => cookieHoldRead(),
  confirmRunRecommendationAction: () => cookieConfirm(),
  skipRunRecommendationAction: () => cookieSkip(),
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
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => (
    <div data-testid="inline-run-panel" data-run-id={runId} />
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/embed/assistant",
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

import { installWidgetServiceStub, surfaceElement } from "./conversation-column-harness";

/** The widget's own dispatch turn: the durable part, and the line beside it. */
function dispatchTurn(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "draft the Q3 post" },
    {
      id: "a1",
      role: "assistant",
      content: "",
      parts: [
        {
          kind: "tool_call",
          id: "widget_dispatch",
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

const CANDIDATES = [
  {
    skillId: "@cinatra-ai/chat:blog-content",
    skillRevisionId: "blog-content@7",
    name: "Blog content",
    vendorName: "Northstar",
    recommended: true,
    rank: 1,
    score: 0.9,
    scoredFeatures: [],
  },
  {
    skillId: "@cinatra-ai/chat:company-research",
    skillRevisionId: "company-research@2",
    name: "Company research",
    vendorName: "Northstar",
    recommended: false,
    rank: 2,
    score: 0.2,
    scoredFeatures: [],
  },
];

const HELD = {
  state: "held",
  runId: RUN_ID,
  agentPackageName: PACKAGE,
  promptText: "{}",
  holdRef: "hold-ref-3062-widget",
  canDecide: true,
  recommendations: CANDIDATES,
};

/** The settled hold a reader comes back to once the run is under way. */
const SETTLED_RUNNING = {
  state: "confirmed",
  runId: RUN_ID,
  skillNames: ["Blog content"],
  holdRef: "hold-ref-3062-widget",
  canDecide: true,
  runStarted: true,
  decided: [
    { skillId: CANDIDATES[0].skillId, name: "Blog content", mark: "confirmed" },
    { skillId: CANDIDATES[1].skillId, name: "Company research", mark: "skipped" },
  ],
  candidates: CANDIDATES.map((c) => ({
    skillId: c.skillId,
    skillRevisionId: c.skillRevisionId,
    name: c.name,
    vendorName: c.vendorName,
    rank: c.rank,
    recommended: c.recommended,
  })),
};

const CARD = '[data-lifecycle-card="recommendation_hold"]';

async function mountWidget(hold: () => unknown, decide?: (body: Record<string, unknown>) => unknown) {
  const stub = installWidgetServiceStub({
    lifecycle: () => null,
    recommendationHold: () => hold(),
    ...(decide ? { recommendationDecide: (body: Record<string, unknown>) => decide(body) } : {}),
  });
  const result = render(surfaceElement("widget", { messages: dispatchTurn() }));
  const root = await waitFor(
    () => {
      const found = result.container.querySelector<HTMLElement>(CARD);
      if (!found) throw new Error("the widget drew no recommendation card");
      return found;
    },
    { timeout: 15_000 },
  );
  return { stub, result, root };
}

const decisionCalls = (stub: { calls: Array<{ url: string; init: RequestInit }> }) =>
  stub.calls.filter((c) => c.url.includes("recommendation") && c.url.includes("decide"));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the widget draws §V's checkbox card inside a third-party page", () => {
  it("draws a checkbox per skill, one Continue, and nothing to press on a pill", async () => {
    const { stub, root, result } = await mountWidget(() => HELD);
    try {
      expect(root.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
      expect(root.getAttribute("data-lifecycle-card-state")).toBe("held");
      expect(root.getAttribute("data-run-recommendation-reading")).toBe("skills-checklist");
      expect(root.querySelectorAll("[data-skills-step-pill]")).toHaveLength(2);
      expect(root.querySelectorAll("[data-skills-step-checkbox]")).toHaveLength(2);
      expect(root.querySelectorAll("[data-skills-step-continue]")).toHaveLength(1);
      expect(root.querySelectorAll("[data-skill-action]")).toHaveLength(0);
      // Every pill names its skill and its vendor.
      expect(root.querySelectorAll("[data-skills-step-vendor]")).toHaveLength(2);
      expect(root.textContent).toContain("Blog content");
      expect(root.textContent).toContain("Northstar");
      // Inside the widget's own frame, in the conversation list it draws.
      const list = result.container.querySelector("[data-conversation-list]");
      expect(list?.contains(root)).toBe(true);
    } finally {
      stub.restore();
    }
  });

  it("is its own turn — one card, after the dispatch line, nothing stacked above it", async () => {
    const { stub, root, result } = await mountWidget(() => HELD);
    try {
      // ONE card root in the whole column: the widget arm mounts it once.
      expect(result.container.querySelectorAll(CARD)).toHaveLength(1);
      // In the dispatch part's OWN container — the producing slot.
      const slot = result.container.querySelector(`[data-agent-run-slot="${RUN_ID}"]`);
      expect(slot).not.toBeNull();
      expect(slot!.contains(root)).toBe(true);
      // NOTHING IS STACKED ABOVE IT, which is what the issue asks of this turn:
      // no run progress card over the open question, and no second lifecycle
      // card in the slot.
      expect(result.container.querySelector('[data-testid="inline-run-panel"]')).toBeNull();
      expect(slot!.querySelectorAll("[data-lifecycle-card]")).toHaveLength(1);

      // NAMED DEVIATION, MEASURED RATHER THAN ASSUMED (cinatra#3062). §V draws
      // the row "beneath the line" — the assistant says it dispatched the agent
      // and the row follows. In the shipped transcript the card is drawn at its
      // PRODUCING SLOT, the `agent_run` part's own container (S9i, and the
      // held-turn card contract requires exactly that), and a dispatch turn
      // emits the tool part BEFORE the text part — so the card precedes the
      // line. Moving it would take the card out of the container the contract
      // rules it into, which is neither this issue's scope nor a thing to do
      // silently. The order is pinned HERE, as it is, so it cannot change
      // without someone reading this note.
      //
      // The line is read off the DEEPEST element that carries it: an ancestor
      // contains both, and `compareDocumentPosition` calls a descendant
      // FOLLOWING, so an ancestor would answer whatever was asked of it.
      const TEXT = "paused for your decision on the recommended skills";
      const carriers = [...result.container.querySelectorAll("*")].filter(
        (el) =>
          el.textContent?.includes(TEXT) &&
          ![...el.children].some((c) => c.textContent?.includes(TEXT)),
      );
      expect(carriers, "the dispatch line is not in the turn").toHaveLength(1);
      const line = carriers[0]!;
      expect(line.contains(root), "the line is not an ancestor of the card").toBe(false);
      expect(
        line.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_PRECEDING,
        "the card is drawn at its producing slot, which precedes the dispatch text",
      ).toBeTruthy();
    } finally {
      stub.restore();
    }
  });

  it("decides through the BROKER, once per run, under the widget's own credential", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const { stub, root } = await mountWidget(
      () => HELD,
      (body) => {
        bodies.push(body);
        return { ok: true, dispatched: true };
      },
    );
    try {
      const cont = root.querySelector<HTMLButtonElement>("[data-skills-step-continue]")!;
      await act(async () => {
        fireEvent.click(cont);
      });
      await waitFor(() => expect(bodies).toHaveLength(1));

      // The whole row, answered in one act: the recommended box was ticked, the
      // other was not.
      expect(bodies[0]).toMatchObject({
        runId: RUN_ID,
        decision: "confirm",
        confirmedSkillIds: [CANDIDATES[0].skillId],
        holdRef: "hold-ref-3062-widget",
      });
      const sent = decisionCalls(stub);
      expect(sent).toHaveLength(1);
      expect(sent[0].init.method).toBe("POST");
      expect(sent[0].init.credentials).toBe("omit");
      expect(
        (sent[0].init.headers as Record<string, string>)["X-Cinatra-Widget-User-Token"],
      ).toBe("cwu_user");

      // A SECOND PRESS CHANGES NOTHING — one release per run.
      await act(async () => {
        fireEvent.click(cont);
      });
      expect(bodies).toHaveLength(1);

      // …and no cookie-bound road was taken from this host.
      expect(cookieConfirm).not.toHaveBeenCalled();
      expect(cookieSkip).not.toHaveBeenCalled();
      expect(cookieHoldRead).not.toHaveBeenCalled();
    } finally {
      stub.restore();
    }
  });

  it("draws the settled card read-only once the run is under way", async () => {
    const { stub, root } = await mountWidget(() => SETTLED_RUNNING);
    try {
      expect(root.getAttribute("data-lifecycle-card-state")).toBe("decided");
      expect(root.getAttribute("data-skills-step-editable")).toBe("false");
      // Each pill states in its own box whether that skill was applied.
      const applied = Object.fromEntries(
        [...root.querySelectorAll("[data-skills-step-pill]")].map((p) => [
          p.getAttribute("data-skill-id"),
          p.getAttribute("data-skill-applied"),
        ]),
      );
      expect(applied).toEqual({
        [CANDIDATES[0].skillId]: "true",
        [CANDIDATES[1].skillId]: "false",
      });
      for (const box of root.querySelectorAll<HTMLButtonElement>("[data-skills-step-checkbox]")) {
        expect(box.disabled).toBe(true);
      }
      // No Continue is left beneath it, and nothing is left to press.
      expect(root.querySelector("[data-skills-step-continue]")).toBeNull();
      expect(root.querySelectorAll("[data-skill-action]")).toHaveLength(0);
      // …and no outcome panel stands in for the row (cinatra#3062 refinement 2).
      expect(root.querySelector("[data-recommendation-outcome-panel]")).toBeNull();
    } finally {
      stub.restore();
    }
  });

  it("is STILL THERE after a reload, re-read through the widget's own transport", async () => {
    // A reload tears the frame down and rebuilds it from the persisted
    // transcript. The card is durable state, not client state, so what comes
    // back must be what the run recorded — and it must come back through the
    // host's own credential, because a reloaded third-party frame has no
    // session to fall back to.
    const first = await mountWidget(() => SETTLED_RUNNING);
    const readsBefore = first.stub.calls.filter((c) => c.url.includes("recommendation")).length;
    expect(readsBefore).toBeGreaterThan(0);
    first.stub.restore();
    cleanup();

    const second = await mountWidget(() => SETTLED_RUNNING);
    try {
      expect(second.root.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
      expect(second.root.getAttribute("data-lifecycle-card-state")).toBe("decided");
      expect(second.root.querySelectorAll("[data-skills-step-pill]")).toHaveLength(2);
      expect(second.root.querySelector("[data-skills-step-continue]")).toBeNull();
      expect(
        second.stub.calls.filter((c) => c.url.includes("recommendation")).length,
      ).toBeGreaterThan(0);
      expect(cookieHoldRead).not.toHaveBeenCalled();
    } finally {
      second.stub.restore();
    }
  });
});
