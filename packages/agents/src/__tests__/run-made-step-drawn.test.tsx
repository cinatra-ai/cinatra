// @vitest-environment jsdom
/**
 * THE RUN'S LAST STEP, DRAWN AS THE DRAWING DRAWS IT (cinatra#3029, fix leg 2).
 *
 * The first proof round graded this step 5 of 12 on its own cells in both
 * palettes: the rows were bare links. Every sentence pinned below is the
 * ratified drawing's artifact review, section I.2, transcribed:
 *
 *   "Every row carries the artifact's title, the type that owns it, the
 *    revision the run filed or read, and the control that opens it on its own
 *    page."
 *   "one row per artifact the run wrote, and -- where the run consumed an
 *    artifact to make them -- that artifact too, marked used"
 *   "The rail's last entry is the run's own record."
 *   "This run wrote no artifact and used none -- it read the cohort and
 *    reported back, and no step of it made work that outlives the run."
 *
 * The drawing's own row box is measured too, because the round graded the box
 * and not only the words: "border:1px solid var(--line);border-radius:8px;
 * background:var(--surface-strong);padding:9px 12px", and the consumed row
 * "border:1px dashed var(--line-strong);background:var(--surface)".
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-made-step-drawn.test.tsx
 */
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import { afterEach, describe, expect, it } from "vitest";

import {
  RUN_MADE_EMPTY_READING,
  RUN_MADE_STEP_LABEL,
  runMadeCategoryPhrase,
  runMadeReading,
  type RunMadeArtifactRow,
} from "../run-made-reading";
import { RunMadeStepSurface } from "../run-made-step-surface";
import { RunSurfaceRail, RunSurfaceRailRow } from "../run-surface-rail";
import type { RunSurfaceRailStep } from "../run-surface-rail-step";

afterEach(cleanup);

const wrote = (over: Partial<RunMadeArtifactRow> = {}): RunMadeArtifactRow => ({
  artifactId: "art_1",
  title: "Why migrations are the hardest part",
  href: "/artifacts/art_1",
  extension: "@cinatra-ai/blog:post",
  typeLabel: "Blog post",
  revision: 1,
  mime: "text/markdown",
  rung: "structure",
  used: false,
  ...over,
});

const usedRow = (over: Partial<RunMadeArtifactRow> = {}): RunMadeArtifactRow =>
  wrote({
    artifactId: "art_idea",
    title: "Why migrations are the hardest part of self-hosting",
    href: "/artifacts/art_idea",
    extension: "@cinatra-ai/blog:idea",
    typeLabel: "Blog idea",
    revision: 3,
    mime: "text/markdown",
    rung: null,
    used: true,
    ...over,
  });

describe("§I.2 — every row carries the four things the drawing names", () => {
  it("draws the title, the type that owns it, the revision, and the control that opens it", () => {
    const { container } = render(
      <RunMadeStepSurface rows={[wrote()]} reading={runMadeReading([wrote()])} />,
    );
    const rows = container.querySelectorAll("[data-run-made-row]");
    expect(rows.length).toBe(1);
    const row = rows[0] as HTMLElement;
    expect(row.querySelector("[data-run-made-row-title]")?.textContent).toBe(
      "Why migrations are the hardest part",
    );
    expect(row.querySelector("[data-run-made-row-type]")?.textContent).toBe("Blog post");
    const meta = row.querySelector("[data-run-made-row-revision]")?.textContent ?? "";
    expect(meta).toContain("@cinatra-ai/blog:post");
    expect(meta).toContain("revision 1");
    expect(meta).toContain("text/markdown");
    const open = row.querySelector("[data-run-made-open]") as HTMLAnchorElement | null;
    expect(open).not.toBeNull();
    expect(open?.getAttribute("href")).toBe("/artifacts/art_1");
    expect(open?.textContent).toContain("Open");
  });

  it("draws the drawing's own row box, and the consumed row's dashed one", () => {
    const { container } = render(
      <RunMadeStepSurface
        rows={[wrote(), usedRow()]}
        reading={runMadeReading([wrote(), usedRow()])}
      />,
    );
    const written = container.querySelector('[data-run-made-used="written"]') as HTMLElement;
    const consumed = container.querySelector('[data-run-made-used="used"]') as HTMLElement;
    // The drawing states border-radius:8px. `rounded-lg` computes to 10px under
    // this app's radius scale -- the first proof round measured that on the live
    // boot, against the class's own transcription of the drawing. The row now
    // states the drawing's measurement literally, so it cannot drift again.
    for (const c of ["border", "border-line", "rounded-[8px]", "bg-surface-strong", "px-3", "py-[9px]"]) {
      expect(written.className).toContain(c);
    }
    expect(written.className).not.toContain("rounded-lg");
    expect(written.className).not.toContain("border-dashed");
    // The drawing's dashed used-mark is `var(--line-strong)`. That token is
    // declared for the light palette only, and the dark palette must NOT
    // re-declare it (the etched-rule gate binds to that), so the first round
    // measured the dashed border at 1.20:1 in the dark palette -- not
    // perceivable. `--line-control` IS `var(--line-strong)` in the light
    // palette and the app's own strengthened line in the dark one, so the row
    // draws the drawing's own value in the light palette and keeps the mark
    // findable in the dark.
    for (const c of ["border-dashed", "border-line-control", "bg-surface", "rounded-[8px]"]) {
      expect(consumed.className).toContain(c);
    }
    expect(consumed.className).not.toContain("border-line-strong");
    // "that artifact too, marked used" -- the drawing's own tag beside its type.
    expect(consumed.querySelector("[data-run-made-used-tag]")?.textContent).toBe("Used");
    expect(written.querySelector("[data-run-made-used-tag]")).toBeNull();
  });

  it("carries the same link affordance in the dark palette as in the light one", () => {
    // The palette does not change the class; a token that resolves to the link
    // colour in BOTH palettes is what the round found missing on the bare rows.
    const { container } = render(<RunMadeStepSurface rows={[wrote()]} reading="x" />);
    // `text-primary underline` is the app's OWN link vocabulary -- shadcn's
    // `button variant="link"` is exactly that, and every link in the app draws
    // it -- so the control reads as the app's link in whichever palette is on.
    const open = container.querySelector("[data-run-made-open]") as HTMLElement;
    expect(open.className).toContain("text-primary");
    expect(open.className).toContain("underline");
  });
});

