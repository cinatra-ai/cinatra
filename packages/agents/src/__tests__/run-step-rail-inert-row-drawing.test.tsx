// @vitest-environment jsdom
/**
 * A RAIL ROW THAT OPENS NOTHING IS DRAWN AS A ROW THAT OPENS NOTHING
 * (cinatra#3002, acceptance criterion 3 — fix leg 7).
 *
 * Fix leg 6 took the BUTTON off the step-result row: the row that opens nothing
 * stopped being a control in the DOM. The sixth proof round photographed the
 * result and read the same picture back — the row still draws the same circle,
 * the same numeral, the same title and the same box as the rows that DO open,
 * so ON PIXELS nothing tells a reader it does not open. A difference only the
 * DOM carries is not a difference the reader has.
 *
 * WHAT THE DRAWING GIVES, AND WHAT IT DOES NOT. The ratified drawing's run
 * surface names ONE action for this rail — "open-run-step -> step-detail", the
 * action the pinned manifest surface `run-step-rail` carries — and its rail
 * examples draw every row alike, parted only by the state ink: the entry
 * already passed and the entry still ahead share one muted ground, the entry
 * being read takes the ink. It draws NO row that looks like a step and cannot
 * be opened, because on the drawing every rail row opens: "selecting a step
 * opens it on the right". So there is no drawn treatment to copy for this row,
 * and inventing a mark the drawing does not have would be a second departure.
 *
 * THE READING TAKEN, AND WHY IT IS THE SYSTEM'S OWN. This rail already draws
 * rows a reader cannot press — a step still ahead is rendered `disabled`, and
 * the vendored stepper's own row carries `cursor-pointer ...
 * disabled:pointer-events-none disabled:opacity-60`. A row that cannot be
 * pressed is therefore ALREADY a 60%-ink row with no pointer cursor on this
 * very surface. The step-result row takes that same reading rather than a new
 * one: the drawing's row anatomy (24px glyph, numeral, title, 28px box, the
 * marks between the rows) is untouched, and the only thing that changes is the
 * affordance — which is exactly the difference the row was lying about.
 *
 * WHICH STEP-RESULT ROW IS EVEN DRAWN (cinatra#3226, merged in on the leg-8
 * forward). The rail names every entry by the work it did and draws no entry at
 * all for a record that names nothing — so the row this file is about is the
 * row a NAMED step result leaves. The nameless record's road (no row at all) is
 * pinned by `run-step-rail-step-result-entry.test.tsx`; between the two, every
 * step result the runtime can leave takes one of acceptance 3's two permitted
 * roads.
 *
 * WHAT THIS TEST PINS, IN BOTH PALETTES. The two rows are DIFFERENT on the
 * attributes a reader sees: the row that opens is a control at full ink with a
 * pointer cursor; the row that opens nothing is not a control, sits at the
 * rail's own not-pressable ink and takes no pointer. It pins the same reading
 * at BOTH sites that draw a step-result row — the page rail
 * (`RunStepRailPanel`) and the live rail's shared row (`RailExtraEntry`, which
 * the orchestrator rail renders every non-spine entry through, a surplus
 * step-result row included). And it pins that the treatment carries no
 * palette-scoped token, so the reader in the dark palette is told exactly what
 * the reader in the light one is told — the sixth round shot neither.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-step-rail-inert-row-drawing.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Stepper, StepperItem, StepperNav } from "@/components/reui/stepper";

import { buildRunStepRail } from "../run-step-rail";
import type { RunStepRailEntry } from "../run-step-rail";
import { RunStepRailPanel } from "../run-step-rail-panel";
import {
  RailExtraEntry,
  RUN_PAGE_RAIL_INERT_ROW_CLASS,
} from "../run-step-rail-extra-entry";

afterEach(() => {
  cleanup();
  document.documentElement.className = "";
});

/** The rail's own ink for a row a reader cannot press (the vendored stepper's
 *  `disabled:opacity-60`, which this rail already draws an upcoming step with). */
const NOT_PRESSABLE_INK = "opacity-60";
/** The cursor a row that opens nothing takes — never the control's pointer. */
const NOT_PRESSABLE_CURSOR = "cursor-default";
/** The cursor the vendored stepper puts on a row that DOES open. */
const PRESSABLE_CURSOR = "cursor-pointer";

function tokens(className: string | null | undefined): string[] {
  return (className ?? "").split(/\s+/).filter(Boolean);
}

/** The name the runtime's own record gives the work that surplus step did. */
const STEP_RESULT_WORK_NAME = "Reviewed the flow";

/** The rail a run on the agent runtime actually leaves: one template step that
 *  opens, and one surplus step-result row past it that opens nothing. The
 *  surplus record names its work, which is what earns it a row at all. */
function railWithBothRows() {
  return buildRunStepRail({
    templateSteps: [{ index: 1, stepNumber: 10, label: "Draft" }],
    stepResults: [
      { ok: true },
      {
        kind: "wayflow_response",
        output: "four findings",
        output_data: { title: STEP_RESULT_WORK_NAME },
      },
    ],
  });
}

function stepResultEntry(): RunStepRailEntry {
  return {
    key: "step:stepResult:2",
    ordinal: 2,
    kind: "step",
    label: STEP_RESULT_WORK_NAME,
    status: "completed",
    sources: ["stepResult"],
    openable: false,
  } as RunStepRailEntry;
}

function openableStepEntry(): RunStepRailEntry {
  return {
    key: "step:10",
    ordinal: 1,
    kind: "step",
    label: "Draft",
    status: "completed",
    sources: ["template"],
  } as RunStepRailEntry;
}

