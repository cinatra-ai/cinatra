// @vitest-environment jsdom
/**
 * NO SENTENCE ON THE RECORD ENTRY'S SURFACE DENIES AN OUTPUT THE RUN RECORDED
 * (cinatra#3449, second fix leg).
 *
 * The two sentences pinned below are the completion card's, and the completion
 * card is not on this page: the run page's own detail draws the rail's last
 * entry — "The rail's last entry is the run's own record, and its page lists
 * the run's work" (specs/app-artifact-review.html §I.2). This file is the arm
 * that keeps it so: neither sentence is drawn on the record entry's surface in
 * EITHER reading, before or after the completion anchors are added.
 *
 * AND THE ABSENCE CANNOT BE GOT BY DRAWING NOTHING: the listed reading is
 * asserted to still draw its rows list beside the two absences, so a surface
 * that rendered nothing at all would not pass this file.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-made-step-denial-sentences-absent.test.tsx
 */
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  RUN_MADE_EMPTY_READING,
  runMadeReading,
  type RunMadeArtifactRow,
} from "../run-made-reading";
import { RunMadeStepSurface } from "../run-made-step-surface";

afterEach(cleanup);

/** The sentence that DENIES the output. */
const DENYING_SENTENCE =
  "This run finished. Its output was recorded during the run, but it is not part of this run's transcript.";
/** The sentence that says the output is still coming. */
const LOADING_SENTENCE = "This run finished. Its output is still loading.";

const wrote = (over: Partial<RunMadeArtifactRow> = {}): RunMadeArtifactRow => ({
  artifactId: "art_post",
  title: "Why migrations are the hardest part",
  href: "/artifacts/art_post",
  extension: "@cinatra-ai/blog:post",
  typeLabel: "Blog post",
  revision: 1,
  mime: "text/markdown",
  rung: "structure",
  used: false,
  ...over,
});

const usedRow = wrote({
  artifactId: "art_idea",
  title: "Why migrations are the hardest part of self-hosting",
  href: "/artifacts/art_idea",
  extension: "@cinatra-ai/blog:idea",
  typeLabel: "Blog idea",
  revision: 3,
  rung: null,
  used: true,
});

describe("§I.2 — the record entry's surface denies nothing the run recorded", () => {
  it("draws neither sentence on the listed reading, beside the rows it does draw", () => {
    const rows = [wrote(), usedRow];
    const { container } = render(
      <RunMadeStepSurface rows={rows} reading={runMadeReading(rows)} />,
    );

    // The rows list IS drawn — the absence below is an absence on a page that
    // says something, not on an empty one.
    expect(container.querySelectorAll("[data-run-made-rows]").length).toBe(1);
    expect(container.querySelectorAll("[data-run-made-row]").length).toBe(2);

    const text = container.textContent ?? "";
    expect(text).not.toContain(DENYING_SENTENCE);
    expect(text).not.toContain(LOADING_SENTENCE);
  });

  it("draws neither sentence on the empty reading either", () => {
    const { container } = render(
      <RunMadeStepSurface rows={[]} reading={RUN_MADE_EMPTY_READING} />,
    );

    const text = container.textContent ?? "";
    expect(text).toContain(RUN_MADE_EMPTY_READING);
    expect(text).not.toContain(DENYING_SENTENCE);
    expect(text).not.toContain(LOADING_SENTENCE);
  });
});
