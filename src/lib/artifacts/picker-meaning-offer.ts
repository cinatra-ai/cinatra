// ---------------------------------------------------------------------------
// The type picker's DERIVED MEANING, narrowed to what the picker offers
// (spec `specs/app-artifacts.html` §VI.1 "Derived meaning & suggestion chips",
// cinatra#3319).
//
// The detail read's ONE presentation reading
// (`readArtifactForDetail({ withMeaningOffer: true })` and its deferred
// `readPresentation()`, through `resolveArtifactPresentationReading`) answers
// which matcher draft auto-surfaced (at or above its pack's threshold) and
// which drafts stay suggestions. The picker can only pre-select, or confirm as a
// chip, a meaning it OFFERS. The drawing admits only the installed types whose
// `accepts` include the file's detected MIME, and the candidate list also keeps
// every type the actor may not use off it, and the row's own base type unless
// the row's reading presents exactly that extension (as its pre-selection or as
// a suggestion); the confirmation gate (`assertUploadMeaning`) refuses any
// extension outside that list. So this PURE step keeps exactly the parts of the
// reading that name an offered extension and drops the rest, and labels each
// chip the way the drawing does ("Pricing sheet · Sales" followed by its
// confidence).
//
// PURE — no React, no database, no server-only import.
// ---------------------------------------------------------------------------

import type { InstalledMeaningType } from "./installed-type-picker";

/** One suggestion chip the picker draws. */
export type PickerMeaningSuggestion = {
  /** The extension a confirmation asserts as a user-sourced meaning. */
  extension: string;
  /** The offered type's display name and pack label, as the drawing writes it. */
  label: string;
  /** The draft's confidence in [0,1], or null when the draft carries none. */
  confidence: number | null;
};

/** What the picker opens with. */
export type PickerMeaningOffer = {
  /** The offered extension the picker opens pre-selected on, else null. */
  preselect: string | null;
  /** The chips, in the reading's order, each naming an offered extension. */
  suggestions: PickerMeaningSuggestion[];
};

export function narrowMeaningOfferToOffered(
  offer: {
    preselect: string | null;
    suggestions: ReadonlyArray<{ extension: string; confidence: number | null }>;
  },
  types: readonly InstalledMeaningType[],
): PickerMeaningOffer {
  const byExtension = new Map<string, InstalledMeaningType>();
  for (const t of types) if (!byExtension.has(t.extension)) byExtension.set(t.extension, t);
  const preselect =
    offer.preselect !== null && byExtension.has(offer.preselect) ? offer.preselect : null;
  const seen = new Set<string>();
  const suggestions: PickerMeaningSuggestion[] = [];
  for (const s of offer.suggestions) {
    if (s.extension === preselect || seen.has(s.extension)) continue;
    const t = byExtension.get(s.extension);
    if (!t) continue;
    seen.add(s.extension);
    suggestions.push({
      extension: s.extension,
      label: `${t.displayName} · ${t.extensionLabel}`,
      confidence: s.confidence,
    });
  }
  return { preselect, suggestions };
}
