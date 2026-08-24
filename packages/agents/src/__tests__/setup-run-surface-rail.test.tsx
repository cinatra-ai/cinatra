// @vitest-environment jsdom
//
// THE SETUP RUN PAGE IS THE SAME TWO-COLUMN RUN SURFACE (cinatra#2970, epic
// #2784).
//
// The ratified drawing `images/lifecycle-screens/design-run-surface-rail-and-gate.png`:
// "The surface is a two-column frame: a step rail down the left names the run's
// ordered steps, and the run detail on the right shows the selected step …
// Selecting a step opens it on the right … right here in the run detail, under
// the same rail, never as a standalone document." Plan (A) §7.2 step 5 and §7.4
// step 7 add the clause this screen kept breaking — "it opens to the right of
// the steps, never directly under a step, and no agentic run progress card is
// shown with it" — and §6.2 says the same while the recommended skills can be
// selected.
//
// WHAT WAS WRONG. The setup run page — the run page before the agent has ever
// run — drew ONE centred column: the scheduling form alone in the middle of the
// page, with the run's steps named nowhere. Every other run-page state drew the
// two columns. These are DOM facts (which column each surface is a descendant
// of, how many rows the rail has, what is drawn beside the selected step) —
// none of them is readable from source, which is why they are pinned here.
//
// THE SKILLS STEP IS DRIVEN ON THE PRODUCTION RENDERER, not on a stand-in: the
// step opens the shipped `RecommendationHoldCard`, so the suite mounts THAT and
// drives its authority through the same mocked action the card's own suite
// uses. A held run proves the card opens in the run detail; an unheld one proves
// the honest reading of a step the run has not reached — the card draws no DOM
// and nothing is invented in its place.
//
// Run:
//   cd packages/agents && npx vitest run src/__tests__/setup-run-surface-rail.test.tsx

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { Button } from "@/components/ui/button";

import {
  RUN_SURFACE_RAIL_LABELS,
  RunSurfaceRail,
  type RunSurfaceStep,
} from "../run-surface-rail";

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
    ownKeys: () => ["Check", "ChevronDown", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

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
      canDecide?: boolean;
    };

const holdStateMock = vi.fn(async (): Promise<HoldState> => ({ state: "none" }));

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: () => holdStateMock(),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

// The chip-row's candidate fetch lives in a server-only module graph; the row's
// own drawing is not under test here (it shipped with cinatra#2067).
vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  holdStateMock.mockImplementation(async () => ({ state: "none" }));
});

const HELD: HoldState = {
  state: "held",
  agentPackageName: "@cinatra-test/setup-rail-fixture",
  promptText: "{}",
  recommendations: [
    { skillId: "skill-a", skillRevisionId: "rev-a", recommended: true, name: "Skill A" },
  ],
  holdRef: "hold-ref-2970",
};

/** The scheduler step's surface, standing in for the shipped scheduling form —
 *  the form itself is `trigger-form.test.tsx`'s subject; what is pinned HERE is
 *  which column it lands in. */
function SchedulerForm() {
  return (
    <form data-testid="scheduler-form">
      <p>When should this run?</p>
      <Button type="submit">Continue</Button>
    </form>
  );
}

/** What must NEVER be drawn beside a step of a run that has not run. */
function RunProgress() {
  return (
    <section data-testid="run-detail-panel">
      <h2>Agentic Run Progress</h2>
    </section>
  );
}

/** The recommendation step's surface exactly as the screen composes it: the ONE
 *  shipped renderer, under the host this page declares. */
async function recommendationSurface() {
  const { RecommendationHoldCard } = await import("../run-recommendation-chip-row");
  const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
  return (
    <LifecycleCardSurfaceProvider host="run_card">
      <RecommendationHoldCard
        runId="run-2970"
        agentPackageName="@cinatra-test/setup-rail-fixture"
        wireRef={null}
      />
    </LifecycleCardSurfaceProvider>
  );
}

