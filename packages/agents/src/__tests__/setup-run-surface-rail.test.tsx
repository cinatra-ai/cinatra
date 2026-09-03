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
// AND WHAT THE PICTURES CAUGHT AFTER THAT (cells C10 and C11 of the #2939 proof
// set). Item 3 of cinatra#2970 — "the skills-recommendation step and the review
// step open the same way, to the right of the steps, never under a row" — was
// met by NEITHER row:
//
//   • the recommendation row was closed by the RUN'S STATUS, which is the
//     opposite of the question: a recommendation hold parks its run at
//     `pending_input`, so the row was closed exactly when the card had something
//     to draw, and open exactly when it had nothing — an empty run detail two
//     presses from the scheduler;
//   • the review row was composed with `surface: null` UNCONDITIONALLY, so it
//     could never open for any run at all.
//
// BOTH ROWS NOW READ THE RUN'S OWN ROWS. The recommendation asks the same
// predicates the run page's rail asks (`recommendationRailEntry` and, for a page
// with no run detail to fall back to, `recommendationRailStepOpens`), and the
// review asks the same reader the run page's panel asks (`readRunReviewSlot` ->
// `runReviewStepReading`, cinatra#2997). This suite drives BOTH through those
// functions rather than through literals typed into a harness, so a change that
// inverts either answer fails here.
//
// AND THE SURFACES ARE THE PRODUCTION ONES, RESOLVED. The recommendation step
// opens the shipped `RecommendationHoldCard` and the review step the shipped
// `ReviewGateCard` / `ReviewGatePlaceholder`, each under the host this page
// declares, each driven at its own real seam — the card's hold-state action and
// the lifecycle resolve — so "the row opened onto something" is read off DOM the
// production components actually drew, never off a wrapper this suite supplied.
//
// Run:
//   cd packages/agents && npx vitest run src/__tests__/setup-run-surface-rail.test.tsx

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { Button } from "@/components/ui/button";

import { RunSurfaceRail } from "../run-surface-rail";
import { isRunSurfaceStepSelectable } from "../run-surface-rail-step";
// The rows are built by the SAME mapping the screen calls, so a row that
// promises an opening the frame would refuse fails here rather than shipping.
import { buildSetupRailSteps, type SetupRailStep } from "../setup-run-surface-steps";
// The answers the screen reads off the run, through the functions the screen
// calls. None of them is restated here.
import {
  recommendationRailEntry,
  recommendationRailStepOpens,
} from "../recommendation-rail-entry";
import {
  runReviewStepReading,
  type RunReviewSlot,
  type RunReviewStepReading,
} from "../run-review-slot-reading";

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

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

type DecidedSkill = { skillId: string; name: string; mark: "confirmed" | "adjusted" | "skipped" };

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
    }
  | { state: "confirmed"; skillNames: string[]; decided?: DecidedSkill[] };

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

/** The answer the review card's own resolve gets for an OPEN gate — the shape
 *  the core's suite and the run panel's slot suite both drive it with. */
const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

