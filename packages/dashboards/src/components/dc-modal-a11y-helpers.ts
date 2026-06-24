/**
 * Pure DOM helpers used by `DcModalA11yScope`.
 *
 * Kept in a SEPARATE module from `dc-modal-a11y-scope.tsx` so the test
 * suite can vitest-mount these in JSDOM without dragging in
 * drizzle-cube/client, the dashboard store, or React.
 */

/**
 * The four drizzle-cube dashboard-modal "open" flags plus the matching
 * close action for each, as a flat snapshot taken from the dashboard
 * store. Kept structural (not the `DashboardStore` type) so this module
 * stays free of any `drizzle-cube/client` import and can be unit-tested
 * in JSDOM in isolation — see `dc-modal-a11y-scope.test.ts`.
 */
export interface DcModalEscapeState {
  readonly isPortletModalOpen: boolean;
  readonly isTextModalOpen: boolean;
  readonly isFilterConfigModalOpen: boolean;
  readonly deleteConfirmPortletId: string | null;
  readonly closePortletModal: () => void;
  readonly closeTextModal: () => void;
  readonly closeFilterConfigModal: () => void;
  readonly closeDeleteConfirm: () => void;
}

/**
 * Returns the close action for the single open drizzle-cube dashboard
 * modal, or `null` when none is open.
 *
 * drizzle-cube `0.5.7`'s modals are mutually exclusive — each open action
 * is gated on the dashboard being idle — so at most one flag is ever
 * truthy. We still pick deterministically (portlet → text → filter →
 * delete) so a hypothetical double-open can never leave ESC inert.
 *
 * This exists because the DC modals do NOT agree on ESC-to-close:
 * `PortletAnalysisModal`/`ConfirmModal`/`PortletFilterConfigModal` go
 * through DC's shared `<Modal>` (which binds a `keydown` ESC listener),
 * but `TextPortletModal` hand-rolls its own overlay with NO key handling
 * — so "Add portlet" closes on ESC while "Add text" does not (cinatra
 * #438). We can't patch DC's private modal chunks, so `DcModalA11yScope`
 * binds ONE document-level ESC handler that routes through this resolver,
 * giving uniform ESC-to-close across all four modals.
 */
export function resolveDcModalEscapeClose(
  state: DcModalEscapeState,
): (() => void) | null {
  if (state.isPortletModalOpen) return state.closePortletModal;
  if (state.isTextModalOpen) return state.closeTextModal;
  if (state.isFilterConfigModalOpen) return state.closeFilterConfigModal;
  if (state.deleteConfirmPortletId !== null) return state.closeDeleteConfirm;
  return null;
}

/**
 * Walks from `dialog` UP to (and including a stop at) `root`, and at
 * each ancestor level inerts every HTMLElement sibling. Returns a
 * cleanup fn that restores the original `inert` state on every
 * element we touched. Elements that already had `inert` keep it.
 *
 * The helper must cover deep dialogs, for example:
 *   `body > dashboard-shell > grid > dialog`.
 * Inerting only direct children of `root` can leave an ancestor shell
 * interactive, which lets focus still reach grid/edit-toolbar controls
 * inside the FocusScope container. Walking the FULL ancestor chain and
 * inerting every SIBLING at every level keeps only the dialog's direct
 * path interactive.
 *
 * Returns a no-op cleanup if the dialog is detached (not under root).
 */
export function inertSiblingsAlongAncestorChain(
  root: HTMLElement,
  dialog: HTMLElement | null,
): () => void {
  if (!dialog) return () => undefined;
  const restorations: Array<() => void> = [];

  let cursor: HTMLElement = dialog;
  while (cursor !== root && cursor.parentElement !== null) {
    const parent: HTMLElement = cursor.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === cursor) continue;
      if (!(sibling instanceof HTMLElement)) continue;
      const had = sibling.hasAttribute("inert");
      if (!had) sibling.setAttribute("inert", "");
      restorations.push(() => {
        if (!had) sibling.removeAttribute("inert");
      });
    }
    cursor = parent;
    if (cursor === root) break;
  }

  return () => {
    for (const r of restorations) r();
  };
}
