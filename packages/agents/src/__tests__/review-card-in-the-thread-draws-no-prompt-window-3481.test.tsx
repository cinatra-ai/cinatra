// @vitest-environment jsdom
//
// THE REVIEW CARD HOSTED IN THE THREAD MOUNTS NO PROMPT WINDOW (cinatra#3481).
//
// THE DRAWING'S OWN SENTENCE, read at `specs/app-lifecycle-cards.html` §II:
// "A change request is typed into that composer: Agent run & review §VI fixes
// typing a request as the whole affordance, and inside a conversation the
// composer at the foot of the thread is where it is typed. No prompt window is
// drawn inside a conversation — the prompt window is the box outside the chat."
//
// The card carried its window to every host that named a run, the conversation
// included, so a reader in the thread was given two boxes to type the same
// request into: the card's own window between the decision floor and the
// thread's composer, and the composer itself. What the drawing gives the
// conversation is the composer alone.
//
// THE DIVISION IS THE HOST, NOT THE RUN: the run page's card, the review page's
// gate region and the widget keep the window the drawing gives them there
// (§VI), and the case below holds them to it — so this gate is read as the one
// sentence it is and never as a retirement of the window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

// The window's field is the shared `PromptField`, which pulls browser-only deps
// jsdom cannot load. Stubbed to a plain element that surfaces the placeholder as
// text and carries a send marker — so "no prompt field and no send control
// inside the card" is read off real DOM rather than off the stub's absence.
vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="review-prompt-field">
      {placeholder}
      {/* A <span> marker, not a raw <button> — the ui-design-system gate bans
          raw buttons; this jsdom stub only needs a node carrying the testid. */}
      <span data-testid="review-prompt-send" />
    </div>
  ),
}));

// The run's stored exchange is a server action; the window reads it on mount.
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ kind: "ok", entries: [] })),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ReviewGateCard } from "../review-gate-card";

const VIEW = {
  viewType: "artifact_review_gate" as const,
  schemaVersion: 1,
  ref: "ref-3481",
};

/** The window's own reading, drawn from the shared panel's placeholder map. */
const OFFER = "Ask Cinatra about this review, or ask for changes to the work…";

/** The widget's credential declaration — the provider's fail-closed invariant. */
const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
  credentials: "omit" as const,
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  routerRefresh.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  // The suite installs its own `fetch`; the tier's other files get theirs back.
  globalThis.fetch = realFetch;
});

function mockResolve(state: LifecycleCardState): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ kind: "artifact_review_gate", state, body: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

function renderOn(
  host: "chat_thread" | "run_card" | "page_gate_region" | "site_widget",
  runId: string | undefined = "run-3481",
) {
  return render(
    <LifecycleCardSurfaceProvider
      host={host}
      auth={host === "site_widget" ? WIDGET_AUTH : undefined}
    >
      <ReviewGateCard view={VIEW} runId={runId} />
    </LifecycleCardSurfaceProvider>,
  );
}

const cardRoot = (root: ParentNode) =>
  root.querySelector('[data-conformance-id="review-gate-card"]');

describe("#3481 — no prompt window is drawn inside a conversation", () => {
  it("the chat-hosted card names its run and still mounts NO prompt window", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = renderOn("chat_thread");

    // The card is drawn and settled on its pending reading before anything is
    // read as absent — an assertion on an unmounted card proves nothing.
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    const card = cardRoot(container);
    expect(card).not.toBeNull();

    expect(card!.querySelectorAll('[data-conformance-id="review-prompt-window"]')).toHaveLength(0);
    expect(card!.querySelectorAll('[data-testid="review-prompt-field"]')).toHaveLength(0);
    expect(card!.querySelectorAll('[data-testid="review-prompt-send"]')).toHaveLength(0);
    expect(card!.textContent).not.toContain(OFFER);
    // Nowhere in the dispatched subtree either — not merely outside the card's
    // own frame, which would be the same box one wrapper further out.
    expect(container.querySelectorAll('[data-conformance-id="review-prompt-window"]')).toHaveLength(
      0,
    );
    expect(container.textContent).not.toContain(OFFER);
  });

  it("draws no window for a card the INLINE RUN PANEL mounts as a run card inside the thread", async () => {
    // THE SECOND ROAD INTO THE THREAD (codex round). The inline run panel is
    // drawn between the thread's turns and its composer, and it mounts this same
    // card under its OWN `run_card` declaration (`agentic-run-panel.tsx`, the
    // review screen's one mount). A gate that read only the nearest host would
    // have left the forbidden box exactly where the ruling saw it, so what is
    // read is the conversation the card is drawn IN.
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCardSurfaceProvider host="run_card">
          <ReviewGateCard view={VIEW} runId="run-3481" />
        </LifecycleCardSurfaceProvider>
      </LifecycleCardSurfaceProvider>,
    );

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    const card = cardRoot(container);
    expect(card).not.toBeNull();
    // The panel's own declaration still stands for everything else it decides —
    // only the window reads the conversation.
    expect(card!.getAttribute("data-lifecycle-card-host")).toBe("run_card");

    expect(container.querySelectorAll('[data-conformance-id="review-prompt-window"]')).toHaveLength(
      0,
    );
    expect(container.querySelectorAll('[data-testid="review-prompt-field"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="review-prompt-send"]')).toHaveLength(0);
    expect(container.textContent).not.toContain(OFFER);
  });

  it("keeps drawing the window on every host OUTSIDE a conversation", async () => {
    // THE RULING IS SCOPED TO THE CONVERSATION. The run detail, the review page's
    // gate region and the widget carry the window the drawing gives them, so the
    // gate above is a host division and never a retirement of the window.
    for (const host of ["run_card", "page_gate_region", "site_widget"] as const) {
      mockResolve({ state: "pending", canDecide: true, canComment: true });
      const { container } = renderOn(host);
      await waitFor(() =>
        expect(
          container.querySelectorAll('[data-conformance-id="review-prompt-window"]'),
        ).toHaveLength(1),
      );
      expect(container.textContent).toContain(OFFER);
      cleanup();
    }
  });
});
