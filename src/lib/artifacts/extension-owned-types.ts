// ---------------------------------------------------------------------------
// THE TYPES AN EXTENSION OWNS — registered OR claimed (cinatra#3033).
//
// The §VI.1 Confirm road asks which artifact type is an extension's own. A pack
// may own its type only through a cross-namespace claim over a type the HOST
// registers without provenance (`@cinatra-ai/linkedin:post-draft`, claimed by
// `@cinatra-ai/linkedin-artifacts`), so the answer is the ids the package
// registered plus the ids it claimed that resolve and carry NO registering
// package. A claim over another package's registered type is a display
// registration and never ownership.
//
// PURE — no registry, no fs, no DB: the caller hands in the registry readings.
// ---------------------------------------------------------------------------

/** One claimed type id, as the registries answer for it. */
export type ExtensionTypeCandidate = {
  typeId: string;
  /** The package that REGISTERED it, or null for a host/built-in registration. */
  registeringPackage: string | null;
  /** Does anything define this id at all? */
  resolves: boolean;
};

/** The type ids `extension` owns, out of the ids it registered and the ids it
 *  claimed. Sorted and deduplicated. */
export function selectExtensionOwnedTypeIds(input: {
  extension: string;
  registeredTypeIds: readonly string[];
  claimedTypeIds: readonly string[];
  candidates: readonly ExtensionTypeCandidate[];
}): string[] {
  const byTypeId = new Map(input.candidates.map((c) => [c.typeId, c]));
  const owned = new Set<string>(input.registeredTypeIds);
  for (const typeId of input.claimedTypeIds) {
    const c = byTypeId.get(typeId);
    if (c && c.resolves && c.registeringPackage == null) owned.add(typeId);
  }
  return [...owned].sort();
}
