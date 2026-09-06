// @vitest-environment jsdom
/**
 * ONE RAIL, ONE RHYTHM (cinatra#3225).
 *
 * The ratified drawing, agent run and review surface, fixes the mark between
 * two entries in its own rail rule:
 *
 *   ".rail .sep { width: 2px; height: 8px; margin: 4px 0 4px 11px;
 *      border-radius: 1px; background: var(--line); }"
 *
 * and, in "The step rail — merged steps and gate entries": "so the rail is the
 * run's whole lifecycle at a glance, not just its live tip." One rail read at
 * a glance is one rhythm; two compositions of it are two.
 *
 * Two components compose the rail on the run surface. The run-surface rail
 * drew its mark at the drawing's measurements; the run page's own panel rail
 * drew it from a class that set neither the mark's width nor its radius, and
 * its rows kept the design-system button's fixed height on top. Measured on a
 * real completed run: 50.0px and then 45.5px between adjacent circle centres
 * on the panel rail, against the run-surface rail's 44.0px.
 *
 * THE INSTRUMENT. jsdom lays nothing out, so the pitch is RESOLVED from the
 * utility tokens the rendered rows and marks carry — the same tokens a picture
 * is graded on — by the resolver below, which reads each box the way the
 * stylesheet does (an important token wins; a later token of the same property
 * wins; a fixed height wins over content). Both rails are read with the same
 * resolver, so a rhythm only one of them holds cannot pass.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-page-rail-rhythm.test.tsx
 */
import React from "react";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { RunStepRailPanel } from "../run-step-rail-panel";
import type { RunStepRailEntry } from "../run-step-rail";
import { RUN_PAGE_RAIL_SEP_CLASS } from "../run-step-rail-extra-entry";
import { RUN_RAIL_MARK_CLASS } from "../run-step-rail-extra-entry";
import { RunSurfaceRail, RunSurfaceRailRow } from "../run-surface-rail";
import type { RunSurfaceRailStep } from "../run-surface-rail-step";

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// The resolver: utility tokens → the box a picture would measure.
// ---------------------------------------------------------------------------
const SPACING: Record<string, number> = { "0": 0, "0.5": 2, "1": 4, "1.5": 6, "2": 8, "3": 12, "4": 16 };
const CIRCLE_PX = 24; // `size-6`, the circle every row carries

function tokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

/** The value of the LAST matching token, an `!`-important one winning outright. */
function resolve(className: string, pattern: RegExp, read: (m: RegExpMatchArray) => number): number | null {
  let value: number | null = null;
  let important = false;
  for (const raw of tokens(className)) {
    const bang = raw.startsWith("!");
    const token = bang ? raw.slice(1) : raw;
    // A variant-scoped token (`group-data-[…]:h-12`) applies in the vertical
    // rail too; it is read at its own place in the list.
    const bare = token.includes(":") ? token.slice(token.lastIndexOf(":") + 1) : token;
    const m = bare.match(pattern);
    if (!m) continue;
    if (important && !bang) continue;
    value = read(m);
    important = important || bang;
  }
  return value;
}

const px = (m: RegExpMatchArray) => (m[1]!.startsWith("[") ? Number(m[1]!.slice(1, -3)) : SPACING[m[1]!]!);

type Box = { height: number; marginTop: number; marginBottom: number; circleCentre: number };

/** A ROW's box: the circle plus the row's own padding and border, or a fixed height. */
function rowBox(row: HTMLElement): Box {
  const c = row.className;
  const fixed = resolve(c, /^h-(\d+(?:\.\d+)?)$/, px);
  const auto = tokens(c).includes("h-auto");
  const py = resolve(c, /^py-(\d+(?:\.\d+)?)$/, px) ?? 0;
  const border = tokens(c).includes("border-0") ? 0 : tokens(c).includes("border") ? 1 : 0;
  const height = fixed !== null && !auto ? fixed : CIRCLE_PX + 2 * py + 2 * border;
  // `items-center` centres the circle in a fixed box; a content box puts it
  // after the border and the padding.
  const circleCentre = fixed !== null && !auto ? height / 2 : border + py + CIRCLE_PX / 2;
  return { height, marginTop: 0, marginBottom: 0, circleCentre };
}

