// @vitest-environment jsdom
//
// THE SCHEDULE STEP OPENS ON THE RIGHT (cinatra#2788, epic #2784 S9d rework).
//
// Plan (A) §7.2 step 5 / §7.4 step 7: "open that step to see the configuration
// or change it — it opens to the right of the steps, never directly under a
// step, and no agentic run progress card is shown with it." The ratified drawing
// `images/lifecycle-screens/design-run-surface-rail-and-gate.png` draws the same
// frame: "a step rail down the left names the run's ordered steps, and the run
// detail on the right shows the selected step … Selecting a step opens it on the
// right … right here in the run detail, under the same rail".
//
// WHAT WAS WRONG. The round this replaces opened the configuration INSIDE the
// rail column, directly under the row, and left the run-detail column drawing
// "Agentic Run Progress" beside it for a run that had never executed. Both are
// pinned here as DOM facts — which column the form is a descendant of, and what
// is drawn beside it — because both were visible in the rejected capture and
// neither was measurable from source.
//
// Run:
//   cd packages/agents && npx vitest run src/__tests__/schedule-rail-step.test.tsx

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { TriggerScheduleProposalViewBody } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import { Button } from "@/components/ui/button";

import { ScheduleRailStep, useRunStepSelection } from "../schedule-rail-step";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SETTLED: TriggerScheduleProposalViewBody = {
  phase: "settled",
  version: 1,
  agentName: "Weekly cohort sweep",
  runId: "run-777",
  schedule: {
    kind: "recurring",
    timezone: "Europe/Berlin",
    selection: {
      frequency: "weekly",
      interval: 1,
      weekdays: [1, 2, 3, 4, 5],
      dayOfMonth: 1,
      monthlyMode: "date",
      nthWeek: 1,
      monthlyWeekday: 1,
      quarterAnchor: "start",
      yearlyMonth: 1,
      hour: 9,
      minute: 0,
    },
  },
  triggerType: "recurring",
  scheduleCopy: "Every weekday at 9:00 AM",
  timezone: "Europe/Berlin",
  gatedSteps: [],
  released: false,
  arming: false,
  canSave: true,
  canCancel: true,
  canRelease: false,
};

/** The resolve answer the card parses, in the per-kind envelope (S9c). */
function mockResolve(body: TriggerScheduleProposalViewBody = SETTLED) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "trigger_schedule_proposal",
          // A settled state carries no decision axis — the union is strict.
          state: { state: "settled" },
          body,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

/** A rail row drawn by the rail BESIDE the step — the review page's Review row
 *  is exactly this: a row that selects the run detail. */
function DetailRow() {
  const selection = useRunStepSelection();
  return (
    <Button
      type="button"
      variant="ghost"
      data-testid="detail-row"
      onClick={() => selection?.select("detail")}
    >
      Review
    </Button>
  );
}

/** The run detail as a page composes it: the run's progress section. */
function RunProgress() {
  return (
    <section data-testid="run-detail-panel">
      <h2>Agentic Run Progress</h2>
    </section>
  );
}

function renderSurface(initialSelection: "schedule" | "detail") {
  return render(
    <div className="flex items-start gap-6" data-run-detail-contract="">
      <ScheduleRailStep
        host="run_card"
        cardRef="schedule-ref-1"
        displayStep={1}
        rail={<DetailRow />}
        detail={<RunProgress />}
        initialSelection={initialSelection}
      />
    </div>,
  );
}

const railColumn = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-run-step-rail-column]");
const detailColumn = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-run-detail-column]");
const card = (c: HTMLElement) =>
  c.querySelector<HTMLElement>('[data-lifecycle-card="trigger_schedule_proposal"]');

