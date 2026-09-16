// @vitest-environment jsdom
//
// THE REVIEW CARD IN THE THREAD CARRIES NO HEADER STRIP (cinatra#3080, the fix
// leg after the first proof round).
//
// THE DRAWING'S OWN SENTENCE, read at design `specs/app-lifecycle-cards.html`
// §II: "One card, one gate. The review card fills the assistant's turn: the
// target panel naming what is under review and pinning its exact revision, then
// the decision floor that governs it." There is no third part. §II.1 says the
// same from the other side — "what the card puts around the display is the
// floor" — and the turn's own prose is the assistant's line above the card, not
// a strip inside it.
//
// WHAT THE ROUND SAW. The chat-hosted card opened with "Review requested · run
// <id> · Awaiting your decision" (and "Review · run <id>" once settled) — a
// header strip no drawing gives a card in a thread.
//
// THE DIVISION IS THE CONVERSATION, NOT THE GATE. The run detail and the review
// route are PAGES: `app-artifact-review.html` §III gives them a gate header
// inside the run detail ("the gate opens with a gate header ... then the review
// target, then the decision bar"), and they keep it. Only the card drawn inside
// a conversation drops it, exactly as #3481 divided the prompt window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import type {
  LifecycleCardState,
  LifecycleTargetHeader,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

// The prompt window's field pulls browser-only deps jsdom cannot load; the
// window itself is not what this file reads.
vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => <div>{placeholder}</div>,
}));
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ kind: "ok", entries: [] })),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ReviewGateCard } from "../review-gate-card";

/** A FRESH REF PER CASE. The resolve hook is keyed by ref, so two cases that
 *  share one would read each other's answer. */
let refSeq = 0;
function nextView() {
  refSeq += 1;
  return {
    viewType: "artifact_review_gate" as const,
    schemaVersion: 1,
    ref: `ref-3080-strip-${refSeq}`,
  };
}

const HEADER: LifecycleTargetHeader = {
  title: "Q3 re-engagement email",
  typeLabel: "Email",
  objectType: "@cinatra-ai/email:draft",
  revisionId: "rev_8f3a0011",
  facts: ["Team · Private", "text/html", "updated 8 min ago"],
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  routerRefresh.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

function mockResolve(state: LifecycleCardState, targetHeaders: LifecycleTargetHeader[] | null) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ kind: "artifact_review_gate", state, body: null, targetHeaders }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

function renderOn(
  host: "chat_thread" | "run_card" | "page_gate_region" | "site_widget",
) {
  return render(
    <LifecycleCardSurfaceProvider host={host}>
      <ReviewGateCard view={nextView()} runId="run-3080" agentLabel="Blog Idea Generator" />
    </LifecycleCardSurfaceProvider>,
  );
}

const cardRoot = (root: ParentNode) =>
  root.querySelector('[data-conformance-id="review-gate-card"]');

describe("cinatra#3080 — the chat-hosted review card puts the floor around the display and nothing else", () => {
  it("draws NO header strip in the thread: the target panel, then the floor", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true }, [HEADER]);
    const { container } = renderOn("chat_thread");

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    const card = cardRoot(container)!;
    expect(card).not.toBeNull();

    // The strip itself, by its own conformance id and by every word it draws.
    expect(card.querySelectorAll('[data-conformance-id="review-gate-header"]')).toHaveLength(0);
    expect(card.querySelectorAll("[data-review-gate-naming]")).toHaveLength(0);
    expect(card.textContent).not.toContain("Review requested");
    expect(card.textContent).not.toContain("Awaiting your decision");

    // WHAT IS LEFT IS THE DRAWING'S TWO PARTS, in the drawing's order: the
    // target panel naming what is under review, then the floor that governs it.
    const first = card.firstElementChild!;
    expect(first.getAttribute("data-conformance-id")).toBe("review-target-header");
    expect(first.textContent).toContain("Q3 re-engagement email");
    expect(card.querySelectorAll('[data-conformance-id="review-decision-bar"]')).toHaveLength(1);
  });

  it("the SETTLED chat card drops the strip too — no 'Review · run …' line", async () => {
    mockResolve(
      { state: "settled", outcome: "approved", decidedByName: "Dana Okafor" },
      [HEADER],
    );
    const { container } = renderOn("chat_thread");

    await waitFor(() => expect(cardRoot(container)).not.toBeNull());
    const card = cardRoot(container)!;
    await waitFor(() =>
      expect(card.querySelectorAll('[data-conformance-id="review-target-header"]')).toHaveLength(1),
    );
    expect(card.querySelectorAll('[data-conformance-id="review-gate-header"]')).toHaveLength(0);
    expect(card.querySelectorAll("[data-review-gate-naming]")).toHaveLength(0);
  });

  it("every host OUTSIDE a conversation keeps the page's own gate header", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true }, [HEADER]);
    const { container } = renderOn("run_card");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    expect(
      container.querySelectorAll('[data-conformance-id="review-gate-header"]'),
    ).toHaveLength(1);
    expect(container.textContent).toContain("Review requested");
    expect(container.textContent).toContain("Awaiting your decision");
  });

  it("the pending card in the thread is PAINTED, floor and all: Comment · Regenerate · Continue", async () => {
    // The criterion the re-cut carries: no ancestor of the card root hides it,
    // and the three floor controls are in the layout.
    mockResolve({ state: "pending", canDecide: true, canComment: true }, [HEADER]);
    const { container } = renderOn("chat_thread");

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    const card = cardRoot(container)!;
    for (
      let node: HTMLElement | null = card as HTMLElement;
      node !== null;
      node = node.parentElement
    ) {
      expect(node.hidden).toBe(false);
      expect(node.style.display).not.toBe("none");
    }
    const bar = card.querySelector('[data-conformance-id="review-decision-bar"]')!;
    expect(bar.querySelector('[data-action="comment-review -> annotated"]')).not.toBeNull();
    expect(bar.querySelector('[data-action="regenerate-review -> changes-requested"]')).not.toBeNull();
    expect(bar.querySelector('[data-action="continue-review -> resolved"]')).not.toBeNull();
  });
});
