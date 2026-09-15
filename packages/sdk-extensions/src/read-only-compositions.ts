// EXTENSION-LEGAL READ-ONLY COMPOSITIONS — the promotion contract (enabler 0.11
// of `PLAN: Agents Lifecycle (C)`, cinatra#3027 / epic #3023).
//
// THE ENABLER, IN THE PLAN'S OWN WORDS: "Extension-legal read-only
// compositions: a host composition an extension display needs is promoted into
// an SDK surface an extension may depend on and admitted at the extension
// boundary, and both the host page and the extension consume the same
// composition — the read-only dashboard and single-portlet views are the first,
// wired in the sibling plan."
//
// WHAT IT FIXES, IN THE PLAN'S OWN WORDS: "an extension outside this repository
// may not import the host's compositions, so a display that needs one cannot
// render at all; and no read-only variant of such a composition exists today."
//
// WHAT THIS MODULE IS. The REGISTER of promotions: which host composition has
// been promoted, the SDK specifier and export name an extension may depend on,
// and the assertion that it is read-only. It is the admission list at the
// extension boundary, and it is a LEAF — pure data and two pure predicates, no
// React, no drizzle-cube, no host import — so an extension can consult it
// without pulling a composition it did not ask for.
//
// WHAT THIS MODULE IS NOT. It is not the compositions. Those live at the
// promoted specifier (`@cinatra-ai/sdk-dashboard/components`), which is where
// both the host page and the extension import them from — one implementation,
// which is the half of the enabler a registry alone cannot deliver.
//
// READ-ONLY IS A DECLARED PROPERTY, NOT A HOPE. A promoted composition mounts no
// mutation affordance: no toolbar with a save, no edit-mode modals, no drag
// handles. `mutationAffordances: "none"` records that, and the acceptance test
// for this enabler pins that every registered entry declares it — so promoting a
// composition that can write is a test failure, not a review miss.

/** A composition promoted out of the host into an SDK surface. */
export interface PromotedReadOnlyComposition {
  /** The stable id the boundary admits by. Never a package-internal path. */
  id: string;
  /** The SDK specifier an extension imports from. */
  specifier: string;
  /** The named export at that specifier. */
  exportName: string;
  /** The host module that used to own it, kept so the promotion is traceable
   *  and so a reviewer can check that the host now consumes the SDK surface
   *  rather than keeping a second copy. */
  promotedFrom: string;
  /** Read-only by declaration. `"none"` is the only admissible value today. */
  mutationAffordances: "none";
  /** What the composition draws, in one line. */
  summary: string;
}

/**
 * THE ADMISSION LIST. The read-only dashboard and the single-portlet view are
 * the first two, exactly as the plan names them.
 */
export const PROMOTED_READ_ONLY_COMPOSITIONS: readonly PromotedReadOnlyComposition[] =
  Object.freeze([
    Object.freeze({
      id: "read-only-dashboard",
      specifier: "@cinatra-ai/sdk-dashboard/components",
      exportName: "ReadOnlyComposedDashboard",
      promotedFrom: "@cinatra-ai/dashboards/composed-dashboard",
      mutationAffordances: "none",
      summary:
        "A dashboard's portlet grid, drawn from a configuration, with no toolbar, no modals and no edit mode.",
    }),
    Object.freeze({
      id: "read-only-single-portlet",
      specifier: "@cinatra-ai/sdk-dashboard/components",
      exportName: "ReadOnlySinglePortlet",
      promotedFrom: "@cinatra-ai/dashboards/composed-dashboard",
      mutationAffordances: "none",
      summary: "One portlet of a dashboard configuration, drawn alone and read-only.",
    }),
  ] as const);

/** Look one promotion up by its admitted id. */
export function findPromotedReadOnlyComposition(
  id: string,
): PromotedReadOnlyComposition | null {
  return PROMOTED_READ_ONLY_COMPOSITIONS.find((c) => c.id === id) ?? null;
}

/**
 * Is this (specifier, export) pair admitted at the extension boundary?
 *
 * FAIL-CLOSED and EXACT: an unpromoted export at a promoted specifier is
 * refused, and so is a promoted export name at some other specifier. A
 * composition an extension may depend on is one somebody deliberately promoted,
 * never one that happens to be reachable.
 */
export function isCompositionAdmittedForExtension(input: {
  specifier: string;
  exportName: string;
}): boolean {
  return PROMOTED_READ_ONLY_COMPOSITIONS.some(
    (c) => c.specifier === input.specifier && c.exportName === input.exportName,
  );
}
