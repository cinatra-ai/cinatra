// @vitest-environment jsdom
/**
 * THE SCHEDULE CARD'S TURN DRAWS THE CARD (cinatra#3174, criteria 1 and 2).
 *
 * The card's own section is unambiguous about what shares its turn:
 *
 *   "The card is the scheduling step, in the turn — and it is the only thing
 *    drawn."
 *   "One card, five readings, and never a second card."
 *
 * and the conversation section puts it exactly where prose would be: "A card
 * takes that content slot, at the column's full width, exactly where prose
 * would otherwise sit." Every example turn in that section is an assistant line
 * and the card, and nothing else — no run-progress panel with its own heading
 * and placeholder line, and no second card carrying its own Continue.
 *
 * What shipped drew all three in ONE container: the `agent_run` part's slot
 * mounted the run panel, the agent's own next-screen card and the produced
 * views as siblings, so a turn whose schedule card had settled still carried a
 * progress heading, a placeholder line and a second decidable card beside it.
 *
 * WHAT THIS FILE MEASURES, AND WHY THE TWO STUBS ARE NOT OPAQUE. The mount
 * DECISION is what changed, so the two components the decision governs are
 * stubbed to draw exactly the nodes the departure named — the panel's own
 * heading and its "No messages yet." line, and a marked root for the next
 * screen. An opaque stub would hide the very thing being counted. The schedule
 * card itself is the REAL one, resolved through the real refetch seam against a
 * settled body, because the reading it elects is what the turn keys off.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/schedule-card-turn-3174.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, waitFor } from "@testing-library/react";

configure({ asyncUtilTimeout: 15_000 });

import type { UiMessage } from "../types";

if (typeof globalThis.window !== "undefined" &&
    typeof window.localStorage?.getItem !== "function") {
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

const RUN_ID = "7e2b1a44-0f65-4a2c-9a44-2f1e6a0b91cc";
const CARD_REF = "schedule-ref-3174";

// The two lines the run-progress panel draws that the departure named: its own
// heading, and the placeholder that stands in for a message list. Kept as the
// literal strings the panel uses so a rename there shows up here.
const PANEL_HEADING = "Agentic Run Progress";
const PANEL_PLACEHOLDER = "No messages yet.";

vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  // No hold on this run: the schedule is what parked it, not the skills row.
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

// THE RUN PANEL, drawing exactly what the departure counted - AND publishing a
// gate the way the real panel does (convergence). The stub is not inert on
// purpose: the panel is the conversation's only publisher of the run's gate
// changes, so a stub that published nothing could not tell a panel that stands
// down from one that was unmounted, which is the difference this file now has
// to measure.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({
    runId,
    onActiveGateChange,
  }: {
    runId: string;
    onActiveGateChange?: (
      runId: string,
      gate: {
        reviewTaskId: string;
        xRenderer: string;
        fieldName: string | null;
        fields: Array<{ name: string; type: string; required: boolean }>;
      } | null,
      instanceId: string,
    ) => void;
  }) => {
    // A gate that opens MID-RUN, after the turn was drawn - the case the run's
    // own signal exists for.
    React.useEffect(() => {
      onActiveGateChange?.(
        runId,
        {
          reviewTaskId: "review-task-3174",
          xRenderer: "cinatra:form",
          fieldName: "approval",
          fields: [{ name: "approval", type: "string", required: true }],
        },
        "instance-3174",
      );
    }, [runId, onActiveGateChange]);
    return (
      <div data-testid="inline-run-panel" data-run-id={runId}>
        <h3 data-testid="run-progress-heading">Agentic Run Progress</h3>
        <span data-testid="run-status-pill">queued</span>
        <p data-testid="run-progress-placeholder">No messages yet.</p>
      </div>
    );
  },
}));

// THE AGENT'S OWN NEXT SCREEN. Drawn unconditionally here: what is measured is
// WHERE it mounts, not whether the run has a screen open, and the real card
// self-gates to nothing without one. It reports the change signal it was handed,
// because whether that signal still arrives is criterion 1's own consequence.
vi.mock("@cinatra-ai/agents/agent-hitl-screen-card", () => ({
  AgentHitlScreenCard: ({ runId, wireRef }: { runId: string; wireRef: string | null }) => (
    <div data-testid="hitl-screen-card" data-run-id={runId} data-wire-ref={wireRef ?? "none"}>
      <span data-testid="hitl-screen-continue">Continue</span>
    </div>
  ),
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

import { LIFECYCLE_VIEW_SCHEMA_VERSION } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { LIFECYCLE_VIEW_RESOLVE_PATH } from "../renderable-views/lifecycle-card";
import { RUN_SEED_ROUTE } from "../run-seed-request";
import { mountSurface } from "./conversation-column-harness";

/** A fired one-off schedule, settled — the section's fifth reading. */
const SETTLED_FIRED_ONE_OFF = {
  phase: "settled",
  version: 1,
  agentName: "Q3 cohort sweep",
  runId: RUN_ID,
  schedule: { kind: "scheduled", runAt: "2026-07-14T09:00", timezone: "Europe/Berlin" },
  triggerType: "scheduled",
  scheduleCopy: "Once, at 2026-07-14 09:00",
  timezone: "Europe/Berlin",
  gatedSteps: [],
  released: true,
  arming: false,
  canSave: false,
  canCancel: false,
};

