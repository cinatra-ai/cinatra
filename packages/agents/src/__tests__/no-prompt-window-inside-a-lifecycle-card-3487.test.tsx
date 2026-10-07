// @vitest-environment jsdom
/**
 * E3 (the card half) — NO PROMPT WINDOW INSIDE A LIFECYCLE CARD, IN ANY HOST
 * (cinatra#3487).
 *
 * The ruling: "THE PROMPT WINDOW IS NEVER PART OF A LIFECYCLE SCREEN AND NEVER
 * INSIDE A LIFECYCLE CARD, IN ANY HOST." And the enforcement it names: "rendered
 * tests per host (chat thread, run page, review page, the third-party island):
 * every lifecycle card mounted in review, setup, schedule and blocked states
 * carries no prompt component or send control inside its card root. Ordinary
 * form fields and the approved subordinate rationale are not prompt components".
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
//
// THE FIELD IS THE SHADCN WRAPPER, never a raw element: the design-system
// boundary admits no exemption for a test file, and the wrapper renders the very
// `textarea` node, while the prompt-specific send marker makes its purpose
// positively identifiable. The factory
// is async so the wrapper is imported where the mock actually runs — a hoisted
// factory cannot close over a module-level import.
vi.mock("@cinatra-ai/sdk-ui", async () => {
  const { Textarea } = await import("@/components/ui/textarea");
  return {
    LoadingSpinner: () => null,
    PromptField: ({ placeholder }: { placeholder?: string }) => (
      <div data-testid="prompt-field">
        <Textarea placeholder={placeholder} readOnly value="" />
        <span role="button" aria-label="Apply AI suggestion" data-send-control="" />
      </div>
    ),
  };
});

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

/** Positive markers of prompt components, never a generic textarea exemption. */
const PROMPT_MARKERS = {
  anchors: '[data-conformance-id="review-prompt-window"], [data-conformance-id="schedule-prompt-window"], [data-conformance-id="schedule-window-over"]',
  fields: '[data-run-window-field], [data-conformance-id="chat-composer-primary"], [data-conversation-composer], [data-testid="chat-prompt-input"], [role="textbox"][aria-label="Apply AI suggestion"]',
  sendControls: 'button[aria-label="Apply AI suggestion"], [role="button"][aria-label="Apply AI suggestion"]',
} as const;

function windowPartsInside(root: ParentNode): {
  fields: number;
  sendControls: number;
  anchors: number;
} {
  const cards = root.querySelectorAll("[data-lifecycle-card-host]");
  let fields = 0;
  let sendControls = 0;
  let anchors = 0;
  for (const card of cards) {
    fields += card.querySelectorAll(PROMPT_MARKERS.fields).length;
    sendControls += card.querySelectorAll(PROMPT_MARKERS.sendControls).length;
    anchors += card.querySelectorAll(PROMPT_MARKERS.anchors).length;
  }
  return { fields, sendControls, anchors };
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
      it(`${host} / ${label}: no prompt component or send control inside the card root`, async () => {
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
        expect(parts).toEqual({ fields: 0, sendControls: 0, anchors: 0 });
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


describe("3487 positive prompt-marker controls", () => {
  it.each([
    ['panel', '<div data-conformance-id="review-prompt-window"></div>'],
    ['closed schedule window', '<div data-conformance-id="schedule-prompt-window"></div>'],
    ['closed schedule answer', '<p data-conformance-id="schedule-window-over"></p>'],
    ['window field', '<div data-run-window-field></div>'],
    ['primary composer', '<div data-conformance-id="chat-composer-primary"></div>'],
    ['thread composer', '<div data-conversation-composer></div>'],
    ['chat editor', '<div data-testid="chat-prompt-input"></div>'],
    ['prompt editor', '<div role="textbox" aria-label="Apply AI suggestion"></div>'],
    ['prompt send', '<button aria-label="Apply AI suggestion"></button>'],
  ])('identifies %s inside any actual card root, including beside the approved rationale', (_name, html) => {
    const root = document.createElement('section');
    root.innerHTML = '<section data-lifecycle-card-host="page_gate_region"><div data-conformance-id="review-note-field-subordinate"><textarea></textarea></div>' + html + '</section>';
    const parts = windowPartsInside(root);
    expect(parts.fields + parts.sendControls + parts.anchors).toBeGreaterThan(0);
    expect(noteFieldsInside(root)).toBe(1);
  });

  it('does not identify the approved note or a native setup form field as a prompt', () => {
    const root = document.createElement('section');
    root.innerHTML = '<section data-lifecycle-card-host="run_card"><div data-conformance-id="review-note-field-subordinate"><textarea></textarea></div><textarea name="native-setup-value"></textarea><button aria-label="Comment"></button></section>';
    expect(windowPartsInside(root)).toEqual({ fields: 0, sendControls: 0, anchors: 0 });
    expect(noteFieldsInside(root)).toBe(1);
  });
});
