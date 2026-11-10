// @vitest-environment jsdom
//
// The status cell of the two marketplace approval tables, as the application
// drawing's "Marketplace approval states in a table" (specs/app.html V.2) draws
// it (cinatra#4296): the state pill's own label, never the raw state word; the
// Failed pill and the attempt count beside the state pill; the promotion step on
// a muted second line under the Approved pill.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { SubmissionStatusPill } from "../submissions/submission-status-pill";
import { VendorApplicationStatusCell } from "../vendor-applications/vendor-application-status-cell";

afterEach(cleanup);

const pills = (root: HTMLElement) =>
  [...root.querySelectorAll('[data-slot="status-pill"]')].map((pill) => pill.textContent);

function vendor(status: string, extra: { viewerMayDecide?: boolean; repairStuckAt?: string | null; attempts?: number } = {}) {
  return render(
    <VendorApplicationStatusCell
      status={status}
      viewerMayDecide={extra.viewerMayDecide ?? true}
      repairStuckAt={extra.repairStuckAt ?? null}
      attempts={extra.attempts ?? 0}
    />,
  ).container;
}
function submission(status: string, promotionState = "none", viewerMayDecide = false) {
  return render(<SubmissionStatusPill status={status} promotionState={promotionState} viewerMayDecide={viewerMayDecide} />).container;
}

describe("vendor applications status cell", () => {
  it.each([
    ["applied", true, "Awaiting you"],
    ["applied", false, "Awaiting others"],
    ["approved", true, "Approved"],
    ["rejected", true, "Declined"],
    ["cancelled", true, "Withdrawn"],
    ["reset", true, "Reset"],
  ])("%s (viewer may decide: %s) draws the %s pill", (status, viewerMayDecide, label) => {
    expect(pills(vendor(status, { viewerMayDecide }))).toEqual([label]);
  });

  it("repair stuck puts the Failed pill beside the state pill and the attempt count beside it", () => {
    const cell = vendor("approved", { repairStuckAt: "2026-10-01T00:00:00Z", attempts: 3 });
    expect(pills(cell)).toEqual(["Approved", "Failed"]);
    expect(cell.textContent).toBe("ApprovedFailed3 attempts");
    expect(cell.querySelector(".text-muted-foreground")?.textContent).toBe("3 attempts");
    expect(cell.querySelector('[data-slot="badge"]')).toBeNull();
  });

  it.each([
    [1, "ApprovedFailed1 attempt"],
    [0, "ApprovedFailed"],
    [-1, "ApprovedFailed"],
    [2.5, "ApprovedFailed"],
  ])("an attempt count of %s reads %s", (attempts, text) => {
    expect(vendor("approved", { repairStuckAt: "2026-10-01T00:00:00Z", attempts }).textContent).toBe(text);
  });
});

describe("extension submissions status cell", () => {
  it.each([
    ["approved", "in_flight", "Promotion in flight"],
    ["approved", "failed", "Promotion failed"],
    ["approved", "complete", "Promoted"],
    ["promoted", "complete", "Promoted"],
    ["promoted", "none", "Promoted"],
  ])("%s with promotion %s takes the Approved pill and the step %s under it", (status, promotion, step) => {
    const cell = submission(status, promotion);
    expect(pills(cell)).toEqual(["Approved"]);
    const line = cell.querySelector("p");
    expect(line?.textContent).toBe(step);
    expect(line?.className).toContain("text-muted-foreground");
  });

  it("an approved submission with no promotion yet has no step line", () => {
    const cell = submission("approved", "none");
    expect(pills(cell)).toEqual(["Approved"]);
    expect(cell.querySelector("p")).toBeNull();
  });

  it.each([
    ["pending", true, "Awaiting you"],
    ["pending", false, "Awaiting others"],
    ["rejected", false, "Declined"],
    ["withdrawn", false, "Withdrawn"],
    ["superseded", false, "Archived"],
    ["something-new", false, "Unknown"],
  ])("%s (viewer may decide: %s) draws %s and no raw state word", (status, viewerMayDecide, label) => {
    const cell = submission(status, "none", viewerMayDecide);
    expect(pills(cell)).toEqual([label]);
    expect(cell.querySelector("p")).toBeNull();
  });

  it("keeps the promotion error as the cell's title", () => {
    const { container } = render(<SubmissionStatusPill status="approved" promotionState="failed" promotionError="boom" viewerMayDecide={false} />);
    expect(container.querySelector('[title="Error: boom"]')).not.toBeNull();
  });
});
