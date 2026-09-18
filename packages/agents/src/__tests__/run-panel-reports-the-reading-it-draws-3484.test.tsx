// @vitest-environment jsdom
/**
 * THE RUN PANEL REPORTS THE READING IT IS DRAWING - FOR EVERY READING IT HAS
 * (cinatra#3484).
 *
 * WHY A TABLE AND NOT ONE CASE. The turn that hosts this panel inside a
 * conversation stands it down while a spent schedule card is the turn's record,
 * and that stand-down is right for every reading of the panel that asks the
 * reader nothing and wrong for the one reading that asks. A test of the one
 * reading the picture round happened to report would leave the next reading
 * anybody adds to fail first in a picture round; so the rows below are the
 * CENSUS of what this panel can draw, each row naming what it draws and whether
 * it asks, and the arm asserts the report against the row.
 *
 * THE PROPERTY, stated once and asserted per row: the panel reports TRUE
 * exactly when the reading it has selected is its review screen - the one
 * reading of this panel that mounts a lifecycle card able to ask the reader. A
 * reading that puts a lifecycle card root on screen while reporting false fails
 * here - which is what makes this table the floor for a reading added later
 * rather than a record of the readings that existed when it was written.
 *
 * AND WHAT IT DOES NOT SAY, written down so no reader takes it for more: the
 * report is about the reading the panel selected, not about what the card in it
 * resolved to. A review the reader may not read draws no card, and a settled
 * one draws a reading that asks nothing; both still report the review reading.
 * Reporting on the resolved state would have to come from the card itself, and
 * that wire is not opened here - it is the open question this arm leaves named.
 *
 * ONE ROW ASKS AND IS DELIBERATELY NOT COUNTED AS A LIFECYCLE CARD: the run
 * panel's own failed reading, with its Retry. It is the panel's error block, not
 * one of the lifecycle cards the drawing's section IX matrices govern, so no
 * sentence of that drawing makes a rule about it and this arm invents none - it
 * carries the row marked "asks, not a lifecycle card, stand-down unchanged" and
 * leaves it exactly as it stands. It is an open question for the run panel's own
 * drawing, recorded rather than silently skipped.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/run-panel-reports-the-reading-it-draws-3484.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } from "../agent-builder-ids";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return new Proxy({} as Record<string, () => null>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Loader2", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3484",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
  getSkillsForAgentAction: vi.fn(async () => []),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ kind: "ok", entries: [] })),
}));

const {
  readRunOutputEvidence,
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction,
  skipRunRecommendationAction,
} = vi.hoisted(() => ({
  readRunOutputEvidence: vi.fn(),
  getRunRecommendationHoldStateAction: vi.fn(),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction,
  skipRunRecommendationAction,
}));
vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  triggerAgentRun: vi.fn(async () => ({ ok: true })),
  readRunOutputEvidence,
}));

// No live stream: what is read here is what the run's own STATE makes the panel
// draw, and a stream would supply a status of its own.
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: null,
    error: null,
    presentationHint: null,
    isLive: false,
    interruptContext: null,
    streamedText: "",
    dataPartFrames: [],
  })),
}));

const RUN_ID = "run-3484";
const REVIEW_REF = "lcr-opaque-3484";
const REVIEW_SLOT = "[data-run-review-slot]";
const PROGRESS_PANEL = "[data-run-progress-panel]";
const ANY_LIFECYCLE_CARD = "[data-lifecycle-card]";

/** The answer the core's own suites use for an OPEN gate the reader may decide. */
const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

/** A MARKED artifact-review gate, parked mid-run, carrying the server-minted
 *  ref that is the only handle this panel has on it. */
const MARKED_REVIEW_GATE = {
  reviewTaskId: "review-task-3484",
  xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  fieldName: null,
  fields: [],
  currentValues: { lifecycleCardRef: REVIEW_REF },
};

/** A gate that needs INPUT - a setup field, not a review. */
const INPUT_GATE = {
  reviewTaskId: "review-task-setup-3484",
  xRenderer: "cinatra:form",
  fieldName: "recipient",
  fields: [{ name: "recipient", type: "string", required: true }],
  currentValues: {},
};

type PanelProps = Record<string, unknown>;