/** A MARK's box: its height and its vertical margins. */
function markBox(mark: HTMLElement): Box {
  const c = mark.className;
  const height = resolve(c, /^h-(\d+(?:\.\d+)?|\[\d+px\])$/, px) ?? 0;
  const m = resolve(c, /^m-(\d+(?:\.\d+)?)$/, px) ?? 0;
  const my = resolve(c, /^my-(\d+(?:\.\d+)?)$/, px);
  const mt = resolve(c, /^mt-(\d+(?:\.\d+)?)$/, px);
  const mb = resolve(c, /^mb-(\d+(?:\.\d+)?)$/, px);
  return { height, marginTop: mt ?? my ?? m, marginBottom: mb ?? my ?? m, circleCentre: 0 };
}

type Reading = { rows: HTMLElement[]; marks: HTMLElement[] };

/** Centre-to-centre pitch and the two gaps around each mark, pair by pair. */
function rhythm({ rows, marks }: Reading) {
  expect(marks.length).toBe(rows.length - 1);
  return marks.map((mark, i) => {
    const above = rowBox(rows[i]!);
    const below = rowBox(rows[i + 1]!);
    const m = markBox(mark);
    const gapAbove = above.height - above.circleCentre - CIRCLE_PX / 2 + m.marginTop;
    const gapBelow = m.marginBottom + below.circleCentre - CIRCLE_PX / 2;
    const pitch = above.height - above.circleCentre + m.marginTop + m.height + m.marginBottom + below.circleCentre;
    return { pitch, gapAbove, gapBelow };
  });
}

// ---------------------------------------------------------------------------
// The same four entries on both rails.
// ---------------------------------------------------------------------------
function panelEntries(): RunStepRailEntry[] {
  return [
    { key: "step:1", ordinal: 1, kind: "step", label: "Fetched Q3 cohort", status: "completed", sources: [] },
    { key: "step:2", ordinal: 2, kind: "step", label: "Drafted re-engagement email", status: "completed", sources: [] },
    {
      key: "gate:r1",
      ordinal: 3,
      kind: "gate",
      label: "Review",
      status: "resolved",
      sources: [],
      gate: { gateId: "g1", reviewTaskId: "r1", disposition: "approved", resolved: true },
    },
    {
      key: "verification:r1",
      ordinal: 4,
      kind: "verification",
      label: "Audit",
      status: "completed",
      sources: [],
      verification: { gateId: "g1", reviewTaskId: "r1", outcome: "verified" },
    },
  ] as RunStepRailEntry[];
}

function surfaceSteps(): RunSurfaceRailStep[] {
  const rows: Array<{ key: RunSurfaceRailStep["key"]; label: string }> = [
    { key: "input:0", label: "Fetched Q3 cohort" },
    { key: "input:1", label: "Drafted re-engagement email" },
    { key: "schedule", label: "Review" },
    { key: "review", label: "Audit" },
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
        settled={i < 3}
      />
    ),
    surface: <div data-testid={`surface-${i + 1}`}>{label}</div>,
  }));
}

function panelReading(): Reading {
  const { container } = render(
    <RunStepRailPanel entries={panelEntries()} activeOrdinal={null} reviewHrefBase="/agents/v/p/run/review" />,
  );
  const items = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="stepper-item"]'));
  const rows = items.map((item) => {
    const row =
      item.querySelector<HTMLElement>('[data-slot="stepper-trigger"]') ??
      item.querySelector<HTMLElement>("a");
    if (!row) throw new Error("rail row without a row box");
    return row;
  });
  const marks = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="stepper-separator"]'));
  return { rows, marks };
}

