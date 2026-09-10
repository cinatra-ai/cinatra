// @vitest-environment jsdom
/**
 * THE RAIL ROW'S LABEL FITS ITS COLUMN (cinatra#3226, the third proof round's
 * fourth finding).
 *
 * The measured reading, on a real completed run: the settled work step — named
 * by the work it did, which is what the drawing asks a rail entry to say — ran
 * out of the 208px rail column and was cut by the detail card beside it. Read on
 * the live boot at the fixture that mounts this very panel: a work-named label
 * measured 384px against a 208px column, `white-space: nowrap`, 208px of it
 * outside the column, in both palettes.
 *
 * IT WRAPS RATHER THAN TRUNCATES, which is the rule this rail already states for
 * a lifecycle reason: "It WRAPS inside the narrow rail (never truncates) — a
 * clipped reason answers nothing." A clipped NAME answers no more.
 *
 * THE INSTRUMENT. jsdom lays nothing out, so the box is read from the utility
 * tokens the rendered rows carry — the same tokens the picture is graded on:
 * the shared row is allowed to shrink inside the column (`w-full min-w-0`) and
 * its text is allowed to wrap (`whitespace-normal`, against the design-system
 * button's own `whitespace-nowrap`), and the label itself may break a long word
 * (`break-words`). The pixel reading is taken on the boot.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-page-rail-label-fits-the-column.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { RunStepRailPanel } from "../run-step-rail-panel";
import type { RunStepRailEntry } from "../run-step-rail";

afterEach(() => {
  cleanup();
});

const LONG_LABEL = "Draft the re-engagement email for the Q3 dormant cohort";

const ENTRIES: RunStepRailEntry[] = [
  { key: "step:1", ordinal: 1, kind: "step", label: LONG_LABEL, status: "completed", sources: [] },
  {
    key: "gate:r1",
    ordinal: 2,
    kind: "gate",
    label: LONG_LABEL,
    status: "resolved",
    sources: [],
    gate: { gateId: "g1", reviewTaskId: "r1", disposition: "approved", resolved: true },
  },
  {
    key: "verification:r1",
    ordinal: 3,
    kind: "verification",
    label: LONG_LABEL,
    status: "completed",
    sources: [],
    verification: { gateId: "g1", reviewTaskId: "r1", outcome: "verified" },
  },
] as RunStepRailEntry[];

function reading() {
  const { container } = render(
    <RunStepRailPanel entries={ENTRIES} activeOrdinal={null} reviewHrefBase="/agents/v/p/run/review" />,
  );
  const rail = container.querySelector<HTMLElement>("[data-run-step-rail]")!;
  const titles = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="stepper-title"]'));
  const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="stepper-item"]')).map(
    (item) =>
      item.querySelector<HTMLElement>('[data-slot="stepper-trigger"]') ??
      item.querySelector<HTMLElement>("a")!,
  );
  return { rail, titles, rows };
}

function tokens(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

describe("every rail row's label stays inside the column", () => {
  it("draws the column at the rail's own width", () => {
    expect(tokens(reading().rail)).toContain("w-52");
  });

  it("lets every row shrink inside that column", () => {
    for (const row of reading().rows) {
      expect(tokens(row)).toContain("min-w-0");
      expect(tokens(row)).toContain("w-full");
    }
  });

  it("lets every row's text wrap rather than run past the column", () => {
    for (const row of reading().rows) {
      const wrapping = tokens(row).filter((t) => /^whitespace-/.test(t));
      // The design-system button pins `whitespace-nowrap`; the row's own token
      // is what overrides it, and it must be the LAST word on the property.
      expect(wrapping[wrapping.length - 1]).toBe("whitespace-normal");
    }
  });

  it("breaks a single long word rather than overflowing on it", () => {
    for (const title of reading().titles) {
      expect(tokens(title)).toContain("break-words");
      expect(tokens(title)).toContain("min-w-0");
      expect(tokens(title)).toContain("whitespace-normal");
    }
  });

  it("still draws the whole name — nothing is truncated away", () => {
    for (const title of reading().titles) {
      expect(title.textContent).toContain(LONG_LABEL);
      expect(tokens(title)).not.toContain("truncate");
    }
  });
});
