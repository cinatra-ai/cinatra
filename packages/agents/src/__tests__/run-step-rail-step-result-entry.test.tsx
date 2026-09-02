// @vitest-environment jsdom
/**
 * A rail row derived from a step result is not drawn as a step someone can
 * open (cinatra#3002, acceptance criterion 3).
 *
 * A run executed on the agent runtime leaves ONE step result, and the rail drew
 * it as a checked "Step 1" — a numbered, ticked row inside a stepper trigger,
 * which reads as "click me to see it". It opens nothing: only gate,
 * verification and lifecycle rows carry a target. The reader clicked a finished
 * step and nothing happened, right beside a card claiming the output was
 * somewhere on the page.
 *
 * The row keeps its place in the run's history — it IS a thing that happened —
 * but it is no longer dressed as an affordance:
 *
 *   1. the builder marks a step-result-derived row as not openable;
 *   2. a template-derived step row is untouched;
 *   3. the panel draws the marked row with no trigger at all, and says so in
 *      the DOM, while the rows that do open keep theirs.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-step-rail-step-result-entry.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

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
    ownKeys: () => ["Check", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the step-result rail row (cinatra#3002)", () => {
  it("marks a step-result-derived row as not openable", async () => {
    const { buildRunStepRail } = await import("../run-step-rail");
    const rail = buildRunStepRail({
      // exactly what a run on the agent runtime leaves behind.
      stepResults: [{ kind: "wayflow_response", output: "four findings" }],
    });

    expect(rail.entries.length).toBe(1);
    const entry = rail.entries[0];
    expect(entry.kind).toBe("step");
    expect(entry.sources).toEqual(["stepResult"]);
    expect(entry.openable).toBe(false);
  });

  it("leaves a template-derived step row openable as before", async () => {
    const { buildRunStepRail } = await import("../run-step-rail");
    const rail = buildRunStepRail({
      templateSteps: [{ index: 1, stepNumber: 10, label: "Draft" }],
      stepResults: [{ ok: true }],
    });

    expect(rail.entries.length).toBe(1);
    expect(rail.entries[0].openable).not.toBe(false);
  });

  it("draws the marked row with no trigger, and keeps the others' triggers", async () => {
    const { RunStepRailPanel } = await import("../run-step-rail-panel");
    const { buildRunStepRail } = await import("../run-step-rail");
    const rail = buildRunStepRail({
      templateSteps: [{ index: 1, stepNumber: 10, label: "Draft" }],
      stepResults: [{ ok: true }, { kind: "wayflow_response", output: "four findings" }],
    });

    render(
      <RunStepRailPanel
        entries={rail.entries}
        activeOrdinal={null}
        reviewHrefBase="/agents/vendor/package/instance/review"
      />,
    );

    const rows = document.querySelectorAll('[data-rail-kind="step"]');
    expect(rows.length).toBe(2);
    const inert = document.querySelector('[data-rail-openable="false"]');
    expect(inert).not.toBeNull();
    // The step-result row is the inert one, and it is not a control.
    expect(inert!.textContent).toContain("Step 2");
    expect(inert!.querySelector("button")).toBeNull();
    // The template step still draws its trigger.
    const openable = Array.from(rows).find((r) => r !== inert)!;
    expect(openable.querySelector("button")).not.toBeNull();
  });
});
