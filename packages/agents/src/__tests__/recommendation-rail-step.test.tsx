// @vitest-environment jsdom
//
// THE RECOMMENDATION GATE IS A STEP IN THE RUN PAGE'S RAIL (cinatra#2790, epic
// #2784 S9f).
//
// Plan (A) §6.2: "On the run page the same row sits at the trigger position, the
// top entry on the step rail, ahead of the work steps it would authorize."
// The ratified drawing `images/lifecycle-screens/design-run-surface-rail-and-gate.png`
// draws what that means: "a gate step opens the gate's own surface in place —
// right here in the run detail, under the same rail, never as a standalone
// document."
//
// WHAT WAS WRONG. The run page drew the chip row as a block in the run detail
// with no rail entry at all: the question that gates the whole run was not one
// of the run's steps, and on a run with no schedule the page had no rail. Both
// halves are pinned here as DOM facts — WHICH column the row is a descendant of,
// and WHAT is drawn beside it — because both were visible in the surface and
// neither was measurable from source.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/recommendation-rail-step.test.tsx

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { Button } from "@/components/ui/button";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

type HoldState =
  | { state: "none" }
  | {
      state: "held";
      agentPackageName: string;
      promptText: string;
      recommendations: {
        skillId: string;
        skillRevisionId: string;
        recommended: boolean;
        name?: string;
      }[];
      holdRef: string;
    }
  | { state: "confirmed"; skillNames: string[] };

const holdStateMock = vi.fn(async (): Promise<HoldState> => ({ state: "none" }));

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: () => holdStateMock(),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { RecommendationHoldCard } from "../run-recommendation-chip-row";
import { RecommendationRailStepRow } from "../recommendation-rail-step";
import { ScheduleRailStepRow } from "../schedule-rail-step";
import {
  RunSurfaceRail,
  useRunStepSelection,
  type RunStepSelection,
  type RunSurfaceRailStep,
} from "../run-surface-rail";
import { recommendationRailEntry } from "../recommendation-rail-entry";

const HELD: HoldState = {
  state: "held",
  agentPackageName: "@cinatra-test/rail-fixture-agent",
  promptText: "{}",
  recommendations: [
    { skillId: "skill-a", skillRevisionId: "rev-a", recommended: true, name: "Skill A" },
  ],
  holdRef: "hold-ref-2790",
};

const DECIDED: HoldState = { state: "confirmed", skillNames: ["Skill A"] };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// A CARD REMEMBERS THIS RUN'S LAST AUTHORITATIVE ANSWER (cinatra#3007, fix leg
// 10), so a REBUILT card redraws it instead of blanking while its own read is on
// the wire. A browser drops that memory with the tab. A file that mounts many
// cards for the SAME run id has no such boundary, so it takes one here — every
// arm below starts from a card that has never been told anything.
beforeEach(async () => {
  const { forgetAuthorizedRecommendationAnswers } = await import(
    "../run-recommendation-chip-row"
  );
  forgetAuthorizedRecommendationAnswers();
});

beforeEach(() => {
  holdStateMock.mockImplementation(async () => ({ state: "none" }));
});

/** A rail row drawn by the rail BESIDE the gate steps — the run's own steps. */
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

/** The run detail as the screen composes it: the settled card, then the run's
 *  own progress section. */
function RunProgress() {
  return (
    <section data-testid="run-detail-panel">
      <h2>Agentic Run Progress</h2>
    </section>
  );
}

/**
 * The run surface, composed the way `SetupScreen` composes it: ONE card mount
 * used by the step's surface and by the run detail, which are mutually
 * exclusive slots of the same frame.
 */
function surface(opts: {
  hasRecommendationStep?: boolean;
  hasScheduleStep?: boolean;
  settled?: boolean;
  initialSelection: RunStepSelection;
}) {
  const card = (
    <LifecycleCardSurfaceProvider host="run_card">
      <RecommendationHoldCard
        runId="run-2790"
        agentPackageName="@cinatra-test/rail-fixture-agent"
        wireRef={null}
      />
    </LifecycleCardSurfaceProvider>
  );
  const steps: RunSurfaceRailStep[] = [];
  if (opts.hasRecommendationStep !== false) {
    steps.push({
      key: "recommendation",
      row: (
        <RecommendationRailStepRow
          displayStep={steps.length + 1}
          settled={opts.settled === true}
        />
      ),
      surface: card,
    });
  }
  if (opts.hasScheduleStep !== false) {
    steps.push({
      key: "schedule",
      row: <ScheduleRailStepRow host="run_card" displayStep={steps.length + 1} />,
      surface: <div data-testid="schedule-surface" />,
    });
  }
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
            <RunProgress />
          </>
        }
        initialSelection={opts.initialSelection}
      />
    </div>
  );
}

