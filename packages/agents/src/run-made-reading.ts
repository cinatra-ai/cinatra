// ---------------------------------------------------------------------------
// THE RUN'S LAST STEP — "What this run made" (cinatra#3029, epic #3023 W5).
//
// A plain module, deliberately NOT "use client": the setup run page's screen is
// a SERVER component and composes this step's row and reading while it is still
// on the server (see run-surface-rail-step.ts for why that matters).
//
// The words are TRANSCRIBED from the ratified drawing's artifact review,
// section I.2, rather than chosen here:
//
//   the step        "What this run made"
//   the reading     "Four artifacts written — the post and its featured image,
//                    the LinkedIn post, and one file nothing could name — and
//                    the idea they came from. Each opens on its own page; the
//                    run keeps the revision it filed or read."
//   the empty one   "This run wrote no artifact and used none — it read the
//                    cohort and reported back, and no step of it made work that
//                    outlives the run."
//
// The empty reading is the drawing's sentence VERBATIM.
//
// THE SECOND CLAUSE NAMES A CATEGORY, NEVER A TITLE (fix leg 2). Read the
// drawing's own sentence again: "the post and its featured image, the LinkedIn
// post, and one file nothing could name" — not one of those is the title of the
// artifact it stands for. The titles are on the ROWS beneath ("Why migrations
// are the hardest part"); the sentence above them says what KIND of thing the
// run made. The first leg spliced the raw titles into that clause, so a real
// run read back a sentence made of headlines. Every row now carries the words
// its own type is named by — the same `artifactKindLabelFor` the artifact's own
// page puts in its header — and the reading is built from THOSE.
//
// WHAT THIS CANNOT REPRODUCE, said plainly. The drawing's specimen sentence is
// that specimen's own copy: "its featured image" and "one file nothing could
// name" are written for those four rows, and no reading composed from data can
// invent them. What is general is the RULE the specimen follows — name the
// category, not the headline — and that is what this composes.
// ---------------------------------------------------------------------------

/** The step's own word on the rail. */
export const RUN_MADE_STEP_LABEL = "What this run made";

/** The drawing's empty reading, verbatim. */
export const RUN_MADE_EMPTY_READING =
  "This run wrote no artifact and used none — it read the cohort and reported back, and no step of it made work that outlives the run.";

/** The word the drawing's pill carries on the finished step's heading. */
export const RUN_MADE_STATE_PILL_LABEL = "Finished";

/** One row of the step: an artifact this run wrote, or one it used. */
export type RunMadeArtifactRow = {
  artifactId: string;
  /** The artifact's own title. */
  title: string;
  /** Its own page. */
  href: string;
  /** The type id the run recorded — the drawing's `@cinatra-ai/blog:post`. */
  extension: string;
  /**
   * THE TYPE THAT OWNS IT, in the pack's own words — the drawing's `Blog post`
   * tag. Resolved by the host through `artifactKindLabelFor`, which is the same
   * function the artifact's own page header reads, so a row and the page it
   * opens cannot name one pack two ways.
   */
  typeLabel: string;
  /** The revision the run filed or read; null where none was pinned. */
  revision: number | null;
  /** The representation's mime, where the run pinned one. */
  mime: string | null;
  /** The ladder rung that decided its form; null for an artifact the run used
   *  or one a declared binding named. */
  rung: string | null;
  /** True when the run READ this artifact rather than writing it. */
  used: boolean;
};

const COUNT_WORDS = [
  "No",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
] as const;

function countWord(n: number): string {
  return n < COUNT_WORDS.length ? COUNT_WORDS[n] : String(n);
}

/** "a, b, and c" — the drawing's own list punctuation. */
function nameList(phrases: readonly string[]): string {
  if (phrases.length === 0) return "";
  if (phrases.length === 1) return phrases[0];
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(", ")}, and ${phrases[phrases.length - 1]}`;
}

/**
 * THE CATEGORY PHRASE for one row — "the blog post", "the LinkedIn post".
 *
 * The label arrives in the pack's own spelling, which is a TITLE in a tag and a
 * NOUN in a sentence, so exactly one thing is adjusted: an ordinary capitalized
 * first word is lowered ("Blog post" reads "the blog post"), and a word the
 * pack capitalized ITS OWN way is left alone — "LinkedIn" and "PDF" are how
 * those packs spell themselves, and lowering them would be the host overriding
 * a pack's spelling, which `artifact-kind-label.ts` rules out in as many words.
 */
export function runMadeCategoryPhrase(typeLabel: string): string {
  const label = typeLabel.trim();
  if (label.length === 0) return "the artifact";
  const [first, ...rest] = label.split(" ");
  const ordinary = first === first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  const head = ordinary ? first.toLowerCase() : first;
  return `the ${[head, ...rest].join(" ")}`;
}

/**
 * The last step's reading, true to the rows beneath it. Empty rows ⇒ the
 * drawing's empty reading, drawn as the drawing gives it — never an empty panel.
 */
export function runMadeReading(rows: readonly RunMadeArtifactRow[]): string {
  if (rows.length === 0) return RUN_MADE_EMPTY_READING;
  const phrase = (r: RunMadeArtifactRow) => runMadeCategoryPhrase(r.typeLabel);
  const written = rows.filter((r) => !r.used);
  const consumed = rows.filter((r) => r.used);
  // "No artifact written" and "One artifact written" both take the singular.
  const head = `${countWord(written.length)} artifact${written.length > 1 ? "s" : ""} written`;
  const writtenClause =
    written.length === 0 ? head : `${head} — ${nameList(written.map(phrase))}`;
  // "— and the idea they came from": the drawing's own closing of the list, and
  // its tail says where the written work came FROM, so it is written only where
  // the run both wrote and read.
  const usedClause =
    consumed.length === 0
      ? ""
      : ` — and ${nameList(consumed.map(phrase))}${written.length > 0 ? " they came from" : ""}`;
  const kept =
    written.length > 0 && consumed.length > 0
      ? "filed or read"
      : consumed.length > 0
        ? "read"
        : "filed";
  return `${writtenClause}${usedClause}. Each opens on its own page; the run keeps the revision it ${kept}.`;
}
