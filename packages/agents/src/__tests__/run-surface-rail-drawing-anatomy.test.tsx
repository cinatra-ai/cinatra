// @vitest-environment jsdom
/**
 * THE RAIL'S ANATOMY, AGAINST THE RATIFIED DRAWING (cinatra#3188 items 1 & 2).
 *
 * The run-surface drawing fixes the rail's anatomy in its own stylesheet, and
 * two of its sentences were not drawn:
 *
 *   ".rail .step.upcoming .glyph, .rail .step.settled .glyph {
 *      background: rgba(92,103,121,0.4); color: var(--paper); }"
 *
 *   ".rail .sep { width: 2px; height: 8px; margin: 4px 0 4px 11px;
 *      border-radius: 1px; background: var(--line); }"
 *
 * and the drawing's own rail draws a `sep` between every pair of adjacent
 * entries.
 *
 * The first says a SETTLED entry's circle takes the SAME muted ground the
 * upcoming entry already takes — the indigo fill belongs to the entry the run
 * is on, not to the history above it. The rail drew the settled circle filled
 * instead. The second says a separator stands between entries; the rail drew
 * none at all.
 *
 * WHAT IS PINNED HERE is the reading a picture is graded on: the classes the
 * circle resolves to, and a separator element of the drawing's own measurements
 * standing between every pair of adjacent rows.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-surface-rail-drawing-anatomy.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { RunSurfaceRail, RunSurfaceRailRow } from "../run-surface-rail";
import { RecommendationRailStepRow } from "../recommendation-rail-step";
import type { RunSurfaceRailStep } from "../run-surface-rail-step";

afterEach(() => {
  cleanup();
});

/** The drawing's muted ground for an entry that is not the one being read. */
const MUTED_GROUND = "bg-muted-foreground/40";
/** The indigo fill, which the drawing gives the OPEN entry alone. */
const PRIMARY_FILL = "bg-primary";

const ROW_SEL = "[data-run-surface-rail-step]";
const SEP_SEL = "[data-run-surface-rail-separator]";
const COLUMN_SEL = '[data-conformance-id="run-step-rail-column"]';

function StepSurface({ name }: { name: string }) {
  return <div data-testid={`surface-${name}`}>{name}</div>;
}

/** Three entries: one settled above, the open one, one still ahead. */
function threeSteps(): RunSurfaceRailStep[] {
  return [
    {
      key: "schedule",
      row: (
        <RunSurfaceRailRow
          selectionKey="schedule"
          label="Schedule"
          displayStep={1}
          conformanceId="schedule-rail-step"
          action="open-schedule-step"
          settled
        />
      ),
      surface: <StepSurface name="schedule" />,
    },
    {
      key: "recommendation",
      row: (
        <RunSurfaceRailRow
          selectionKey="recommendation"
          label="Recommendation"
          displayStep={2}
          conformanceId="recommendation-rail-step"
          action="open-recommendation-step"
        />
      ),
      surface: <StepSurface name="recommendation" />,
    },
    {
      key: "review",
      row: (
        <RunSurfaceRailRow
          selectionKey="review"
          label="Review"
          displayStep={3}
          conformanceId="review-rail-step"
          action="open-review-step"
          reached={false}
          selectable={false}
        />
      ),
      surface: null,
    },
  ];
}

function renderRail(rail: React.ReactNode = null) {
  return render(
    <RunSurfaceRail
      steps={threeSteps()}
      rail={rail}
      detail={<StepSurface name="detail" />}
      initialSelection="recommendation"
    />,
  );
}

function rows(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(ROW_SEL));
}

function indicatorOf(row: HTMLElement) {
  return row.querySelector<HTMLElement>("span")!;
}