function renderRunSurface(opts: Parameters<typeof surface>[0]) {
  return render(surface(opts));
}

const railColumn = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-run-step-rail-column]")!;
const detailColumn = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-run-detail-column]")!;
const chipRow = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-run-recommendation-chip-row]");
const recommendationRow = (c: HTMLElement) =>
  c.querySelector<HTMLElement>('[data-conformance-id="recommendation-rail-step"]');

describe("a LIVE hold — the gate opens in the run detail, under the same rail", () => {
  it("draws the chip row inside the run-detail column and NOT inside the rail column", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { container } = renderRunSurface({ initialSelection: "recommendation" });

    await waitFor(() => expect(chipRow(container)).not.toBeNull());

    const rail = railColumn(container);
    const detail = detailColumn(container);
    const row = chipRow(container)!;
    // The two columns are siblings inside the run-detail contract, in this order.
    expect(container.querySelector("[data-run-detail-contract]")!.children.length).toBe(2);
    expect(detail.contains(row)).toBe(true);
    expect(rail.contains(row)).toBe(false);
    // The rail ENTRY stays a row: the entry is in the rail, its surface is not.
    const entry = recommendationRow(container)!;
    expect(rail.contains(entry)).toBe(true);
    expect(entry.contains(row)).toBe(false);
    expect(entry.getAttribute("data-recommendation-step-selected")).toBe("true");
    expect(entry.getAttribute("data-recommendation-step-settled")).toBe("false");
  });

  it("sits at the TRIGGER POSITION — the top entry, ahead of the steps it would authorize", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { container } = renderRunSurface({ initialSelection: "recommendation" });

    await waitFor(() => expect(chipRow(container)).not.toBeNull());

    const rail = railColumn(container);
    const rows = Array.from(
      rail.querySelectorAll(
        '[data-conformance-id="recommendation-rail-step"], [data-conformance-id="schedule-rail-step"], [data-testid="review-row"]',
      ),
    );
    expect(rows.map((r) => r.getAttribute("data-conformance-id") ?? r.getAttribute("data-testid"))).toEqual([
      "recommendation-rail-step",
      "schedule-rail-step",
      "review-row",
    ]);
    // …and it is numbered first, with the schedule renumbered behind it.
    expect(
      rail.querySelector('[data-conformance-id="recommendation-rail-indicator"]')!.textContent,
    ).toBe("1");
    expect(
      rail.querySelector('[data-conformance-id="schedule-rail-indicator"]')!.textContent,
    ).toBe("2");
  });

  it("draws NO agentic run progress beside it — the selected step is what the detail shows", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { container } = renderRunSurface({ initialSelection: "recommendation" });

    await waitFor(() => expect(chipRow(container)).not.toBeNull());

    expect(container.textContent).not.toContain("Agentic Run Progress");
    expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull();
    // Exactly one chip row is drawn on this host, ever.
    expect(container.querySelectorAll("[data-run-recommendation-chip-row]").length).toBe(1);
  });
});