/** The three setup steps as the setup run page composes them. `reached` is what
 *  the screen reads off the run, so the suite states it per case rather than
 *  hard-coding it: a run holding at its skills question HAS reached that step. */
async function setupSteps(
  opts: { recommendationReached?: boolean } = {},
): Promise<RunSurfaceStep[]> {
  return [
    {
      key: "schedule",
      label: RUN_SURFACE_RAIL_LABELS.schedule,
      surface: <SchedulerForm />,
    },
    {
      key: "recommendation",
      label: RUN_SURFACE_RAIL_LABELS.recommendation,
      reached: opts.recommendationReached,
      surface: await recommendationSurface(),
    },
    {
      key: "review",
      label: RUN_SURFACE_RAIL_LABELS.review,
      reached: false,
      surface: null,
    },
  ];
}

async function renderSetupSurface(opts: { recommendationReached?: boolean } = {}) {
  return render(
    <RunSurfaceRail steps={await setupSteps(opts)} initialSelectedKey="schedule" />,
  );
}

const railColumn = (c: HTMLElement) =>
  c.querySelectorAll<HTMLElement>('[data-conformance-id="run-step-rail-column"]');
const detailColumn = (c: HTMLElement) =>
  c.querySelectorAll<HTMLElement>('[data-conformance-id="run-detail-column"]');
const rows = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>('[data-conformance-id="run-surface-rail-step"]'));
const holdCard = (c: HTMLElement) =>
  c.querySelector<HTMLElement>('[data-lifecycle-card="recommendation_hold"]');

