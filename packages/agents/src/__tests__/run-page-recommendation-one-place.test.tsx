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
 * REWRITTEN FOR THE REVIEW'S POINT D (2026-08-28). "Every HITL shows on its own
 * dedicated page. Do not show skills on top of a HITL card. Do not show the
 * skills on top of the review card or the schedule card or any other card
 * either." The one place became one PAGE: the row is the Skills step's own
 * surface and it is NOT in the run detail beside the later cards, so the arms
 * that measured "one row in the detail column at the HITL / working / review /
 * schedule moment" now measure ZERO there and one on the step's own page. The
 * frame below composes the detail the way the screen composes it now — the
 * branch's panel and nothing else.
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
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

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
      // The row takes no numeral (cinatra#3047): the drawing gives this entry
      // its own glyph, and the rail's numerals start on the step after it.
      row: <RecommendationRailStepRow settled={entry === "settled"} />,
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
        // THE RUN DETAIL IS THE BRANCH'S OWN PANEL, and nothing above it
        // (cinatra#3047, review point D). The card used to stand here too, so
        // every later card was drawn under a settled skills row.
        detail={<RunPanelForBranch panel={panel} moment={moment} />}
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

/**
 * SETTLING THE FRAME BEFORE AN ABSENCE IS MEASURED.
 *
 * Waiting for the row to appear is not available as a signal when the assertion
 * IS its absence, and neither is waiting for the authoritative resolve: since
 * the row is the Skills step's own surface, a page open on any other step never
 * mounts the card at all and never asks. That is itself part of point D and it
 * is asserted where it belongs, below; here the frame is simply flushed so the
 * absence is measured on a settled tree rather than on a first paint.
 */
async function settleFrame() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

// ---------------------------------------------------------------------------
// POINT 4 (the second review round) — NO CARD AROUND THE ROW.
//
// The pills and their Continue sit DIRECTLY in the run detail column beside the
// rail. The row's own suite measures its root in isolation; this measures the
// composition it is actually drawn in — the frame the run page builds — so a
// card supplied by the HOST rather than by the row would be caught here.
// ---------------------------------------------------------------------------

/**
 * Card chrome, as classes rather than as a vibe: an outline, a ground, a corner
 * radius, a drop shadow, or padding that insets content from an edge.
 */
const CARD_CHROME =
  /(^|\s)(border|border-[a-z]|rounded(-|$)|bg-(?!transparent)|shadow(-|$)|p-|px-|py-|pt-|pb-)/;

