/**
 * THE LIST ROW'S TYPE-SPECIFIC REGION, and the one way it may be generic.
 *
 * The uniform row shell — the cell, its size, its tint — is core chrome and
 * stays core chrome. What sits INSIDE it is the row's type speaking, and a core
 * icon standing there is core drawing the artifact. So the rule the ownership
 * boundary produces for this region is: an extension or base `listRow` display
 * covers it, or a generic glyph stands there under an exception that is
 * RECORDED — named, reasoned and readable — rather than under a silent default.
 *
 * This module is that record, and the predicate a gate reads it through. Pure:
 * no React and no registry, so the audit can enumerate the fleet against it.
 */

/**
 * THE RECORDED EXCEPTION. No artifact pack in the pinned fleet ships a `listRow`
 * display today: the slot exists in the manifest contract and the host resolves
 * it, and no pack has filled it. Until a pack does, every claimed row's glyph
 * region is the host's tier glyph, and that is recorded here rather than left to
 * be discovered in the component.
 *
 * The exception is deliberately written as a WHOLE-FLEET one and not as a list
 * of type ids: a list would go stale silently every time the fleet gains a type,
 * and a stale list reads as coverage. When the first pack ships a `listRow`
 * display, this record narrows to the types still uncovered, and the gate that
 * reads it starts holding the rest to the display.
 */
export const GENERIC_ROW_GLYPH_EXCEPTION = Object.freeze({
  appliesToEveryInstalledType: true,
  reason:
    "No artifact pack in the pinned fleet ships a `listRow` display; the host's tier glyph stands in that region until one does.",
} as const);

/** How one row's type-specific glyph region is covered. */
export type ListRowGlyphCoverage = "extension" | "recorded-exception" | "uncovered";

/**
 * Answer how a row's glyph region is covered. `extension` when the row's winner
 * ships a `listRow` display this build can mount; `recorded-exception` when the
 * exception above admits the generic glyph; `uncovered` otherwise — the state
 * the gate refuses, and the state that means core is drawing a type's glyph
 * with nothing recorded to say why.
 */
export function listRowGlyphCoverage(input: {
  objectType: string;
  hasMountableListRowDisplay: boolean;
}): ListRowGlyphCoverage {
  if (input.hasMountableListRowDisplay) return "extension";
  if (GENERIC_ROW_GLYPH_EXCEPTION.appliesToEveryInstalledType) return "recorded-exception";
  return "uncovered";
}
