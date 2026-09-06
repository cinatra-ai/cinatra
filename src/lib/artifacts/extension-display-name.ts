/**
 * THE ONE KIND NAME for an extension package id, as a leaf.
 *
 * `@cinatra-ai/screenshot-artifact:screenshot` → "Screenshot".
 *
 * It was written inside the library surface, which is where it is drawn as the
 * row's claim chip. Wave 3's fix leg draws the SAME label beside the artifact
 * page's title — the ratified drawing puts the kind beside the title on the
 * artifact's own page — and the two labels have to be one label, not two that
 * agree today. The library keeps naming it at its call site (its own surface
 * conformance test reads that call), and re-exports it from here so nothing
 * imports a server-only surface module to read a string.
 *
 * WHAT THE DRAWING DRAWS, AND WHAT THIS USED TO DRAW. Every kind label in the
 * ratified drawing is a KIND NAME in sentence case — "Screenshot", "Slide
 * deck", "Brand voice", "Email", "Sales" — never the package id title-cased
 * word by word. This leaf used to do exactly that, so a picture read "Image
 * Artifact" where the drawing gives a kind, and the fourth proof round graded
 * every artifact frame down for it. Two rules close the gap and nothing else
 * changes:
 *
 *   THE PACKAGING WORD IS NOT PART OF THE KIND. A trailing `artifact` /
 *   `artifacts` segment names how the package is shipped, not what the work is,
 *   so it is dropped — but only while some word is left to name the kind, so a
 *   package called nothing else still reads.
 *
 *   AN INITIALISM STAYS AN INITIALISM. The drawing writes "CMS page", not "Cms
 *   page", so the handful of segments that are read letter by letter are drawn
 *   that way. Everything else is one sentence-cased phrase.
 */

/** Segments a reader says letter by letter. Deliberately short and closed: a
 *  word that is not on this list is drawn as a word. */
const KIND_INITIALISMS = new Set([
  "ai",
  "api",
  "cms",
  "csv",
  "html",
  "icp",
  "json",
  "pdf",
  "url",
  "xml",
]);

/** Is this segment the packaging word rather than a word of the kind? */
function isPackagingWord(segment: string): boolean {
  return segment === "artifact" || segment === "artifacts";
}

export function extensionDisplayName(extension: string): string {
  const afterScope = extension.includes("/")
    ? extension.slice(extension.indexOf("/") + 1)
    : extension;
  const base = afterScope.split(":")[0] ?? afterScope;
  const segments = base
    .split("-")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  // Only while a word is left to name the kind: a package whose whole name IS
  // the packaging word still has to read as something.
  while (segments.length > 1 && isPackagingWord(segments[segments.length - 1]!)) {
    segments.pop();
  }
  if (segments.length === 0) return DEFAULT_ARTIFACT_KIND_LABEL;
  const words = segments.map((segment) =>
    KIND_INITIALISMS.has(segment) ? segment.toUpperCase() : segment,
  );
  const first = words[0]!;
  return [
    KIND_INITIALISMS.has(segments[0]!) ? first : first.charAt(0).toUpperCase() + first.slice(1),
    ...words.slice(1),
  ].join(" ");
}

/** What the floor's chip reads where a row has no defining extension — the
 *  same words the library row draws for the same row. */
export const DEFAULT_ARTIFACT_KIND_LABEL = "Default artifact";