describe("the settled entry's circle takes the drawing's muted ground (item 1)", () => {
  it("draws the settled circle on the muted ground, never the indigo fill", () => {
    const { container } = renderRail();
    const settled = rows(container)[0]!;

    expect(settled.getAttribute("data-run-surface-rail-settled")).toBe("true");
    const circle = indicatorOf(settled);
    expect(circle.className).toContain(MUTED_GROUND);
    expect(circle.className).not.toContain(PRIMARY_FILL);
  });

  it("gives the settled entry the SAME ground the upcoming entry already takes", () => {
    const { container } = renderRail();
    const settled = indicatorOf(rows(container)[0]!);
    const upcoming = indicatorOf(rows(container)[2]!);

    // The drawing names the two in ONE rule, so the two circles cannot part
    // company: whatever ground the upcoming entry resolves to is the settled
    // entry's ground too.
    expect(settled.className).toBe(upcoming.className);
  });

  it("keeps the indigo fill for the entry the surface is actually on", () => {
    const { container } = renderRail();
    const open = indicatorOf(rows(container)[1]!);

    expect(open.className).toContain(PRIMARY_FILL);
    expect(open.className).not.toContain(MUTED_GROUND);
  });

  it("draws the settled circle the same way on the gate step's own row", () => {
    // The recommendation gate draws its OWN row rather than the shared one, and
    // a rail whose two kinds of row disagree about the same state is two
    // vocabularies rather than one rail.
    const { container } = render(
      <RunSurfaceRail
        steps={[
          {
            key: "recommendation",
            row: <RecommendationRailStepRow displayStep={1} settled />,
            surface: <StepSurface name="recommendation" />,
          },
        ]}
        detail={<StepSurface name="detail" />}
        initialSelection="recommendation"
      />,
    );
    const circle = container.querySelector<HTMLElement>(
      '[data-conformance-id="recommendation-rail-indicator"]',
    )!;
    expect(circle).not.toBeNull();
    expect(circle.className).toContain(MUTED_GROUND);
    expect(circle.className).not.toContain(PRIMARY_FILL);
  });
});

describe("a separator stands between adjacent entries (item 2)", () => {
  it("puts one separator between every pair of adjacent rows, and none at the ends", () => {
    const { container } = renderRail();
    const column = container.querySelector<HTMLElement>(COLUMN_SEL)!;
    const kinds = Array.from(column.children).map((child) =>
      child.matches(SEP_SEL) ? "sep" : child.matches(ROW_SEL) ? "row" : "other",
    );

    expect(kinds).toEqual(["row", "sep", "row", "sep", "row"]);
  });

  it("draws the separator at the drawing's own measurements", () => {
    const { container } = renderRail();
    const sep = container.querySelector<HTMLElement>(SEP_SEL)!;

    expect(sep).not.toBeNull();
    // 2px wide, 8px tall, 1px corners, on the line token, 4px above and below
    // and indented 11px — the centre of the 24px circle beside it.
    expect(sep.className).toContain("w-0.5");
    expect(sep.className).toContain("h-2");
    expect(sep.className).toContain("rounded-[1px]");
    expect(sep.className).toContain("bg-line");
    expect(sep.className).toContain("my-1");
    expect(sep.className).toContain("ml-[11px]");
    // It is a mark, not a row: nothing to read out and nothing to press.
    expect(sep.getAttribute("aria-hidden")).toBe("true");
    expect(sep.textContent).toBe("");
  });

  it("separates the gate rows from the page's own rail below them", () => {
    const { container } = renderRail(<div data-testid="page-rail">steps</div>);
    const column = container.querySelector<HTMLElement>(COLUMN_SEL)!;
    const children = Array.from(column.children);
    const pageRail = container.querySelector<HTMLElement>('[data-testid="page-rail"]')!;
    const before = children[children.indexOf(pageRail) - 1]!;

    expect(before.matches(SEP_SEL)).toBe(true);
  });

  it("draws no separator for a rail of one entry", () => {
    const { container } = render(
      <RunSurfaceRail
        steps={[
          {
            key: "schedule",
            row: (
              <RunSurfaceRailRow
                selectionKey="schedule"
                label="Schedule"
                displayStep={1}
                conformanceId="schedule-rail-step"
                action="open-schedule-step"
              />
            ),
            surface: <StepSurface name="schedule" />,
          },
        ]}
        detail={<StepSurface name="detail" />}
        initialSelection="schedule"
      />,
    );

    expect(container.querySelectorAll(SEP_SEL).length).toBe(0);
  });
});