let restoreFetch: typeof globalThis.fetch;

beforeEach(() => {
  restoreFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    // THE RUN'S OWN ROW (cinatra#3044). The conversation's run container reads
    // it to learn which moment the run stands at; this run has already moved
    // past its schedule, which is what leaves the spent card as a reading of
    // its own and gives the run's progress panel back to criterion 1's rule.
    // Without an answer here the container would still be LOOKING, and a
    // container that is still looking withholds the panel outright - which
    // would hide the difference criterion 1 measures.
    if (url.startsWith(`${RUN_SEED_ROUTE}/`)) {
      return json({
        id: RUN_ID,
        status: "completed",
        lifecycleMoment: null,
        lifecycleCard: null,
      });
    }
    if (url === LIFECYCLE_VIEW_RESOLVE_PATH) {
      return json({
        kind: "trigger_schedule_proposal",
        state: { state: "settled" },
        body: SETTLED_FIRED_ONE_OFF,
        // THE FIRED READING RIDES THE ANSWER, BESIDE THE BODY (cinatra#3193) -
        // the version-1 settled body is `.strict()` and carries no such key.
        firedOnce: true,
      });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = restoreFetch;
});

/** The turn a schedule-parked chat dispatch produces: the `agent_run` part with
 *  the server-pinned run id, the schedule view it PRODUCED at that same step,
 *  and the assistant's own line. */
function scheduleTurn(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "Run this once on 14 July at 9 in the morning." },
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
              ref: CARD_REF,
            },
          ],
        },
        {
          kind: "text",
          content:
            "It ran at the time you set. A one-time schedule is spent once it fires, so the rows below are the record of it and cannot be changed.",
        },
      ],
    } as unknown as UiMessage,
  ];
}

async function mountScheduleTurn() {
  const result = await mountSurface("chat", { messages: scheduleTurn() });
  // ONE WAIT FOR THE SETTLED SHAPE, WHOLE. The turn reaches it in three steps -
  // the run's row answers that it has moved past its schedule, the spent card
  // takes its own place as a reading, and the card reports that reading into
  // the turn's register - and the container draws a different shape after each.
  // Waiting for one of them and then querying is what turns the counts below
  // into a race: the card is briefly between its two mounts. So the helper waits
  // for the shape all three have landed in, and asserts nothing the tests do not
  // assert again for themselves.
  await waitFor(() => {
    const card = result.container.querySelector(
      '[data-conformance-id="schedule-proposal-card"]',
    );
    if (card === null) throw new Error("the schedule card never drew");
    if (card.getAttribute("data-schedule-reading") !== "fired-one-off") {
      throw new Error("the card has not settled on its fired reading yet");
    }
    if (result.container.querySelector("[data-settled-moment-reading]") === null) {
      throw new Error("the spent card has not taken its own place yet");
    }
    if (result.container.querySelector(`[data-agent-run-screen-slot="${RUN_ID}"]`) === null) {
      throw new Error("the turn has not elected the settled shape yet");
    }
  });
  return result;
}

const turnContainer = (root: HTMLElement) =>
  root.querySelector(`[data-agent-run-slot="${RUN_ID}"]`);

/** Is this node reachable by a reader at all - or is it inside a subtree the
 *  page has taken out of the picture and out of the accessibility tree? */
const drawn = (node: Element | null) =>
  node !== null && node.closest("[hidden], [aria-hidden='true']") === null;

/** The text a reader can actually see, with every hidden subtree left out. */
function visibleText(root: Element): string {
  let out = "";
  for (const child of Array.from(root.children)) {
    if (child.hasAttribute("hidden") || child.getAttribute("aria-hidden") === "true") continue;
    out += visibleText(child);
  }
  return out + (root.children.length === 0 ? (root.textContent ?? "") : "");
}

