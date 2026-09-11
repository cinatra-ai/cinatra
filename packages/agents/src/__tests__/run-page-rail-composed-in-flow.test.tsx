// @vitest-environment jsdom
/**
 * THE RAIL IS COMPOSED THE WAY THE DRAWING COMPOSES IT (cinatra#3225 items 2
 * and 3, fix leg 10).
 *
 * The ratified drawing, agent run and review surface, section I, states the rail
 * in three sentences:
 *
 *   ".rail .step  { display: flex; align-items: center; gap: 8px; padding: 2px 0;
 *                   font-size: 14px; line-height: 1.15 }"
 *   ".rail .step .glyph { width: 24px; height: 24px; border-radius: 50% }"
 *   ".rail .sep   { width: 2px; height: 8px; margin: 4px 0 4px 11px;
 *                   border-radius: 1px }"
 *
 * — three siblings in normal flow: a row box with its circle centred in it, the
 * mark with fixed margins against the row boxes either side, the next row box.
 * There is no slot for the mark to be reserved in, no out-of-flow mark, and no
 * rule that pins the circle to the label's first line.
 *
 * WHAT TWO EARLIER LEGS BUILT INSTEAD, and what this file now refuses. Leg 8
 * read the circle onto the label's FIRST text line (`items-start` on the row
 * plus a 2px nudge on the label). Leg 9 then took the mark OUT of the flow and
 * centred it in a 16px slot the row above reserved (`relative pb-4`), so that
 * its two gaps stayed equal under leg 8's alignment. The sixth proof round
 * measured what the pair composes on a real run page, on a work step whose title
 * wraps to three lines: a circle centre at 286 in a row box running 272..354 —
 * 27px above that box's own centre — and the second mark at y 323..331, with
 * 25px of margin above and below it, INSIDE that same row box; pitches of 44
 * and then 82 down one rail.
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT. jsdom lays out no text, so a rail
 * label can never wrap here and no reading taken in this environment can measure
 * the rhythm of a wrapped row — which is exactly how both withdrawn readings
 * passed their own suites. So this file pins the COMPOSITION, which jsdom can
 * see honestly: the markup order, the containment, and the declarations the
 * three rail modules share. THE NUMBERS ARE MEASURED IN A REAL BROWSER, on a run
 * whose title wraps to three lines and in both palettes, by
 * `tests/e2e/run-page-rail/rail-rhythm.spec.ts` and the pure grader beside it.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-page-rail-composed-in-flow.test.tsx
 */
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { RunStepRailPanel } from "../run-step-rail-panel";
import type { RunStepRailEntry } from "../run-step-rail";
import {
  RUN_PAGE_RAIL_ROW_CLASS,
  RUN_PAGE_RAIL_SEP_CLASS,
  RUN_PAGE_RAIL_TITLE_CLASS,
  RUN_RAIL_MARK_CLASS,
} from "../run-step-rail-extra-entry";
import { RunSurfaceRail, RunSurfaceRailRow, runSurfaceRailTitleClass } from "../run-surface-rail";
import type { RunSurfaceRailStep } from "../run-surface-rail-step";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

const tokens = (className: string): string[] => className.split(/\s+/).filter(Boolean);
const bare = (token: string): string => token.replace(/^!/, "").replace(/^-/, "");
const has = (className: string, token: string): boolean =>
  tokens(className).some((raw) => bare(raw) === token);

const railModulePath = (file: string): string => path.join(__dirname, "..", file);
const railModule = (file: string): string => readFileSync(railModulePath(file), "utf8");

/** Tokens that would take the mark out of the flow, or reserve a slot for it. */
const OUT_OF_FLOW = ["absolute", "fixed", "my-auto", "m-auto"];
const RESERVING = /^(pb|py|mb|my)-/;

function panelEntries(): RunStepRailEntry[] {
  return [
    { key: "step:1", ordinal: 1, kind: "step", label: "Setup", status: "completed", sources: [] },
    {
      key: "step:2",
      ordinal: 2,
      kind: "step",
      label: "Why Release Notes Belong in the Sprint, Not After It",
      status: "completed",
      sources: [],
    },
    {
      key: "gate:r1",
      ordinal: 3,
      kind: "gate",
      label: "Review",
      status: "resolved",
      sources: [],
      gate: { gateId: "g1", reviewTaskId: "r1", disposition: "approved", resolved: true },
    },
  ] as RunStepRailEntry[];
}

