// @vitest-environment jsdom
/**
 * THE CHAT-HOSTED REVIEW CARD IS PAINTED, IN ITS PENDING STATE (cinatra#3080).
 *
 * The fifth proof round of this issue read the card in the thread and could not
 * photograph it:
 *
 *   "The review gate card is present in the thread's DOM at state pending, host
 *    run_card, conformance id review-gate-card, with exactly Comment, Regenerate
 *    and Continue and neither Reject nor Approve, but its own box measures x0 y0
 *    w0 h0 in both palettes, live on arrival and after a reload. The first hiding
 *    ancestor is an unclassed div with computed display none, four levels above
 *    the card; every ancestor above that is visible with real height."
 *
 * WHERE THAT DIV IS. This view draws the run's inline panel inside
 * `<div hidden aria-hidden data-inline-run-panel-stood-down>` whenever the turn
 * carries a SETTLED schedule card (cinatra#3174, criterion 1). A run dispatched
 * from the chat carries exactly that card once its trigger step has fired, and
 * the run's review gate is drawn INSIDE that same panel
 * (`data-run-review-slot="review"`, cinatra#2997) and nowhere else in the turn
 * (`one-review-card-per-run-per-turn`): the injected `artifact_review_gate` part
 * is suppressed for a turn that draws the run card. So the reader is shown a
 * turn with the decision taken out of it.
 *
 * WHAT #3174 TOOK AWAY IS THE PANEL'S PROGRESS READING — "its heading, its
 * status pill and its 'No messages yet.' line" — not a review the reader owes an
 * answer to. Criterion 1 names the three it counted, and a pending review gate
 * is none of them.
 *
 * WHAT IS REAL HERE AND WHAT STANDS IN. The schedule card is the REAL one,
 * resolved through the real refetch seam against a settled body, because the
 * reading it elects is what the turn keys off. The review card is the REAL
 * `ReviewGateCard` on its real `run_card` host, inside the REAL slot markup the
 * run panel draws it in (`agentic-run-panel.tsx`), so the floor under assertion
 * is the shipped floor and the ancestor chain under assertion is the shipped
 * chain. Only the panel's own chrome — the heading, the status pill, the
 * "No messages yet." line — stands in, exactly as the sibling #3174 suite stands
 * it in, because an opaque stub would hide the very thing being counted.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/chat-hosted-review-card-is-painted-3080.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, waitFor } from "@testing-library/react";

configure({ asyncUtilTimeout: 20_000 });

import type { UiMessage } from "../types";

if (
  typeof globalThis.window !== "undefined" &&
  typeof window.localStorage?.getItem !== "function"
) {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const RUN_ID = "2d0a38b4-e152-472a-b08c-496325dfe9ce";
const SCHEDULE_REF = "schedule-ref-3080";
const REVIEW_REF = "review-ref-3080";

vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async () => ({ state: "none" }),
  confirmRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
  skipRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
}));
vi.mock("../../../agents/src/hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: async () => [],
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => null,
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));
// THE AGENT'S OWN NEXT SCREEN. The real card self-gates to nothing without an
// open screen, and this turn has none; it stands in for the same reason the
// sibling #3174 suite stands it in — its module graph reaches the server
// runtime, which is what the four stand-ins above are for.
vi.mock("@cinatra-ai/agents/agent-hitl-screen-card", () => ({
  AgentHitlScreenCard: () => null,
}));

// THE RUN PANEL. Its chrome stands in — the heading, the status pill and the
// "No messages yet." line the #3174 departure counted — and its REVIEW SLOT is
// the real one: the same `section[data-run-review-slot="review"]` markup
// `agentic-run-panel.tsx` draws, holding the real `ReviewGateCard` under the
// real `run_card` host declaration. That is the subtree whose ancestors the
// proof round measured.
vi.mock("../inline-agent-run-card", async () => {
  const { LifecycleCardSurfaceProvider } = await import(
    "@cinatra-ai/agents/lifecycle-card-runtime"
  );
  const { ReviewGateCard } = await import("@cinatra-ai/agents/review-gate-card");
  const { LIFECYCLE_VIEW_SCHEMA_VERSION } = await import(
    "@cinatra-ai/agent-ui-protocol/renderable-views"
  );
  return {
    InlineAgentRunCard: ({ runId }: { runId: string }) => (
      <div className="my-2" data-inline-run-card={runId}>
        <div data-testid="run-progress-heading">Agentic Run Progress</div>
        <section
          className="soft-panel rounded-card px-6 py-5 flex flex-col gap-4"
          data-run-review-slot="review"
        >
          <LifecycleCardSurfaceProvider host="run_card">
            <ReviewGateCard
              view={{
                viewType: "artifact_review_gate",
                schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
                ref: REVIEW_REF,
              }}
              runId={runId}
            />
          </LifecycleCardSurfaceProvider>
        </section>
      </div>
    ),
  };
});

import { LIFECYCLE_VIEW_SCHEMA_VERSION } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { LIFECYCLE_VIEW_RESOLVE_PATH } from "../renderable-views/lifecycle-card";
import { RUN_SEED_ROUTE } from "../run-seed-request";
import { mountSurface } from "./conversation-column-harness";

/** The trigger step of a chat-dispatched run once it has fired: the settled
 *  reading, which is what stands the run panel down. */
