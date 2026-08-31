// @vitest-environment jsdom
//
// "WHAT THIS RUN MADE" — THE PANEL'S OWN DRAWING (cinatra#3029, epic #3023 W5).
//
// The pure model behind this panel is already fixture-pinned in
// `run-artifact-list.test.ts`. This file pins the two things the model cannot
// say, because they live in the drawing and only a rendered surface shows them.
//
// 1. THE ROW'S MUTED LINE WRAPS. The ratified drawing's row carries the
//    identity, the revision and the MIME on one muted line and lets that line
//    WRAP, so the form an artifact took is always legible. The measured surface
//    drew it with `truncate` and the reading clipped mid-word — a row that ends
//    "text/markdo…" does not say what the artifact is. The rail's own lifecycle
//    reason already states the house rule for this ("it WRAPS inside the narrow
//    rail (never truncates) — a clipped reason answers nothing",
//    `run-step-rail-extra-entry.tsx`); the panel's line owes the same.
//
// 2. THE PANEL TITLE IS PAIRED WITH THE RUN-STATE PILL. The drawing sets the
//    run's state beside "What this run made", so the panel says WHOSE record it
//    is showing and in what state that run ended. The measured surface drew no
//    pill in any frame, in either theme, on any of the three runs.
//
// Run:
//   npx vitest run --config vitest.config.ts \
//     packages/agents/src/__tests__/run-made-panel.test.tsx

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  } & Record<string, unknown>) =>
    React.createElement("a", { href, ...rest }, children),
}));

import { RunMadePanel } from "../run-made-panel";
import { RUN_MADE_PANEL_TITLE, type RunArtifactRecord } from "../run-artifact-list";

afterEach(() => cleanup());

// The record the second capture actually measured on this road, with the MIME
// that clipped: `@cinatra-ai/blog-post-artifact:post · revision 3b0f991f… ·
// text/markdown`.
const WROTE_MARKDOWN: RunArtifactRecord = {
  artifactId: "d082b515-a917-4068-8846-4169bc4b9a94",
  representationRevisionId: "3b0f991f-9124-4133-ab38-f0fea7128c17",
  role: "wrote",
  title: "How Small Teams Keep a Content Calendar",
  objectTypeId: "@cinatra-ai/blog-post-artifact:post",
  mime: "text/markdown",
};

describe("the row's muted line", () => {
  it("WRAPS — it never carries a truncation class, so the MIME is always legible", () => {
    const { container } = render(
      <RunMadePanel records={[WROTE_MARKDOWN]} runStatus="completed" />,
    );
    const detail = container.querySelector("[data-run-made-detail]");
    expect(detail).not.toBeNull();

    // The whole line is there to be read, MIME included.
    expect(detail!.textContent).toBe(
      "@cinatra-ai/blog-post-artifact:post · revision 3b0f991f… · text/markdown",
    );

    // ...and nothing clips it. `truncate` is `overflow-hidden` +
    // `text-overflow: ellipsis` + `whitespace-nowrap`: the text stays in the
    // DOM and the READER loses it, which is exactly what the capture measured.
    expect(detail!.classList.contains("truncate")).toBe(false);
    expect(detail!.classList.contains("whitespace-normal")).toBe(true);
    expect(detail!.classList.contains("break-words")).toBe(true);
  });

  it("wraps a long identity too — the row grows, it does not clip", () => {
    const { container } = render(
      <RunMadePanel
        records={[
          {
            ...WROTE_MARKDOWN,
            objectTypeId: "@cinatra-ai/an-extension-with-a-very-long-package-name:post",
            annotation: "body · after §2",
          },
        ]}
        runStatus="completed"
      />,
    );
    const detail = container.querySelector("[data-run-made-detail]");
    expect(detail!.textContent).toBe(
      "@cinatra-ai/an-extension-with-a-very-long-package-name:post · revision 3b0f991f… · text/markdown · body · after §2",
    );
    expect(detail!.classList.contains("truncate")).toBe(false);
  });
});

describe("the panel title is paired with the run-state pill", () => {
  it("draws the pill beside the title, reading the run's own state", () => {
    const { container } = render(
      <RunMadePanel records={[WROTE_MARKDOWN]} runStatus="completed" />,
    );
    const pill = container.querySelector('[data-slot="status-pill"]');
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toContain("Completed");

    // BESIDE the title, not somewhere else in the panel: the title and the pill
    // share one header row, which is what "paired" means in the drawing.
    const header = container.querySelector("[data-run-made-header]");
    expect(header).not.toBeNull();
    expect(header!.textContent).toContain(RUN_MADE_PANEL_TITLE);
    expect(header!.contains(pill!)).toBe(true);
  });

  it("says the state truthfully — a failed run does not read as a completed one", () => {
    const { container } = render(
      <RunMadePanel records={[WROTE_MARKDOWN]} runStatus="failed" />,
    );
    const pill = container.querySelector('[data-slot="status-pill"]');
    expect(pill!.textContent).toContain("Failed");
    expect(pill!.getAttribute("data-status")).toBe("failed");
  });

  it("is drawn on the EMPTY reading too — a run that kept nothing still has a state", () => {
    const { container } = render(<RunMadePanel records={[]} runStatus="stopped" />);
    const pill = container.querySelector('[data-slot="status-pill"]');
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toContain("Stopped");
    // The empty reading the capture proved good is untouched.
    expect(container.textContent).toContain(
      "This run wrote no artifact and used none",
    );
  });
});
