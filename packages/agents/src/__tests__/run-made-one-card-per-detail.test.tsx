// @vitest-environment jsdom
//
// ONE CARD PER DETAIL — THE RECORD IS NOT STACKED ON THE GATE (cinatra#3149
// item 2, epic #3023 W5).
//
// THE DEFECT the fourth graded reading measured: on a run whose default-road
// output had opened a review gate, the "What this run made" panel and the
// gate's own review card were visible TOGETHER, in the same instant, in the
// same run detail.
//
// THE DRAWING, quoted (§I, "One page per gate — the step's own card, and
// nothing else"): "Selecting a step opens THAT STEP'S PAGE in the run detail,
// and the page carries the ONE CARD of the step it belongs to. ... an answered
// Skills row is NEVER drawn above the HITL card, the review card, the schedule
// card or any other card, AND TWO CARDS ARE NEVER STACKED IN ONE DETAIL."
//
// And §I.2 puts the record on a page of its own: "The rail's LAST ENTRY is the
// run's own record, and ITS PAGE lists the run's work".
//
// WHERE THE PROPERTY IS PINNED. The screen used to decide the record's place
// twice — once to mount it inside the run detail, and once to make it a step —
// out of two separately-written expressions that could drift into agreeing on
// "both". Those two questions are ONE question, so they are answered once, by
// the pure seam `runMadePlacement`, and the screen reads its answer in both
// places. A placement is a single value: "stacked" is not one of the answers it
// can return, which is what makes the drawing's rule structural rather than
// remembered.
//
// The second half proves the DRAWN consequence at the frame: the run detail
// column shows the record's page or the gate's, never the two together.
//
// Run:
//   npx vitest run --config vitest.config.ts \
//     packages/agents/src/__tests__/run-made-one-card-per-detail.test.tsx

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  } & Record<string, unknown>) => React.createElement("a", { href, ...rest }, children),
}));

import { runMadePlacement, type RunMadePlacement } from "../run-artifact-list";
import { RunSurfaceRail } from "../run-surface-rail";
import type { RunSurfaceRailStep } from "../run-surface-rail-step";

afterEach(() => cleanup());

describe("the record has ONE place, decided once", () => {
  const table: ReadonlyArray<{
    saysSomething: boolean;
    railAvailable: boolean;
    detailHoldsPendingGateCard?: boolean;
    expected: RunMadePlacement;
  }> = [
    // The run's record has an answer AND the page can stand a rail beside it:
    // the record is the rail's last step and opens on a page of its own.
    { saysSomething: true, railAvailable: true, expected: "step-page" },
    // The ONE branch where the record cannot be a step — the flow branch, whose
    // rail lives INSIDE the run detail, so opening a page of its own would
    // leave the reader with no rail at all. There it stays in the detail, and
    // it is then the only card the detail has to itself.
    { saysSomething: true, railAvailable: false, expected: "in-run-detail" },
    // ... and on THAT branch the detail is also where the gate's own review
    // card is drawn. While the gate is UNDECIDED the card owns the detail and
    // the record is not drawn beside it — "two cards are never stacked in one
    // detail" holds on the branch that has no step pages too (adopted at
    // convergence).
    {
      saysSomething: true,
      railAvailable: false,
      detailHoldsPendingGateCard: true,
      expected: "not-drawn",
    },
    // A DECIDED gate takes nothing away: the record draws in the detail exactly
    // as before, so the rule orders the two cards rather than losing one.
    {
      saysSomething: true,
      railAvailable: false,
      detailHoldsPendingGateCard: false,
      expected: "in-run-detail",
    },
    // The page-rail branch is unaffected — there the record has a page of its
    // own, so an open gate never puts the two in one detail to begin with.
    {
      saysSomething: true,
      railAvailable: true,
      detailHoldsPendingGateCard: true,
      expected: "step-page",
    },
    // The read answered nothing yet: the record is not drawn at all.
    { saysSomething: false, railAvailable: true, expected: "not-drawn" },
    { saysSomething: false, railAvailable: false, expected: "not-drawn" },
  ];

  it("answers every case with exactly one placement", () => {
    for (const row of table) {
      expect(
        runMadePlacement({
          saysSomething: row.saysSomething,
          railAvailable: row.railAvailable,
          detailHoldsPendingGateCard: row.detailHoldsPendingGateCard,
        }),
      ).toBe(row.expected);
    }
  });

  it("can never say both — a placement is one value, so the two mounts cannot agree on stacking", () => {
    for (const row of table) {
      const placement = runMadePlacement({
        saysSomething: row.saysSomething,
        railAvailable: row.railAvailable,
        detailHoldsPendingGateCard: row.detailHoldsPendingGateCard,
      });
      const isStep = placement === "step-page";
      const isInDetail = placement === "in-run-detail";
      expect(isStep && isInDetail).toBe(false);
    }
  });
});

describe("the branch with no step pages never stacks the record on an open gate", () => {
  // The seam read the way the screen reads it on that branch: the rail lives
  // inside the run detail, so `railAvailable` is false and the gate's card is
  // drawn into the very column the record would join.
  const onTheFlowBranch = (gateAwaiting: boolean) =>
    runMadePlacement({
      saysSomething: true,
      railAvailable: false,
      detailHoldsPendingGateCard: gateAwaiting,
    });

  it("does not draw the record while the gate is still undecided", () => {
    expect(onTheFlowBranch(true)).toBe("not-drawn");
  });

  it("draws the record in the detail once the gate is decided", () => {
    expect(onTheFlowBranch(false)).toBe("in-run-detail");
  });
});

describe("the run detail column draws one card at a time", () => {
  /** The gate's review card, as the run detail composes it. */
  const detail = <div data-test-gate-card="">Review requested · awaiting your decision</div>;
  /** The record's own page — the rail's last step's surface. */
  const runMadeStep: RunSurfaceRailStep = {
    key: "runMade",
    row: null,
    settled: true,
    surface: <div data-test-run-made="">What this run made</div>,
  };

  it("shows the gate's card, and not the record, while the run detail is open", () => {
    const { container } = render(
      <RunSurfaceRail steps={[runMadeStep]} detail={detail} initialSelection="detail" />,
    );
    expect(container.querySelectorAll("[data-test-gate-card]").length).toBe(1);
    expect(container.querySelectorAll("[data-test-run-made]").length).toBe(0);
  });

  it("shows the record's own page, and not the gate's card, when the record is open", () => {
    const { container } = render(
      <RunSurfaceRail steps={[runMadeStep]} detail={detail} initialSelection="runMade" />,
    );
    expect(container.querySelectorAll("[data-test-run-made]").length).toBe(1);
    expect(container.querySelectorAll("[data-test-gate-card]").length).toBe(0);
  });

  it("never has both in the detail column, whichever step is open", () => {
    for (const initial of ["detail", "runMade"] as const) {
      const { container, unmount } = render(
        <RunSurfaceRail steps={[runMadeStep]} detail={detail} initialSelection={initial} />,
      );
      const column = container.querySelector("[data-run-detail-column]");
      expect(column).toBeTruthy();
      const cards =
        column!.querySelectorAll("[data-test-gate-card]").length +
        column!.querySelectorAll("[data-test-run-made]").length;
      expect(cards).toBe(1);
      unmount();
    }
    expect(screen.queryByText("nothing")).toBeNull();
  });
});
