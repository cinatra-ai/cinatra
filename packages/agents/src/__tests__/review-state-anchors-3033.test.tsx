// @vitest-environment jsdom
/**
 * THE REVIEW READINGS' DESIGN ANCHORS (cinatra#3033).
 *
 * `app-artifact-review.html` §I.3 draws the run page's review step in two
 * readings, `run-review-step-post` and `run-review-step-picture`, and
 * `app-lifecycle-cards.html` §II.1 draws the featured image's card in the chat
 * thread, `review-card-post-with-featured-image`. The drawing tells the two
 * readings apart by the note field: on the picture it opens carrying the prompt
 * that made it, on the post it opens empty. The card reads that from the
 * resolve answer's `recordedPrompt` and names no artifact type.
 *
 * Each test mounts the REAL `ReviewGateCard` under a real host declaration and
 * answers its resolve, then counts every anchor: the right one exactly once and
 * the others never.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/review-state-anchors-3033.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

// The run page draws the prompt window under the card; its real field pulls
// browser-only dependencies jsdom cannot load, and no anchor is read from it.
vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: () => null,
}));

vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ ok: true, entries: [] })),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ReviewGateCard, reviewStateAnchor } from "../review-gate-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VIEW = {
  viewType: "artifact_review_gate" as const,
  schemaVersion: 1,
  ref: "ref-3033",
};

const PROMPT = "A long road over layered ground, cool light, no text.";

const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
const RESTRICTED: LifecycleCardState = {
  state: "restricted",
  canDecide: false,
  canComment: true,
  reason: "Another reviewer owns this gate.",
};

const ANCHORS = [
  "run-review-step-post",
  "run-review-step-picture",
  "review-card-post-with-featured-image",
] as const;
type Anchor = (typeof ANCHORS)[number];

function mockResolve(state: LifecycleCardState, recordedPrompt: string | null): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "artifact_review_gate",
          state,
          body: null,
          ...(recordedPrompt === null ? {} : { recordedPrompt }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

function counts(root: ParentNode): Record<Anchor, number> {
  return Object.fromEntries(
    ANCHORS.map((id) => [id, root.querySelectorAll(`[data-conformance-id="${id}"]`).length]),
  ) as Record<Anchor, number>;
}

function only(anchor: Anchor | null): Record<Anchor, number> {
  return Object.fromEntries(ANCHORS.map((id) => [id, id === anchor ? 1 : 0])) as Record<
    Anchor,
    number
  >;
}

async function mountedFloor(container: HTMLElement): Promise<void> {
  // The floor is drawn once the resolve answer has arrived.
  await waitFor(() =>
    expect(container.querySelector('[data-lifecycle-card-state="pending"], [data-lifecycle-card-state="restricted"]')).not.toBeNull(),
  );
}

describe("the run page's review step carries the reading it draws", () => {
  it("a review with no recorded prompt is the post's reading", async () => {
    mockResolve(PENDING, null);
    const { container } = render(
      <LifecycleCardSurfaceProvider host="run_card">
        <ReviewGateCard view={VIEW} runId="run-3033" />
      </LifecycleCardSurfaceProvider>,
    );
    // red-first-expect: "run-review-step-post": 0,
    await waitFor(() => expect(counts(container)).toEqual(only("run-review-step-post")));
    // The anchor is drawn inside the card, not around it.
    const card = container.querySelector('[data-conformance-id="review-gate-card"]');
    expect(card?.querySelector('[data-conformance-id="run-review-step-post"]')).not.toBeNull();
  });

  it("a review that recorded the prompt is the featured image's reading", async () => {
    mockResolve(PENDING, PROMPT);
    const { container } = render(
      <LifecycleCardSurfaceProvider host="run_card">
        <ReviewGateCard view={VIEW} runId="run-3033" />
      </LifecycleCardSurfaceProvider>,
    );
    // red-first-expect: "run-review-step-picture": 0,
    await waitFor(() => expect(counts(container)).toEqual(only("run-review-step-picture")));
    // The same trait the drawing names: the note opens with the prompt.
    const note = container.querySelector<HTMLTextAreaElement>('textarea[data-testid="review-rationale"]');
    expect(note?.value).toBe(PROMPT);
  });

  it("a restricted reader sees the same reading", async () => {
    mockResolve(RESTRICTED, PROMPT);
    const { container } = render(
      <LifecycleCardSurfaceProvider host="run_card">
        <ReviewGateCard view={VIEW} runId="run-3033" />
      </LifecycleCardSurfaceProvider>,
    );
    // red-first-expect: "run-review-step-picture": 0,
    await waitFor(() => expect(counts(container)).toEqual(only("run-review-step-picture")));
  });
});

describe("the chat thread carries the featured image's card", () => {
  it("the card with a recorded prompt carries the anchor", async () => {
    mockResolve(PENDING, PROMPT);
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <ReviewGateCard view={VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    // red-first-expect: "review-card-post-with-featured-image": 0,
    await waitFor(() =>
      expect(counts(container)).toEqual(only("review-card-post-with-featured-image")),
    );
  });

  it("the inline run panel inside the thread is still the thread", async () => {
    mockResolve(PENDING, PROMPT);
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCardSurfaceProvider host="run_card">
          <ReviewGateCard view={VIEW} runId="run-3033" />
        </LifecycleCardSurfaceProvider>
      </LifecycleCardSurfaceProvider>,
    );
    // red-first-expect: "review-card-post-with-featured-image": 0,
    await waitFor(() =>
      expect(counts(container)).toEqual(only("review-card-post-with-featured-image")),
    );
  });

  it("the post's card in the thread carries no anchor of a reading", async () => {
    mockResolve(PENDING, null);
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <ReviewGateCard view={VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await mountedFloor(container);
    expect(counts(container)).toEqual(only(null));
  });
});

describe("no reading is claimed where the card cannot tell", () => {
  for (const host of ["page_gate_region", "site_widget"] as const) {
    it(`${host}: neither reading is drawn`, async () => {
      mockResolve(PENDING, PROMPT);
      const { container } = render(
        <LifecycleCardSurfaceProvider
          host={host}
          auth={
            host === "site_widget"
              ? { headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }), credentials: "omit" }
              : undefined
          }
        >
          <ReviewGateCard view={VIEW} runId="run-3033" />
        </LifecycleCardSurfaceProvider>,
      );
      await mountedFloor(container);
      expect(counts(container)).toEqual(only(null));
    });
  }

  it("while the resolve answer is loading, neither run page reading is drawn", async () => {
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const { container } = render(
      <LifecycleCardSurfaceProvider host="run_card">
        <ReviewGateCard view={VIEW} runId="run-3033" />
      </LifecycleCardSurfaceProvider>,
    );
    // The resolve was asked and has not answered; the card holds no reading.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(counts(container)).toEqual(only(null));
  });

  it("a settled gate discloses no prompt, so it claims no reading", async () => {
    mockResolve({ state: "settled", outcome: "approved" }, null);
    const { container } = render(
      <LifecycleCardSurfaceProvider host="run_card">
        <ReviewGateCard view={VIEW} runId="run-3033" />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-lifecycle-card-state="settled"]')).not.toBeNull(),
    );
    expect(counts(container)).toEqual(only(null));
  });
});

describe("reviewStateAnchor — the rule", () => {
  const base = { host: "run_card" as const, insideConversation: false, recordedPrompt: null };

  it("decides each reading from the place and the recorded prompt", () => {
    // red-first-expect: reviewStateAnchor is not a function
    expect(reviewStateAnchor({ ...base, state: "pending" })).toBe("run-review-step-post");
    expect(reviewStateAnchor({ ...base, state: "pending", recordedPrompt: PROMPT })).toBe(
      "run-review-step-picture",
    );
    expect(reviewStateAnchor({ ...base, state: "pending", recordedPrompt: "" })).toBe(
      "run-review-step-post",
    );
    expect(
      reviewStateAnchor({ ...base, host: "chat_thread", insideConversation: true, state: "pending", recordedPrompt: PROMPT }),
    ).toBe("review-card-post-with-featured-image");
    expect(
      reviewStateAnchor({ ...base, host: "chat_thread", insideConversation: true, state: "pending" }),
    ).toBeNull();
    expect(reviewStateAnchor({ ...base, host: "page_gate_region", state: "pending", recordedPrompt: PROMPT })).toBeNull();
    expect(reviewStateAnchor({ ...base, host: null, state: "pending", recordedPrompt: PROMPT })).toBeNull();
  });

  it("claims nothing outside the states whose answer can carry the prompt", () => {
    // red-first-expect: reviewStateAnchor is not a function
    for (const state of ["loading", "settled", "advisory", "absent"] as const) {
      expect(reviewStateAnchor({ ...base, state, recordedPrompt: PROMPT })).toBeNull();
      expect(reviewStateAnchor({ ...base, state })).toBeNull();
    }
  });
});
