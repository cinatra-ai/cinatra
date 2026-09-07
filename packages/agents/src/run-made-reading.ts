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
// The empty reading is the drawing's sentence VERBATIM. The non-empty reading is
// the drawing's sentence read back from THIS run's own rows: the count of what
// the run WROTE, then those artifacts named in the order the rail lists them,
// then what the run USED, then the drawing's closing clause — whose tail says
// "filed or read" only where the run did both.
// ---------------------------------------------------------------------------

/** The step's own word on the rail. */
export const RUN_MADE_STEP_LABEL = "What this run made";

/** The drawing's empty reading, verbatim. */
export const RUN_MADE_EMPTY_READING =
  "This run wrote no artifact and used none — it read the cohort and reported back, and no step of it made work that outlives the run.";

/** One row of the step: an artifact this run wrote, or one it used. */
export type RunMadeArtifactRow = {
  artifactId: string;
  /** The artifact's own title. */
  title: string;
  /** Its own page. */
  href: string;
  /** The base the artifact landed under. */
  extension: string;
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
function nameList(titles: readonly string[]): string {
  if (titles.length === 0) return "";
  if (titles.length === 1) return titles[0];
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  return `${titles.slice(0, -1).join(", ")}, and ${titles[titles.length - 1]}`;
}

/**
 * The last step's reading, true to the rows beneath it. Empty rows ⇒ the
 * drawing's empty reading, drawn as the drawing gives it — never an empty panel.
 */
export function runMadeReading(rows: readonly RunMadeArtifactRow[]): string {
  if (rows.length === 0) return RUN_MADE_EMPTY_READING;
  const written = rows.filter((r) => !r.used);
  const consumed = rows.filter((r) => r.used);
  // "No artifact written" and "One artifact written" both take the singular.
  const head = `${countWord(written.length)} artifact${written.length > 1 ? "s" : ""} written`;
  const writtenClause =
    written.length === 0 ? head : `${head} — ${nameList(written.map((r) => r.title))}`;
  const usedClause = consumed.length === 0 ? "" : ` — and ${nameList(consumed.map((r) => r.title))}`;
  const kept =
    written.length > 0 && consumed.length > 0
      ? "filed or read"
      : consumed.length > 0
        ? "read"
        : "filed";
  return `${writtenClause}${usedClause}. Each opens on its own page; the run keeps the revision it ${kept}.`;
}
