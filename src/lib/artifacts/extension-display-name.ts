/**
 * THE ONE PRETTIFIER for an extension package id, as a leaf.
 *
 * `@cinatra-ai/prospect-lists:list` → "Prospect Lists".
 *
 * It was written inside the library surface, which is where it is drawn as the
 * row's claim chip. Wave 3's fix leg draws the SAME label beside the artifact
 * page's title — the ratified drawing puts the kind beside the title on the
 * artifact's own page — and the two labels have to be one label, not two that
 * agree today. The library keeps naming it at its call site (its own surface
 * conformance test reads that call), and re-exports it from here so nothing
 * imports a server-only surface module to read a string.
 */
export function extensionDisplayName(extension: string): string {
  const afterScope = extension.includes("/")
    ? extension.slice(extension.indexOf("/") + 1)
    : extension;
  const base = afterScope.split(":")[0] ?? afterScope;
  return base
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** What the floor's chip reads where a row has no defining extension — the
 *  same words the library row draws for the same row. */
export const DEFAULT_ARTIFACT_KIND_LABEL = "Default artifact";
