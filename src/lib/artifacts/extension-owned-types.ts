import "server-only";

// ---------------------------------------------------------------------------
// THE TYPES AN EXTENSION OWNS — registered OR claimed (cinatra#3033, W9).
//
// Two surfaces on the §VI.1 Confirm road need one answer to "which artifact type
// is THIS extension's own?": the converging re-confirmation (is the row already
// in this extension's type?) and the typed promotion road (what is there to
// promote INTO?). Both asked `objectTypeRegistry.getTypesForPackage`, which
// answers only what a package REGISTERED.
//
// THAT IS NOT THE WHOLE OWNERSHIP. Ownership of a type id is by NAMESPACE, and a
// pack may CLAIM an id in another namespace: the claim registers the pack's
// display and never the type, and the type's single runtime registrar is
// whoever owns the namespace — for `@cinatra-ai/linkedin:post-draft` that is the
// HOST (epic #1448 principle 5), which registers without provenance. So the
// claiming pack `@cinatra-ai/linkedin-artifacts` registered nothing, owned
// nothing by this read, and the road returned "this extension declares no type
// of its own" — measured on a live boot: a person picked "Post draft" through
// the product's own Upload control, the meaning assertion landed, and the row
// stayed `@cinatra-ai/markdown-artifact:artifact`, so the LinkedIn display drew
// on no surface at all (issue #3033 acceptance item 1: "each of the four
// displays draws on the page, on the card and inside a third-party application
// at the pinned revision").
//
// A CLAIM IS ADMITTED ONLY OVER A TYPE NOTHING ELSE HAS PROVENANCE FOR. If some
// package registered the id, that package owns it and a claimant does not — the
// claim is then a display registration and nothing more. So the union is: the
// types this package registered, PLUS the types it claimed that resolve and
// carry NO registering package.
// ---------------------------------------------------------------------------

/** One candidate type, as the registries answer for it. */
export type ExtensionTypeCandidate = {
  typeId: string;
  /** The package that REGISTERED it, or null for a host/built-in registration. */
  registeringPackage: string | null;
  /** Does anything define this id at all? (`resolve` !== undefined) */
  resolves: boolean;
};

/**
 * PURE core: the type ids `extension` owns, out of the ids it registered and the
 * ids it claimed. Sorted, deduped, stable.
 */
export function selectExtensionOwnedTypeIds(input: {
  extension: string;
  registeredTypeIds: readonly string[];
  claimedTypeIds: readonly string[];
  candidates: readonly ExtensionTypeCandidate[];
}): string[] {
  const by = new Map(input.candidates.map((c) => [c.typeId, c]));
  const owned = new Set<string>(input.registeredTypeIds);
  for (const typeId of input.claimedTypeIds) {
    const c = by.get(typeId);
    // Resolvable (something defines it) AND provenance-less (nothing else owns
    // it as a package type). A claim over another PACKAGE's registered type is a
    // display registration, never ownership.
    if (c && c.resolves && c.registeringPackage == null) owned.add(typeId);
  }
  return [...owned].sort();
}
