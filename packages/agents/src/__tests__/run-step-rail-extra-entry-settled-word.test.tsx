// @vitest-environment jsdom
/**
 * THE RESOLVED GATE'S RAIL ENTRY SAYS THE DRAWING'S WORD (cinatra#3046, fix
 * leg 16).
 *
 * The twelfth proof round measured it on real runs: the card that settles reads
 * "Continued", and the rail entry for the very same gate, two columns away on
 * the same screen, read "APPROVE" — `entry.gate.disposition` printed straight
 * through and uppercased by the badge's own CSS. A disposition is the verb the
 * decider pressed; the drawing gives three readings a display may show, and the
 * rail is one of the surfaces that draws them.
 *
 * This suite mounts the real `RailExtraEntry` inside the stepper context it
 * requires and pins the plain title plus canonical metadata for EVERY disposition a gate row can be
 * resolved with, plus the unreadable case that keeps the row's old fallback.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-step-rail-extra-entry-settled-word.test.tsx
 */
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

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
    ownKeys: () => ["ClipboardCheck", "ScanSearch", "SkipForward", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

import { Stepper, StepperItem } from "@/components/reui/stepper";

import { RailExtraEntry, RunStepSelectionProvider } from "../run-step-rail-extra-entry";
import { buildRunStepRail } from "../run-step-rail";
import type { RunStepSelection } from "../run-surface-rail-step";
import type { RunStepRailEntry } from "../run-step-rail";

afterEach(() => cleanup());

/** A RESOLVED gate row, exactly as the rail builder hands it over: the stored
 *  disposition, unmapped, straight off the gate row's column. */
const resolvedGate = (disposition: string | null): RunStepRailEntry => ({
  key: "gate:task-1",
  ordinal: 6,
  kind: "gate",
  label: "Review",
  status: "resolved",
  sources: ["gate"],
  gate: {
    gateId: "gate-1",
    reviewTaskId: "task-1",
    disposition,
    resolved: true,
  },
});

function renderEntry(entry: RunStepRailEntry) {
  return render(
    <Stepper defaultValue={1} orientation="vertical">
      <StepperItem step={1} completed>
        <RailExtraEntry entry={entry} reviewHrefBase="/agents/v/p/i/review" />
      </StepperItem>
    </Stepper>,
  );
}

describe("the rail entry for a settled gate", () => {
  it.each([
    ["approve", "Continued"],
    ["reject", "Changes requested"],
    ["changes_requested", "Changes requested"],
  ] as const)("a gate resolved with %s draws %s", (disposition, word) => {
    const { container } = renderEntry(resolvedGate(disposition));
    const badge = container.querySelector("[data-rail-gate-settlement]");
    expect(badge).not.toBeNull();
    const title = container.querySelector('[data-slot="stepper-title"]');
    expect(title!.textContent).toBe(`Review · ${word.toLowerCase()}`);
    expect(title!.childElementCount).toBe(0);
    expect(badge!.getAttribute("data-rail-gate-settlement")).toBe(word);
  });

  it.each(["approve", "reject", "changes_requested"] as const)(
    "never draws the raw %s verb the row stores",
    (disposition) => {
      const { container } = renderEntry(resolvedGate(disposition));
      const row = container.querySelector('[data-rail-gate-history="true"]');
      expect(row).not.toBeNull();
      // A stored decision verb in either case is never the drawn settlement.
      expect(row!.textContent).not.toContain(disposition);
      expect(row!.textContent).not.toContain(disposition.toUpperCase());
    },
  );

  it("keeps the old fallback for a settled gate whose outcome cannot be read", () => {
    const { container } = renderEntry(resolvedGate(null));
    const badge = container.querySelector("[data-rail-gate-settlement]");
    expect(container.querySelector('[data-slot="stepper-title"]')!.textContent).toBe("Review · resolved");
    expect(badge!.getAttribute("data-rail-gate-settlement")).toBe("resolved");
    // Not the header's pending reading: this row HAS settled.
    expect(badge!.textContent).not.toContain("Review requested");
  });

  it("draws no settlement at all on a gate still pending", () => {
    const { container } = renderEntry({
      ...resolvedGate(null),
      status: "pending",
      gate: { gateId: "gate-2", reviewTaskId: "task-2", disposition: null, resolved: false },
    });
    expect(container.querySelector("[data-rail-gate-settlement]")).toBeNull();
    expect(container.querySelector('[data-rail-gate-pending="true"]')).not.toBeNull();
  });
});


function namedGate(status: "pending" | "resolved", disposition: string | null = "approve") {
  return buildRunStepRail({ gates: [{
    gateId: "gate-1", reviewTaskId: "task-1", status,
    disposition: status === "pending" ? null : disposition,
    createdAt: "2026-10-06T00:00:00Z", artifactName: "the post",
  }] }).entries[0]!;
}

function FramedEntry({ entry, selected }: { entry: RunStepRailEntry; selected: (key: RunStepSelection) => void }) {
  const [current, setCurrent] = useState<RunStepSelection>("detail");
  return <RunStepSelectionProvider value={{ selected: current, select: (key) => { selected(key); setCurrent(key); } }}>
    <Stepper defaultValue={1} orientation="vertical">
      <StepperItem step={1} completed={entry.status === "resolved"}>
        <RailExtraEntry entry={entry} reviewHrefBase="/agents/v/p/i/review" />
      </StepperItem>
    </Stepper>
  </RunStepSelectionProvider>;
}

describe("the I.3 review row is one plain text run", () => {
  it.each([
    ["approve", "continued"], ["reject", "changes requested"],
    ["changes_requested", "changes requested"], [null, "resolved"],
  ] as const)("renders the settled artifact and %s reading without a badge", (disposition, word) => {
    const { container } = renderEntry(namedGate("resolved", disposition));
    const title = container.querySelector('[data-slot="stepper-title"]')!;
    expect(title.textContent).toBe(`Review · the post · ${word}`);
    expect(title.childElementCount).toBe(0);
    expect(container.querySelector('[data-rail-gate-history="true"]')).not.toBeNull();
    expect(container.querySelector('[data-rail-gate-pending="true"]')).toBeNull();
    expect(container.querySelector('[data-rail-gate-link="task-1"]')!.getAttribute("href"))
      .toBe("/agents/v/p/i/review/task-1");
  });

  it("preserves the pending text and current in-place control", () => {
    const selected = vi.fn();
    const { container } = render(<FramedEntry entry={namedGate("pending")} selected={selected} />);
    const title = container.querySelector('[data-slot="stepper-title"]')!;
    expect(title.textContent).toBe("Review · the post");
    expect(title.childElementCount).toBe(0);
    expect(container.querySelector('[data-rail-gate-settlement]')).toBeNull();
    const trigger = container.querySelector('[data-rail-gate-open="task-1"]')!;
    expect(trigger.getAttribute("aria-current")).toBe("step");
    fireEvent.click(trigger);
    expect(selected).toHaveBeenCalledExactlyOnceWith("detail");
    expect(container.querySelector('[data-rail-gate-pending="true"]')).not.toBeNull();
  });

  it.each(["pointer", "Enter", "Space"])("keeps settled history selectable by %s with aria-current", (activation) => {
    const selected = vi.fn();
    const { container } = render(<FramedEntry entry={namedGate("resolved")} selected={selected} />);
    const trigger = container.querySelector('[data-rail-gate-open="task-1"]')!;
    expect(trigger.getAttribute("aria-current")).toBeNull();
    expect(trigger.getAttribute("tabindex")).toBe("0");
    if (activation === "pointer") fireEvent.click(trigger);
    else fireEvent.keyDown(trigger, { key: activation === "Space" ? " " : activation });
    expect(selected).toHaveBeenCalledExactlyOnceWith("review:task-1");
    expect(trigger.getAttribute("aria-current")).toBe("step");
    expect(trigger.getAttribute("data-run-surface-rail-selected")).toBe("true");
    expect(container.querySelector('[data-rail-gate-history="true"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="stepper-title"]')!.textContent).toBe("Review · the post · continued");
    expect(container.querySelector("a")).toBeNull();
  });
});
