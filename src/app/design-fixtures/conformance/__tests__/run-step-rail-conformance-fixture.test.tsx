// @vitest-environment jsdom
//
// The RUN STEP RAIL harness mount, read on the unit tier (cinatra#3007).
//
// WHAT THIS PINS. The functional-acceptance driver asserts, in a browser, that
// the answered gate the mount keeps as history records how it was settled. The
// mount is the SHIPPED `RunStepRailPanel`, so the word that row carries is the
// product's own settled word for the disposition the fixture stores — never a
// word the fixture writes. This renders the same mount and reads the same row
// the driver reads, so a fixture that hands the rail a word the rail does not
// draw goes red here, in the node tier, before the browser run.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { RunStepRailConformanceFixture } from "../run-step-rail-conformance-fixtures";
import {
  RUN_STEP_RAIL_CONFORMANCE_SETTLED_DISPOSITION,
  RUN_STEP_RAIL_CONFORMANCE_SETTLED_POSITION,
} from "../run-step-rail-conformance-data";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function settledRow(): Element {
  const { container } = render(<RunStepRailConformanceFixture />);
  const panel = container.querySelector(
    '[data-surface-id="run-step-rail"] [data-conformance-id="run-step-rail"]',
  );
  expect(panel, "the harness mounts the shipped rail").not.toBeNull();
  const rows = panel!.querySelectorAll('[data-slot="stepper-item"]');
  const row = rows[RUN_STEP_RAIL_CONFORMANCE_SETTLED_POSITION - 1];
  expect(row, "the settled gate keeps its place on the rail").toBeDefined();
  return row!;
}

describe("the run step rail harness mount's settled gate", () => {
  it("is a completed row kept as read-only history, not a pending gate", () => {
    const row = settledRow();
    expect(row.getAttribute("data-state")).toBe("completed");
    expect(row.querySelectorAll('[data-rail-gate-history="true"]')).toHaveLength(1);
    expect(row.querySelectorAll('[data-rail-gate-pending="true"]')).toHaveLength(0);
  });

  it("records how it was settled with the word the rail draws", () => {
    const row = settledRow();
    // The browser driver's reading: a case-sensitive substring of the row.
    expect(row.textContent).toContain(RUN_STEP_RAIL_CONFORMANCE_SETTLED_DISPOSITION);
    // And the badge itself says exactly that word, in its text and attribute.
    const badge = row.querySelector("[data-rail-gate-settlement]");
    expect(badge, "the settled row draws its settlement badge").not.toBeNull();
    expect(badge!.textContent).toBe(RUN_STEP_RAIL_CONFORMANCE_SETTLED_DISPOSITION);
    expect(badge!.getAttribute("data-rail-gate-settlement")).toBe(
      RUN_STEP_RAIL_CONFORMANCE_SETTLED_DISPOSITION,
    );
  });
});
