// @vitest-environment jsdom
/**
 * THE SKILLS ROW HAS ONE PLACE ON THE RUN PAGE (cinatra#3047).
 *
 * The requirement, in one sentence: the skills recommendation is a dedicated
 * step on the run page — the rail entry at the head of the run's steps, with its
 * chip-row filling the run detail beside the rail — and that is the only place
 * the row is drawn. The run-progress panel draws no copy of it at any moment.
 *
 * WHAT WAS WRONG, PHOTOGRAPHED. The row was drawn in two different places
 * depending on the run's moment: at the schedule moment beside the rail, in the
 * ordinary detail column, drawn by the run screen; at the HITL, working and
 * review moments INSIDE the run-progress panel, above the panel's own content,
 * drawn by `AgenticRunPanel`. One row, two owners, two placements, moving
 * between them as the run advanced.
 *
 * WHAT IS PINNED HERE, as DOM facts read off a mounted frame rather than off
 * source, because both halves were visible in the surface and neither was
 * measurable from source:
 *
 *   1. WHICH COLUMN the row's root is a descendant of, on EVERY branch of
 *      `runDetailPanelKind` — the picker that decides which panel the run detail
 *      mounts — with a HELD and a SETTLED fixture each, and none at all for a
 *      run that never held.
 *   2. WHERE IT IS NOT: outside `[data-run-review-slot]` and outside
 *      `[data-run-progress-panel]`, the two boxes the panel draws.
 *   3. HOW MANY: exactly one root. The `agentic` branch mounts the REAL panel
 *      here, so a panel that still drew its own copy is counted, not assumed
 *      away.
 *   4. The rail ENTRY stays first, reads live or settled correctly, and opening
 *      it draws the row in the detail column without a second instance.
 *
 * WHY THE FRAME AND NOT THE SCREEN. `SetupScreen` is a server component that
 * reaches the database; this file composes the frame exactly as that screen
 * composes it — one card node used by the step's surface and by the run detail,
 * which are mutually exclusive slots — and mounts the real run panel in the
 * detail. The screen's own composition is pinned separately, from source, in
 * `instance-screens-recommendation-step.test.ts`.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-page-recommendation-one-place.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { Button } from "@/components/ui/button";

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
    runId: "run-3047",
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

// The generated extension registry is a SERVER leaf the panel's graph reaches
// transitively. Nothing here measures it, and resolving it needs the installed
// extension packages, so it is replaced by its own empty shape — the same
// treatment `agentic-run-panel.decided-recommendation-no-skill-picker.test.tsx`
// gives it, and it keeps this file runnable wherever the workspace is checked
// out.
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {},
  STATIC_EXTENSION_RECORDS: [],
  GENERATED_EXTENSION_SERVER_ENTRIES: {},
  GENERATED_CONNECTOR_ENTRY_MODULES: {},
  GENERATED_CONNECTOR_MCP_MODULES: {},
  GENERATED_CONNECTOR_PRIMITIVE_HANDLERS: {},
  GENERATED_EXTERNAL_MCP_TOOLBOXES: {},
  GENERATED_WIDGET_STREAM_AGENTS: {},
  GENERATED_CHAT_WIDGET_MODULES: {},
  GENERATED_CHAT_WIDGET_MANIFEST_MODULES: {},
  GENERATED_DEV_SETUP_MODULES: {},
}));
// Same reason, for the generated field-renderer registry: its entries are
// dynamic imports of installed extension packages, and no HITL renderer is
// under test here.
vi.mock("@/lib/generated/field-renderer-components", () => ({
  GENERATED_FIELD_RENDERER_COMPONENTS: {},
}));

const { getRunRecommendationHoldStateAction } = vi.hoisted(() => ({
  getRunRecommendationHoldStateAction: vi.fn(),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  triggerAgentRun: vi.fn(async () => ({ ok: true })),
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
  })),
}));

// No live stream: what these pins are about is what the run's own state makes
// the frame draw, and a stream would supply its own values.
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

import { AgenticRunPanel } from "../agentic-run-panel";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { RecommendationHoldCard } from "../run-recommendation-chip-row";
import { RecommendationRailStepRow } from "../recommendation-rail-step";
import { recommendationRailEntry } from "../recommendation-rail-entry";
import { ScheduleRailStepRow } from "../schedule-rail-step";
import {
  RunSurfaceRail,
  useRunStepSelection,
  type RunStepSelection,
  type RunSurfaceRailStep,
} from "../run-surface-rail";
// TYPE ONLY. The branch names come from the production picker so this matrix
// cannot drift from it, and a type import loads no server module into jsdom.
import type { RunDetailPanelKind } from "../instance-screens";

const RUN_ID = "run-3047";
const PKG = "@cinatra-ai/blog-draft-writer-agent";

/** The four branches the run detail's right column can take. */
const PANEL_KINDS: readonly RunDetailPanelKind[] = ["none", "trigger", "stepper", "agentic"];

