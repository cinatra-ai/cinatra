// @vitest-environment jsdom
/**
 * THE RUN PAGE'S OWN RAIL DRAWS THE SETTLED CIRCLE THE SAME WAY (cinatra#3188
 * item 1, forward + fix leg 1).
 *
 * The first proof round graded the settled glyph and reported the run page's
 * own panel-rail entry still drawing the indigo circle: "The one completed rail
 * entry a real run reached: a 24x24 circle, primary-fill background, white
 * check — the stepper indicator, not the run-surface rail."
 *
 * The ratified drawing names the settled entry and the entry still ahead in ONE
 * rule, and it is a rule about THE RAIL, not about one component of it:
 *
 *   ".rail .step.upcoming .glyph, .rail .step.settled .glyph {
 *      background: rgba(92,103,121,0.4); color: var(--paper); }"
 *
 * The run page draws its rows through three components that mount the shared
 * `StepperIndicator` — the panel rail's own step rows, the resolved-gate /
 * verification / lifecycle rows beside them, and the live rail inside the
 * orchestrator panel. Each of them overrode the INACTIVE state onto the muted
 * ground and left the COMPLETED state on the primitive's `bg-primary`, so a
 * step the run had already passed came out filled where the drawing has it
 * muted.
 *
 * WHY THE OVERRIDE IS AT THE CONSUMERS AND NOT IN THE PRIMITIVE: the
 * `StepperIndicator` in `@/components/reui/stepper` is a vendored design-system
 * primitive and its consumers are not all rails. The rule is the RAIL's, so it
 * is applied where the rail is drawn — held in ONE exported class so the three
 * rows cannot drift apart, exactly as `runSurfaceRailIndicatorClass` already
 * holds it for the run-surface rail.
 *
 * ONE ROW IS LEFT ON THE OLD READING ON PURPOSE: the review task screen's own
 * step list draws the same rail vocabulary and still fills a passed step with
 * the indigo. It is the same defect at a fourth site and it is NOT this leg's —
 * the checklist asks for the glyphs THE RUN PAGE draws, and this leg's proof
 * round photographs the run page. It is carried as a named deviation rather
 * than changed on a screen this leg never pictures.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-page-rail-settled-glyph.test.tsx
 */
import { existsSync, readFileSync } from "node:fs";

import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { RunStepRailPanel } from "../run-step-rail-panel";
import type { RunStepRailEntry } from "../run-step-rail";
import {
  RUN_PAGE_RAIL_INDICATOR_CLASS,
  RUN_PAGE_RAIL_ROW_CLASS,
  RUN_PAGE_RAIL_SEP_CLASS,
} from "../run-step-rail-extra-entry";

afterEach(() => {
  cleanup();
});

/** The drawing's muted ground for an entry that is not the one being read. */
const MUTED_GROUND = "bg-muted-foreground/40";
/** The indigo fill, which the drawing gives the OPEN entry alone. */
const PRIMARY_FILL = "bg-primary";

function stepEntry(key: string, ordinal: number, status: RunStepRailEntry["status"]) {
  return {
    key,
    ordinal,
    kind: "step",
    label: key,
    status,
    sources: [],
  } as RunStepRailEntry;
}

function resolvedGateEntry(): RunStepRailEntry {
  return {
    key: "gate-1",
    ordinal: 3,
    kind: "gate",
    label: "Review",
    status: "resolved",
    sources: [],
    gate: {
      gateId: "g1",
      reviewTaskId: "r1",
      disposition: "approved",
      resolved: true,
    },
  } as RunStepRailEntry;
}

function indicators(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="stepper-indicator"]'),
  );
}

function completedIndicators(container: HTMLElement) {
  return indicators(container).filter((node) => node.getAttribute("data-state") === "completed");
}

/**
 * THE GROUND ONE STATE ACTUALLY RESOLVES TO.
 *
 * A `StepperIndicator`'s class list is the same string in every state -- the
 * state is a `data-state` attribute the state-scoped utilities key off -- so
 * comparing two circles' class strings compares nothing. This reads the
 * background the given state resolves to: its own `data-[state=X]:bg-*` if the
 * list carries one, and the unscoped `bg-*` default otherwise.
 */