const SETTLED_FIRED_ONE_OFF = {
  phase: "settled",
  version: 1,
  agentName: "Blog Idea Generator",
  runId: RUN_ID,
  schedule: { kind: "scheduled", runAt: "2026-09-15T09:00", timezone: "Europe/Berlin" },
  triggerType: "scheduled",
  scheduleCopy: "Once, at 2026-09-15 09:00",
  timezone: "Europe/Berlin",
  gatedSteps: [],
  released: true,
  arming: false,
  canSave: false,
  canCancel: false,
};

let restoreFetch: typeof globalThis.fetch;

/** THE RUN'S OWN ROW, per test (convergence, cinatra#3080). The default is the
 *  photographed shape — finished, at no open moment, its review gate already on
 *  file — and a test that is about the OTHER road rewrites the one field it is
 *  about. */
let runRow: Record<string, unknown>;

beforeEach(() => {
  runRow = {
    id: RUN_ID,
    status: "completed",
    lifecycleMoment: null,
    lifecycleCard: null,
    reviewGate: { ref: REVIEW_REF, awaiting: false },
  };
  restoreFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    // The run's own row: it has finished and stands at no open moment, so the
    // container neither withholds the panel nor keeps looking.
    if (url.startsWith(`${RUN_SEED_ROUTE}/`)) {
      return json(runRow);
    }
    if (url.startsWith(LIFECYCLE_VIEW_RESOLVE_PATH)) {
      let viewType = "artifact_review_gate";
      try {
        viewType = JSON.parse(String(init?.body ?? "{}")).viewType ?? viewType;
      } catch {
        // A caller that issued no body keeps the review kind.
      }
      if (viewType === "trigger_schedule_proposal") {
        return json({
          kind: "trigger_schedule_proposal",
          state: { state: "settled" },
          body: SETTLED_FIRED_ONE_OFF,
          firedOnce: true,
        });
      }
      return json({
        kind: "artifact_review_gate",
        state: { state: "pending", canDecide: true, canComment: true },
        body: null,
      });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = restoreFetch;
  vi.restoreAllMocks();
});

/** The turn a chat dispatch produces: the `agent_run` part with the
 *  server-pinned run id, the trigger card it produced at that same step, and
 *  the assistant's own line. */
function chatDispatchedRunTurn(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "Run the Blog Idea Generator." },
    {
      id: "a1",
      role: "assistant",
      content: "",
      parts: [
        {
          kind: "tool_call",
          id: "t1",
          name: "agent_run",
          status: "completed",
          runId: RUN_ID,
          views: [
            {
              viewType: "trigger_schedule_proposal",
              schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
              ref: SCHEDULE_REF,
            },
          ],
        },
        { kind: "text", content: "It ran. The output is waiting on your review." },
      ],
    } as unknown as UiMessage,
  ];
}