function surfaceSteps(): RunSurfaceRailStep[] {
  const rows: Array<{ key: RunSurfaceRailStep["key"]; label: string }> = [
    { key: "input:0", label: "Setup" },
    { key: "input:1", label: "Why Release Notes Belong in the Sprint, Not After It" },
    { key: "review", label: "Review" },
  ];
  return rows.map(({ key, label }, i) => ({
    key,
    row: (
      <RunSurfaceRailRow
        selectionKey={key}
        label={label}
        displayStep={i + 1}
        conformanceId="schedule-rail-step"
        action="open-step"
        settled
      />
    ),
    surface: <div data-testid={`surface-${i + 1}`}>{label}</div>,
  }));
}

function panelRail(palette: "light" | "dark") {
  document.documentElement.classList.toggle("dark", palette === "dark");
  const { container } = render(
    <RunStepRailPanel entries={panelEntries()} activeOrdinal={null} reviewHrefBase="/agents/v/p/run/review" />,
  );
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-slot="stepper-trigger"], a[data-rail-gate-link], a[data-rail-verification-link]',
    ),
  );
  const marks = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="stepper-separator"]'));
  return { container, rows, marks };
}

function surfaceRail(palette: "light" | "dark") {
  document.documentElement.classList.toggle("dark", palette === "dark");
  const { container } = render(
    <RunSurfaceRail steps={surfaceSteps()} detail={<div>detail</div>} initialSelection="review" />,
  );
  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-run-surface-rail-step]"));
  const marks = Array.from(container.querySelectorAll<HTMLElement>("[data-run-surface-rail-separator]"));
  return { container, rows, marks };
}

const PALETTES = ["light", "dark"] as const;

describe.each(PALETTES)("the rail's markup, in the %s palette", (palette) => {
  it("stands every mark BETWEEN two row boxes as a sibling, never inside one (C4)", () => {
    for (const { rows, marks } of [panelRail(palette), surfaceRail(palette)]) {
      expect(marks.length).toBe(rows.length - 1);
      marks.forEach((mark, index) => {
        const above = rows[index]!;
        const below = rows[index + 1]!;
        // Neither row box may CONTAIN the mark: a mark inside a row's box is the
        // composition the sixth proof round measured at 25px either side.
        expect(above.contains(mark), `mark ${index + 1} stands inside the row above it`).toBe(false);
        expect(below.contains(mark), `mark ${index + 1} stands inside the row below it`).toBe(false);
        // And the mark follows the row above it in document order.
        expect(
          above.compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
          mark.compareDocumentPosition(below) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      });
    }
  });

  it("reserves no slot for the mark anywhere between two rows (C4)", () => {
    for (const { rows, marks } of [panelRail(palette), surfaceRail(palette)]) {
      for (const mark of marks) {
        for (const token of OUT_OF_FLOW) {
          expect(has(mark.className, token), `the mark carries ${token}`).toBe(false);
        }
        // Nothing on the way from the mark up to the rail column may pad the
        // gap the mark's own margins already state.
        let node: HTMLElement | null = mark.parentElement;
        while (node && !node.hasAttribute("data-run-step-rail-column") && node.tagName !== "BODY") {
          const reserving = tokens(node.className ?? "").filter((raw) => RESERVING.test(bare(raw)));
          expect(reserving, `${node.getAttribute("data-slot") ?? node.tagName} reserves ${reserving.join(" ")}`).toEqual([]);
          node = node.parentElement;
        }
      }
      expect(rows.length).toBeGreaterThan(1);
    }
  });

  it("centres every circle in its own row box and lets the label wrap inside it (C1, C6)", () => {
    for (const { rows } of [panelRail(palette), surfaceRail(palette)]) {
      for (const row of rows) {
        expect(has(row.className, "items-center"), `${row.className} is not items-center`).toBe(true);
        expect(has(row.className, "items-start")).toBe(false);
        // The row is sized by its content, with the drawing's own 2px either
        // side and no border in the box.
        expect(has(row.className, "h-auto")).toBe(true);
        expect(has(row.className, "py-0.5")).toBe(true);
      }
    }
    const { container } = panelRail(palette);
    const titles = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="stepper-title"]'));
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) {
      // THE DRAWING'S OWN LINE BOX, wrapping, breaking a token no wrap point
      // can break — and NO vertical nudge. ".rail .step" states "font-size:
      // 14px; line-height: 1.15", so the box is 16.1px; `leading-5` is the 20px
      // leg 8 chose, which the drawing states nowhere, and leg 8's `mt-0.5` is
      // what pinned the label's first line to the circle.
      expect(has(title.className, "leading-[1.15]")).toBe(true);
      expect(has(title.className, "leading-5"), "the label still sets a 20px line box").toBe(false);
      expect(has(title.className, "whitespace-normal")).toBe(true);
      expect(has(title.className, "break-words")).toBe(true);
      expect(tokens(title.className).filter((raw) => /^mt-/.test(bare(raw)))).toEqual([]);
    }
  });
});

