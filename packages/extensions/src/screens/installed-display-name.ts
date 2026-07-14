/**
 * Display-name resolution for the Installed extensions page (cinatra#1570).
 *
 * §VI renders the card's human title. The hydration chain, highest priority
 * first:
 *
 *   1. the per-kind NATIVE descriptor's name (`t.name` / `s.name` /
 *      `c.displayName` / `w.name`) — the running capability's own label;
 *   2. the registry catalog TITLE (the marketplace packument title) — the
 *      established source for a catalog-listed package;
 *   3. the extension's SELF-DECLARED `cinatra.displayName` (the generated
 *      static manifest's `displayName`). This tier rescues the locked/system
 *      class, which has no marketplace catalog entry AND whose artifact-kind
 *      descriptor carries no name at all — before this the row fell straight
 *      to the raw package name (the #1570 symptom: `@cinatra-ai/default-artifact`
 *      instead of "Default Artifact");
 *   4. the raw package name — a last resort, never a human title.
 *
 * The manifest tier sits BELOW the registry title deliberately: a catalog-
 * listed package keeps the title it already rendered (no behaviour change),
 * and the self-declared name only fills the gap where there was none. Blank /
 * whitespace values at any tier are treated as absent.
 */
export function resolveInstalledDisplayName(input: {
  /** Per-kind native descriptor name (null for the artifact kind). */
  nativeName: string | null | undefined;
  /** Registry catalog summary title (packument title). */
  registryTitle: string | null | undefined;
  /** `cinatra.displayName` from the generated static extension manifest. */
  manifestDisplayName: string | null | undefined;
  /** Raw package name — the guaranteed non-empty last resort. */
  packageName: string;
}): string {
  return (
    normalize(input.nativeName) ??
    normalize(input.registryTitle) ??
    normalize(input.manifestDisplayName) ??
    input.packageName
  );
}

function normalize(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