/** The first ancestor a reader's browser takes out of the picture, or null. */
function firstHidingAncestor(node: Element): Element | null {
  let current: Element | null = node.parentElement;
  while (current) {
    if (current.hasAttribute("hidden")) return current;
    if (current.getAttribute("aria-hidden") === "true") return current;
    const display = current.ownerDocument.defaultView?.getComputedStyle(current).display;
    if (display === "none") return current;
    current = current.parentElement;
  }
  return null;
}

/** A hiding ancestor, named the way the proof round names one. */
function describeNode(node: Element | null): string | null {
  if (node === null) return null;
  const attrs = Array.from(node.attributes)
    .map((a) => `${a.name}="${a.value}"`)
    .join(" ");
  return `<${node.tagName.toLowerCase()} ${attrs}>`.trim();
}

describe("the chat-hosted review card in its pending state is painted", () => {
  it("draws the card with no hidden ancestor, and its floor in the layout", async () => {
    const mounted = await mountSurface("chat", { messages: chatDispatchedRunTurn() });
    const root = mounted.container;

    // The turn reaches the shape the proof round photographed: the trigger card
    // settles, and the run's review gate is mounted on `run_card` beneath it.
    let found: HTMLElement | null = null;
    await waitFor(() => {
      const settled = root.querySelector('[data-conformance-id="schedule-proposal-card"]');
      if (settled === null) throw new Error("the trigger card never drew");
      found = root.querySelector<HTMLElement>('[data-conformance-id="review-gate-card"]');
      if (found === null) throw new Error("the review card never mounted in the thread");
      if (found.querySelector('[data-conformance-id="review-decision-bar"]') === null) {
        throw new Error("the review card has not reached its pending state yet");
      }
    });
    const card = found as unknown as HTMLElement;

    // 1. NOTHING HIDES IT. No ancestor of the card is taken out of the picture.
    expect(describeNode(firstHidingAncestor(card))).toBeNull();

    // 2. AND ITS FLOOR IS IN THE LAYOUT: the three the ratified drawing draws,
    //    each of them reachable by a reader.
    const floor = card.querySelector('[data-conformance-id="review-decision-bar"]');
    expect(floor).not.toBeNull();
    for (const action of [
      "comment-review -> annotated",
      "regenerate-review -> changes-requested",
      "continue-review -> resolved",
    ]) {
      const control = floor!.querySelector(`[data-action="${action}"]`);
      expect(control, `the floor draws ${action}`).not.toBeNull();
      expect(describeNode(firstHidingAncestor(control!))).toBeNull();
    }
  });

  // THE ASYNC ROAD (convergence finding, cinatra#3080). The run FINISHES before
  // its gate row exists — the sweeper opens the review after the fact — and this
  // container's watch ends at the terminal status, so the ref it reads is null
  // and no later look will ever correct it. The panel's own slot reader goes on
  // and draws the review a moment later; if the wrapper closed on the terminal
  // answer, it would draw it into a box nothing reopens.
  it("leaves the panel out of the wrapper while the run's review is still owed", async () => {
    runRow.reviewGate = { ref: null, awaiting: true };
    const mounted = await mountSurface("chat", { messages: chatDispatchedRunTurn() });
    const root = mounted.container;

    await waitFor(() => {
      if (root.querySelector('[data-conformance-id="schedule-proposal-card"]') === null) {
        throw new Error("the trigger card never settled");
      }
    });
    expect(
      describeNode(root.querySelector("[data-inline-run-panel-stood-down]")),
    ).toBeNull();
  });
});
