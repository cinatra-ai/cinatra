// @vitest-environment jsdom
//
// REGENERATE IS REFUSED — VISIBLY — ON A LEGACY MULTI-TARGET GATE (cinatra#3080
// item 4, the fix leg after the first proof round).
//
// THE ISSUE'S OWN SENTENCE: "A gate that still pins more than one target (legacy
// rows from before one-review-per-artifact) refuses Regenerate with a stated
// reason and allows Comment and Continue; no new multi-target gate is minted."
//
// THE DECISION OPERATION ALREADY REFUSES IT — `submitReviewDecisionAction`
// answers `REGENERATE_MULTI_TARGET_REASON` for a gate whose pinned set is not of
// size one. What the first proof round saw is the other half of the sentence:
// the control was drawn LIVE on the combined gate, so the refusal was something
// a person discovered by pressing. A refusal that is only reachable by pressing
// is a control that fails on press, which is exactly what the drawing's states
// forbid. So the floor draws it disabled, with the reason on screen, while
// Comment and Continue stay live.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import type {
  LifecycleCardState,
  LifecycleTargetHeader,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { REGENERATE_MULTI_TARGET_REASON } from "@/lib/artifacts/review-surface-model";

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
import { ReviewDecisionBar } from "../review-decision-bar";

function header(n: number): LifecycleTargetHeader {
  return {
    title: `Blog idea ${n}`,
    typeLabel: "Blog post",
    objectType: "@cinatra-ai/blog-post:draft",
    revisionId: `rev_idea_${n}`,
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

function mockResolve(
  state: LifecycleCardState,
  targetHeaders: LifecycleTargetHeader[],
  pinnedTargetCount?: number,
) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "artifact_review_gate",
          state,
          body: null,
          targetHeaders,
          ...(pinnedTargetCount === undefined ? {} : { pinnedTargetCount }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

function renderCard(headers: LifecycleTargetHeader[], pinnedTargetCount?: number) {
  refSeq += 1;
  mockResolve(
    { state: "pending", canDecide: true, canComment: true },
    headers,
    pinnedTargetCount,
  );
  return render(
    <LifecycleCardSurfaceProvider host="page_gate_region">
      <ReviewGateCard
        view={{
          viewType: "artifact_review_gate",
          schemaVersion: 1,
          ref: `ref-3080-multi-${refSeq}`,
        }}
      />
    </LifecycleCardSurfaceProvider>,
  );
}

const REGENERATE = '[data-action="regenerate-review -> changes-requested"]';
const COMMENT = '[data-action="comment-review -> annotated"]';
const CONTINUE = '[data-action="continue-review -> resolved"]';

describe("cinatra#3080 item 4 — the floor's own answer on a legacy multi-target gate", () => {
  it("draws Regenerate DISABLED with the stated reason, and keeps Comment and Continue live", async () => {
    const { container } = renderCard([header(1), header(2), header(3)]);

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    const bar = container.querySelector('[data-conformance-id="review-decision-bar"]')!;

    const regenerate = bar.querySelector(REGENERATE)!;
    expect(regenerate).not.toBeNull();
    expect(regenerate.hasAttribute("disabled")).toBe(true);
    expect(regenerate.getAttribute("aria-disabled")).toBe("true");

    // THE REASON IS ON SCREEN, not behind a press — and it is the ONE sentence
    // the decision operation refuses with, so a person hears the same answer
    // wherever they ask.
    const stated = bar.querySelector('[data-conformance-id="review-regenerate-refused"]');
    expect(stated).not.toBeNull();
    expect(stated!.textContent).toBe(REGENERATE_MULTI_TARGET_REASON);

    // COMMENT AND CONTINUE STILL WORK ON IT.
    expect(bar.querySelector(COMMENT)!.hasAttribute("disabled")).toBe(false);
    expect(bar.querySelector(CONTINUE)!.hasAttribute("disabled")).toBe(false);
  });

  it("a gate that pins ONE target keeps a live Regenerate and states nothing", async () => {
    const { container } = renderCard([header(1)]);

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    const bar = container.querySelector('[data-conformance-id="review-decision-bar"]')!;
    expect(bar.querySelector(REGENERATE)!.hasAttribute("disabled")).toBe(false);
    expect(bar.querySelectorAll('[data-conformance-id="review-regenerate-refused"]')).toHaveLength(
      0,
    );
  });

  it("the bar itself is the single drawing: the refusal rides one prop, on every surface", async () => {
    // The floor is ONE component mounted by the chat card, the run page's review
    // step, the review route and the widget, so a refusal wired into it is drawn
    // by all four. Read directly off the bar so the claim does not depend on a
    // host.
    const { container } = render(
      <ReviewDecisionBar
        permissions={{ canDecide: true, canComment: true }}
        submitAction={async () => ({ kind: "annotated" })}
        regenerateRefusal={REGENERATE_MULTI_TARGET_REASON}
      />,
    );
    const regenerate = container.querySelector(REGENERATE)!;
    expect(regenerate.hasAttribute("disabled")).toBe(true);
    expect(
      container.querySelector('[data-conformance-id="review-regenerate-refused"]')!.textContent,
    ).toBe(REGENERATE_MULTI_TARGET_REASON);
    expect(container.querySelector(CONTINUE)!.hasAttribute("disabled")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE REFUSAL IS A FACT ABOUT THE GATE, NOT ABOUT THE HEADERS THIS READER GOT
// (cinatra#3080 item 4, the convergence round of 2026-09-16).
// ---------------------------------------------------------------------------
//
// The resolve answer composes NO header for a pinned target whose actor-scoped
// read is not `ok` — a denied row, a tombstoned one. So a LEGACY gate pinning
// two artifacts hands a reader who may read one of them a single header. A floor
// that counted the headers drew Regenerate LIVE on exactly the gate item 4 says
// must refuse it, and the card drew its own header back above an island that is
// already pairing each header with its own panel. The answer therefore carries
// the GATE's pinned cardinality beside the reader's header list.

describe("a legacy gate whose rows this reader may not all read", () => {
  it("refuses Regenerate on a TWO-target gate that composed ONE header", async () => {
    const { container } = renderCard([header(1)], 2);

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    const bar = container.querySelector('[data-conformance-id="review-decision-bar"]')!;

    expect(bar.querySelector(REGENERATE)!.hasAttribute("disabled")).toBe(true);
    expect(
      bar.querySelector('[data-conformance-id="review-regenerate-refused"]')!.textContent,
    ).toBe(REGENERATE_MULTI_TARGET_REASON);
    // The other two are untouched by the refusal, exactly as item 4 says.
    expect(bar.querySelector(COMMENT)!.hasAttribute("disabled")).toBe(false);
    expect(bar.querySelector(CONTINUE)!.hasAttribute("disabled")).toBe(false);
  });

  it("draws NO header of its own for that gate — the island pairs each one with its body", async () => {
    const { container } = renderCard([header(1)], 2);

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    expect(container.querySelectorAll('[data-conformance-id="review-target-header"]')).toHaveLength(
      0,
    );
  });

  it("a ONE-target gate named as one keeps its live Regenerate and its own header", async () => {
    const { container } = renderCard([header(1)], 1);

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    const bar = container.querySelector('[data-conformance-id="review-decision-bar"]')!;
    expect(bar.querySelector(REGENERATE)!.hasAttribute("disabled")).toBe(false);
    expect(
      bar.querySelectorAll('[data-conformance-id="review-regenerate-refused"]'),
    ).toHaveLength(0);
    expect(container.querySelectorAll('[data-conformance-id="review-target-header"]')).toHaveLength(
      1,
    );
  });
});