/** A run paused ON the question — the card draws its chips and its decisions. */
const HELD = {
  state: "held" as const,
  agentPackageName: PKG,
  promptText: "draft a blog post",
  recommendations: [
    {
      skillId: "skill-blog",
      skillRevisionId: "skill-blog@1",
      name: "Blog content",
      score: 0.9,
      rank: 1,
      recommended: true,
      scoredFeatures: [],
    },
  ],
  holdRef: "hold-ref-3047",
  canDecide: true,
};

/** A run whose question was answered — the read-only settled summary. */
const SETTLED = {
  state: "confirmed" as const,
  runId: RUN_ID,
  skillNames: ["Blog content"],
  decided: [{ skillId: "skill-blog", name: "Blog content", mark: "confirmed" }],
};

/** A run that never held: the card draws no DOM at all. */
const NONE = { state: "none" as const };

beforeEach(() => {
  getRunRecommendationHoldStateAction.mockReset();
  getRunRecommendationHoldStateAction.mockResolvedValue(NONE);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** A rail row drawn BESIDE the gate steps — one of the run's own steps. */
function ReviewRow() {
  const selection = useRunStepSelection();
  return (
    <Button
      type="button"
      variant="ghost"
      data-testid="review-row"
      onClick={() => selection?.select("detail")}
    >
      Review
    </Button>
  );
}

/**
 * WHAT THE RUN DETAIL MOUNTS ON EACH BRANCH.
 *
 *   `none`    — a run that has not been triggered: no run panel at all.
 *   `trigger` — the scheduling step's form; it mounts no lifecycle card.
 *   `stepper` — the orchestrator column. Its only `RecommendationHoldCard`
 *               mount addresses the Dev Stepper's child-run preview, a
 *               different run behind an explicitly opened preview, so a
 *               stand-in stands for it here and the source fact is pinned in
 *               `instance-screens-recommendation-host.test.ts`.
 *   `agentic` — the REAL panel, because that is the branch whose panel drew the
 *               second copy. Nothing about it is stubbed away.
 */
function RunPanelForBranch({
  panel,
  moment,
}: {
  panel: RunDetailPanelKind;
  moment: "progress" | "working" | "review";
}) {
  if (panel === "none") return null;
  if (panel === "trigger") return <div data-testid="trigger-step-form" />;
  if (panel === "stepper") {
    return (
      <section data-testid="stepper-panel">
        <h2>Agentic Run Progress</h2>
      </section>
    );
  }
  return (
    <AgenticRunPanel
      runId={RUN_ID}
      initialStatus={moment === "review" ? "completed" : moment === "working" ? "running" : "pending_approval"}
      initialError={null}
      initialMessages={[]}
      agUiEnabled={false}
      templateId="tmpl-3047"
      agentPackageName={PKG}
      surface="agent-detail"
      initialReviewGate={
        moment === "review" ? { ref: "lcr-opaque-3047", awaiting: false } : { ref: null, awaiting: false }
      }
      // The slot reader is the panel's own network read; this frame is about
      // placement, so the run's seed is handed over instead of fetched.
      readReviewSlot={async () => ({ ref: null, awaiting: false })}
    />
  );
}

/**
 * The run surface, composed the way `SetupScreen` composes it: ONE card mount
 * used by the rail step's surface and by the run detail — two mutually exclusive
 * slots of the same frame — with the branch's run panel below it in the detail.
 */
function RunSurface({
  panel,
  hasPark,
  held,
  initialSelection,
  moment = "progress",
}: {
  panel: RunDetailPanelKind;
  hasPark: boolean;
  held: boolean;
  initialSelection: RunStepSelection;
  moment?: "progress" | "working" | "review";
}) {
  const card = (
    <LifecycleCardSurfaceProvider host="run_card">
      <RecommendationHoldCard runId={RUN_ID} agentPackageName={PKG} wireRef={null} />
    </LifecycleCardSurfaceProvider>
  );
  const entry = recommendationRailEntry({ hasPark, held });
  const steps: RunSurfaceRailStep[] = [];
  if (entry !== "none") {
    steps.push({
      key: "recommendation",
      row: (
        <RecommendationRailStepRow
          displayStep={steps.length + 1}
          settled={entry === "settled"}
        />
      ),
      surface: card,
    });
  }
  steps.push({
    key: "schedule",
    row: <ScheduleRailStepRow host="run_card" displayStep={steps.length + 1} />,
    surface: <div data-testid="schedule-surface" />,
  });
  return (
    <div
      className="flex items-start gap-6"
      data-run-detail-contract=""
      data-conformance-id="run-surface"
    >
      <RunSurfaceRail
        steps={steps}
        rail={<ReviewRow />}
        detail={
          <>
            {card}
            <RunPanelForBranch panel={panel} moment={moment} />
          </>
        }
        initialSelection={initialSelection}
      />
    </div>
  );
}

const detailColumn = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-run-detail-column]")!;
const railColumn = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-run-step-rail-column]")!;
const chipRows = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-run-recommendation-chip-row]"));
const railEntry = (c: HTMLElement) =>
  c.querySelector<HTMLElement>('[data-conformance-id="recommendation-rail-step"]');

