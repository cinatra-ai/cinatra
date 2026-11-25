// @vitest-environment jsdom
/**
 * THE RUN'S LAST STEP CARRIES THE DRAWING'S SURFACE ANCHOR (cinatra#3033).
 *
 * `specs/app-artifact-review.html` §I.2 marks the run's last step with
 * `data-conformance-id="run-outputs-list"`, and its state list names both
 * readings: the listed rows and the empty "kept nothing" sentence. The step's
 * own page is `RunMadeStepSurface`, so its root carries the anchor in both
 * readings, exactly once.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-outputs-list-anchor-3033.test.tsx
 */
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { runMadeReading, type RunMadeArtifactRow } from "../run-made-reading";
import { RunMadeStepSurface } from "../run-made-step-surface";

afterEach(cleanup);

const ANCHOR = '[data-conformance-id="run-outputs-list"]';

const wrote: RunMadeArtifactRow = {
  artifactId: "art_1",
  title: "Why migrations are the hardest part",
  href: "/artifacts/art_1",
  extension: "@acme/notes:note",
  typeLabel: "Note",
  revision: 1,
  mime: "text/markdown",
  rung: "structure",
  used: false,
};

describe("§I.2 run-outputs-list on the run's last step", () => {
  it("the listed reading carries the anchor once, on the step page's root", () => {
    const { container } = render(
      <RunMadeStepSurface rows={[wrote]} reading={runMadeReading([wrote])} />,
    );
    // red-first-expect: to have a length of 1 but got +0
    expect(container.querySelectorAll(ANCHOR)).toHaveLength(1);
    const root = container.querySelector(ANCHOR) as HTMLElement;
    expect(root.getAttribute("data-run-made")).toBe("listed");
    expect(root.querySelectorAll("[data-run-made-row]")).toHaveLength(1);
  });

  it("the empty reading carries the same anchor once", () => {
    const { container } = render(<RunMadeStepSurface rows={[]} reading={runMadeReading([])} />);
    expect(container.querySelectorAll(ANCHOR)).toHaveLength(1);
    const root = container.querySelector(ANCHOR) as HTMLElement;
    expect(root.getAttribute("data-run-made")).toBe("empty");
    expect(root.querySelector('[role="status"]')).not.toBeNull();
  });
});