describe("point 4 — the Skills step sits directly in the detail column", () => {
  it("puts NOTHING with panel chrome between the detail column and the row's root", async () => {
    getRunRecommendationHoldStateAction.mockResolvedValue(HELD);
    const { container } = render(
      <RunSurface panel="none" hasPark held initialSelection="recommendation" />,
    );
    await settleFrame();

    const column = detailColumn(container);
    const root = column.querySelector<HTMLElement>("[data-run-recommendation-chip-row]");
    expect(root).not.toBeNull();

    // Walk the ancestors from the row's root up to the detail column: every one
    // of them must be free of card treatment, and the column itself too.
    let node: HTMLElement | null = root!;
    const seen: string[] = [];
    while (node && node !== column) {
      seen.push(node.className);
      node = node.parentElement;
    }
    expect(node).toBe(column);
    for (const className of seen) expect(className).not.toMatch(CARD_CHROME);
    expect(column.className).not.toMatch(CARD_CHROME);
  });

  it("draws the row as an immediate child of the detail column — no wrapper at all", async () => {
    getRunRecommendationHoldStateAction.mockResolvedValue(HELD);
    const { container } = render(
      <RunSurface panel="none" hasPark held initialSelection="recommendation" />,
    );
    await settleFrame();

    const column = detailColumn(container);
    const root = column.querySelector<HTMLElement>("[data-run-recommendation-chip-row]");
    // The surface is handed over BARE: the card is the whole of the step.
    expect(root!.parentElement).toBe(column);
  });

  it("does the same for the read-only reading after the run has started", async () => {
    getRunRecommendationHoldStateAction.mockResolvedValue({ ...SETTLED, runStarted: true });
    const { container } = render(
      <RunSurface panel="none" hasPark held={false} initialSelection="recommendation" />,
    );
    await settleFrame();

    const column = detailColumn(container);
    const root = column.querySelector<HTMLElement>("[data-run-recommendation-chip-row]");
    expect(root).not.toBeNull();
    expect(root!.parentElement).toBe(column);
    expect(root!.className).not.toMatch(CARD_CHROME);
    // …and no bordered outcome panel is drawn on this host at all.
    expect(column.querySelector("[data-recommendation-outcome-panel]")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POINT D — EVERY STEP ON ITS OWN PAGE. The detail column shows the selected
// step and nothing else, on every branch of `runDetailPanelKind`.
// ---------------------------------------------------------------------------
describe.each(PANEL_KINDS)("runDetailPanelKind '%s'", (panel) => {
  it("draws NO skills row in the run detail once the run has moved past the step", async () => {
    getRunRecommendationHoldStateAction.mockResolvedValue(SETTLED);
    const { container } = render(
      <RunSurface panel={panel} hasPark held={false} initialSelection="detail" moment="working" />,
    );

    await settleFrame();
    // NOT above the branch's own card — that is the whole of point D.
    expect(chipRows(container)).toHaveLength(0);
    expect(detailColumn(container).querySelectorAll("[data-recommendation-chip]")).toHaveLength(0);
    // The row is not merely hidden: it is not mounted, so the hold is not even
    // read on a page that is not the Skills step.
    expect(getRunRecommendationHoldStateAction).not.toHaveBeenCalled();
    // …and the rail still records that the step was completed.
    expect(railEntry(container)!.getAttribute("data-recommendation-step-settled")).toBe("true");
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

    await settleFrame();
    expect(chipRows(container)).toHaveLength(0);
    expect(railEntry(container)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE MOMENTS THE REVIEW NAMES — "Do not show skills on top of a HITL card. Do
// not show the skills on top of the review card or the schedule card or any
// other card either."
// ---------------------------------------------------------------------------
describe("the cards the skills row must not sit above", () => {
  it.each([
    ["the HITL moment", "agentic" as const, "progress" as const, "detail" as const],
    ["the working moment", "agentic" as const, "working" as const, "detail" as const],
    ["the review moment", "agentic" as const, "review" as const, "detail" as const],
    ["the schedule moment", "trigger" as const, "progress" as const, "detail" as const],
  ])("%s draws its own page, with no skills row above it", async (_name, panel, moment, selection) => {
    getRunRecommendationHoldStateAction.mockResolvedValue(SETTLED);
    const { container } = render(
      <RunSurface
        panel={panel}
        hasPark
        held={false}
        initialSelection={selection}
        moment={moment}
      />,
    );

    await settleFrame();
    // The moment's own card IS on the page…
    expect(detailColumn(container).children.length).toBeGreaterThan(0);
    // …and the skills row is nowhere on it.
    expect(chipRows(container)).toHaveLength(0);
  });

  it("the schedule STEP's page carries none either", async () => {
    getRunRecommendationHoldStateAction.mockResolvedValue(SETTLED);
    const { container } = render(
      <RunSurface panel="trigger" hasPark held={false} initialSelection="schedule" />,
    );

    await settleFrame();
    expect(container.querySelector('[data-testid="schedule-surface"]')).not.toBeNull();
    expect(chipRows(container)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// THE SKILLS STEP'S OWN PAGE — what selecting the completed step shows.
// ---------------------------------------------------------------------------
describe("the Skills step's own page", () => {
  it("shows the settled pills, read-only, when the completed step is selected", async () => {
    getRunRecommendationHoldStateAction.mockResolvedValue(SETTLED);
    const { container } = render(
      <RunSurface panel="agentic" hasPark held={false} initialSelection="detail" moment="working" />,
    );

    await settleFrame();
    expect(chipRows(container)).toHaveLength(0);

    fireEvent.click(railEntry(container)!);
    await waitFor(() => expect(chipRows(container).length).toBeGreaterThan(0));

    // ONE row, on the step's own page, in the detail column.
    expect(chipRows(container)).toHaveLength(1);
    const row = chipRows(container)[0];
    expect(detailColumn(container).contains(row)).toBe(true);
    expect(row.getAttribute("data-lifecycle-card-state")).toBe("decided");
    // Read-only: the pill's box states what was recorded and cannot be moved,
    // and there is no Continue on a settled step.
    const box = row.querySelector<HTMLElement>('[role="checkbox"]')!;
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(box.hasAttribute("disabled")).toBe(true);
    expect(row.querySelector("[data-skills-step-continue]")).toBeNull();
    // The step's surface REPLACES the run detail, so the panel's boxes are not
    // on the page at all while the step is open.
    expect(panelBoxes(container)).toHaveLength(0);
  });

  it("leaves the detail column empty of it again when another row is selected", async () => {
    getRunRecommendationHoldStateAction.mockResolvedValue(SETTLED);
    const { container } = render(
      <RunSurface panel="agentic" hasPark held={false} initialSelection="recommendation" moment="working" />,
    );

    await waitFor(() => expect(chipRows(container).length).toBeGreaterThan(0));
    fireEvent.click(container.querySelector('[data-testid="review-row"]')!);

    await waitFor(() => expect(chipRows(container)).toHaveLength(0));
    expect(panelBoxes(container).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// THE RAIL ENTRY — it keeps its place and its two readings (cinatra#3047's own
// criterion 2, unchanged by the review).
// ---------------------------------------------------------------------------
describe("the rail entry", () => {
  it("is the FIRST row on the rail, ahead of the steps it would authorize", async () => {
    getRunRecommendationHoldStateAction.mockResolvedValue(SETTLED);
    const { container } = render(
      <RunSurface panel="agentic" hasPark held={false} initialSelection="detail" />,
    );

    await settleFrame();
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
    await settleFrame();
    expect(
      railEntry(settled.container)!.getAttribute("data-recommendation-step-settled"),
    ).toBe("true");
  });

  it("names the step 'Skills'", async () => {
    getRunRecommendationHoldStateAction.mockResolvedValue(SETTLED);
    const { container } = render(
      <RunSurface panel="agentic" hasPark held={false} initialSelection="detail" />,
    );
    await settleFrame();
    expect(railEntry(container)!.textContent).toBe("Skills");
  });
});
