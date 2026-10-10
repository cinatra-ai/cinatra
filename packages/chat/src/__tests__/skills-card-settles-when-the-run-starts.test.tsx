// @vitest-environment jsdom
/**
 * THE SKILLS CARD SETTLES WHEN THE RUN STARTS, WITHOUT A RELOAD (cinatra#3062,
 * refinement 1).
 *
 * The issue, in its own words: "The skill boxes stay editable as long as the
 * agent run has not started — a person who returns to the card can change the
 * selection until then; the read-only reading exists only once the run is
 * running." §V draws that reading: "Once the run has started the same pills are
 * drawn with the state their boxes were left in, read-only, and with no
 * Continue".
 *
 * WHAT WAS WRONG. The card re-reads its authority on mount, on a change of the
 * hold interrupt's wire ref, on focus, visibility and `online`, and on its own
 * decision. The conversation mounts it with no wire ref, and the run leaving its
 * pre-start statuses is none of those events — so the card kept its editable
 * reading and a live Continue on a run that was already `running`, until a
 * reload re-mounted it.
 *
 * WHAT IS DRIVEN HERE. The REAL conversation column, on both hosts: the real
 * transcript renderer and the real card, with the card's cookie-bound state
 * action, the run panel's chrome and the widget's server replaced, and the
 * run's seed route — the turn's own run-row watch — answered by a test double
 * of `fetch`. The run row first reads `pending_trigger` and then `running`; the
 * authority first answers `runStarted: false` and then `runStarted: true`. No
 * reload, no remount and no focus event happen in between.
 *
 * The watch reads the row on its own cadence, so the flip arrives one watch
 * interval after the row records the start — never on a reload.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/skills-card-settles-when-the-run-starts.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, render, waitFor } from "@testing-library/react";

// The column loads its message list behind a lazy boundary, and the run-row
// watch reads on its own cadence — the same budget the column's other suites
// give a mount.
configure({ asyncUtilTimeout: 15_000 });

import type { UiMessage } from "../types";

// The composer reads `window.localStorage` on mount; jsdom under Node 25
// exposes the property without its methods. Installed ONLY when it is missing,
// exactly as the column's other suites install it.
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

const RUN_ID = "3a0c5d7e-1b2f-4c6d-8e9f-3062a1b2c3d4";
const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";

/** Where the run stands, as its row and its authority both say. */
const run = vi.hoisted(() => ({ started: false, cookieReads: 0 }));

vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async () => {
    run.cookieReads += 1;
    return settled(run.started);
  },
  confirmRunRecommendationAction: async () => ({ ok: true, dispatched: false }),
  skipRunRecommendationAction: async () => ({ ok: true, dispatched: false }),
}));
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: async () => ({ state: "none" }),
}));
vi.mock("../../../agents/src/hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: async () => [],
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
}));
// The run panel's chrome belongs to the agents package's own suites.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => (
    <div data-testid="inline-run-panel" data-run-id={runId} />
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

import { resetDrawnRecommendationReadings } from "../../../agents/src/run-recommendation-reading-register";
import { installWidgetServiceStub, surfaceElement } from "./conversation-column-harness";

/** The dispatch turn a chat start produces: the durable part and its line. */
function dispatchTurn(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "draft the Q3 post" },
    {
      id: "a1",
      role: "assistant",
      content: "",
      parts: [
        {
          kind: "tool_call",
          id: "explicit_dispatch_pre_router",
          name: "agent_run",
          status: "completed",
          runId: RUN_ID,
          result: JSON.stringify({ runId: RUN_ID, status: "pending_trigger" }),
        },
        {
          kind: "text",
          content: `Dispatched \`${PACKAGE}\` (runId: \`${RUN_ID}\`, status: \`pending_trigger\`).`,
        },
      ],
    } as unknown as UiMessage,
  ];
}

const CANDIDATES = [
  {
    skillId: "@cinatra-ai/chat:blog-content",
    skillRevisionId: "blog-content@7",
    name: "Blog content",
    vendorName: "Northstar",
    recommended: true,
  },
  {
    skillId: "@cinatra-ai/chat:company-research",
    skillRevisionId: "company-research@2",
    name: "Company research",
    vendorName: "Northstar",
    recommended: false,
  },
];