function groundFor(className: string, state: string): string {
  const scoped = className
    .split(/\s+/)
    .filter((token) => token.startsWith(`data-[state=${state}]:bg-`))
    .pop();
  if (scoped) return scoped.slice(`data-[state=${state}]:`.length);
  return className.split(/\s+/).filter((token) => /^bg-/.test(token)).pop() ?? "";
}

/**
 * The module's own file on disk. Read from the working directory rather than
 * from `import.meta.url`, which the test transform rewrites to a served path.
 */
function railModulePath(fileName: string): string {
  const cwd = process.cwd();
  for (const candidate of [
    `${cwd}/src/${fileName}`,
    `${cwd}/packages/agents/src/${fileName}`,
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`rail module not found on disk: ${fileName}`);
}

describe("the run page's panel rail draws a passed step on the drawing's muted ground", () => {
  it("never leaves a completed step's circle on the indigo fill", () => {
    const { container } = render(
      <RunStepRailPanel
        entries={[
          stepEntry("Step 1", 1, "completed"),
          stepEntry("Step 2", 2, "pending"),
        ]}
        activeOrdinal={2}
        reviewHrefBase="/agents/v/p/i"
      />,
    );

    const completed = completedIndicators(container);
    expect(completed.length).toBeGreaterThan(0);
    for (const circle of completed) {
      expect(circle.className).toContain(`data-[state=completed]:${MUTED_GROUND}`);
      expect(circle.className).not.toContain(`data-[state=completed]:${PRIMARY_FILL}`);
    }
  });

  it("gives a passed step the SAME ground a step still ahead already takes", () => {
    const { container } = render(
      <RunStepRailPanel
        entries={[
          stepEntry("Step 1", 1, "completed"),
          stepEntry("Step 2", 2, "pending"),
          stepEntry("Step 3", 3, "upcoming"),
        ]}
        activeOrdinal={2}
        reviewHrefBase="/agents/v/p/i"
      />,
    );

    // The drawing names the two in ONE rule, so the two circles cannot part
    // company: whatever ground the entry still ahead resolves to is the ground
    // of the entry the run has passed. And the indigo fill stays with the entry
    // the reader is standing on.
    const circle = completedIndicators(container)[0]!;
    expect(groundFor(circle.className, "completed")).toBe(MUTED_GROUND);
    expect(groundFor(circle.className, "inactive")).toBe(MUTED_GROUND);
    expect(groundFor(circle.className, "active")).toBe(PRIMARY_FILL);
  });

  it("draws a RESOLVED gate's circle on the muted ground too", () => {
    // A resolved gate is the rail's read-only history row; it reaches the DOM
    // through the shared extra-entry row rather than the step row, and a rail
    // whose two kinds of row disagree about the same state is two vocabularies
    // rather than one rail.
    const { container } = render(
      <RunStepRailPanel
        entries={[stepEntry("Step 1", 1, "pending"), resolvedGateEntry()]}
        activeOrdinal={1}
        reviewHrefBase="/agents/v/p/i"
      />,
    );

    const gateCircle = container
      .querySelector<HTMLElement>('[data-rail-kind="gate"]')!
      .querySelector<HTMLElement>('[data-slot="stepper-indicator"]')!;
    expect(gateCircle).not.toBeNull();
    expect(gateCircle.className).toContain(`data-[state=completed]:${MUTED_GROUND}`);
    expect(gateCircle.className).not.toContain(`data-[state=completed]:${PRIMARY_FILL}`);
  });

  it("holds the rule in ONE class, so the run page's three rows cannot drift apart", () => {
    // Both states the drawing puts in one rule, and both of them muted.
    expect(RUN_PAGE_RAIL_INDICATOR_CLASS).toContain(`data-[state=inactive]:${MUTED_GROUND}`);
    expect(RUN_PAGE_RAIL_INDICATOR_CLASS).toContain(`data-[state=completed]:${MUTED_GROUND}`);
    expect(RUN_PAGE_RAIL_INDICATOR_CLASS).toContain("data-[state=inactive]:text-background");
    expect(RUN_PAGE_RAIL_INDICATOR_CLASS).toContain("data-[state=completed]:text-background");
    // The indigo fill stays with the entry the reader is standing on: the rule
    // says nothing about the ACTIVE state, so the primitive keeps it.
    expect(RUN_PAGE_RAIL_INDICATOR_CLASS).not.toContain("data-[state=active]:");
  });
});

describe("the run page's own rail carries the drawing's rhythm too (item 2, convergence)", () => {
  /**
   * WHY THIS BLOCK EXISTS. The first proof round measured 7.5px above the mark
   * and 6.5px below against the drawing's 4px and 4px, on the rail the setup
   * surface draws. After the run page gained its two-column frame it draws a
   * SECOND rail through the vendored `Stepper` -- this panel -- and the second
   * proof round photographs that one. A rhythm only one of the two rails holds
   * is not the rail's rhythm, so the same two drawing sentences are read here:
   *
   *   ".rail .step { ... padding: 2px 0; ... }"
   *   ".rail .sep { width: 2px; height: 8px; margin: 4px 0 4px 11px; ... }"
   */
  function renderPanel() {
    return render(
      <RunStepRailPanel
        entries={[
          stepEntry("Step 1", 1, "completed"),
          stepEntry("Step 2", 2, "pending"),
          resolvedGateEntry(),
        ]}
        activeOrdinal={2}
        reviewHrefBase="/agents/v/p/i"
      />,
    );
  }

  it("gives every row the drawing's step box, with no border in it", () => {
    const { container } = renderPanel();
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="stepper-trigger"]'),
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Red before this change: `StepperTrigger` renders the design-system
      // Button, whose base draws a 1px TRANSPARENT border on every side --
      // invisible, and still in the box.
      expect(row.className).not.toMatch(/(?:^|\s)border(?:\s|$)/);
      expect(row.className).toContain("border-0");
      // The 2px above and below the circle the drawing's `.rail .step` carries.
      expect(row.className).toContain("py-0.5");
    }
  });

  it("puts the drawing's own two numbers on the mark between two entries", () => {
    const { container } = renderPanel();
    const marks = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="stepper-separator"]'),
    );

    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      // 4px above and below -- the whole gap between two entries -- stated as
      // the drawing's rule about the GAP rather than about the flow, so that it
      // holds on a wrapped row too (cinatra#3225 items 2 and 3, fix leg 9): the
      // mark is centred in the span from one circle's bottom to the next
      // circle's top, which on a one-line pair IS the drawing's 4 and 4. Red
      // before the first of those changes: the vendored separator's own `m-0.5`
      // stood at 2px and the rail overrode only the height and the ink.
      expect(mark.className).toContain("!my-auto");
      expect(mark.className).toContain("top-[26px]");
      expect(mark.className).toContain("-bottom-0.5");
      // 11px in from the column edge, which is where the drawing puts it.
      expect(mark.className).toContain("left-[11px]");
      expect(mark.className).not.toMatch(/(?:^|\s)ms-3(?:\s|$)/);
      // The 8px height the drawing states.
      expect(mark.className).toContain("!h-2");
    }
  });

  it("holds the row and the mark in ONE declaration each, for all three rows", () => {
    // The run page draws rail rows from three modules. The glyph rule already
    // lives in one class; so must the box and the mark, or the second proof
    // round grades three rails that agree only by accident.
    expect(RUN_PAGE_RAIL_ROW_CLASS).toContain("border-0");
    expect(RUN_PAGE_RAIL_ROW_CLASS).toContain("py-0.5");
    expect(RUN_PAGE_RAIL_SEP_CLASS).toContain("!my-auto");
    expect(RUN_PAGE_RAIL_SEP_CLASS).toContain("left-[11px]");

    for (const module of [
      "run-step-rail-panel.tsx",
      "run-step-rail-extra-entry.tsx",
      "orchestrator-stepper-panel.tsx",
    ]) {
      const source = readFileSync(railModulePath(module), "utf8");
      // No module re-declares the anatomy. `orchestrator-stepper-panel` is the
      // one rail this suite cannot render (it needs a live run stream), so its
      // reading is taken here rather than assumed.
      expect(source).not.toMatch(/className="ms-3 !h-2 bg-border"/);
      expect(source).not.toMatch(/className="gap-2 px-0 py-0.5"/);
      expect(source).not.toMatch(/data-\[state=completed\]:bg-primary/);
      expect(source).toContain("RUN_PAGE_RAIL_INDICATOR_CLASS");
    }
  });
});