describe("the mark's own declaration (C3)", () => {
  it("states the drawing's 2 x 8, its 4px above and below, and its 11px indent", () => {
    for (const className of [RUN_RAIL_MARK_CLASS, RUN_PAGE_RAIL_SEP_CLASS]) {
      expect(has(className, "w-0.5")).toBe(true);
      expect(has(className, "h-2")).toBe(true);
      expect(has(className, "my-1")).toBe(true);
      expect(has(className, "mr-0")).toBe(true);
      expect(has(className, "ml-[11px]")).toBe(true);
      expect(has(className, "rounded-[1px]")).toBe(true);
      expect(has(className, "bg-line")).toBe(true);
      // The withdrawn composition, named so it cannot come back unnoticed.
      for (const token of [...OUT_OF_FLOW, "top-[26px]", "left-[11px]", "bottom-0.5", "relative"]) {
        expect(has(className, token), `the mark still carries ${token}`).toBe(false);
      }
    }
  });

  it("is the ONE declaration all three rail modules read", () => {
    expect(RUN_PAGE_RAIL_SEP_CLASS).toBe(RUN_RAIL_MARK_CLASS);
    for (const file of [
      "run-step-rail-panel.tsx",
      "run-step-rail-extra-entry.tsx",
      "orchestrator-stepper-panel.tsx",
      "run-surface-rail.tsx",
    ]) {
      const source = railModule(file);
      // No module keeps a pair box, and none re-states the mark's geometry.
      expect(source, `${file} still names a pair box`).not.toContain("RUN_RAIL_PAIR_CLASS");
      expect(source, `${file} re-states the mark's indent`).not.toContain("left-[11px]");
    }
  });

  it("states the row and the label once, for every rail that draws one", () => {
    expect(RUN_PAGE_RAIL_ROW_CLASS).toContain("items-center");
    expect(RUN_PAGE_RAIL_ROW_CLASS).toContain("py-0.5");
    expect(RUN_PAGE_RAIL_TITLE_CLASS).toContain("leading-[1.15]");
    expect(RUN_PAGE_RAIL_TITLE_CLASS).not.toContain("leading-5");
    expect(RUN_PAGE_RAIL_TITLE_CLASS).not.toContain("mt-");
    // ONE RAIL, ONE LINE BOX: the run-surface frame's rows state the same
    // sentence, or the two compositions read at two rhythms again.
    for (const selected of [true, false]) {
      const title = runSurfaceRailTitleClass(selected);
      expect(has(title, "leading-[1.15]"), `${title} does not state the drawing's line box`).toBe(true);
      expect(has(title, "leading-5"), `${title} still sets a 20px line box`).toBe(false);
      expect(tokens(title).filter((raw) => /^mt-/.test(bare(raw)))).toEqual([]);
    }
  });
});

describe("the numbers themselves", () => {
  it("are measured in a real browser, and this file says where", () => {
    // jsdom cannot wrap a label, so the rhythm of a wrapped row is not provable
    // here. The instrument that measures it is named in the repo, not only in
    // this comment, so that retiring one without the other is visible.
    const spec = readFileSync(
      path.join(__dirname, "..", "..", "..", "..", "tests", "e2e", "run-page-rail", "rail-rhythm.spec.ts"),
      "utf8",
    );
    expect(spec).toContain("gradeRailReading");
    const grader = readFileSync(
      path.join(__dirname, "..", "..", "..", "..", "tests", "e2e", "run-page-rail", "rail-rhythm-grader.ts"),
      "utf8",
    );
    expect(grader).toContain("export function gradeRailReading");
  });
});