describe("the treatment itself (cinatra#3002 acceptance 3)", () => {
  it("is one declaration, at the rail's own not-pressable ink, with no pointer", () => {
    const declared = tokens(RUN_PAGE_RAIL_INERT_ROW_CLASS);
    expect(declared).toContain(NOT_PRESSABLE_INK);
    expect(declared).toContain(NOT_PRESSABLE_CURSOR);
    expect(declared).not.toContain(PRESSABLE_CURSOR);
  });

  it("reads the same in both palettes — no palette-scoped token in it", () => {
    // A distinction drawn only in the light palette is a distinction the reader
    // in the dark one does not get. The treatment is opacity and cursor, and
    // both read through the palette rather than against it.
    expect(RUN_PAGE_RAIL_INERT_ROW_CLASS ?? "").not.toMatch(/dark:/);
    expect(RUN_PAGE_RAIL_INERT_ROW_CLASS ?? "").not.toMatch(/light:/);
  });
});

for (const palette of ["light", "dark"] as const) {
  describe(`the step-result row against the row that opens — ${palette} palette`, () => {
    function renderInPalette(node: React.ReactElement) {
      document.documentElement.className = palette === "dark" ? "dark" : "";
      return render(node);
    }

    it("draws the page rail's two rows differently", () => {
      const rail = railWithBothRows();
      const { container } = renderInPalette(
        <RunStepRailPanel
          entries={rail.entries}
          activeOrdinal={null}
          reviewHrefBase="/agents/vendor/package/instance/review"
        />,
      );

      const inertWrapper = container.querySelector<HTMLElement>('[data-rail-openable="false"]');
      expect(inertWrapper).not.toBeNull();
      const inertRow = inertWrapper!.firstElementChild as HTMLElement;
      expect(inertRow).not.toBeNull();
      expect(inertRow.textContent).toContain(STEP_RESULT_WORK_NAME);

      const openableRow = container.querySelector<HTMLElement>(
        '[data-slot="stepper-trigger"]',
      );
      expect(openableRow).not.toBeNull();
      expect(openableRow!.textContent).toContain("Draft");

      // The row that opens nothing is not a control at all …
      expect(inertRow.tagName).not.toBe("BUTTON");
      expect(inertRow.querySelector("button")).toBeNull();
      expect(inertRow.getAttribute("role")).toBeNull();
      // … and it does not draw like one either.
      const inertTokens = tokens(inertRow.className);
      const openableTokens = tokens(openableRow!.className);
      expect(inertTokens).toContain(NOT_PRESSABLE_INK);
      expect(inertTokens).toContain(NOT_PRESSABLE_CURSOR);
      expect(inertTokens).not.toContain(PRESSABLE_CURSOR);
      expect(openableTokens).toContain(PRESSABLE_CURSOR);
      expect(openableTokens).not.toContain(NOT_PRESSABLE_INK);
      expect(inertRow.className).not.toBe(openableRow!.className);
    });

    it("draws the live rail's shared row the same way", () => {
      // The orchestrator rail renders every NON-SPINE entry through
      // `RailExtraEntry` — a surplus step-result row included — so the row that
      // opens nothing reaches the reader through this component on the branch
      // the run page actually mounts for a stepper run. One row, one reading.
      const { container } = renderInPalette(
        <Stepper value={1} orientation="vertical">
          <StepperNav>
            <StepperItem step={1} completed>
              <RailExtraEntry
                entry={stepResultEntry()}
                reviewHrefBase="/agents/vendor/package/instance/review"
                displayStep={1}
              />
            </StepperItem>
          </StepperNav>
        </Stepper>,
      );

      const wrapper = container.querySelector<HTMLElement>('[data-rail-kind="step"]');
      expect(wrapper).not.toBeNull();
      // The walk reads this row by its own attributes.
      expect(wrapper!.getAttribute("data-rail-openable")).toBe("false");
      expect(wrapper!.getAttribute("data-rail-status")).toBe("completed");
      expect(wrapper!.querySelector("button")).toBeNull();
      expect(wrapper!.querySelector("a")).toBeNull();

      const row = wrapper!.firstElementChild as HTMLElement;
      const rowTokens = tokens(row.className);
      expect(rowTokens).toContain(NOT_PRESSABLE_INK);
      expect(rowTokens).toContain(NOT_PRESSABLE_CURSOR);
      expect(rowTokens).not.toContain(PRESSABLE_CURSOR);
    });

    it("leaves the row that DOES open exactly as it was", () => {
      const { container } = renderInPalette(
        <Stepper value={1} orientation="vertical">
          <StepperNav>
            <StepperItem step={1} completed>
              <RailExtraEntry
                entry={openableStepEntry()}
                reviewHrefBase="/agents/vendor/package/instance/review"
                displayStep={1}
              />
            </StepperItem>
          </StepperNav>
        </Stepper>,
      );

      const wrapper = container.querySelector<HTMLElement>('[data-rail-kind="step"]');
      expect(wrapper).not.toBeNull();
      expect(wrapper!.getAttribute("data-rail-openable")).toBeNull();
      const trigger = wrapper!.querySelector<HTMLElement>('[data-slot="stepper-trigger"]');
      expect(trigger).not.toBeNull();
      const triggerTokens = tokens(trigger!.className);
      expect(triggerTokens).toContain(PRESSABLE_CURSOR);
      expect(triggerTokens).not.toContain(NOT_PRESSABLE_INK);
    });
  });
}
