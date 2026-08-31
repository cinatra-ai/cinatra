// @vitest-environment jsdom
//
// THE RECORDED NOTE IS ON THE SURFACE (cinatra#3080).
//
// `ReviewGateCard` is the one review renderer on all four hosts, so a note
// drawn here is a note the run page, the review page, the conversation and a
// third-party application all draw. Before this, a Comment through the floor
// reached the store and nothing else: the words appeared zero times in the page
// text of every surface, and no panel said they had been recorded.
//
// The shape is the cards drawing's own (§VII): a label over one panel per
// comment, each carrying its author kind in mono above the comment itself.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ReviewGateCard } from "../review-gate-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VIEW = { viewType: "artifact_review_gate" as const, schemaVersion: 1, ref: "ref-abc-123" };
const TYPED = "The second section needs a plainer opening sentence.";

function mockResolve(state: LifecycleCardState) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ kind: "artifact_review_gate", state, body: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

const HOSTS = ["chat_thread", "run_card", "page_gate_region"] as const;

function renderOn(host: (typeof HOSTS)[number]) {
  return render(
    <LifecycleCardSurfaceProvider host={host}>
      <ReviewGateCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

describe("the note a Comment recorded is drawn back to the reader", () => {
  for (const host of HOSTS) {
    it(`draws the reviewer's own words on a pending gate — ${host}`, async () => {
      mockResolve({
        state: "pending",
        canDecide: true,
        canComment: true,
        notes: [{ authorKind: "user", body: TYPED }],
      });
      const { container } = renderOn(host);
      await waitFor(() =>
        expect(container.querySelector('[data-conformance-id="review-recorded-notes"]')).not.toBeNull(),
      );
      expect(screen.getByText(TYPED)).not.toBeNull();
    });
  }

  it("keeps the gate open — a drawn note settles nothing", async () => {
    mockResolve({
      state: "pending",
      canDecide: true,
      canComment: true,
      notes: [{ authorKind: "user", body: TYPED }],
    });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    // The floor is untouched by the panel above it.
    expect(screen.getByRole("button", { name: /continue/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /regenerate/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /comment/i })).not.toBeNull();
  });

  it("names each note's author kind above it", async () => {
    mockResolve({
      state: "pending",
      canDecide: true,
      canComment: true,
      notes: [{ authorKind: "user", body: TYPED }],
    });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector("[data-review-note='0']")).not.toBeNull(),
    );
    expect(
      container.querySelector("[data-review-note='0']")?.getAttribute("data-review-note-author-kind"),
    ).toBe("user");
  });

  it("draws the notes on a RESTRICTED card — a reader who may not decide still reads them", async () => {
    mockResolve({
      state: "restricted",
      canDecide: false,
      canComment: true,
      reason: "Continuing or regenerating needs decision access on this run.",
      notes: [{ authorKind: "user", body: TYPED }],
    });
    renderOn("chat_thread");
    await waitFor(() => expect(screen.getByText(TYPED)).not.toBeNull());
  });

  it("keeps them on the SETTLED card, where the floor is gone", async () => {
    mockResolve({
      state: "settled",
      outcome: "approved",
      decidedByName: "Dana Reyes",
      notes: [{ authorKind: "user", body: TYPED }],
    });
    const { container } = renderOn("chat_thread");
    await waitFor(() => expect(screen.getByText(TYPED)).not.toBeNull());
    expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).toBeNull();
  });

  it("draws NO panel when the review carries no notes", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true, notes: [] });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-conformance-id="review-recorded-notes"]')).toBeNull();
  });

  it("draws NO panel when the state carries no notes field at all", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = renderOn("chat_thread");
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-conformance-id="review-recorded-notes"]')).toBeNull();
  });
});