/** The two boxes the run-progress panel draws. The row belongs in neither. */
function panelBoxes(c: HTMLElement): HTMLElement[] {
  return Array.from(
    c.querySelectorAll<HTMLElement>("[data-run-review-slot], [data-run-progress-panel]"),
  );
}

// ---------------------------------------------------------------------------
// CRITERION 1 — one owner, one place, on every branch.
// ---------------------------------------------------------------------------
describe.each(PANEL_KINDS)("runDetailPanelKind '%s'", (panel) => {
  it("draws the SETTLED row in the run detail column, in one instance, and never inside the run-progress panel", async () => {
    getRunRecommendationHoldStateAction.mockResolvedValue(SETTLED);
    // A settled run has executed, so the frame opens on the run detail — the
    // moment the panel used to draw its own copy at.
    const { container } = render(
      <RunSurface panel={panel} hasPark held={false} initialSelection="detail" moment="working" />,
    );

    await waitFor(() => expect(chipRows(container).length).toBeGreaterThan(0));
    // EXACTLY ONE. Two roots is the defect: one owner drew it beside the rail
    // and the other inside the panel.
    expect(chipRows(container)).toHaveLength(1);
    const row = chipRows(container)[0];
    expect(detailColumn(container).contains(row)).toBe(true);
    expect(railColumn(container).contains(row)).toBe(false);
    for (const box of panelBoxes(container)) {
      expect(box.contains(row)).toBe(false);
    }
  });

  it("draws the HELD row as the step's own surface, in one instance, and never inside the run-progress panel", async () => {
    getRunRecommendationHoldStateAction.mockResolvedValue(HELD);
    // A held run is paused ON the question, so the frame opens on that step.
    // (In production only the `none` branch can reach this state — a held run is
    // `pending_input` — and the frame's answer must not depend on the branch.)
    const { container } = render(
      <RunSurface panel={panel} hasPark held initialSelection="recommendation" />,
    );

    await waitFor(() => expect(chipRows(container).length).toBeGreaterThan(0));
    expect(chipRows(container)).toHaveLength(1);
    const row = chipRows(container)[0];
    expect(detailColumn(container).contains(row)).toBe(true);
    expect(railColumn(container).contains(row)).toBe(false);
    for (const box of panelBoxes(container)) {
      expect(box.contains(row)).toBe(false);
    }
  });

  it("draws no row at all for a run that never held", async () => {
    getRunRecommendationHoldStateAction.mockResolvedValue(NONE);
    const { container } = render(
      <RunSurface panel={panel} hasPark={false} held={false} initialSelection="detail" />,
    );

    await waitFor(() => {
      if (getRunRecommendationHoldStateAction.mock.calls.length === 0) {
        throw new Error("the hold was never read");
      }
    });
    expect(chipRows(container)).toHaveLength(0);
    expect(railEntry(container)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE REVIEW MOMENT — the slot the panel swaps its placeholder for the review
// screen in. The row is not in that box either, at either of its readings.
// ---------------------------------------------------------------------------
describe("the review moment on the agentic branch", () => {
  it.each([["working" as const], ["review" as const]])(
    "keeps the settled row in the run detail column while the panel's slot reads '%s'",
    async (moment) => {
      getRunRecommendationHoldStateAction.mockResolvedValue(SETTLED);
      const { container } = render(
        <RunSurface
          panel="agentic"
          hasPark
          held={false}
          initialSelection="detail"
          moment={moment}
        />,
      );

      await waitFor(() => expect(chipRows(container).length).toBeGreaterThan(0));
      const slot = container.querySelector<HTMLElement>("[data-run-review-slot]");
      expect(slot).not.toBeNull();
      expect(slot!.getAttribute("data-run-review-slot")).toBe(moment);
      expect(chipRows(container)).toHaveLength(1);
      expect(detailColumn(container).contains(chipRows(container)[0])).toBe(true);
      expect(slot!.contains(chipRows(container)[0])).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// CRITERION 2 — the rail entry keeps its place and its two readings.
// ---------------------------------------------------------------------------
describe("the rail entry", () => {
  it("is the FIRST row on the rail, ahead of the steps it would authorize", async () => {
    getRunRecommendationHoldStateAction.mockResolvedValue(SETTLED);
    const { container } = render(
      <RunSurface panel="agentic" hasPark held={false} initialSelection="detail" />,
    );

    await waitFor(() => expect(chipRows(container).length).toBeGreaterThan(0));
    const rows = Array.from(
      railColumn(container).querySelectorAll(
        '[data-conformance-id="recommendation-rail-step"], [data-conformance-id="schedule-rail-step"], [data-testid="review-row"]',
      ),
    );
    expect(
      rows.map((r) => r.getAttribute("data-conformance-id") ?? r.getAttribute("data-testid")),
    ).toEqual(["recommendation-rail-step", "schedule-rail-step", "review-row"]);
  });

  it("reads LIVE for a held run and SETTLED for a decided one", async () => {
    getRunRecommendationHoldStateAction.mockResolvedValue(HELD);
    const live = render(
      <RunSurface panel="none" hasPark held initialSelection="recommendation" />,
    );
    await waitFor(() => expect(chipRows(live.container).length).toBeGreaterThan(0));
    expect(railEntry(live.container)!.getAttribute("data-recommendation-step-settled")).toBe(
      "false",
    );
    expect(railEntry(live.container)!.getAttribute("data-recommendation-step-selected")).toBe(
      "true",
    );
    cleanup();

    getRunRecommendationHoldStateAction.mockResolvedValue(SETTLED);
    const settled = render(
      <RunSurface panel="agentic" hasPark held={false} initialSelection="detail" />,
    );
    await waitFor(() => expect(chipRows(settled.container).length).toBeGreaterThan(0));
    expect(
      railEntry(settled.container)!.getAttribute("data-recommendation-step-settled"),
    ).toBe("true");
  });

  it("opens the row in the run detail when it is selected — and still only one", async () => {
    getRunRecommendationHoldStateAction.mockResolvedValue(SETTLED);
    const { container } = render(
      <RunSurface panel="agentic" hasPark held={false} initialSelection="detail" moment="working" />,
    );

    await waitFor(() => expect(chipRows(container).length).toBeGreaterThan(0));
    fireEvent.click(railEntry(container)!);

    await waitFor(() =>
      expect(railEntry(container)!.getAttribute("data-recommendation-step-selected")).toBe(
        "true",
      ),
    );
    await waitFor(() => expect(chipRows(container).length).toBeGreaterThan(0));
    expect(chipRows(container)).toHaveLength(1);
    expect(detailColumn(container).contains(chipRows(container)[0])).toBe(true);
    // The step's surface REPLACES the run detail, so the panel's boxes are not
    // on the page at all while the gate is open.
    expect(panelBoxes(container)).toHaveLength(0);
  });
});
