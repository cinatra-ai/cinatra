// @vitest-environment jsdom
//
// THE TARGET HEADER SITS DIRECTLY OVER ITS OWN REPRESENTATION — ON THE RUN
// PAGE'S REVIEW STEP AND THE REVIEW ROUTE ALIKE (cinatra#3080, the fix leg
// after the first proof round).
//
// `app-artifact-review.html` §IV: "Every target OPENS with a header that names
// what is under review and fixes it in place: the artifact's display title over
// a mono meta line carrying its type, the pinned representation revision (shown
// as a mono revision id with a pinned marker), and the read-only row facts the
// host authorized ... Beneath the header sits the representation slot."
//
// WHAT THE ROUND SAW. On a legacy gate pinning three targets the card stacked
// all three headers over ONE island holding all three bodies: the review route
// read as headers-then-bodies, and the run page's Review step read as three
// representations with no header on any of them. One composition, two readings,
// one cause.
//
// THE DIVISION. A gate that pins ONE target — every gate minted under
// one-review-per-artifact — keeps its header HERE, in the card, above the
// island, because that is the only place it survives the island's skeleton and
// its recovery panel (cinatra#3141 item 7). A legacy gate that pins several
// draws none here: the island pairs each header with its own body inside the one
// document that holds them (pinned by
// src/app/lifecycle/review-island/__tests__/each-target-over-its-own-body-3080).

import { afterEach, describe, expect, it, vi } from "vitest";
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

function header(n: number): LifecycleTargetHeader {
  return {
    title: `Blog idea ${n}`,
    typeLabel: "Blog post",
    objectType: "@cinatra-ai/blog-post:draft",
    revisionId: `rev_idea_000${n}`,
    facts: ["Team · Private", "text/markdown", "updated 2 min ago"],
  };
}

const realFetch = globalThis.fetch;
let refSeq = 0;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
});

function renderOn(
  host: "run_card" | "page_gate_region",
  targetHeaders: LifecycleTargetHeader[],
) {
  refSeq += 1;
  const state: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ kind: "artifact_review_gate", state, body: null, targetHeaders }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
  return render(
    <LifecycleCardSurfaceProvider host={host}>
      <ReviewGateCard
        view={{
          viewType: "artifact_review_gate",
          schemaVersion: 1,
          ref: `ref-3080-pairing-${refSeq}`,
        }}
        runId="run-3080"
        agentLabel="Blog Idea Generator"
        step={{ index: 4, total: 6 }}
      />
    </LifecycleCardSurfaceProvider>,
  );
}

describe("cinatra#3080 — the run page's Review step opens its target with the immutable header", () => {
  it("draws the header, with §IV's fields, DIRECTLY above the representation slot", async () => {
    const { container } = renderOn("run_card", [header(1)]);
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-target-island"]')).not.toBeNull(),
    );

    const headers = container.querySelectorAll('[data-conformance-id="review-target-header"]');
    expect(headers).toHaveLength(1);
    const drawn = headers[0]!;

    // §IV's fields: the title, the type, the pinned revision (with its marker)
    // and the row facts the host authorized.
    expect(drawn.textContent).toContain("Blog idea 1");
    expect(drawn.querySelector('[data-review-target-type="Blog post"]')).not.toBeNull();
    expect(drawn.querySelector('[data-review-target-revision="rev_idea_0001"]')).not.toBeNull();
    expect(drawn.textContent).toContain("pinned");
    expect(drawn.textContent).toContain("Team · Private");
    expect(drawn.textContent).toContain("text/markdown");
    expect(drawn.textContent).toContain("updated 2 min ago");

    // DIRECTLY above the slot: the very next element is the representation.
    expect(drawn.nextElementSibling!.getAttribute("data-conformance-id")).toBe(
      "review-target-island",
    );
  });

  it("a LEGACY multi-target gate stacks NO headers here — each one rides its own body", async () => {
    const { container } = renderOn("page_gate_region", [header(1), header(2)]);
    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-target-island"]')).not.toBeNull(),
    );

    expect(
      container.querySelectorAll('[data-conformance-id="review-target-header"]'),
    ).toHaveLength(0);
    // And the floor still governs the gate it was always drawn under.
    expect(
      container.querySelectorAll('[data-conformance-id="review-decision-bar"]'),
    ).toHaveLength(1);
  });
});