describe("a DECIDED hold — the settled reading in the rail, the run detail restored", () => {
  it("keeps the entry as the resolved-gate history row and shows the run's own detail", async () => {
    holdStateMock.mockImplementation(async () => DECIDED);
    const { container } = renderRunSurface({ settled: true, initialSelection: "detail" });

    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull(),
    );

    const entry = recommendationRow(container)!;
    expect(entry.getAttribute("data-recommendation-step-settled")).toBe("true");
    expect(entry.getAttribute("data-recommendation-step-selected")).toBe("false");
    // The rail's own completed reading — the numeral is replaced, no status word
    // is added beside the title.
    expect(
      entry.querySelector('[data-conformance-id="recommendation-rail-indicator"]')!.textContent,
    ).toBe("");
    expect(entry.textContent).toBe("Recommendation");
    // The run detail is what the run page otherwise shows.
    expect(container.textContent).toContain("Agentic Run Progress");
    // …and the settled chip row stays where the branch already draws it.
    await waitFor(() => expect(chipRow(container)).not.toBeNull());
    expect(detailColumn(container).contains(chipRow(container)!)).toBe(true);
    expect(railColumn(container).contains(chipRow(container)!)).toBe(false);
  });

  it("re-opens the settled reading in the same place when its step is selected", async () => {
    holdStateMock.mockImplementation(async () => DECIDED);
    const { container } = renderRunSurface({ settled: true, initialSelection: "detail" });

    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull(),
    );

    fireEvent.click(container.querySelector('[data-action="open-recommendation-step"]')!);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull(),
    );
    await waitFor(() => expect(chipRow(container)).not.toBeNull());
    expect(detailColumn(container).contains(chipRow(container)!)).toBe(true);
    expect(container.querySelectorAll("[data-run-recommendation-chip-row]").length).toBe(1);

    fireEvent.click(container.querySelector('[data-testid="review-row"]')!);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull(),
    );
  });
});

/**
 * THE BRANCH WHOSE PANEL DRAWS THE CARD (cinatra#2790, S9f — R6).
 *
 * `AgenticRunPanel` declares `run_card` and mounts the one card itself, so the
 * screen hosts none (`screenHostsRecommendationCard("agentic") === false`, pinned
 * in `instance-screens-recommendation-step.test.ts` together with the run
 * statuses that reach this branch). Whether the rail still carries the entry is
 * `recommendationRailEntry`'s answer — the screen's own — so what this renders is
 * what the run page renders. The step gets NO surface of its own here: the
 * settled card is already inside the panel, which is the frame's "this step
 * keeps the run detail" case.
 */
function panelHostedSurface(opts: { hasPark: boolean; held: boolean }) {
  const hostsCard = false;
  const entry = recommendationRailEntry({
    hasPark: opts.hasPark,
    held: opts.held,
    hostsCard,
  });
  const detail = (
    <section data-testid="run-detail-panel">
      <h2>Agentic Run Progress</h2>
      <LifecycleCardSurfaceProvider host="run_card">
        <RecommendationHoldCard
          runId="run-2790"
          agentPackageName="@cinatra-test/rail-fixture-agent"
          wireRef={null}
        />
      </LifecycleCardSurfaceProvider>
    </section>
  );
  const steps: RunSurfaceRailStep[] = [];
  if (entry !== "none") {
    steps.push({
      key: "recommendation",
      row: (
        <RecommendationRailStepRow displayStep={steps.length + 1} settled={entry === "settled"} />
      ),
      surface: null,
    });
  }
  return (
    <div
      className="flex items-start gap-6"
      data-run-detail-contract=""
      data-conformance-id="run-surface"
    >
      <RunSurfaceRail
        steps={steps}
        rail={<ReviewRow />}
        detail={detail}
        initialSelection="detail"
      />
    </div>
  );
}

