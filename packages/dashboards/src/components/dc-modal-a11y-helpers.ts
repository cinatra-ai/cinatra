/**
 * Pure DOM helpers used by `DcModalA11yScope`.
 *
 * Kept in a SEPARATE module from `dc-modal-a11y-scope.tsx` so the test
 * suite can vitest-mount these in JSDOM without dragging in
 * drizzle-cube/client, the dashboard store, or React.
 */

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