describe("criterion 1 — the settled schedule card's turn carries no run-progress lines", () => {
  it("draws exactly one settled schedule card in the turn", async () => {
    const { container } = await mountScheduleTurn();
    const cards = container.querySelectorAll('[data-conformance-id="schedule-proposal-card"]');
    expect(cards.length).toBe(1);
    expect(turnContainer(container)?.contains(cards[0]!)).toBe(true);
  });

  it("draws no run-progress heading, no status pill and no placeholder line", async () => {
    const { container } = await mountScheduleTurn();

    // Not one of the panel's four nodes reaches the reader: each is either
    // absent or inside the stood-down subtree, which is `hidden` and
    // `aria-hidden`, so it is in neither the picture nor the reading order.
    for (const mark of [
      "inline-run-panel",
      "run-progress-heading",
      "run-status-pill",
      "run-progress-placeholder",
    ]) {
      const node = container.querySelector(`[data-testid="${mark}"]`);
      expect(drawn(node), `${mark} is still drawn beside the settled schedule card`).toBe(false);
    }
    // And the lines themselves, so a panel drawn without those marks is caught.
    expect(visibleText(container)).not.toContain(PANEL_HEADING);
    expect(visibleText(container)).not.toContain(PANEL_PLACEHOLDER);
    // The panel is stood down by name, not by accident.
    expect(
      container.querySelector(`[data-inline-run-panel-stood-down="${RUN_ID}"]`),
    ).not.toBeNull();
  });

  // CONVERGENCE: standing the panel down must not take the run's gate changes
  // down with it. The panel is this conversation's only publisher of them, and
  // a schedule card stays settled for the whole of the run that follows, so a
  // panel that was UNMOUNTED here would leave a gate that opens mid-run with
  // nothing to announce it - the screen would keep the answer it read on mount
  // until the reader refocused the window or reloaded the thread.
  it("keeps listening: the run's gate changes still reach the turn", async () => {
    const { container } = await mountScheduleTurn();
    const screen = await waitFor(() => {
      const el = container.querySelector('[data-testid="hitl-screen-card"]');
      if (el === null) throw new Error("the screen never drew");
      if (el.getAttribute("data-wire-ref") === "none") {
        throw new Error("no gate change reached the turn");
      }
      return el;
    });
    // The whole signature the slot builds, not the gate's id alone.
    expect(screen.getAttribute("data-wire-ref")).toBe(
      "review-task-3174::cinatra:form::approval::approval:string:1",
    );
  });
});

describe("criterion 2 — the agent's own next screen keeps its own place", () => {
  it("never shares the settled card's turn container", async () => {
    const { container } = await mountScheduleTurn();

    const screen = container.querySelector('[data-testid="hitl-screen-card"]');
    const card = container.querySelector('[data-conformance-id="schedule-proposal-card"]');
    expect(card).not.toBeNull();
    expect(screen).not.toBeNull();

    const turn = turnContainer(container);
    expect(turn).not.toBeNull();
    expect(turn!.contains(card!)).toBe(true);
    // The whole of criterion 2: the two roots are never both inside one turn
    // container, and neither is nested inside the other.
    expect(turn!.contains(screen!)).toBe(false);
    expect(card!.contains(screen!)).toBe(false);
    expect(screen!.contains(card!)).toBe(false);
  });

  it("still draws the screen — it is moved, not withheld", async () => {
    const { container } = await mountScheduleTurn();
    const screen = container.querySelector('[data-testid="hitl-screen-card"]');
    expect(screen).not.toBeNull();
    expect(screen!.getAttribute("data-run-id")).toBe(RUN_ID);
    // It is still INSIDE the conversation, in its own marked place.
    expect(container.querySelector("[data-conversation-list]")?.contains(screen!)).toBe(true);
    expect(
      container.querySelector(`[data-agent-run-screen-slot="${RUN_ID}"]`)?.contains(screen!),
    ).toBe(true);
  });
});

describe("a turn with NO schedule card is untouched", () => {
  it("keeps the panel and the screen in the run's own slot", async () => {
    const result = await mountSurface("chat", {
      messages: [
        { id: "u1", role: "user", content: "Run the proof agent" },
        {
          id: "a1",
          role: "assistant",
          content: "",
          parts: [
            { kind: "tool_call", id: "t1", name: "agent_run", status: "completed", runId: RUN_ID },
          ],
        } as unknown as UiMessage,
      ],
    });
    await waitFor(() => {
      if (result.container.querySelector('[data-testid="inline-run-panel"]') === null) {
        throw new Error("the run panel never drew");
      }
    });
    const turn = turnContainer(result.container);
    expect(turn).not.toBeNull();
    expect(drawn(turn!.querySelector('[data-testid="inline-run-panel"]'))).toBe(true);
    expect(drawn(turn!.querySelector('[data-testid="hitl-screen-card"]'))).toBe(true);
    expect(
      result.container.querySelector(`[data-agent-run-screen-slot="${RUN_ID}"]`),
    ).toBeNull();
    expect(
      result.container.querySelector("[data-inline-run-panel-stood-down]"),
      "a turn with no schedule card stands nothing down",
    ).toBeNull();
  });
});