function surfaceReading(): Reading {
  const { container } = render(
    <RunSurfaceRail steps={surfaceSteps()} detail={<div>detail</div>} initialSelection="review" />,
  );
  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-run-surface-rail-step]"));
  const marks = Array.from(container.querySelectorAll<HTMLElement>("[data-run-surface-rail-separator]"));
  return { rows, marks };
}

// ---------------------------------------------------------------------------
// Item 1 — the mark's six values on the panel rail.
// ---------------------------------------------------------------------------
describe("the mark on the run page's own panel rail carries the drawing's geometry (item 1)", () => {
  it("resolves to 2px wide, 8px tall, 1px radius, 4px above and below, 11px in, on the line token", () => {
    const { marks } = panelReading();
    expect(marks.length).toBe(3);
    for (const mark of marks) {
      const c = mark.className;
      expect(resolve(c, /^w-(\d+(?:\.\d+)?)$/, px)).toBe(2);
      expect(resolve(c, /^h-(\d+(?:\.\d+)?)$/, px)).toBe(8);
      expect(tokens(c)).toContain("rounded-[1px]");
      expect(markBox(mark).marginTop).toBe(4);
      expect(markBox(mark).marginBottom).toBe(4);
      expect(tokens(c).some((t) => t === "ml-[11px]" || t === "ms-[11px]")).toBe(true);
      // The line token, and no other ink: the primitive's `bg-muted` and the
      // old `bg-border` are both other inks.
      const inks = tokens(c).filter((t) => /^bg-/.test(t));
      expect(inks[inks.length - 1]).toBe("bg-line");
      expect(tokens(c).filter((t) => /^rounded/.test(t)).pop()).toBe("rounded-[1px]");
    }
  });
});

// ---------------------------------------------------------------------------
// Items 2 and 3 — one pitch, equal gaps, on both rails.
// ---------------------------------------------------------------------------
describe("every adjacent pair composes the same pitch, and the panel rail's equals the run-surface rail's (item 2)", () => {
  it("reads one pitch on the panel rail, and the same one on the run-surface rail, within a pixel", () => {
    const panel = rhythm(panelReading());
    cleanup();
    const surface = rhythm(surfaceReading());

    expect(panel.length).toBe(3);
    expect(surface.length).toBe(3);
    const pitches = [...panel, ...surface].map((r) => r.pitch);
    for (const pitch of pitches) {
      expect(Math.abs(pitch - pitches[0]!)).toBeLessThanOrEqual(1);
    }
    // The drawing's rhythm in numbers: a 28px step box (24px circle, 2px above
    // and below) and a 16px mark (8px, 4px above and below).
    expect(pitches[0]).toBe(44);
  });
});

describe("the gap above the mark equals the gap below it (item 3)", () => {
  it("holds on every pair and across pairs, on both rails", () => {
    const readings = [rhythm(panelReading())];
    cleanup();
    readings.push(rhythm(surfaceReading()));
    const gaps = readings.flat();
    for (const g of gaps) {
      expect(g.gapAbove).toBe(g.gapBelow);
      expect(g.gapAbove).toBe(gaps[0]!.gapAbove);
    }
  });
});