/** The panel's props for a row, on top of the shape every row shares. */
function panelProps(over: PanelProps = {}): PanelProps {
  return {
    runId: RUN_ID,
    initialStatus: "completed",
    initialError: null,
    initialMessages: [],
    agUiEnabled: false,
    templateId: "tmpl-3484",
    surface: "chat",
    initialHitlContext: null,
    initialReviewGate: null,
    // Every row answers its own slot read rather than reaching the default
    // same-origin reader: a row that draws no review must be able to say so.
    readReviewSlot: async () => ({ ref: null, awaiting: false }),
    ...over,
  };
}

/** The run's own row, seeded per row so the panel's 2s tick cannot move the
 *  reading out from under the reading being measured. */
function stubFetch(seed: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/agents/runs/")) {
      return new Response(JSON.stringify(seed), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(RESOLVE_PENDING), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function seedBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: null,
    reviewGate: null,
    ...over,
  };
}

/**
 * THE CENSUS, ONE ROW PER READING THE PANEL CAN DRAW.
 *
 * `asksAsALifecycleCard` is the property the report is asserted against.
 * `drawn` is what that reading puts on screen, waited for by its own marked
 * node so a row cannot pass on a panel that never reached its reading.
 */
const CENSUS: Array<{
  reading: string;
  draws: string;
  asksAsALifecycleCard: boolean;
  note?: string;
  props: PanelProps;
  seed: Record<string, unknown>;
  /** The node that proves this reading actually drew. */
  settled: (root: HTMLElement) => boolean;
}> = [
  {
    reading: "the review screen, reached from a parked marked gate",
    draws: "the shipped review card whole, with its decision floor",
    asksAsALifecycleCard: true,
    props: panelProps({
      initialStatus: "pending_approval",
      initialHitlContext: MARKED_REVIEW_GATE,
    }),
    seed: seedBody({ status: "pending_approval", hitlContext: MARKED_REVIEW_GATE }),
    settled: (root) =>
      root.querySelector(REVIEW_SLOT)?.getAttribute("data-run-review-slot") === "review",
  },
  {
    reading: "the review screen, reached from a completed run's own slot",
    draws: "the shipped review card whole, with its decision floor",
    asksAsALifecycleCard: true,
    props: panelProps({
      initialStatus: "completed",
      initialReviewGate: { ref: REVIEW_REF, awaiting: false },
      readReviewSlot: async () => ({ ref: REVIEW_REF, awaiting: false }),
    }),
    seed: seedBody({ reviewGate: { ref: REVIEW_REF, awaiting: false } }),
    settled: (root) =>
      root.querySelector(REVIEW_SLOT)?.getAttribute("data-run-review-slot") === "review",
  },
  {
    reading: "the working placeholder",
    draws: "the frame, the spinner and an empty review screen; it asks nothing",
    asksAsALifecycleCard: false,
    props: panelProps({ initialStatus: "running" }),
    seed: seedBody({ status: "running" }),
    settled: (root) =>
      root.querySelector(REVIEW_SLOT)?.getAttribute("data-run-review-slot") === "working",
  },
  {
    reading: "the progress plate",
    draws: "the heading, the status pill and the message list; it asks nothing",
    asksAsALifecycleCard: false,
    props: panelProps({ initialStatus: "completed" }),
    seed: seedBody(),
    settled: (root) => root.querySelector(PROGRESS_PANEL) !== null,
  },
  {
    reading: "the failed reading, with its Retry",
    draws: "the run panel's own error block and its Retry control",
    asksAsALifecycleCard: false,
    note: "asks, not a lifecycle card, stand-down unchanged",
    props: panelProps({ initialStatus: "failed", initialError: "WayFlow task failed" }),
    seed: seedBody({ status: "failed", error: "WayFlow task failed" }),
    settled: (root) =>
      root.querySelector(PROGRESS_PANEL) !== null &&
      (root.textContent ?? "").includes("The run failed before completing."),
  },
  {
    reading: "a gate that needs input",
    draws: "nothing of its own inside a conversation - the turn's own screen card owns it",
    asksAsALifecycleCard: false,
    props: panelProps({
      initialStatus: "pending_approval",
      initialHitlContext: INPUT_GATE,
    }),
    seed: seedBody({ status: "pending_approval", hitlContext: INPUT_GATE }),
    settled: (root) => root.querySelector(PROGRESS_PANEL) !== null,
  },
];

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  readRunOutputEvidence.mockReset();
  readRunOutputEvidence.mockResolvedValue({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
    outputsUnavailable: false,
    unlinkableOutputs: 0,
  });
  getRunRecommendationHoldStateAction.mockReset();
  getRunRecommendationHoldStateAction.mockResolvedValue({ state: "none" });
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("cinatra#3484 - the panel reports the reading it draws", () => {
  for (const row of CENSUS) {
    it(`${row.reading} - ${row.asksAsALifecycleCard ? "asks" : "asks nothing"}: ${row.draws}`, async () => {
      stubFetch(row.seed);
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");

      const reports: Array<[string, boolean]> = [];
      const onReviewReadingChange = (runId: string, drawsReview: boolean) => {
        reports.push([runId, drawsReview]);
      };

      // Under the CONVERSATION's declaration, which is the host the stand-down
      // this report feeds belongs to.
      const { container } = render(
        <LifecycleCardSurfaceProvider host="chat_thread">
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <AgenticRunPanel
            {...(row.props as any)}
            onReviewReadingChange={onReviewReadingChange}
          />
        </LifecycleCardSurfaceProvider>,
      );

      // The reading actually drew: a row may not pass on a panel that never got
      // there.
      await waitFor(() => expect(row.settled(container)).toBe(true), { timeout: 10_000 });

      // THE REPORT MATCHES THE ROW. The LAST report is the panel's current
      // answer; the report is asserted to have happened at all, because "never
      // reported" and "reported false" are different failures and only one of
      // them is this row's.
      await waitFor(() => {
        expect(reports.length, "the panel reported no reading at all").toBeGreaterThan(0);
        expect(reports[reports.length - 1]).toEqual([RUN_ID, row.asksAsALifecycleCard]);
      }, { timeout: 10_000 });

      // AND THE REPORT IS THE TRUTH ABOUT WHAT IS ON SCREEN. This is the half
      // that makes the table a floor: a reading added later that puts a
      // lifecycle card root on screen without reporting fails HERE.
      const cards = container.querySelectorAll(ANY_LIFECYCLE_CARD);
      if (row.asksAsALifecycleCard) {
        expect(cards.length).toBeGreaterThan(0);
      } else {
        expect(
          cards.length,
          `${row.reading} draws a lifecycle card root while reporting no review`,
        ).toBe(0);
      }
    }, 20_000);
  }

  it("reports false when it leaves, so no container is left holding a stale reading", async () => {
    // A panel that unmounts while drawing a review would otherwise leave its
    // container believing a review is still on screen, and a stand-down open
    // for ever.
    stubFetch(seedBody({ reviewGate: { ref: REVIEW_REF, awaiting: false } }));
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");

    const reports: Array<[string, boolean]> = [];
    const view = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <AgenticRunPanel
          {...(panelProps({
            initialReviewGate: { ref: REVIEW_REF, awaiting: false },
            readReviewSlot: async () => ({ ref: REVIEW_REF, awaiting: false }),
          }) as any)}
          onReviewReadingChange={(runId: string, drawsReview: boolean) =>
            reports.push([runId, drawsReview])
          }
        />
      </LifecycleCardSurfaceProvider>,
    );

    await waitFor(() => expect(reports).toContainEqual([RUN_ID, true]), { timeout: 10_000 });
    view.unmount();
    expect(reports[reports.length - 1]).toEqual([RUN_ID, false]);
  }, 20_000);

  it("the census is the whole of what this panel draws for a reader", () => {
    // THE CENSUS'S OWN CONCLUSION, asserted rather than assumed: exactly one
    // reading of this panel draws a lifecycle card that asks the reader inside
    // a conversation, and it is the review screen. Two rows reach it, by the
    // two roads a review arrives on.
    const asking = CENSUS.filter((row) => row.asksAsALifecycleCard);
    expect(asking).toHaveLength(2);
    for (const row of asking) expect(row.reading).toContain("the review screen");
    // And the one row that asks WITHOUT being a lifecycle card is named, so it
    // is visible as an open question rather than silently absent.
    expect(CENSUS.filter((row) => row.note !== undefined).map((row) => row.note)).toEqual([
      "asks, not a lifecycle card, stand-down unchanged",
    ]);
  });
});
