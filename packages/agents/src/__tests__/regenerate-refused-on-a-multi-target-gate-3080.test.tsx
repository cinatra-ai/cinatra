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

function mockResolve(state: LifecycleCardState, targetHeaders: LifecycleTargetHeader[]) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "artifact_review_gate",
          state,
          body: null,
          targetHeaders,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

function renderCard(headers: LifecycleTargetHeader[]) {
  refSeq += 1;
  mockResolve({ state: "pending", canDecide: true, canComment: true }, headers);
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

const REGENERATE = '[data-action="regenerate-review -> successor-gate-opened"]';
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
// THE SIGNAL IS THE RESOLVE ANSWER'S TARGET HEADERS (cinatra#3080 item 4).
// ---------------------------------------------------------------------------
//
// The card draws the pre-press refusal from the one thing the resolve answer
// carries about the gate's targets: its `targetHeaders`, one per pinned target
// (review-gate-card.tsx, `regenerateRefusal={(targetHeaders?.length ?? 0) > 1 ...}`).
// The resolve answer carries no other target count, so this block pins exactly
// that signal at its boundary: the SMALLEST legacy multi-target gate (two pinned
// targets, two headers) is refused before the press; one header keeps Regenerate
// live. A floor that counted from any other field, or that refused only above
// two, goes red here. A reader who is handed fewer headers than the gate pins
// still meets the server's refusal (`submitReviewDecisionAction` answers
// `REGENERATE_MULTI_TARGET_REASON` for any pinned set whose size is not one).

describe("the pre-press refusal follows the resolve answer's target headers", () => {
  it("a TWO-target legacy gate (two headers) draws Regenerate disabled with the one sentence", async () => {
    const { container } = renderCard([header(1), header(2)]);

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    const bar = container.querySelector('[data-conformance-id="review-decision-bar"]')!;
    const regenerate = bar.querySelector(REGENERATE)!;
    expect(regenerate).not.toBeNull();
    expect(regenerate.hasAttribute("disabled")).toBe(true);
    expect(regenerate.getAttribute("aria-disabled")).toBe("true");
    const stated = bar.querySelectorAll('[data-conformance-id="review-regenerate-refused"]');
    expect(stated).toHaveLength(1);
    expect(stated[0]!.textContent).toBe(REGENERATE_MULTI_TARGET_REASON);
    expect(bar.querySelector(COMMENT)!.hasAttribute("disabled")).toBe(false);
    expect(bar.querySelector(CONTINUE)!.hasAttribute("disabled")).toBe(false);
  });

  it("a ONE-target gate (one header) keeps its live Regenerate, states nothing and draws its own header", async () => {
    const { container } = renderCard([header(1)]);

    await waitFor(() =>
      expect(container.querySelector('[data-conformance-id="review-decision-bar"]')).not.toBeNull(),
    );
    const bar = container.querySelector('[data-conformance-id="review-decision-bar"]')!;
    const regenerate = bar.querySelector(REGENERATE)!;
    expect(regenerate).not.toBeNull();
    expect(regenerate.hasAttribute("disabled")).toBe(false);
    expect(
      bar.querySelectorAll('[data-conformance-id="review-regenerate-refused"]'),
    ).toHaveLength(0);
    expect(container.querySelectorAll('[data-conformance-id="review-target-header"]')).toHaveLength(
      1,
    );
  });
});
