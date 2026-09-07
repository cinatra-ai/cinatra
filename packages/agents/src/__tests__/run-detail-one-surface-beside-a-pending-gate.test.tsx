// @vitest-environment jsdom
/**
 * ONE SURFACE AT A TIME IN THE RUN DETAIL (cinatra#3149, acceptance item 2).
 *
 * The ratified drawing, `specs/app-artifact-review.html` at design main
 * 033a697c, section I:
 *
 *   "One page per gate — the step's own card, and nothing else. Selecting a
 *    step opens that step's page in the run detail, and the page carries the
 *    one card of the step it belongs to ... and two cards are never stacked in
 *    one detail."
 *
 * and section I.2, which gives a finished run a page of its OWN — "A finished
 * run says what it made. The rail's last entry is the run's own record, and
 * its page lists the run's work" — a page, not a panel stacked over the gate
 * the same run is still waiting at.
 *
 * WHAT THIS SUITE IS, HONESTLY. Issue #3149's item 2 was measured against a
 * `RunMadePanel` that lives on an unmerged branch and exists nowhere on `main`.
 * On `main` the run detail's terminal reading is the completion card
 * (`run-completion-affordances.tsx`), and the mutual exclusion the item asks
 * for is already the panel's structure: the completed branch elects the review
 * screen, the placeholder, or the completion card, and returns before the
 * completion card's own mount is reached (cinatra#2997, cinatra#3002 fix
 * leg 1). So this suite PINS an invariant that already holds rather than
 * fixing a break — it is the regression guard the acceptance item asks for,
 * standing on the surfaces that actually ship, so the reading cannot silently
 * regress into the stack the issue photographed on the other branch.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-detail-one-surface-beside-a-pending-gate.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["AlertCircle", "ArrowRight", "CalendarClock", "Clock", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  getSkillsForAgentAction: vi.fn(async () => []),
}));

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(() => new Promise<never>(() => {})),
  sendAgentBuilderMessage: vi.fn(async () => ({})),
}));

// The gate's own card is drawn elsewhere and has its own suites. What this one
// reads is WHICH SURFACE the detail elects, so the card stands in as a marker.
vi.mock("../review-gate-card", () => ({
  LIFECYCLE_VIEW_SCHEMA_VERSION: 1,
  ReviewGateCard: () => <div data-testid="review-gate-card" />,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: () => ({
    status: "completed",
    error: null,
    presentationHint: null,
    isLive: false,
    interruptContext: null,
    streamedText: "",
    dataPartFrames: [],
  }),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true,
    outputs: [],
    hasTranscript: true,
    hasStepResults: false,
    outputsUnavailable: false,
    unlinkableOutputs: 0,
  })),
}));

import { SetupCompletionWatcher } from "../setup-completion-watcher";
import type { SerializedAgentRunMessage } from "../agentic-run-panel";

type WatcherProps = React.ComponentProps<typeof SetupCompletionWatcher>;

function finalTranscriptRow(): SerializedAgentRunMessage {
  return {
    id: "msg-final-1",
    runId: "run-3149",
    sequence: 1,
    role: "assistant" as const,
    messageType: "final" as const,
    toolCallId: null,
    toolName: null,
    body: {
      messageType: "final" as const,
      role: "assistant" as const,
      text: "The post and its featured image are drafted.",
    },
    createdAt: "2026-09-06T01:32:09.185Z",
  };
}

/** The run page's own mount, for a run that EXECUTED and reached `completed`. */
function runPageProps(overrides: Partial<WatcherProps> = {}): WatcherProps {
  return {
    runId: "run-3149",
    agentId: "cinatra-ai/blog-writer-agent",
    instanceId: "run-3149",
    initialStatus: "completed",
    initialError: null,
    initialMessages: [finalTranscriptRow()],
    requiredFields: [],
    initialInputParams: {},
    agUiEnabled: false,
    runHasExecuted: true,
    triggerConfigured: true,
    initialStreamedText: "",
    ...overrides,
  };
}

/** The run's seed route's answer — the ONE road a first-party surface learns
 *  its review slot by (`parseRunReviewSlot`). */
function seedSlot(slot: { ref: string | null; awaiting: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ reviewGate: slot }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

/** Every terminal surface the run detail can elect, counted together. */
function terminalSurfaces(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-run-review-slot], [data-run-completion]"),
  ).map((el) =>
    el.hasAttribute("data-run-review-slot")
      ? `review-slot:${el.getAttribute("data-run-review-slot")}`
      : "completion-card",
  );
}

beforeEach(() => {
  seedSlot({ ref: null, awaiting: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("a finished run whose output still has an open gate draws ONE surface", () => {
  it("draws the gate's page and NOT the completion card", async () => {
    seedSlot({ ref: "gate-ref-post", awaiting: true });
    const { container } = render(<SetupCompletionWatcher {...runPageProps()} />);
    await waitFor(() =>
      expect(container.querySelector('[data-run-review-slot="review"]')).not.toBeNull(),
    );
    expect(container.querySelector("[data-run-completion]")).toBeNull();
    expect(terminalSurfaces(container)).toEqual(["review-slot:review"]);
  });

  it("draws the gate's placeholder alone while the review is still being opened", async () => {
    seedSlot({ ref: null, awaiting: true });
    const { container } = render(<SetupCompletionWatcher {...runPageProps()} />);
    await waitFor(() =>
      expect(container.querySelector('[data-run-review-slot="working"]')).not.toBeNull(),
    );
    expect(container.querySelector("[data-run-completion]")).toBeNull();
    expect(terminalSurfaces(container)).toEqual(["review-slot:working"]);
  });

  it("draws the completion card alone for a finished run with no gate on its output", async () => {
    seedSlot({ ref: null, awaiting: false });
    const { container } = render(<SetupCompletionWatcher {...runPageProps()} />);
    await waitFor(() =>
      expect(container.querySelector("[data-run-completion]")).not.toBeNull(),
    );
    expect(container.querySelector("[data-run-review-slot]")).toBeNull();
    expect(terminalSurfaces(container)).toEqual(["completion-card"]);
  });
});