// ---------------------------------------------------------------------------
// Item 4 — one definition serves both rails.
// ---------------------------------------------------------------------------
function repoFile(relative: string): string {
  const cwd = process.cwd();
  for (const candidate of [`${cwd}/${relative}`, `${cwd}/../../${relative}`]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error(`file not found: ${relative}`);
}

describe("one definition serves both rails (item 4)", () => {
  it("resolves the panel rail's separator class from the one mark definition", () => {
    expect(RUN_PAGE_RAIL_SEP_CLASS).toBe(RUN_RAIL_MARK_CLASS);
  });

  it("draws the run-surface rail's separator from that same definition", () => {
    const { marks } = surfaceReading();
    expect(marks.length).toBe(3);
    for (const mark of marks) expect(mark.className).toBe(RUN_RAIL_MARK_CLASS);
    expect(repoFile("packages/agents/src/run-surface-rail.tsx")).toContain("className={RUN_RAIL_MARK_CLASS}");
    expect(repoFile("packages/agents/src/run-step-rail-extra-entry.tsx")).toContain(
      "export const RUN_PAGE_RAIL_SEP_CLASS = RUN_RAIL_MARK_CLASS;",
    );
  });
});

// ---------------------------------------------------------------------------
// THE JOIN — where the run surface's own rows meet the page's rail (fix leg 7)
//
// The run page draws ONE rail out of two components: the gate rows that head
// the column, then `RunStepRailPanel` as one more entry beneath them, with the
// drawing's mark standing between. The panel carried a top offset of its OWN
// inside a column that already states the rail's — so the pitch at the join
// composed 48px where every other pair composed the drawing's 44px, which is
// the "48px rows then 44px" the third proof round measured on a real completed
// run. One rail is one rhythm at every pair, the join included.
// ---------------------------------------------------------------------------
import { RunStepRailPanel as JoinedPanel } from "../run-step-rail-panel";

/** A nested rail's OWN vertical offset, which lands inside the pair above it. */
function nestedTopOffset(row: HTMLElement, previous: HTMLElement): number {
  const panel = row.closest<HTMLElement>("[data-run-step-rail]");
  // Only an offset the row above does NOT sit inside enters that pair's gap.
  if (!panel || panel.contains(previous)) return 0;
  return resolve(panel.className, /^pt-(\d+(?:\.\d+)?)$/, px) ?? 0;
}

function joinedReading(): Reading {
  const { container } = render(
    <RunSurfaceRail
      steps={surfaceSteps().slice(0, 2)}
      rail={
        <JoinedPanel
          entries={panelEntries()}
          activeOrdinal={null}
          reviewHrefBase="/agents/v/p/run/review"
        />
      }
      detail={<div>detail</div>}
      initialSelection="input:0"
    />,
  );
  const column = container.querySelector<HTMLElement>("[data-run-step-rail-column]")!;
  const rows = Array.from(
    column.querySelectorAll<HTMLElement>(
      '[data-run-surface-rail-step], [data-slot="stepper-trigger"], a[data-rail-gate-link], a[data-rail-verification-link]',
    ),
  );
  const marks = Array.from(
    column.querySelectorAll<HTMLElement>(
      '[data-run-surface-rail-separator], [data-slot="stepper-separator"]',
    ),
  );
  return { rows, marks };
}

describe("the join composes the same pitch as every other pair (cinatra#3225)", () => {
  it("reads ONE pitch down the whole composed rail, the join included", () => {
    const { rows, marks } = joinedReading();
    // two surface rows and the panel's four, with a mark between every pair.
    expect(rows.length).toBe(6);
    expect(marks.length).toBe(5);

    const pitches = marks.map((mark, i) => {
      const above = rowBox(rows[i]!);
      const below = rowBox(rows[i + 1]!);
      const m = markBox(mark);
      return (
        above.height -
        above.circleCentre +
        m.marginTop +
        m.height +
        m.marginBottom +
        nestedTopOffset(rows[i + 1]!, rows[i]!) +
        below.circleCentre
      );
    });

    for (const pitch of pitches) expect(pitch).toBe(44);
  });

  it("the nested rail states no vertical offset of its own", () => {
    const { container } = render(
      <JoinedPanel
        entries={panelEntries()}
        activeOrdinal={null}
        reviewHrefBase="/agents/v/p/run/review"
      />,
    );
    const panel = container.querySelector<HTMLElement>("[data-run-step-rail]")!;
    const vertical = tokens(panel.className).filter((t) =>
      /^(pt|pb|py|mt|mb|my)-/.test(t),
    );
    expect(vertical).toEqual([]);
  });
});