beforeEach(() => {
  holdStateMock.mockImplementation(async () => ({ state: "none" }));
  // The review card resolves ITSELF against the ref it is handed. Answering
  // that resolve is what makes the card actually draw, so "the row opened onto
  // the review screen" is read off the card's own root rather than off the box
  // this page puts around it.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(RESOLVE_PENDING), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
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

const DECIDED: HoldState = {
  state: "confirmed",
  skillNames: ["Skill A"],
  decided: [{ skillId: "skill-a", name: "Skill A", mark: "confirmed" }],
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

/** The review step's surface exactly as the screen composes it: the run's review
 *  slot, drawn by the SAME two components the run page's panel draws it with. */
async function reviewSurface(reading: RunReviewStepReading) {
  if (reading === "none") return null;
  const { ReviewGateCard, LIFECYCLE_VIEW_SCHEMA_VERSION } = await import("../review-gate-card");
  const { ReviewGatePlaceholder } = await import("../review-gate-states");
  const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
  return (
    <section
      className="soft-panel rounded-card px-6 py-5 flex flex-col gap-4"
      data-run-review-slot={reading === "review" ? "review" : "working"}
    >
      {reading === "review" ? (
        <LifecycleCardSurfaceProvider host="run_card">
          <ReviewGateCard
            view={{
              viewType: "artifact_review_gate",
              schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
              ref: "gate-ref-2970",
            }}
          />
        </LifecycleCardSurfaceProvider>
      ) : (
        <ReviewGatePlaceholder />
      )}
    </section>
  );
}

/** A run's recommendation park, as the screen reads it. */
type ParkFixture = { status: "parked" | "released" | "policy_unresolved" } | null;

type RunFixture = { park?: ParkFixture; slot?: RunReviewSlot | null };

/**
 * The three setup steps as the setup run page composes them.
 *
 * NEITHER `reached` IS HARD-CODED. The suite hands in what the RUN'S OWN ROWS
 * say — its recommendation park and its review slot — and derives both answers
 * through the very functions `TriggerScreen` calls, so a change that inverts
 * either one fails these cases instead of quietly agreeing with a literal typed
 * into a harness.
 */
async function setupSteps(opts: RunFixture = {}): Promise<SetupRailStep[]> {
  const park = opts.park ?? null;
  const entry = recommendationRailEntry({
    hasPark: park != null,
    held: park?.status === "parked",
    // The setup surface draws no run-detail panel, so this screen is the host.
    hostsCard: true,
  });
  const opens = recommendationRailStepOpens({ entry, parkStatus: park?.status });
  const reading = runReviewStepReading(opts.slot ?? null);
  return [
    { key: "schedule", surface: <SchedulerForm /> },
    {
      key: "recommendation",
      reached: opens,
      surface: opens ? await recommendationSurface() : null,
    },
    {
      key: "review",
      reached: reading !== "none",
      surface: await reviewSurface(reading),
    },
  ];
}

async function renderSetupSurface(opts: RunFixture = {}) {
  return render(
    // THE SAME COMPOSITION THE SCREEN MOUNTS. The frame draws the two columns;
    // the page draws the box that holds them, which is where the `run-surface`
    // contract root and its anchors live on every run-page state.
    <div className="flex items-start gap-6" data-run-detail-contract="" data-conformance-id="run-surface">
      <RunSurfaceRail
        steps={buildSetupRailSteps(await setupSteps(opts))}
        initialSelection="schedule"
      />
    </div>,
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
const reviewSlot = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-run-review-slot]");

/** A run holding at its skills question. */
const LIVE_HOLD: ParkFixture = { status: "parked" };
/** A run whose skills question a person answered. */
const DECIDED_HOLD: ParkFixture = { status: "released" };
/** A run whose skills question EXPIRED undecided — the TTL sweeper's fail-closed
 *  park. Terminal, and nobody answered it, so the card draws nothing for it. */
const EXPIRED_HOLD: ParkFixture = { status: "policy_unresolved" };
/** A run that produced something whose review question is still open. */
const AWAITING_REVIEW: RunReviewSlot = { reviewTaskId: null, awaiting: true };
/** A run with a review gate on file. */
const PENDING_REVIEW: RunReviewSlot = { reviewTaskId: "rt-2970", awaiting: false };

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

  it("says which steps this run has nothing to show for", async () => {
    // A run that never held and produced nothing: both rows are read as not
    // reached, off the run's own rows rather than off its status.
    const { container } = await renderSetupSurface();

    expect(rows(container).map((r) => r.getAttribute("data-run-surface-rail-reached"))).toEqual([
      // the scheduler: the step this page IS, and no page claims the run is
      // still short of the step it is standing on;
      null,
      "false",
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
    holdStateMock.mockImplementation(async () => HELD);
    const { container } = await renderSetupSurface({ park: LIVE_HOLD, slot: PENDING_REVIEW });

    for (const row of rows(container)) {
      expect(row.querySelector('[data-testid="scheduler-form"]')).toBeNull();
      expect(row.querySelector("[data-lifecycle-card]")).toBeNull();
      expect(row.querySelector("[data-run-review-slot]")).toBeNull();
    }
    // The rail column carries the rows and the marks between them, and nothing
    // else: three entries, and one separator standing between each adjacent
    // pair (cinatra#3188 item 2).
    const railChildren = Array.from(railColumn(container)[0].children);
    expect(railChildren.length).toBe(5);
    expect(
      railChildren.filter((child) => child.matches("[data-run-surface-rail-separator]")).length,
    ).toBe(2);
  });

  it("draws NO agentic run progress card beside the selected step", async () => {
    const { container } = await renderSetupSurface();

    expect(container.textContent).not.toContain("Agentic Run Progress");
    expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ITEM 3, FIRST HALF: THE SKILLS-RECOMMENDATION STEP (cinatra#2970).
//
// "The skills-recommendation step and the review step open the same way, to the
// right of the steps, never under a row."
// ---------------------------------------------------------------------------
describe("the skills-recommendation step opens exactly when the run has one to show", () => {
  it("opens the SHIPPED card to the right of the steps for a LIVE hold", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { container } = await renderSetupSurface({ park: LIVE_HOLD });

    expect(rows(container)[1].getAttribute("data-run-surface-rail-reached")).toBe("true");
    expect(rows(container)[1].hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(container.querySelector('[data-action="open-recommendation-step"]')!);
    await waitFor(() => expect(holdCard(container)).not.toBeNull());

    const card = holdCard(container)!;
    expect(card.getAttribute("data-lifecycle-card-state")).toBe("held");
    expect(detailColumn(container)[0].contains(card)).toBe(true);
    expect(railColumn(container)[0].contains(card)).toBe(false);
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("run_card");
    // One step at a time: the scheduler is not drawn beside it.
    expect(container.querySelector('[data-testid="scheduler-form"]')).toBeNull();
    expect(rows(container)[1].getAttribute("data-run-surface-rail-selected")).toBe("true");
    expect(rows(container)[0].getAttribute("data-run-surface-rail-selected")).toBe("false");
  });

  it("opens the SETTLED reading once a person has decided — the row keeps its place", async () => {
    // The ratified drawing: "A resolved gate stays on the rail as read-only
    // history — its entry keeps its place and records how it was settled." The
    // step opens the same one renderer, which draws its own settled reading —
    // and the reading is READ BACK here, so a row that opened onto nothing would
    // fail rather than pass on the press alone.
    holdStateMock.mockImplementation(async () => DECIDED);
    const { container } = await renderSetupSurface({ park: DECIDED_HOLD });

    expect(rows(container)[1].getAttribute("data-run-surface-rail-reached")).toBe("true");
    expect(rows(container)[1].getAttribute("data-action")).toBe("open-recommendation-step");
    fireEvent.click(container.querySelector('[data-action="open-recommendation-step"]')!);
    await waitFor(() => expect(holdCard(container)).not.toBeNull());

    const card = holdCard(container)!;
    expect(card.getAttribute("data-lifecycle-card-state")).toBe("decided");
    expect(detailColumn(container)[0].contains(card)).toBe(true);
    expect(detailColumn(container)[0].textContent).toContain("Skill A");
    expect(rows(container)[1].getAttribute("data-run-surface-rail-selected")).toBe("true");
  });

  it("CLOSES the step on a run that never held — the row stays, muted", async () => {
    // THE INVERSION THIS FIXES. The row used to close on the run's STATUS, and a
    // recommendation hold parks its run at `pending_input` — so the row was
    // closed exactly when the card had something to draw and open when it had
    // nothing. It closes on the run's own PARK now: no park, no step.
    const { container } = await renderSetupSurface({ park: null });

    // Still a row, still named, still in the series — muted, not removed.
    expect(rows(container).length).toBe(3);
    expect(rows(container)[1].textContent).toBe("2Recommendation");
    expect(rows(container)[1].getAttribute("data-run-surface-rail-reached")).toBe("false");
    expect(rows(container)[1].getAttribute("aria-disabled")).toBe("true");
    // The row's action NAMES the state instead of promising an open.
    expect(rows(container)[1].getAttribute("data-action")).toBe(
      "recommendation-step-unavailable",
    );
    expect(container.querySelector('[data-action="open-recommendation-step"]')).toBeNull();

    // Clicking it does nothing: the scheduler stays open and the detail column
    // never goes empty.
    fireEvent.click(rows(container)[1]);
    await waitFor(() =>
      expect(rows(container)[0].getAttribute("data-run-surface-rail-selected")).toBe("true"),
    );
    expect(rows(container)[1].getAttribute("data-run-surface-rail-selected")).toBe("false");
    const form = container.querySelector('[data-testid="scheduler-form"]')!;
    expect(form).not.toBeNull();
    expect(detailColumn(container)[0].contains(form)).toBe(true);
    expect(holdCard(container)).toBeNull();
    // And the card was never even asked: a step the run has nothing for opens
    // nothing.
    expect(holdStateMock).not.toHaveBeenCalled();
  });

  it("CLOSES the step on a hold that EXPIRED undecided — terminal is not decided", async () => {
    // The TTL sweeper's fail-closed park is terminal, so the ENTRY predicate
    // reads it as settled — and nobody answered it, so there are no selected
    // revisions and no skip on file and the card resolves to nothing. An
    // openable row over that is the empty column the ruling forbids, and it is
    // the case a "terminal means decided" reading gets wrong.
    holdStateMock.mockImplementation(async () => ({ state: "none" }));
    const { container } = await renderSetupSurface({ park: EXPIRED_HOLD });

    expect(rows(container)[1].getAttribute("data-run-surface-rail-reached")).toBe("false");
    expect(rows(container)[1].getAttribute("aria-disabled")).toBe("true");
    expect(container.querySelector('[data-action="open-recommendation-step"]')).toBeNull();

    fireEvent.click(rows(container)[1]);
    await waitFor(() =>
      expect(rows(container)[0].getAttribute("data-run-surface-rail-selected")).toBe("true"),
    );
    expect(container.querySelector('[data-testid="scheduler-form"]')).not.toBeNull();
    expect(holdStateMock).not.toHaveBeenCalled();
  });

  it("comes back to the scheduler, and never shows two step surfaces together", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { container } = await renderSetupSurface({ park: LIVE_HOLD });

    fireEvent.click(container.querySelector('[data-action="open-recommendation-step"]')!);
    await waitFor(() => expect(holdCard(container)).not.toBeNull());
    expect(container.querySelector('[data-testid="scheduler-form"]')).toBeNull();

    fireEvent.click(container.querySelector('[data-action="open-schedule-step"]')!);
    expect(container.querySelector('[data-testid="scheduler-form"]')).not.toBeNull();
    expect(holdCard(container)).toBeNull();
  });
});

describe("recommendationRailStepOpens — a terminal park is not a decided one", () => {
  it("opens on a live hold and on a released one, and on nothing else", () => {
    expect(recommendationRailStepOpens({ entry: "live", parkStatus: "parked" })).toBe(true);
    expect(recommendationRailStepOpens({ entry: "settled", parkStatus: "released" })).toBe(true);
    // The TTL sweeper's fail-closed park: terminal, and nobody decided.
    expect(
      recommendationRailStepOpens({ entry: "settled", parkStatus: "policy_unresolved" }),
    ).toBe(false);
    expect(recommendationRailStepOpens({ entry: "none", parkStatus: null })).toBe(false);
    expect(recommendationRailStepOpens({ entry: "none", parkStatus: undefined })).toBe(false);
    // An unknown status is not a decision either — it is not read as one.
    expect(recommendationRailStepOpens({ entry: "settled", parkStatus: "who-knows" })).toBe(
      false,
    );
  });

  it("is the ENTRY question's companion, not a replacement for it", () => {
    // The entry says whether the row EXISTS — a settled entry keeps its place on
    // the rail even where it opens nothing, because the run page has a run
    // detail behind it. This says whether it can be OPENED where there is
    // nothing behind it.
    expect(recommendationRailEntry({ hasPark: false, held: false, hostsCard: true })).toBe(
      "none",
    );
    expect(recommendationRailEntry({ hasPark: true, held: true, hostsCard: true })).toBe("live");
    expect(recommendationRailEntry({ hasPark: true, held: false, hostsCard: true })).toBe(
      "settled",
    );
  });
});

// ---------------------------------------------------------------------------
// ITEM 3, SECOND HALF: THE REVIEW STEP (cinatra#2970).
//
// It was composed `surface: null` unconditionally, so it could never open for
// ANY run — the row carried `aria-disabled` on every setup page and pressing it
// did nothing at all (cell C11). Its surface is the run's own review slot now,
// read by the same reader the run page's panel reads it with (cinatra#2997), and
// drawn by the same two components: plan (A) §4.2's placeholder while the run
// works, and the review card in place once the output is generated.
// ---------------------------------------------------------------------------
describe("the review step opens the run's review slot", () => {
  it("opens the PLACEHOLDER while the run's review question is still open", async () => {
    const { container } = await renderSetupSurface({ slot: AWAITING_REVIEW });

    expect(rows(container)[2].getAttribute("data-run-surface-rail-reached")).toBe("true");
    expect(rows(container)[2].getAttribute("data-action")).toBe("open-review-step");
    fireEvent.click(container.querySelector('[data-action="open-review-step"]')!);

    const slot = reviewSlot(container)!;
    expect(slot).not.toBeNull();
    expect(slot.getAttribute("data-run-review-slot")).toBe("working");
    expect(
      slot.querySelector('[data-conformance-id="review-gate-placeholder"]'),
    ).not.toBeNull();
    // TO THE RIGHT OF THE STEPS, never under a row.
    expect(detailColumn(container)[0].contains(slot)).toBe(true);
    expect(railColumn(container)[0].contains(slot)).toBe(false);
    // One step at a time.
    expect(container.querySelector('[data-testid="scheduler-form"]')).toBeNull();
  });

  it("opens the REVIEW CARD in place once a gate is on file", async () => {
    const { container } = await renderSetupSurface({ slot: PENDING_REVIEW });

    expect(rows(container)[2].getAttribute("data-run-surface-rail-reached")).toBe("true");
    fireEvent.click(container.querySelector('[data-action="open-review-step"]')!);

    // THE CARD ITSELF, resolved. The box around it proves nothing — the card
    // draws no DOM until its own resolve answers — so the assertion is on the
    // card's root, which only appears when the review screen is really there.
    const card = await waitFor(() => {
      const el = container.querySelector('[data-conformance-id="review-gate-card"]');
      if (!el) throw new Error("the review card did not draw");
      return el as HTMLElement;
    });
    const slot = reviewSlot(container)!;
    expect(slot.getAttribute("data-run-review-slot")).toBe("review");
    expect(slot.contains(card)).toBe(true);
    // The card takes the slot, and the placeholder stands down: the swap is the
    // ruled property (plan (A) §4.2), so both halves are asserted.
    expect(slot.querySelector('[data-conformance-id="review-gate-placeholder"]')).toBeNull();
    expect(detailColumn(container)[0].contains(card)).toBe(true);
    expect(railColumn(container)[0].contains(card)).toBe(false);
    expect(rows(container)[2].getAttribute("data-run-surface-rail-selected")).toBe("true");
  });

  it("CLOSES the review step for a run with no review to show — the row stays, muted", async () => {
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
});

// ---------------------------------------------------------------------------
// THE RULING'S LAST CLAUSE, AS A PROPERTY OF THE WHOLE RAIL (cinatra#2970):
// "the right column never shows an empty step surface."
//
// The two cells that failed (C10, C11) are two instances of one rule, so the
// rule is checked as a rule: EVERY row the rail draws as openable, opened, and
// the column read back. What is asserted is the CONTENT the production
// component drew — the form's own words, the card's own root — never the box
// this page puts around it, because a box is exactly what an empty column looks
// like when it has a wrapper.
// ---------------------------------------------------------------------------
describe("no selectable row ever opens an empty run detail", () => {
  const RUNS: { name: string; opts: RunFixture; hold: HoldState }[] = [
    { name: "a run with nothing but its scheduler", opts: {}, hold: { state: "none" } },
    { name: "a run holding at its skills question", opts: { park: LIVE_HOLD }, hold: HELD },
    {
      name: "a run whose skills question was decided",
      opts: { park: DECIDED_HOLD },
      hold: DECIDED,
    },
    {
      name: "a run whose skills hold expired undecided",
      opts: { park: EXPIRED_HOLD },
      hold: { state: "none" },
    },
    {
      name: "a run whose review question is still open",
      opts: { slot: AWAITING_REVIEW },
      hold: { state: "none" },
    },
    {
      name: "a run with a review gate on file",
      opts: { slot: PENDING_REVIEW },
      hold: { state: "none" },
    },
    {
      name: "a run carrying every step at once",
      opts: { park: LIVE_HOLD, slot: PENDING_REVIEW },
      hold: HELD,
    },
  ];

  /** What the production component draws for the step this row opens. */
  function drawnMarkerFor(key: string, opts: RunFixture): string {
    if (key === "schedule") return '[data-testid="scheduler-form"]';
    if (key === "recommendation") return '[data-lifecycle-card="recommendation_hold"]';
    return runReviewStepReading(opts.slot ?? null) === "review"
      ? '[data-conformance-id="review-gate-card"]'
      : '[data-conformance-id="review-gate-placeholder"]';
  }

  for (const { name, opts, hold } of RUNS) {
    it(`${name}: every openable row draws its own surface`, async () => {
      // THE RUN'S OWN HOLD STATE, not a live one forced on every fixture. A
      // harness that answers `held` for a decided or expired park is testing a
      // run that does not exist, and it is exactly how an empty column hides.
      holdStateMock.mockImplementation(async () => hold);
      const { container } = await renderSetupSurface(opts);

      const openable = rows(container).filter(
        (r) => r.getAttribute("aria-disabled") !== "true",
      );
      // The rail always carries the step the page is standing on, so "every
      // openable row" is never vacuously none.
      expect(openable.length).toBeGreaterThan(0);

      for (const row of openable) {
        const key = row.getAttribute("data-run-surface-rail-step-key")!;
        // The row promises an opening, so it must be addressable as one.
        expect(row.getAttribute("data-action")).toBe(`open-${key}-step`);
        fireEvent.click(row);
        await waitFor(() =>
          expect(
            detailColumn(container)[0].getAttribute("data-run-surface-selected-step"),
          ).toBe(key),
        );
        const marker = drawnMarkerFor(key, opts);
        await waitFor(() => {
          const drawn = detailColumn(container)[0].querySelector(marker);
          if (!drawn) throw new Error(`${key} opened a run detail with no ${marker} in it`);
        });
      }
    });
  }

  it("marks NO row open when the rail has no step it can open", () => {
    // A degenerate list no page composes — a rail always carries the step its
    // page is standing on. It is still drawn honestly: no row claims to be
    // open, and no empty step surface is mounted under a row that does.
    const { container } = render(
      <RunSurfaceRail
        steps={buildSetupRailSteps([
          { key: "recommendation", surface: null },
          { key: "review", surface: null, reached: false },
        ])}
        initialSelection="schedule"
      />,
    );

    expect(rows(container).length).toBe(2);
    for (const row of rows(container)) {
      expect(row.getAttribute("aria-disabled")).toBe("true");
      expect(row.getAttribute("data-run-surface-rail-selected")).toBe("false");
      expect(row.hasAttribute("aria-current")).toBe(false);
    }
    // The frame says out loud that it is showing the run's own detail rather
    // than any step — and the page composed none, so the column is empty
    // because there is nothing to show, not because a row opened onto nothing.
    expect(detailColumn(container)[0].getAttribute("data-run-surface-selected-step")).toBe(
      "detail",
    );
    expect(detailColumn(container)[0].childNodes.length).toBe(0);
  });

  it("never opens onto a step with no surface, even when the page asks for it", async () => {
    // An `initialSelection` naming a step that has nothing drawn for it falls
    // through to the first row that HAS a surface, rather than painting the
    // empty right column cinatra#2970 forbids.
    const { container } = render(
      <RunSurfaceRail
        steps={buildSetupRailSteps(await setupSteps())}
        initialSelection="review"
      />,
    );

    expect(detailColumn(container)[0].getAttribute("data-run-surface-selected-step")).toBe(
      "schedule",
    );
    expect(container.querySelector('[data-testid="scheduler-form"]')).not.toBeNull();
    expect(rows(container)[0].getAttribute("data-run-surface-rail-selected")).toBe("true");
    expect(rows(container)[2].getAttribute("data-run-surface-rail-selected")).toBe("false");
  });

  it("closes a row its page read as still ahead, even when that step HAS a surface", () => {
    // The two reasons a row closes are independent. This isolates the `reached`
    // one, so the rule cannot be passed by the surface check alone.
    const { container } = render(
      <RunSurfaceRail
        steps={buildSetupRailSteps([
          { key: "schedule", surface: <SchedulerForm /> },
          { key: "review", surface: <RunProgress />, reached: false },
        ])}
        initialSelection="schedule"
      />,
    );

    const row = rows(container)[1];
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.getAttribute("data-action")).toBe("review-step-unavailable");
    expect(container.querySelector('[data-action="open-review-step"]')).toBeNull();

    fireEvent.click(row);

    expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="scheduler-form"]')).not.toBeNull();
    expect(detailColumn(container)[0].getAttribute("data-run-surface-selected-step")).toBe(
      "schedule",
    );
  });

  it("the frame FALLS BACK for every value the predicate calls nothing — including `false`", () => {
    // The predicate and the renderer have to agree on what "nothing drawn" is.
    // They used to part company on `false`: the predicate read it as nothing and
    // let the row open on the strength of the run detail behind it, and `??`
    // read it as the step's own surface and suppressed that fallback — an
    // openable row over an empty column.
    const { container } = render(
      <RunSurfaceRail
        steps={[
          { key: "schedule", row: <span data-testid="row-schedule" />, surface: false },
        ]}
        detail={<RunProgress />}
        initialSelection="schedule"
      />,
    );

    expect(isRunSurfaceStepSelectable({ surface: false }, <RunProgress />)).toBe(true);
    expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull();
  });

  it("keeps the rail's own tri-state rule — surface, and reached only where it is read", () => {
    const surface = <SchedulerForm />;
    // Reached is a THIRD answer: unstated leaves the row openable, because
    // silence is not a claim that the run is still short of the step.
    expect(isRunSurfaceStepSelectable({ surface }, null)).toBe(true);
    expect(isRunSurfaceStepSelectable({ surface, reached: true }, null)).toBe(true);
    expect(isRunSurfaceStepSelectable({ surface, reached: false }, null)).toBe(false);
    // No surface AND nothing to fall back to, no opening — whatever the rail was
    // told about reaching it.
    expect(isRunSurfaceStepSelectable({ surface: null }, null)).toBe(false);
    expect(isRunSurfaceStepSelectable({ surface: null, reached: true }, null)).toBe(false);
    // A page that DOES compose a run detail is the case the run page is: the
    // settled recommendation carries no surface of its own on purpose, and its
    // row opens onto the reading already beside it (cinatra#2790).
    expect(isRunSurfaceStepSelectable({ surface: null }, surface)).toBe(true);
    expect(isRunSurfaceStepSelectable({ surface: null, reached: false }, surface)).toBe(false);
  });
});
