// @vitest-environment jsdom
/**
 * THE RECORD ENTRY'S PAGE IS THE FINISHED RUN'S COMPLETION READING
 * (cinatra#3449, second fix leg).
 *
 * The drawing puts a finished run's outputs on the rail's LAST ENTRY and its
 * page, never on a second card beside it — specs/app-artifact-review.html §I.2:
 *
 *   "A finished run says what it made. The rail's last entry is the run's own
 *    record, and its page lists the run's work: one row per artifact the run
 *    wrote, and — where the run consumed an artifact to make them — that
 *    artifact too, marked used, because a reader needs to see what the run
 *    started from as well as what it produced."
 *
 * So the completion reading is TAKEN ON THIS SURFACE. The rows, the used mark
 * and the Open control are already drawn here; what this file pins is that the
 * reading a walk takes is available on the nodes that are already drawn:
 * `data-run-completion`, `data-run-completion-evidence`, the ONE
 * `data-run-outputs` list, and a `data-run-output-link` on every row the run
 * PRODUCED and on no other.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-made-step-completion-anchors.test.tsx
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

/** A row the run WROTE. */
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

/** A row the run only READ. */
const usedRow = (over: Partial<RunMadeArtifactRow> = {}): RunMadeArtifactRow =>
  wrote({
    artifactId: "art_idea",
    title: "Why migrations are the hardest part of self-hosting",
    href: "/artifacts/art_idea",
    extension: "@cinatra-ai/blog:idea",
    typeLabel: "Blog idea",
    revision: 3,
    rung: null,
    used: true,
    ...over,
  });

const IMAGE = wrote({
  artifactId: "art_image",
  title: "A migration, drawn",
  href: "/artifacts/art_image",
  extension: "@cinatra-ai/blog:image",
  typeLabel: "Blog image",
  revision: 1,
  mime: "image/png",
});

describe("§I.2 — the record entry's page carries the run's output as the completion reading", () => {
  it("reads with-output, names its evidence, and draws ONE outputs list with one link per produced artifact", () => {
    const rows = [wrote(), IMAGE, usedRow()];
    const { container } = render(
      <RunMadeStepSurface rows={rows} reading={runMadeReading(rows)} />,
    );

    const completion = container.querySelector("[data-run-completion]");
    expect(completion).not.toBeNull();
    expect(completion!.getAttribute("data-run-completion")).toBe("with-output");
    expect(completion!.getAttribute("data-run-completion-evidence")).toBe("outputs");

    // EXACTLY ONE list carries the outputs reading.
    expect(container.querySelectorAll("[data-run-outputs]").length).toBe(1);

    // One link per artifact the run PRODUCED, in the order the rows are drawn,
    // and each one opens that artifact's own page.
    const links = Array.from(
      container.querySelectorAll<HTMLElement>("[data-run-output-link]"),
    );
    expect(links.map((link) => link.getAttribute("data-run-output-link"))).toEqual([
      "art_post",
      "art_image",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/artifacts/art_post",
      "/artifacts/art_image",
    ]);
  });

  it("keeps a row the run only read listed and marked used, and gives it no output link", () => {
    const rows = [wrote(), usedRow()];
    const { container } = render(
      <RunMadeStepSurface rows={rows} reading={runMadeReading(rows)} />,
    );

    // BOTH HALVES AT ONCE, so the output list cannot be made true by dropping
    // the used row: the used row is still on the page, still marked used — and
    // carries no output link.
    const used = container.querySelector<HTMLElement>('[data-run-made-row="art_idea"]');
    expect(used).not.toBeNull();
    expect(used!.getAttribute("data-run-made-used")).toBe("used");
    expect(used!.querySelector("[data-run-output-link]")).toBeNull();
    expect(used!.querySelector("[data-run-made-open]")).not.toBeNull();

    const written = container.querySelector<HTMLElement>('[data-run-made-row="art_post"]');
    expect(written!.getAttribute("data-run-made-used")).toBe("written");
    expect(written!.querySelector("[data-run-output-link]")).not.toBeNull();

    expect(container.querySelectorAll("[data-run-output-link]").length).toBe(1);
  });

  it("reads no-output on the empty reading, and draws no outputs list and no output link", () => {
    const { container } = render(
      <RunMadeStepSurface rows={[]} reading={RUN_MADE_EMPTY_READING} />,
    );

    const completion = container.querySelector("[data-run-completion]");
    expect(completion).not.toBeNull();
    expect(completion!.getAttribute("data-run-completion")).toBe("no-output");
    expect(container.querySelectorAll("[data-run-outputs]").length).toBe(0);
    expect(container.querySelectorAll("[data-run-output-link]").length).toBe(0);

    // The empty reading the surface already draws is untouched.
    expect(container.querySelector("[data-run-made-reading]")?.textContent).toBe(
      RUN_MADE_EMPTY_READING,
    );
  });
});
