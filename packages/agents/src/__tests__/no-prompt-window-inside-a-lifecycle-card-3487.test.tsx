// @vitest-environment jsdom
/**
 * E3 (the card half) — NO PROMPT WINDOW INSIDE A LIFECYCLE CARD, IN ANY HOST
 * (cinatra#3487).
 *
 * The ruling: "THE PROMPT WINDOW IS NEVER PART OF A LIFECYCLE SCREEN AND NEVER
 * INSIDE A LIFECYCLE CARD, IN ANY HOST." And the enforcement it names: "rendered
 * tests per host (chat thread, run page, review page, the third-party island):
 * every lifecycle card mounted in review, setup, schedule and blocked states
 * carries no prompt field, no textarea and no send control inside its card
 * root".
 *
 * THE CARD ROOT is the node the card publishes its host on —
 * `[data-lifecycle-card-host]` — which is the same node on all four hosts, so
 * one reading of "inside the card" serves every one of them.
 *
 * NO WAIVER, NO SKIP (E6).
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/no-prompt-window-inside-a-lifecycle-card-3487.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

// The real field pulls browser-only dependencies jsdom cannot load. The stub
// draws what the invariant looks for — a textarea and a send control — so a
// window drawn anywhere inside a card is VISIBLE to this test rather than
// invisible for want of the real component.
vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="prompt-field">
      <textarea placeholder={placeholder} readOnly value="" />
      <span role="button" aria-label="Apply AI suggestion" data-send-control="" />
    </div>
  ),
}));

vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ ok: true, entries: [] })),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ReviewGateCard } from "../review-gate-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VIEW = {
  viewType: "artifact_review_gate" as const,
  schemaVersion: 1,
  ref: "ref-3487",
};

const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
  credentials: "omit" as const,
};

function mockResolve(state: LifecycleCardState): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ kind: "artifact_review_gate", state, body: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

type Host = "chat_thread" | "run_card" | "page_gate_region" | "site_widget";
const HOSTS: Host[] = ["chat_thread", "run_card", "page_gate_region", "site_widget"];

/**
 * THE READING: what counts as a prompt window inside a card root.
 *
 * THE DECISION FLOOR'S OWN NOTE FIELD IS NOT ONE, and is excluded here by name.
 * The ratified drawing puts it inside the card: `app-lifecycle-cards.html` §II
 * — "Three affordances, weighted apart: Comment quiet at the left, Regenerate
 * in the outline treatment and Continue primary at the right, over the one note
 * field" — and `app-artifact-review.html` §I — "Both readings end in the same
 * floor — Comment, Regenerate, Continue, over the one Note field the person's
 * words go in". So a card root legitimately carries exactly one textarea, and
 * what this test measures is every OTHER prompt affordance: the window's field,
 * its send control, its anchor, and any textarea that is not the floor's note.
 */
function windowPartsInside(root: ParentNode): {
  fields: number;
  textareas: number;
  sendControls: number;
  anchors: number;
} {
  const cards = root.querySelectorAll("[data-lifecycle-card-host]");
  let fields = 0;
  let textareas = 0;
  let sendControls = 0;
  let anchors = 0;
  for (const card of cards) {
    fields += card.querySelectorAll('[data-testid="prompt-field"]').length;
    textareas += [...card.querySelectorAll("textarea")].filter(
      (t) => t.closest('[data-conformance-id="review-note-field-subordinate"]') === null,
    ).length;
    sendControls += card.querySelectorAll("[data-send-control]").length;
    anchors += card.querySelectorAll('[data-conformance-id="run-window"]').length;
  }
  return { fields, textareas, sendControls, anchors };
}

/** The floor the drawing DOES put inside the card, so its absence is a defect too. */
function noteFieldsInside(root: ParentNode): number {
  let n = 0;
  for (const card of root.querySelectorAll("[data-lifecycle-card-host]")) {
    n += card.querySelectorAll(
      '[data-conformance-id="review-note-field-subordinate"] textarea',
    ).length;
  }
  return n;
}

const STATES: Array<[string, LifecycleCardState]> = [
  // The review reading — the gate open, the reader able to comment. This is the
  // state the ruling was read on.
  ["review", { state: "pending", canDecide: true, canComment: true }],
  // The BLOCKED reading — the gate is there and the reader may not decide it.
  [
    "blocked",
    { state: "restricted", canDecide: false, canComment: true, reason: "Another reviewer owns this gate." },
  ],
  // Settled and superseded readings, which the rail keeps as history.
  ["settled", { state: "settled", outcome: "approved" }],
];

describe("E3 — a lifecycle card carries no prompt window, on any host", () => {
  for (const host of HOSTS) {
    for (const [label, state] of STATES) {
      it(`${host} / ${label}: no prompt field, no textarea, no send control inside the card root`, async () => {
        mockResolve(state);
        const { container } = render(
          <LifecycleCardSurfaceProvider
            host={host}
            auth={host === "site_widget" ? WIDGET_AUTH : undefined}
          >
            <ReviewGateCard view={VIEW} runId="run-3487" />
          </LifecycleCardSurfaceProvider>,
        );
        await waitFor(() =>
          expect(container.querySelectorAll("[data-lifecycle-card-host]").length).toBe(1),
        );
        // Give any window the card would mount the commits it needs to appear.
        await waitFor(() => expect(container.firstChild).not.toBeNull());
        const parts = windowPartsInside(container);
        expect(parts).toEqual({ fields: 0, textareas: 0, sendControls: 0, anchors: 0 });
        // And the floor the drawing DOES draw is untouched by the removal: on
        // the reading that carries a note field it is still there.
        if (label === "review") expect(noteFieldsInside(container)).toBe(1);
      });
    }
  }

  it("the review card mounts no window even when it names its run", async () => {
    mockResolve({ state: "pending", canDecide: true, canComment: true });
    const { container } = render(
      <LifecycleCardSurfaceProvider host="run_card">
        <ReviewGateCard view={VIEW} runId="run-3487" />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector("[data-lifecycle-card-host]")).not.toBeNull(),
    );
    // The old in-card mount published this anchor; nothing may draw it now.
    expect(
      container.querySelectorAll('[data-conformance-id="review-prompt-window"]').length,
    ).toBe(0);
  });
});
