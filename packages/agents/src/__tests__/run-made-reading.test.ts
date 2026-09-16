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
// The sentences below are the ratified drawing's own words (artifact review
// section I.2), transcribed rather than paraphrased.
//
// THE ROWS NOW CARRY A CATEGORY, AND THE READING NAMES THAT (fix leg 2). The
// first leg's rows were fed the drawing's own category phrases AS TITLES — "the
// post", "its featured image" — which reproduced the drawing's sentence in a
// suite while a real run, whose titles are headlines, read back a sentence made
// of headlines. Each row is built here with a title and a type label that are
// DIFFERENT STRINGS, so a reading that spliced the title in could not pass.
// ---------------------------------------------------------------------------

const wrote = (typeLabel: string, title = `A headline for ${typeLabel}`): RunMadeArtifactRow => ({
  artifactId: `id-${typeLabel}`,
  title,
  href: `/artifacts/id-${typeLabel}`,
  extension: "@cinatra-ai/markdown-artifact",
  typeLabel,
  revision: 1,
  mime: "text/markdown",
  rung: "structure",
  used: false,
});

const used = (typeLabel: string): RunMadeArtifactRow => ({ ...wrote(typeLabel), used: true });

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

  it("reads the drawing's specimen SHAPE back from the specimen's own types", () => {
    // The drawing's sentence names four written things, then the one the run
    // used, then keeps the drawing's closing clause. The specimen's own copy
    // ("its featured image", "one file nothing could name") is that specimen's
    // writing; what a reading composed from data can carry is the category each
    // row's TYPE is named by, which is what is pinned here.
    expect(
      runMadeReading([
        wrote("Blog post"),
        wrote("Blog image"),
        wrote("LinkedIn post"),
        wrote("Binary"),
        used("Blog idea"),
      ]),
    ).toBe(
      "Four artifacts written — the blog post, the blog image, the LinkedIn post, and the binary — and the blog idea they came from. Each opens on its own page; the run keeps the revision it filed or read.",
    );
  });

  it("reads a Title-Cased pack label as a noun phrase, not with a mid-sentence capital", () => {
    // The first proof round read back "the blog Post" on the live boot: the
    // pack spells its label "Blog Post" and only the first word was lowered.
    expect(runMadeReading([wrote("Blog Post")])).toBe(
      "One artifact written — the blog post. Each opens on its own page; the run keeps the revision it filed.",
    );
    // A word a pack capitalises ITS OWN way is still left alone, wherever it
    // stands in the label.
    expect(runMadeReading([wrote("LinkedIn Post")])).toBe(
      "One artifact written — the LinkedIn post. Each opens on its own page; the run keeps the revision it filed.",
    );
  });

  it("never splices a row's raw title into the reading", () => {
    const sentence = runMadeReading([wrote("Blog post", "Why migrations are the hardest part")]);
    expect(sentence).not.toContain("Why migrations are the hardest part");
    expect(sentence).toContain("the blog post");
  });

  it("says what one artifact is, in the singular", () => {
    expect(runMadeReading([wrote("Report")])).toBe(
      "One artifact written — the report. Each opens on its own page; the run keeps the revision it filed.",
    );
  });

  it("keeps the reading true to the rows when the run only used artifacts", () => {
    // No written row, so nothing came FROM the used one and the drawing's
    // "they came from" tail is not written either.
    expect(runMadeReading([used("Cohort")])).toBe(
      "No artifact written — and the cohort. Each opens on its own page; the run keeps the revision it read.",
    );
  });

  it("counts in words up to twelve and in figures beyond", () => {
    const many = Array.from({ length: 13 }, (_, i) => wrote(`Row ${i + 1}`));
    expect(runMadeReading(many).startsWith("13 artifacts written — ")).toBe(true);
    expect(runMadeReading(many.slice(0, 12)).startsWith("Twelve artifacts written — ")).toBe(true);
  });
});
