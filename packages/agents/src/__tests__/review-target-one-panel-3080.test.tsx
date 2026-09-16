// @vitest-environment jsdom
//
// ONE PANEL PER TARGET — THE IMMUTABLE HEADER OVER THE REPRESENTATION, INSIDE
// ONE BORDER (cinatra#3080, the fix leg after the second proof round).
//
// THE DRAWING'S OWN SENTENCE, read at design `specs/app-artifact-review.html`
// §IV: "Every target opens with a header that names what is under review and
// fixes it in place ... Beneath the header sits the representation slot — the
// single region into which the artifact's type renderer mounts". Its own markup
// draws exactly that: ONE bordered, rounded container, the header inside it
// carrying the separating rule ("border-bottom"), the representation directly
// beneath — no second box, no gap between the two.
//
// WHAT THE SECOND ROUND SAW. Each target was drawn as its own rounded HEADER
// card with a gap above a SEPARATE, nested body card: two bordered boxes with
// twelve pixels of nothing between them, where the drawing draws one panel.
//
// WHAT THIS FILE PINS, on the three surfaces the card is drawn on outside and
// inside a conversation: one bordered panel, the header and the representation
// as its two children in that order, and neither of them carrying a border or a
// rounding of its own.

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

const HEADER: LifecycleTargetHeader = {
  title: "Why migrations are the hardest part",
  typeLabel: "Blog post",
  objectType: "@cinatra-ai/blog-post:draft",
  revisionId: "rev_7f10aa21",
  facts: ["Team · Private", "text/markdown", "updated 2 min ago"],
};

let refSeq = 0;
function nextView() {
  refSeq += 1;
  return {
    viewType: "artifact_review_gate" as const,
    schemaVersion: 1,
    ref: `ref-3080-panel-${refSeq}`,
  };
}

const realFetch = globalThis.fetch;

function mockResolve(
  state: LifecycleCardState,
  targetHeaders: LifecycleTargetHeader[] | null,
  pinnedTargetCount: number = targetHeaders?.length ?? 1,
) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "artifact_review_gate",
          state,
          body: null,
          targetHeaders,
          pinnedTargetCount,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

function renderOn(host: "chat_thread" | "run_card" | "page_gate_region") {
  return render(
    <LifecycleCardSurfaceProvider host={host}>
      <ReviewGateCard view={nextView()} runId="run-3080" agentLabel="Blog Idea Generator" />
    </LifecycleCardSurfaceProvider>,
  );
}

beforeEach(() => {
  routerRefresh.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

const SURFACES = ["chat_thread", "run_card", "page_gate_region"] as const;

describe("cinatra#3080 — the target is ONE panel: its header over its representation", () => {
  for (const host of SURFACES) {
    it(`${host}: one bordered panel holds the header and the representation, with nothing between them`, async () => {
      mockResolve({ state: "pending", canDecide: true, canComment: true }, [HEADER]);
      const { container } = renderOn(host);

      await waitFor(() =>
        expect(container.querySelector('[data-conformance-id="review-target-island"]')).not.toBeNull(),
      );

      const panels = container.querySelectorAll('[data-conformance-id="review-target-panel"]');
      expect(panels).toHaveLength(1);
      const panel = panels[0] as HTMLElement;
      // The frame the drawing draws: one border, one rounding, on the panel.
      expect(panel.className).toContain("border");
      expect(panel.className).toContain("rounded-control");

      const header = panel.querySelector('[data-conformance-id="review-target-header"]') as HTMLElement;
      const island = panel.querySelector('[data-conformance-id="review-target-island"]') as HTMLElement;
      expect(header).not.toBeNull();
      expect(island).not.toBeNull();

      // Two children of ONE panel, in the drawing's order, with no element
      // between them — no gap row, no second card.
      expect(header.parentElement).toBe(panel);
      expect(island.parentElement).toBe(panel);
      expect(header.nextElementSibling).toBe(island);
      expect(panel.children).toHaveLength(2);

      // NEITHER half carries a frame of its own: the header draws only the rule
      // that separates it from the work beneath it.
      expect(header.className).not.toContain("rounded-control");
      expect(header.className).toContain("border-b");
      expect(island.className).not.toContain("rounded-control");
      expect(island.className).not.toMatch(/(^|\s)border(\s|$)/);
    });
  }

  it("the SETTLED reading keeps the one panel too — the header the decision was taken on, over the work", async () => {
    mockResolve({ state: "settled", outcome: "approved", decidedByName: "Dana Okafor" }, [HEADER]);
    const { container } = renderOn("run_card");

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-target-island"]')).not.toBeNull(),
    );
    const panel = container.querySelector('[data-conformance-id="review-target-panel"]') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.querySelector('[data-conformance-id="review-target-header"]')).not.toBeNull();
    expect(panel.querySelector('[data-conformance-id="review-target-island"]')).not.toBeNull();
    expect(panel.children).toHaveLength(2);
  });

  it("a LEGACY multi-target gate draws no panel here: the island pairs each header with its own body", async () => {
    // The card draws no header for a gate that pins several targets, so there is
    // nothing to frame — the island's document draws each target's own panel.
    mockResolve(
      { state: "pending", canDecide: true, canComment: true },
      [HEADER, { ...HEADER, title: "A second idea", revisionId: "rev_7f10aa22" }],
      2,
    );
    const { container } = renderOn("run_card");

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-target-island"]')).not.toBeNull(),
    );
    expect(container.querySelectorAll('[data-conformance-id="review-target-panel"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-conformance-id="review-target-header"]')).toHaveLength(0);
    const island = container.querySelector('[data-conformance-id="review-target-island"]') as HTMLElement;
    // Unframed by a panel, it keeps its own frame.
    expect(island.className).toContain("rounded-control");
  });
});
