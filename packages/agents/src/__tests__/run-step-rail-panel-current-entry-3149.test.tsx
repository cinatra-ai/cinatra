// @vitest-environment jsdom
/** cinatra#3149 item 3: the selected reached spine row announces its current step.
 * Render the vendored Stepper; extra rows retain their own selection semantics.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { RunStepRailPanel } from "../run-step-rail-panel";
import type { RunStepRailEntry } from "../run-step-rail";
import { RunStepSelectionProvider } from "../run-step-rail-extra-entry";

afterEach(cleanup);
const step = (ordinal: number, status: RunStepRailEntry["status"], openable = true): RunStepRailEntry => ({
  key: `step:${ordinal}`, ordinal, kind: "step", label: `Work ${ordinal}`, status,
  sources: ["template"], openable,
});
function panel(entries: RunStepRailEntry[], activeOrdinal: number | null, stepOffset = 0) {
  return render(<RunStepRailPanel entries={entries} activeOrdinal={activeOrdinal}
    stepOffset={stepOffset} reviewHrefBase="/agents/vendor/package/run/review" />);
}
function spine(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(
    '[data-rail-kind="step"] [data-run-surface-rail-step]',
  ));
}
describe("the current spine entry (cinatra#3149 item 3)", () => {
  it("marks the active reached row and leaves passed and future rows unmarked", () => {
    const view = panel([step(10, "completed"), step(20, "pending"), step(30, "upcoming")], 20);
    const rows = spine(view.container);
    expect(rows.map(row => row.getAttribute("aria-current"))).toEqual([null, "step", null]);
    expect(view.container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(rows[1].getAttribute("role")).toBe("tab");
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    expect(rows[1].getAttribute("tabindex")).toBe("-1");
  });
  it("keeps display offsets and accessible names while marking the selected row", () => {
    const view = panel([step(10, "completed"), step(20, "pending")], 20, 2);
    expect(view.getByRole("tab", { name: "4 Work 20" }).getAttribute("aria-current")).toBe("step");
    expect(view.getByRole("tab", { name: "3 Work 10" }).getAttribute("aria-current")).toBeNull();
  });
  it("announces a reached inert row without turning it into a control", () => {
    const view = panel([step(10, "completed", false)], 10);
    const row = spine(view.container)[0];
    expect(row.getAttribute("aria-current")).toBe("step");
    expect(row.getAttribute("data-rail-inert")).toBe("");
    expect(row.tagName).toBe("DIV");
    expect(row.getAttribute("role")).toBeNull();
    expect(row.getAttribute("tabindex")).toBeNull();
    expect(view.queryByRole("button")).toBeNull();
    expect(view.queryByRole("tab")).toBeNull();
  });
  it("does not mark an unreached numeric selection as the current step", () => {
    const view = panel([step(10, "upcoming"), step(20, "upcoming")], 10);
    expect(view.getByRole("tab", { name: "1 Work 10" }).getAttribute("aria-selected")).toBe("true");
    expect(spine(view.container).map(row => row.getAttribute("aria-current"))).toEqual([null, null]);
  });
  it("does not mark an unreached inert row", () => {
    const view = panel([step(10, "upcoming", false)], 10);
    expect(spine(view.container)[0].getAttribute("aria-current")).toBeNull();
  });
  it("has no current row when a settled rail has no active ordinal", () => {
    const view = panel([step(10, "completed"), step(20, "resolved"), step(30, "skipped")], null);
    expect(spine(view.container).map(row => row.getAttribute("aria-current"))).toEqual([null, null, null]);
  });
  it("retains the existing pending-row election when no ordinal was supplied", () => {
    const view = panel([step(10, "completed"), step(20, "pending")], null);
    expect(spine(view.container).map(row => row.getAttribute("aria-current"))).toEqual([null, "step"]);
  });
  it("can name the reached resolved row the existing selection points to", () => {
    const view = panel([step(10, "resolved"), step(20, "completed")], 10);
    expect(spine(view.container).map(row => row.getAttribute("aria-current"))).toEqual(["step", null]);
  });
  it("leaves the selected pending gate's current marker with that gate", () => {
    const gate: RunStepRailEntry = { key: "gate:review", ordinal: 20, kind: "gate", label: "Review",
      status: "pending", sources: ["gate"], gate: { gateId: "gate", reviewTaskId: "review",
        disposition: null, resolved: false, current: true } };
    const view = render(<RunStepSelectionProvider value={{ selected: "detail", select: () => {} }}>
      <RunStepRailPanel entries={[step(10, "completed"), gate, step(30, "upcoming")]}
        activeOrdinal={20} reviewHrefBase="/agents/vendor/package/run/review" />
    </RunStepSelectionProvider>);
    expect(spine(view.container).map(row => row.getAttribute("aria-current"))).toEqual([null, null]);
    expect(view.container.querySelector('[data-rail-gate-open="review"]')?.getAttribute("aria-current")).toBe("step");
    expect(view.container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
  });
  it("preserves a selected audit marker without marking the settled spine", () => {
    const audit: RunStepRailEntry = { key: "audit:review", ordinal: 20, kind: "verification",
      label: "Audit", status: "completed", sources: ["verification"],
      verification: { gateId: "gate", reviewTaskId: "review", outcome: "verified" } };
    const view = render(<RunStepSelectionProvider value={{ selected: "audit:review", select: () => {} }}>
      <RunStepRailPanel entries={[step(10, "completed"), audit]} activeOrdinal={20}
        reviewHrefBase="/agents/vendor/package/run/review" />
    </RunStepSelectionProvider>);
    expect(spine(view.container)[0].getAttribute("aria-current")).toBeNull();
    expect(view.container.querySelector('[data-rail-verification-open="review"]')?.getAttribute("aria-current")).toBe("step");
    expect(view.container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
  });
  it("draws no rail or current marker for empty entries", () => {
    const view = panel([], null);
    expect(view.container.innerHTML).toBe("");
  });
});