describe("the schedule step's surface opens in the RUN DETAIL, not under its rail row", () => {
  it("draws the form inside the run-detail column and NOT inside the rail column", async () => {
    mockResolve();
    const { container } = renderSurface("schedule");

    await waitFor(() => expect(card(container)).not.toBeNull());

    const rail = railColumn(container)!;
    const detail = detailColumn(container)!;
    const form = card(container)!;
    // The two columns are siblings inside the run-detail contract, in this order.
    expect(container.querySelector("[data-run-detail-contract]")!.children.length).toBe(2);
    expect(detail.contains(form)).toBe(true);
    expect(rail.contains(form)).toBe(false);
    // The rail row stays a ROW: the entry is in the rail, its surface is not.
    const entry = rail.querySelector('[data-conformance-id="schedule-rail-step"]')!;
    expect(entry).not.toBeNull();
    expect(entry.contains(form)).toBe(false);
    expect(entry.getAttribute("data-schedule-step-selected")).toBe("true");
  });

  it("draws NO agentic run progress beside it — the selected step is what the detail shows", async () => {
    mockResolve();
    const { container } = renderSurface("schedule");

    await waitFor(() => expect(card(container)).not.toBeNull());

    expect(container.textContent).not.toContain("Agentic Run Progress");
    expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull();
  });

  it("shows the run's own detail when another step is selected — and still lists the schedule row", async () => {
    mockResolve();
    const { container } = renderSurface("detail");

    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull(),
    );

    expect(container.textContent).toContain("Agentic Run Progress");
    expect(card(container)).toBeNull();
    const entry = railColumn(container)!.querySelector(
      '[data-conformance-id="schedule-rail-step"]',
    )!;
    expect(entry.textContent).toContain("Schedule");
    expect(entry.getAttribute("data-schedule-step-selected")).toBe("false");
  });

  it("swaps on selection, and never draws the two surfaces together", async () => {
    mockResolve();
    const { container } = renderSurface("schedule");

    await waitFor(() => expect(card(container)).not.toBeNull());
    expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull();

    fireEvent.click(container.querySelector('[data-testid="detail-row"]')!);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="run-detail-panel"]')).not.toBeNull(),
    );
    expect(card(container)).toBeNull();

    fireEvent.click(container.querySelector('[data-action="open-schedule-step"]')!);
    await waitFor(() => expect(card(container)).not.toBeNull());
    expect(container.querySelector('[data-testid="run-detail-panel"]')).toBeNull();
  });
});

describe("the row keeps every anchor its readers address it by", () => {
  // The row is drawn from the SHARED run-surface rail row since cinatra#2970.
  // A shared row is only safe while nothing it carried is lost, so every anchor
  // the capture walk, the review page and this suite address is asserted off
  // the RENDERED element rather than off the source that emits it.
  it("carries the six attributes and the indicator id, on one button element", async () => {
    mockResolve();
    const { container } = renderSurface("schedule");

    await waitFor(() => expect(card(container)).not.toBeNull());

    const entry = railColumn(container)!.querySelector<HTMLElement>(
      '[data-conformance-id="schedule-rail-step"]',
    )!;
    expect(entry).not.toBeNull();
    expect(entry.tagName).toBe("BUTTON");
    expect(entry.getAttribute("type")).toBe("button");
    expect(entry.hasAttribute("data-schedule-rail-step")).toBe(true);
    expect(entry.getAttribute("data-schedule-rail-host")).toBe("run_card");
    expect(entry.getAttribute("data-schedule-step-selected")).toBe("true");
    expect(entry.getAttribute("data-action")).toBe("open-schedule-step");
    expect(entry.getAttribute("aria-current")).toBe("step");
    const indicator = entry.querySelector<HTMLElement>(
      '[data-conformance-id="schedule-rail-indicator"]',
    )!;
    expect(indicator).not.toBeNull();
    expect(entry.textContent).toBe("1Schedule");
    // This row states nothing about "reached" — it is the step the surface is
    // on. An `available` handed down from here would print the mark and change
    // the tokens, so its ABSENCE is what is pinned, not just the rest.
    expect(entry.hasAttribute("data-run-surface-rail-reached")).toBe(false);
    expect(indicator.className).toContain("bg-primary");
    expect(indicator.className).not.toContain("bg-muted-foreground/40");
    expect(entry.querySelector("span:last-of-type")!.className).toContain("text-foreground");
    // The two columns keep the ids the capture recorder counts.
    expect(
      container.querySelectorAll('[data-conformance-id="run-step-rail-column"]').length,
    ).toBe(1);
    expect(
      container.querySelectorAll('[data-conformance-id="run-detail-column"]').length,
    ).toBe(1);
  });

  it("says the host it was mounted on — the review page's row is not the run page's", () => {
    mockResolve();
    const { container } = render(
      <div className="flex items-start gap-6" data-run-detail-contract="">
        <ScheduleRailStep
          host="page_gate_region"
          cardRef="schedule-ref-2"
          displayStep={1}
          rail={<DetailRow />}
          detail={<RunProgress />}
          initialSelection="detail"
        />
      </div>,
    );

    const entry = container.querySelector<HTMLElement>(
      '[data-conformance-id="schedule-rail-step"]',
    )!;
    expect(entry.getAttribute("data-schedule-rail-host")).toBe("page_gate_region");
    expect(entry.getAttribute("data-schedule-step-selected")).toBe("false");
    expect(entry.hasAttribute("aria-current")).toBe(false);
    expect(entry.hasAttribute("data-run-surface-rail-reached")).toBe(false);
    // The UNSELECTED tokens, unchanged by the shared row.
    const indicator = entry.querySelector<HTMLElement>(
      '[data-conformance-id="schedule-rail-indicator"]',
    )!;
    expect(indicator.className).toContain("bg-muted-foreground/40");
    expect(entry.querySelector("span:last-of-type")!.className).toContain(
      "text-muted-foreground",
    );
  });
});
