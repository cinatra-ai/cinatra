import { GENERATED_ARTIFACT_KIND_LABELS } from "@/lib/generated/artifact-kind-labels";

// ---------------------------------------------------------------------------
// THE ONE artifact-kind label (border correction, epic cinatra#2926 / #3023).
//
// A pack's identity lives WITH the pack: `packages/sdk-extensions/src/manifest.ts`
// rules that the SDK owns no roster and that self-describing identity is
// declared, not inferred. So the name of an artifact KIND — "Archive", "Slide
// Deck", "PDF" — is READ from the pack's own `cinatra.displayName`, carried
// here by the manifest generator as the import-free
// `GENERATED_ARTIFACT_KIND_LABELS` map.
//
// The host's package-id derivation survives only as the NEVER-BLANK FLOOR for a
// pack that has declared nothing, and a floored result SAYS SO (`source:
// "floor"`) so the display map's diagnostic can name the gap instead of
// presenting a guess as a declaration. The floor is deliberately the same
// derivation the surfaces rendered before this module existed, so an undeclared
// pack keeps today's rendering exactly.
//
// This module replaces three divergent host copies of that derivation
// (`extensionDisplayName` in the library surface, `reviewTypeLabel` in the
// review surface model, `humanizeExtensionPackage` in the type-definitions
// inventory). One function means the review line and the artifact page header
// cannot name the same pack two different ways.
//
// Import-free data in, pure string out: safe in a server component, a client
// graph and a pure unit test alike.
//
// COVERAGE, stated rather than implied: the declaration road carries the
// IMAGE-BUNDLED packs the manifest generator sees. A pack installed at RUNTIME
// registers its object type through the package-store rescan, which carries no
// display name at all, so such a pack FLOORS until that road carries the
// declaration too. That is the behaviour every pack had before this module
// existed, not something introduced here, and `source: "floor"` is precisely
// the diagnostic that names the gap instead of presenting the guess as a
// declaration.
// ---------------------------------------------------------------------------

/** Where a resolved label came from — a pack DECLARATION, or the host floor. */
export type ArtifactKindLabelSource = "declared" | "floor";

export type ResolvedArtifactKindLabel = {
  /** The label to render. Never blank when the id carries anything at all. */
  label: string;
  /**
   * `"floor"` means NO pack declared this kind's name and the host derived one
   * from the package id. It is a diagnostic, not a rendering difference — the
   * surfaces draw both the same, and the companion pack repo closes the gap by
   * declaring `cinatra.displayName`.
   */
  source: ArtifactKindLabelSource;
};

/**
 * Reduce any id a surface carries — a package id (`@cinatra-ai/zip-artifact`),
 * an object-type id (`@cinatra-ai/zip-artifact:archive`) or a versioned id
 * (`@cinatra-ai/email@1.2.0`) — to the PACKAGE the declaration is keyed by.
 * One normalization, so the same pack resolves identically on every surface no
 * matter which id form that surface holds. Surrounding whitespace is dropped
 * first, so a padded id still finds the pack's declaration rather than silently
 * missing the key and flooring.
 */
export function artifactKindLabelPackageId(id: string): string {
  const trimmed = id.trim();
  const slash = trimmed.indexOf("/");
  const scope = slash >= 0 ? trimmed.slice(0, slash + 1) : "";
  const afterScope = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  const base = afterScope.split(":")[0]?.split("@")[0] ?? afterScope;
  return `${scope}${base}`;
}

/**
 * The FLOOR: the package-id derivation the host used before packs could speak.
 * Scope stripped, local/version suffix dropped, `-`/`_`/whitespace separators
 * become single spaces, each word capitalized. Falls back to the TRIMMED id
 * rather than to nothing, so any id carrying a non-whitespace character renders
 * a non-blank kind; an empty or all-whitespace id has nothing to render and
 * yields the empty string rather than a stray space.
 *
 * ONE floor out of THREE divergent copies, so the delta is stated rather than
 * claimed away. The two deleted client-surface copies (`extensionDisplayName`,
 * `reviewTypeLabel`) split on `-` only and did NOT drop a version suffix; the
 * deleted inventory copy did both. This floor keeps the strictest of the three,
 * so an undeclared pack renders exactly as before EXCEPT for two id forms on
 * those two surfaces: `@acme/thing@1.2.0` now floors to "Thing" instead of
 * "Thing@1.2.0", and `@acme/support_desk` to "Support Desk" instead of
 * "Support_desk". Both are the inventory copy's long-standing behaviour, and
 * neither renders a version string or a raw underscore at a reader.
 */
function derivedKindLabel(id: string): string {
  const trimmed = id.trim();
  const slash = trimmed.indexOf("/");
  const afterScope = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  const base = (afterScope.split(":")[0]?.split("@")[0] ?? afterScope).trim();
  const words = base.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return trimmed;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Resolve the kind label for an id, DECLARED first and floored only as a last
 * resort. The precedence is total and one-way: a declaration always wins, and
 * the host never overrules a pack's own spelling — a declared label is returned
 * unchanged apart from trimmed surrounding whitespace, even when it trips the
 * SDK's advisory shape rule (`artifactKindLabelIssues`). Closing that gap is the
 * declaring repository's own change, never a host rewrite.
 */
export function resolveArtifactKindLabel(id: string): ResolvedArtifactKindLabel {
  const declared = GENERATED_ARTIFACT_KIND_LABELS[artifactKindLabelPackageId(id)];
  if (typeof declared === "string" && declared.trim().length > 0) {
    return { label: declared.trim(), source: "declared" };
  }
  return { label: derivedKindLabel(id), source: "floor" };
}

/** The label alone — what a surface renders. */
export function artifactKindLabelFor(id: string): string {
  return resolveArtifactKindLabel(id).label;
}
