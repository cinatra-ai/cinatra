// @vitest-environment jsdom
//
// THE RUN'S OWN STATE WORD (cinatra#3149 item 1, epic #3023 W5).
//
// THE DEFECT the fourth graded reading measured: the state pill beside "What
// this run made" read "Completed", where the ratified drawing writes
// "Finished" — and it read that word in the very window a person still has a
// decision to take, so the panel claimed the run's work was finished business
// before the reader had made the call the review gate was asking for.
//
// THE DRAWING, quoted (§I.2, "The run's last step — what the run made"): both
// of the section's readings pair the panel title with the same word —
//
//   "What this run made   Finished"
//
// — the reading with four artifacts in it, and the reading for "a run that kept
// nothing". One word, in both. The drawing supplies no second word for the
// window in which a gate on the run's output is still open: the run itself HAS
// ended, and the panel is the run's record, not the gate's.
//
// THIS FILE IS THE ACCEPTANCE PIN for that word. It reds on the head the issue
// was grounded against (cinatra#3074 @ 324bd715, where `RUN_STATE_PILL`'s
// `completed` entry read `label: "Completed"`).
//
// Run:
//   npx vitest run --config vitest.config.ts \
//     packages/agents/src/__tests__/run-made-panel.finished-word.test.tsx

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

import { RunMadePanel } from "../run-made-panel";
import type { RunArtifactRecord } from "../run-artifact-list";

afterEach(() => cleanup());

/** A run whose output reached an artifact — the one a gate is raised over. */
const WROTE: RunArtifactRecord = {
  artifactId: "0d1c2b3a-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
  representationRevisionId: "9f8e7d6c-5b4a-4392-8281-706f5e4d3c2b",
  role: "wrote",
  title: "Why migrations are the hardest part",
  objectTypeId: "@cinatra-ai/blog-post-artifact:post",
  mime: "text/markdown",
};

describe("the state pill reads the drawing's word", () => {
  it('reads "Finished" for a run that has ended and left an artifact under review', () => {
    // The window the issue names: the run has reached its terminal status and
    // its output is sitting in front of a person who has not decided yet.
    render(<RunMadePanel records={[WROTE]} runStatus="completed" />);
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it('reads the same "Finished" for a run with nothing left to decide', () => {
    render(<RunMadePanel records={[]} runStatus="completed" />);
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it("never writes the word the drawing does not write, in any state it can be handed", () => {
    // The panel is built only for a run that has ENDED, so these three are the
    // whole table. A failed or stopped run keeps its own truthful word — a
    // failed run must not read as a finished one.
    for (const [status, word] of [
      ["completed", "Finished"],
      ["failed", "Failed"],
      ["stopped", "Stopped"],
    ] as const) {
      const { container, unmount } = render(<RunMadePanel records={[WROTE]} runStatus={status} />);
      expect(container.textContent).toContain(word);
      expect(container.textContent).not.toContain("Completed");
      unmount();
    }
  });
});
