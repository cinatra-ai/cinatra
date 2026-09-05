import { beforeEach, describe, expect, it } from "vitest";

// THE PAGE WITH NO HIERARCHY (cinatra#2934, fix leg 10). The 404 boundary
// renders at the pathname the reader typed, so the trail composer cannot tell a
// page that was not found from one that was: the boundary says so, on the same
// route-scoped bus that already carries the negative crumb clearing.
import {
  clearCrumbContributions,
  clearPageNotFound,
  isPageNotFound,
  markPageNotFound,
  publishCrumbContributions,
  selectCrumbContributions,
} from "../breadcrumb-contributions";

const RUN_PATH = "/agents/vendor/pkg/aced3514-1f8e-4a44-9c1e-2b6f0f5a77d1";

describe("the page that was not found marks itself", () => {
  beforeEach(() => {
    clearPageNotFound();
    clearCrumbContributions();
  });

  it("marks its own pathname, and clears the parked labels with it", () => {
    publishCrumbContributions(RUN_PATH, "epoch-1", [
      { prefix: RUN_PATH, label: "Blog Draft Writer Agent (1)" },
    ]);
    markPageNotFound(RUN_PATH);
    expect(isPageNotFound(RUN_PATH)).toBe(true);
    expect(selectCrumbContributions(RUN_PATH, "epoch-1")).toEqual([]);
  });

  it("is scoped to that one pathname", () => {
    markPageNotFound(RUN_PATH);
    expect(isPageNotFound("/agents")).toBe(false);
  });

  it("lifts when the reader leaves it", () => {
    markPageNotFound(RUN_PATH);
    clearPageNotFound();
    expect(isPageNotFound(RUN_PATH)).toBe(false);
  });

  // CONVERGENCE ROUND (fix leg 10): the mark is pathname-scoped, so its LIFT
  // must be too. React runs the next boundary's layout effect before the
  // leaving boundary's cleanup during an overlapping transition, so an
  // unconditional clear would erase a mark the leaving page never owned.
  it("the boundary that owns the mark lifts it by naming it", () => {
    markPageNotFound(RUN_PATH);
    clearPageNotFound(RUN_PATH);
    expect(isPageNotFound(RUN_PATH)).toBe(false);
  });

  it("a leaving boundary cannot lift a newer page's mark", () => {
    const OTHER = "/agents/vendor/pkg/1f0b1f2e-0000-4000-8000-000000000000";
    markPageNotFound(RUN_PATH);
    markPageNotFound(OTHER);
    clearPageNotFound(RUN_PATH);
    expect(isPageNotFound(OTHER)).toBe(true);
  });
});