describe("a DECIDED hold on the branch whose PANEL draws the card — R6", () => {
  it("keeps the settled entry on the rail, to the LEFT of the run detail", async () => {
    holdStateMock.mockImplementation(async () => DECIDED);
    const { container } = render(panelHostedSurface({ hasPark: true, held: false }));

    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull(),
    );

    const entry = recommendationRow(container);
    expect(entry).not.toBeNull();
    expect(entry!.getAttribute("data-recommendation-step-settled")).toBe("true");
    expect(entry!.getAttribute("data-recommendation-step-selected")).toBe("false");
    // The rail's own completed reading: the numeral replaced by the check, and
    // no status word added beside the title.
    expect(
      entry!.querySelector('[data-conformance-id="recommendation-rail-indicator"]')!.textContent,
    ).toBe("");
    expect(entry!.textContent).toBe("Recommendation");

    // TWO COLUMNS, the rail first — the drawing's frame.
    const contract = container.querySelector("[data-run-detail-contract]")!;
    expect(contract.children.length).toBe(2);
    expect(contract.children[0]).toBe(railColumn(container));
    expect(contract.children[1]).toBe(detailColumn(container));
    expect(railColumn(container).contains(entry!)).toBe(true);
    expect(detailColumn(container).contains(entry!)).toBe(false);
  });

  it("leaves the run detail exactly as the branch draws it — the panel and its ONE card", async () => {
    holdStateMock.mockImplementation(async () => DECIDED);
    const { container } = render(panelHostedSurface({ hasPark: true, held: false }));

    await waitFor(() => expect(chipRow(container)).not.toBeNull());

    const detail = detailColumn(container);
    expect(detail.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull();
    expect(container.textContent).toContain("Agentic Run Progress");
    // Still exactly one chip row on this host, and it is the panel's.
    expect(container.querySelectorAll("[data-run-recommendation-chip-row]").length).toBe(1);
    expect(detail.contains(chipRow(container)!)).toBe(true);
    expect(railColumn(container).contains(chipRow(container)!)).toBe(false);
  });

  it("selecting the settled entry keeps the run detail — it opens no surface of its own", async () => {
    holdStateMock.mockImplementation(async () => DECIDED);
    const { container } = render(panelHostedSurface({ hasPark: true, held: false }));

    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull(),
    );

    fireEvent.click(container.querySelector('[data-action="open-recommendation-step"]')!);

    // The row takes the selection — it is a rail row — but the detail stays put,
    // because the settled card it would show is already inside that panel.
    expect(recommendationRow(container)!.getAttribute("data-recommendation-step-selected")).toBe(
      "true",
    );
    expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull();
    expect(container.textContent).toContain("Agentic Run Progress");
    expect(container.querySelectorAll("[data-run-recommendation-chip-row]").length).toBe(1);
  });

  it("a run on that branch that NEVER held draws no entry at all — unchanged", async () => {
    holdStateMock.mockImplementation(async () => ({ state: "none" }));
    const { container } = render(panelHostedSurface({ hasPark: false, held: false }));

    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull(),
    );

    expect(recommendationRow(container)).toBeNull();
    expect(container.querySelector('[data-action="open-recommendation-step"]')).toBeNull();
    expect(chipRow(container)).toBeNull();
  });
});

describe("the server's answer wins when it changes — the refresh after a decision", () => {
  it("moves the open step when the screen recomputes it, without a remount", async () => {
    // The decision taken IN the card calls `router.refresh()`: the server tree
    // re-renders and this client frame does NOT remount. A selection kept only
    // from the first paint would leave the reader parked on the gate they just
    // settled.
    holdStateMock.mockImplementation(async () => HELD);
    const { container, rerender } = renderRunSurface({ initialSelection: "recommendation" });
    await waitFor(() => expect(chipRow(container)).not.toBeNull());
    expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull();

    holdStateMock.mockImplementation(async () => DECIDED);
    rerender(surface({ settled: true, initialSelection: "detail" }));

    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull(),
    );
    expect(
      recommendationRow(container)!.getAttribute("data-recommendation-step-settled"),
    ).toBe("true");
  });

  it("leaves the READER's own selection alone when the server's answer has not moved", async () => {
    holdStateMock.mockImplementation(async () => DECIDED);
    const { container, rerender } = renderRunSurface({ settled: true, initialSelection: "detail" });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull(),
    );

    fireEvent.click(container.querySelector('[data-action="open-recommendation-step"]')!);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull(),
    );

    // A re-render carrying the SAME server answer must not yank the reader back.
    rerender(surface({ settled: true, initialSelection: "detail" }));
    expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull();
  });
});

describe("a run that never held — the rail is unchanged", () => {
  it("draws no recommendation entry at all, and the schedule keeps its own numeral", async () => {
    holdStateMock.mockImplementation(async () => ({ state: "none" }));
    const { container } = renderRunSurface({
      hasRecommendationStep: false,
      initialSelection: "schedule",
    });

    await waitFor(() =>
      expect(container.querySelector('[data-testid="schedule-surface"]')).not.toBeNull(),
    );

    expect(recommendationRow(container)).toBeNull();
    expect(container.querySelector('[data-action="open-recommendation-step"]')).toBeNull();
    const rail = railColumn(container);
    expect(
      rail.querySelector('[data-conformance-id="schedule-rail-indicator"]')!.textContent,
    ).toBe("1");
    expect(chipRow(container)).toBeNull();
  });
});