/** The settled selection the reader made before the start, as the authority
 *  answers it: `runStarted` is read from the run row on every read. */
function settled(runStarted: boolean) {
  return {
    state: "confirmed",
    runId: RUN_ID,
    skillNames: ["Blog content"],
    holdRef: "hold-ref-3062-start",
    canDecide: true,
    runStarted,
    decided: [
      { skillId: CANDIDATES[0].skillId, name: "Blog content", mark: "confirmed" },
      { skillId: CANDIDATES[1].skillId, name: "Company research", mark: "skipped" },
    ],
    candidates: CANDIDATES,
  };
}

const CARD = '[data-lifecycle-card="recommendation_hold"]';
const RUN_SEED = "/api/agents/runs/";

const cardOf = (c: HTMLElement) => c.querySelector<HTMLElement>(CARD);
const boxesOf = (c: HTMLElement) =>
  Array.from(cardOf(c)?.querySelectorAll<HTMLElement>('[role="checkbox"]') ?? []);
const continueOf = (c: HTMLElement) =>
  cardOf(c)?.querySelector<HTMLElement>("[data-skills-step-continue]") ?? null;

let stub: ReturnType<typeof installWidgetServiceStub> | null = null;

beforeEach(() => {
  run.started = false;
  run.cookieReads = 0;
  resetDrawnRecommendationReadings();
  // The run row as the turn's own watch reads it, and the widget's server.
  stub = installWidgetServiceStub({
    lifecycle: () => null,
    recommendationHold: () => settled(run.started),
    runSeed: () => ({ status: run.started ? "running" : "pending_trigger" }),
  });
});
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = null;
});

async function editableThenReadOnly(surface: "chat" | "widget") {
  let focused = 0;
  const onFocus = () => {
    focused += 1;
  };
  window.addEventListener("focus", onFocus);
  try {
    const view = render(surfaceElement(surface, { messages: dispatchTurn() }));
    const { container } = view;

    // BEFORE THE START: the boxes take a change and Continue stands beneath them.
    await waitFor(() => expect(boxesOf(container)).toHaveLength(2));
    await waitFor(() => expect(continueOf(container)).not.toBeNull());
    expect(cardOf(container)!.getAttribute("data-skills-step-editable")).toBe("true");
    for (const box of boxesOf(container)) expect(box.hasAttribute("disabled")).toBe(false);
    // …and the turn's watch has read the row at its pre-start status.
    await waitFor(() =>
      expect(stub!.calls.some((call) => call.url.startsWith(RUN_SEED))).toBe(true),
    );

    // THE RUN STARTS: its row reads `running`, and the authority says so.
    run.started = true;

    // No reload, no remount, no focus event: the same turn redraws.
    await waitFor(() => expect(continueOf(container)).toBeNull());
    expect(cardOf(container)!.getAttribute("data-skills-step-editable")).toBe("false");
    expect(boxesOf(container)).toHaveLength(2);
    for (const box of boxesOf(container)) expect(box.hasAttribute("disabled")).toBe(true);
    // The same pills, in the state their boxes were left in.
    expect(boxesOf(container).map((b) => b.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
    ]);
    expect(focused).toBe(0);
    return container;
  } finally {
    window.removeEventListener("focus", onFocus);
  }
}

describe("the skills card settles when the run starts, without a reload", () => {
  it("in /chat: editable with Continue before the start, read-only with none after it", async () => {
    await editableThenReadOnly("chat");
    // The chat arm reads the card's authority through its own session action.
    expect(run.cookieReads).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("in the widget: the same two readings, under the widget's own credential", async () => {
    await editableThenReadOnly("widget");
    // The widget arm never touches the cookie road; it reads through its broker.
    expect(run.cookieReads).toBe(0);
    const holdReads = stub!.calls.filter(
      (call) => !call.url.startsWith(RUN_SEED) && String(call.init.body ?? "").includes(RUN_ID),
    );
    expect(holdReads.length).toBeGreaterThanOrEqual(2);
    for (const call of stub!.calls) expect(call.init.credentials).toBe("omit");
  }, 30_000);
});