describe("§I.2 — the Finished pill on the heading, in both specimens", () => {
  it("draws it over a listed step", () => {
    const { container } = render(<RunMadeStepSurface rows={[wrote()]} reading="x" />);
    const heading = container.querySelector("[data-run-made-heading]") as HTMLElement;
    expect(heading.textContent).toContain(RUN_MADE_STEP_LABEL);
    expect(container.querySelector("[data-run-made-state-pill]")?.textContent).toBe("Finished");
  });

  it("draws it over the empty specimen too, with the drawing's reading and no empty panel", () => {
    const { container } = render(
      <RunMadeStepSurface rows={[]} reading={runMadeReading([])} />,
    );
    expect(container.querySelector("[data-run-made-state-pill]")?.textContent).toBe("Finished");
    const reading = container.querySelector("[data-run-made-reading]") as HTMLElement;
    expect(reading.textContent).toBe(RUN_MADE_EMPTY_READING);
    expect(reading.getAttribute("role")).toBe("status");
    expect(container.querySelector("[data-run-made-rows]")).toBeNull();
  });
});

describe("§I.2 — the reading names a CATEGORY, never a spliced raw title", () => {
  it("reads the type that owns each artifact, not its title", () => {
    const sentence = runMadeReading([wrote(), usedRow()]);
    expect(sentence).toBe(
      "One artifact written — the blog post — and the blog idea they came from. Each opens on its own page; the run keeps the revision it filed or read.",
    );
    expect(sentence).not.toContain("Why migrations are the hardest part");
  });

  it("keeps a pack's own capitals", () => {
    expect(runMadeCategoryPhrase("Blog post")).toBe("the blog post");
    expect(runMadeCategoryPhrase("LinkedIn post")).toBe("the LinkedIn post");
    expect(runMadeCategoryPhrase("PDF")).toBe("the PDF");
    // A pack that Title-Cases every word of its label ("Blog Post") must still
    // read as a noun phrase inside the sentence: the first round's live reading
    // was "the blog Post", a mid-sentence capital the drawing's clause has
    // nowhere in it.
    expect(runMadeCategoryPhrase("Blog Post")).toBe("the blog post");
    expect(runMadeCategoryPhrase("LinkedIn Post")).toBe("the LinkedIn post");
    expect(runMadeCategoryPhrase("Structured Data Record")).toBe("the structured data record");
    expect(runMadeCategoryPhrase("PDF Report")).toBe("the PDF report");
  });
});

describe("§I.2 — the rail's last entry is the run's own record", () => {
  it("draws the made row AFTER the page's own rail rows, in one rail column", () => {
    const madeStep: RunSurfaceRailStep = {
      key: "made",
      reached: true,
      settled: true,
      tail: true,
      surface: <div>made</div>,
      row: (
        <RunSurfaceRailRow
          selectionKey="made"
          label={RUN_MADE_STEP_LABEL}
          displayStep={3}
          reached
          settled
          conformanceId="run-surface-rail-step"
          action="open-made-step"
        />
      ),
    };
    const { container } = render(
      <RunSurfaceRail
        steps={[madeStep]}
        rail={
          <div data-conformance-id="run-step-rail">
            <Button
              type="button"
              variant="ghost"
              data-run-surface-rail-step=""
              data-page-rail-row=""
            >
              Review
            </Button>
          </div>
        }
        detail={<div>detail</div>}
        initialSelection="made"
      />,
    );
    const column = container.querySelector("[data-run-step-rail-column]") as HTMLElement;
    const entries = Array.from(column.querySelectorAll("[data-run-surface-rail-step]"));
    expect(entries.length).toBe(2);
    expect(entries[0].getAttribute("data-page-rail-row")).toBe("");
    expect(entries[entries.length - 1].getAttribute("data-run-surface-rail-step-key")).toBe("made");
  });
});