describe("the setup run page draws the two-column run surface", () => {
  it("measures rail 1 / detail 1 — the anchors the capture recorder counts", async () => {
    const { container } = await renderSetupSurface();

    expect(railColumn(container).length).toBe(1);
    expect(detailColumn(container).length).toBe(1);
    const surface = container.querySelector('[data-conformance-id="run-surface"]')!;
    expect(surface).not.toBeNull();
    expect(surface.children.length).toBe(2);
    expect(surface.children[0]).toBe(railColumn(container)[0]);
    expect(surface.children[1]).toBe(detailColumn(container)[0]);
  });

  it("lists the three setup steps on the rail, in order, numbered from one", async () => {
    const { container } = await renderSetupSurface();

    expect(rows(container).map((r) => r.textContent)).toEqual([
      "1Schedule",
      "2Recommendation",
      "3Review",
    ]);
    expect(rows(container).map((r) => r.getAttribute("data-run-surface-rail-step-key"))).toEqual([
      "schedule",
      "recommendation",
      "review",
    ]);
  });

  it("says which steps are still ahead — and stays silent about the one it cannot read", async () => {
    const { container } = await renderSetupSurface();

    expect(rows(container).map((r) => r.getAttribute("data-run-surface-rail-reached"))).toEqual([
      // the scheduler: the step this page IS; the skills step: unstated, because
      // the screen may not read the hold to draw around it; the review: read off
      // the run, which carries no gate.
      null,
      null,
      "false",
    ]);
  });

  it("opens the scheduler step first, with its form in the DETAIL column", async () => {
    const { container } = await renderSetupSurface();

    const form = container.querySelector('[data-testid="scheduler-form"]')!;
    expect(form).not.toBeNull();
    expect(detailColumn(container)[0].contains(form)).toBe(true);
    expect(railColumn(container)[0].contains(form)).toBe(false);
    expect(container.textContent).toContain("When should this run?");
    expect(container.textContent).toContain("Continue");
    expect(rows(container)[0].getAttribute("data-run-surface-rail-selected")).toBe("true");
    expect(rows(container)[0].getAttribute("aria-current")).toBe("step");
  });

  it("never draws a step's surface under its rail row", async () => {
    const { container } = await renderSetupSurface();

    for (const row of rows(container)) {
      expect(row.querySelector('[data-testid="scheduler-form"]')).toBeNull();
      expect(row.querySelector("[data-lifecycle-card]")).toBeNull();
    }
    // The rail column carries rows and nothing else.
    expect(railColumn(container)[0].children.length).toBe(3);
  });

  it("draws NO agentic run progress card beside the selected step", async () => {
    const { container } = await renderSetupSurface();

    expect(container.textContent).not.toContain("Agentic Run Progress");
    expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull();
  });

  it("opens the SHIPPED skills-recommendation card to the right of the steps", async () => {
    // A run that IS holding at its skills question: the production renderer
    // draws, and it draws in the run detail — never under the rail row.
    holdStateMock.mockImplementation(async () => HELD);
    const { container } = await renderSetupSurface({ recommendationReached: true });

    fireEvent.click(container.querySelector('[data-action="open-recommendation-step"]')!);
    await waitFor(() => expect(holdCard(container)).not.toBeNull());

    const card = holdCard(container)!;
    // The rail never contradicts the surface: a page that says a step is still
    // ahead must not be drawing that step's live card beside the claim.
    expect(rows(container)[1].getAttribute("data-run-surface-rail-reached")).toBe("true");
    expect(detailColumn(container)[0].contains(card)).toBe(true);
    expect(railColumn(container)[0].contains(card)).toBe(false);
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("run_card");
    // One step at a time: the scheduler is not drawn beside it.
    expect(container.querySelector('[data-testid="scheduler-form"]')).toBeNull();
    expect(rows(container)[1].getAttribute("data-run-surface-rail-selected")).toBe("true");
    expect(rows(container)[0].getAttribute("data-run-surface-rail-selected")).toBe("false");
  });

  it("draws NOTHING for a skills step the run has not reached — no invented stand-in", async () => {
    // The card is the authority on whether it draws; with no hold it renders no
    // DOM at all, and this surface puts nothing in its place.
    const { container } = await renderSetupSurface();

    fireEvent.click(container.querySelector('[data-action="open-recommendation-step"]')!);
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());

    expect(holdCard(container)).toBeNull();
    expect(detailColumn(container)[0].textContent).toBe("");
    // The rail is untouched: the step is named, selected, and still a row.
    expect(rows(container).length).toBe(3);
    expect(rows(container)[1].getAttribute("data-run-surface-rail-selected")).toBe("true");
  });

  it("opens the review step the same way, and keeps the rail intact", async () => {
    const { container } = await renderSetupSurface();

    fireEvent.click(container.querySelector('[data-action="open-review-step"]')!);

    expect(detailColumn(container).length).toBe(1);
    expect(detailColumn(container)[0].getAttribute("data-run-surface-selected-step")).toBe(
      "review",
    );
    expect(rows(container).length).toBe(3);
    expect(rows(container)[2].getAttribute("data-run-surface-rail-selected")).toBe("true");
    expect(container.querySelector('[data-testid="scheduler-form"]')).toBeNull();
  });

  it("comes back to the scheduler, and never shows two step surfaces together", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { container } = await renderSetupSurface({ recommendationReached: true });

    fireEvent.click(container.querySelector('[data-action="open-recommendation-step"]')!);
    await waitFor(() => expect(holdCard(container)).not.toBeNull());
    expect(container.querySelector('[data-testid="scheduler-form"]')).toBeNull();

    fireEvent.click(container.querySelector('[data-action="open-schedule-step"]')!);
    expect(container.querySelector('[data-testid="scheduler-form"]')).not.toBeNull();
    expect(holdCard(container)).toBeNull();
  });

  it("draws a run's progress ONLY where a step's own surface carries it", async () => {
    // The guard is structural, not a word filter: the detail column shows the
    // SELECTED step and nothing else, so a page that hands no progress surface
    // to any step cannot draw one.
    const { container } = render(
      <RunSurfaceRail
        steps={[
          { key: "schedule", label: "Schedule", surface: <SchedulerForm /> },
          { key: "detail", label: "Review", surface: <RunProgress /> },
        ]}
        initialSelectedKey="schedule"
      />,
    );
    expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull();
    fireEvent.click(container.querySelector('[data-action="open-detail-step"]')!);
    expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="scheduler-form"]')).toBeNull();
  });
});
