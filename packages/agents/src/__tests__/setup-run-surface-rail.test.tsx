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
// AND WHAT WAS STILL WRONG AFTER THAT. Every row could be opened, so a step the
// run has not reached opened an EMPTY run detail. cinatra#2970: "a step the
// run has not reached cannot be selected. Its row stays
// on the rail, muted, so the series is visible; clicking it does nothing; the
// scheduler stays open; the right column never shows an empty step surface."
// Pinned below on the review step, which is the step this page can actually
// read as still ahead.
//
// THE SKILLS STEP IS DRIVEN ON THE PRODUCTION RENDERER, not on a stand-in: the
// step opens the shipped `RecommendationHoldCard`, so the suite mounts THAT and
// drives its authority through the same mocked action the card's own suite
// uses. A held run proves the card opens in the run detail; a run whose skills
// step the page never read proves the third answer stays a third answer — the
// row is drawn plainly, it still opens, and nothing is invented in the card's
// place.
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
  isRunSurfaceStepSelectable,
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
    // The step the page is standing on is always openable — it has its form and
    // no page claims the run is still short of it.
    expect(rows(container)[0].hasAttribute("aria-disabled")).toBe(false);
    expect(rows(container)[0].getAttribute("data-action")).toBe("open-schedule-step");
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

    // A step the run HAS reached is opened exactly as it always was.
    expect(rows(container)[1].hasAttribute("aria-disabled")).toBe(false);
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

  it("draws NOTHING for a skills step whose reachedness the page never read — and still opens it", async () => {
    // UNSTATED IS THE THIRD ANSWER, and closing the row on it would be a claim
    // the page never made: this screen deliberately does not read the hold's
    // park (the card is the one authority on that interaction, cinatra#2573),
    // so the row is drawn plainly and stays openable. The card is the authority
    // on whether it DRAWS; with no hold it renders no DOM at all, and this
    // surface puts nothing in its place.
    //
    // WHAT THIS PINS IS THE TRI-STATE RULE, NOT AN ENDORSED END STATE. A
    // recommendation card that resolves to nothing still leaves the run detail
    // with nothing in it, which the last clause of cinatra#2970 does not want.
    // This
    // rail cannot see that: a component element is a non-null surface however
    // the component later resolves. Closing the gap needs the card's own
    // resolved authority to reach the rail, which is a change to the one
    // shipped recommendation renderer and is NOT in this change — it is carried
    // as a named residual, not as behaviour anything here approves of.
    const { container } = await renderSetupSurface();

    expect(rows(container)[1].getAttribute("data-run-surface-rail-reached")).toBeNull();
    expect(rows(container)[1].hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(container.querySelector('[data-action="open-recommendation-step"]')!);
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());

    expect(holdCard(container)).toBeNull();
    // The rail is untouched: the step is named, selected, and still a row.
    expect(rows(container).length).toBe(3);
    expect(rows(container)[1].getAttribute("data-run-surface-rail-selected")).toBe("true");
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

// ---------------------------------------------------------------------------
// A STEP THE RUN HAS NOT REACHED CANNOT BE SELECTED (cinatra#2970).
//
// cinatra#2970: "Its row stays on the rail, muted, so the series is visible;
// clicking it does
// nothing; the scheduler stays open; the right column never shows an empty step
// surface."
// ---------------------------------------------------------------------------
describe("a step the run has not reached cannot be opened", () => {
  it("the unreached review step cannot be opened — the scheduler stays open", async () => {
    const { container } = await renderSetupSurface();

    // The row is THERE — the rail is the run's series of steps and a missing row
    // would hide the series — and it says what it is.
    expect(rows(container).length).toBe(3);
    expect(rows(container)[2].getAttribute("aria-disabled")).toBe("true");
    // No reader can address it as an opening it cannot perform.
    expect(container.querySelector('[data-action="open-review-step"]')).toBeNull();
    expect(rows(container)[2].getAttribute("data-action")).toBe("review-step-unavailable");

    fireEvent.click(rows(container)[2]);

    // Clicking did NOTHING: the scheduler is still the open step, its form is
    // still the surface, and the right column never went empty.
    expect(detailColumn(container).length).toBe(1);
    expect(detailColumn(container)[0].getAttribute("data-run-surface-selected-step")).toBe(
      "schedule",
    );
    expect(container.querySelector('[data-testid="scheduler-form"]')).not.toBeNull();
    expect(detailColumn(container)[0].textContent).toContain("When should this run?");
    expect(rows(container)[0].getAttribute("data-run-surface-rail-selected")).toBe("true");
    expect(rows(container)[2].getAttribute("data-run-surface-rail-selected")).toBe("false");
    expect(rows(container)[2].hasAttribute("aria-current")).toBe(false);
  });

  it("the muted row keeps every anchor the capture recorder measures", async () => {
    const { container } = await renderSetupSurface();
    const row = rows(container)[2];

    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("type")).toBe("button");
    expect(row.getAttribute("data-conformance-id")).toBe("run-surface-rail-step");
    expect(row.hasAttribute("data-run-surface-rail-step")).toBe(true);
    expect(row.getAttribute("data-run-surface-rail-step-key")).toBe("review");
    expect(row.getAttribute("data-run-surface-rail-reached")).toBe("false");
    expect(row.textContent).toBe("3Review");
    expect(
      row.querySelector('[data-conformance-id="run-surface-rail-indicator"]'),
    ).not.toBeNull();
    // MUTED, and drawn as something that does not act.
    const indicator = row.querySelector<HTMLElement>(
      '[data-conformance-id="run-surface-rail-indicator"]',
    )!;
    expect(indicator.className).toContain("bg-muted-foreground/40");
    expect(indicator.className).not.toContain("bg-primary");
    expect(row.querySelector("span:last-of-type")!.className).toContain("text-muted-foreground");
    expect(row.className).toContain("cursor-default");
    expect(row.className).not.toContain("hover:opacity-90");
    // `aria-disabled`, not the native `disabled`: the row stays reachable, so a
    // keyboard user can still find the step that is still ahead.
    expect(row.hasAttribute("disabled")).toBe(false);
    // And it does not animate a press it does not act on.
    expect(row.className).toContain("active:not-aria-[haspopup]:translate-y-0");
    expect(row.className).not.toContain("translate-y-px");
  });

  it("closes a row its page read as still ahead, even when that step HAS a surface", () => {
    // The two reasons a row closes are independent, and the review fixture
    // happens to carry BOTH (nothing drawn for it, and read as still ahead).
    // This isolates the second, so the rule cannot be passed by the surface
    // check alone.
    const { container } = render(
      <RunSurfaceRail
        steps={[
          { key: "schedule", label: "Schedule", surface: <SchedulerForm /> },
          { key: "detail", label: "Review", surface: <RunProgress />, reached: false },
        ]}
        initialSelectedKey="schedule"
      />,
    );

    const row = rows(container)[1];
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.getAttribute("data-action")).toBe("detail-step-unavailable");
    expect(container.querySelector('[data-action="open-detail-step"]')).toBeNull();

    fireEvent.click(row);

    expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="scheduler-form"]')).not.toBeNull();
    expect(detailColumn(container)[0].getAttribute("data-run-surface-selected-step")).toBe(
      "schedule",
    );
  });

  it("marks NO row open when the rail has no step it can open", () => {
    // A degenerate list no page composes — a rail always carries the step its
    // page is standing on. It is still drawn honestly: no row claims to be
    // open, and no empty step surface is mounted under a row that does.
    const { container } = render(
      <RunSurfaceRail
        steps={[
          { key: "recommendation", label: "Recommendation", surface: null },
          { key: "review", label: "Review", surface: null, reached: false },
        ]}
      />,
    );

    expect(rows(container).length).toBe(2);
    for (const row of rows(container)) {
      expect(row.getAttribute("aria-disabled")).toBe("true");
      expect(row.getAttribute("data-run-surface-rail-selected")).toBe("false");
      expect(row.hasAttribute("aria-current")).toBe(false);
    }
    expect(detailColumn(container)[0].hasAttribute("data-run-surface-selected-step")).toBe(
      false,
    );
    expect(detailColumn(container)[0].childNodes.length).toBe(0);
  });

  it("never opens onto a step with no surface, even when the page asks for it", async () => {
    // An `initialSelectedKey` naming a step that has nothing drawn for it falls
    // through to the first row that HAS a surface, rather than painting the
    // empty right column cinatra#2970 forbids.
    const { container } = render(
      <RunSurfaceRail steps={await setupSteps()} initialSelectedKey="review" />,
    );

    expect(detailColumn(container)[0].getAttribute("data-run-surface-selected-step")).toBe(
      "schedule",
    );
    expect(container.querySelector('[data-testid="scheduler-form"]')).not.toBeNull();
    expect(rows(container)[0].getAttribute("data-run-surface-rail-selected")).toBe("true");
    expect(rows(container)[2].getAttribute("data-run-surface-rail-selected")).toBe("false");
  });

  it("keeps the rail's own tri-state rule — surface, and reached only where it is read", () => {
    const surface = <SchedulerForm />;
    // Reached is a THIRD answer: unstated leaves the row openable, because
    // silence is not a claim that the run is still short of the step.
    expect(isRunSurfaceStepSelectable({ key: "a", label: "A", surface })).toBe(true);
    expect(
      isRunSurfaceStepSelectable({ key: "a", label: "A", surface, reached: true }),
    ).toBe(true);
    expect(
      isRunSurfaceStepSelectable({ key: "a", label: "A", surface, reached: false }),
    ).toBe(false);
    // No surface, no opening — whatever the rail was told about reaching it.
    expect(isRunSurfaceStepSelectable({ key: "a", label: "A", surface: null })).toBe(false);
    expect(
      isRunSurfaceStepSelectable({ key: "a", label: "A", surface: null, reached: true }),
    ).toBe(false);
  });
});
