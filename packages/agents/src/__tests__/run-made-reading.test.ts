import { describe, expect, it } from "vitest";
import {
  RUN_MADE_STEP_LABEL,
  RUN_MADE_EMPTY_READING,
  runMadeReading,
  type RunMadeArtifactRow,
} from "../run-made-reading";

// ---------------------------------------------------------------------------
// cinatra#3029 acceptance item 5 — "The run page lists the run's artifacts."
//
// The three sentences below are the ratified drawing's own words (artifact
// review section I.2), transcribed rather than paraphrased.
// ---------------------------------------------------------------------------

const wrote = (title: string): RunMadeArtifactRow => ({
  artifactId: `id-${title}`,
  title,
  href: `/artifacts/id-${title}`,
  extension: "@cinatra-ai/markdown-artifact",
  rung: "structure",
  used: false,
});

const used = (title: string): RunMadeArtifactRow => ({ ...wrote(title), used: true });

describe("the run's last step — what this run made", () => {
  it("is named by the drawing's own word", () => {
    expect(RUN_MADE_STEP_LABEL).toBe("What this run made");
  });

  it("draws the drawing's empty reading when the run wrote no artifact and used none", () => {
    expect(runMadeReading([])).toBe(RUN_MADE_EMPTY_READING);
    expect(RUN_MADE_EMPTY_READING).toBe(
      "This run wrote no artifact and used none — it read the cohort and reported back, and no step of it made work that outlives the run.",
    );
  });

  it("reads the drawing's specimen back from the drawing's own rows", () => {
    expect(
      runMadeReading([
        wrote("the post"),
        wrote("its featured image"),
        wrote("the LinkedIn post"),
        wrote("one file nothing could name"),
        used("the idea they came from"),
      ]),
    ).toBe(
      "Four artifacts written — the post, its featured image, the LinkedIn post, and one file nothing could name — and the idea they came from. Each opens on its own page; the run keeps the revision it filed or read.",
    );
  });

  it("says what one artifact is, in the singular", () => {
    expect(runMadeReading([wrote("the report")])).toBe(
      "One artifact written — the report. Each opens on its own page; the run keeps the revision it filed.",
    );
  });

  it("keeps the reading true to the rows when the run only used artifacts", () => {
    expect(runMadeReading([used("the cohort")])).toBe(
      "No artifact written — and the cohort. Each opens on its own page; the run keeps the revision it read.",
    );
  });

  it("counts in words up to twelve and in figures beyond", () => {
    const many = Array.from({ length: 13 }, (_, i) => wrote(`row ${i + 1}`));
    expect(runMadeReading(many).startsWith("13 artifacts written — ")).toBe(true);
    expect(runMadeReading(many.slice(0, 12)).startsWith("Twelve artifacts written — ")).toBe(true);
  });
});
