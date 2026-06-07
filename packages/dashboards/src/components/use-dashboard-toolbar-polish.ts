"use client";
import { useEffect, type RefObject } from "react";

/**
 * Owner-overridable text content for the dashboard toolbar Edit/Save button.
 *
 * drizzle-cube's bundled `<DashboardGrid>` toolbar renders a button whose
 * label flips between the i18n keys `dashboard.edit` (view mode) and
 * `dashboard.finishEditing` (edit mode). The en-GB locale resolves these
 * to "Edit" and "Finish Editing".
 *
 * Cinatra owner doctrine (2026-05-26) revises the labels to "Edit dashboard"
 * and "Save dashboard". The upstream library does not export its
 * `I18nProvider` from a public entrypoint, so we cannot inject overrides
 * through the documented seam. Instead, a scoped `MutationObserver` inside
 * the Cinatra dashboards shell catches DC's button as it lands and rewrites
 * its trailing text node.
 *
 * Match is exact-string against DC's en-GB labels. If DC ever ships a new
 * locale string the polish degrades to a no-op — the upstream label still
 * renders unchanged, no harm done.
 */
const LABEL_MAP: Readonly<Record<string, string>> = {
  Edit: "Edit dashboard",
  "Finish Editing": "Save dashboard",
};

/**
 * Set of label values the toolbar polish already applied. Used to keep the
 * `data-cinatra-save-dashboard` attribute pointing at whichever button is
 * currently rendered (view-mode and edit-mode mount different DOM nodes).
 */
const POLISHED_LABELS = new Set(Object.values(LABEL_MAP));

/**
 * Replace the trailing text node of `btn` with `newLabel`. drizzle-cube
 * emits each button as `<button><svg/>LABEL_TEXT</button>` — children are
 * an icon element followed by a single text node. Iterate from the end so
 * a future DC change that introduces an extra sibling does not relabel the
 * wrong node. No-op when the text node is already correct (keeps the
 * MutationObserver idempotent without needing a `characterData` subscription).
 */
function relabelTrailingText(btn: HTMLButtonElement, newLabel: string): boolean {
  const childNodes = Array.from(btn.childNodes);
  for (let i = childNodes.length - 1; i >= 0; i -= 1) {
    const node = childNodes[i];
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
      if (node.textContent.trim() === newLabel) return false;
      node.textContent = newLabel;
      return true;
    }
  }
  return false;
}

/**
 * Route-scoped primary action buttons injected at the LEFT of each DC
 * dashboard toolbar. The owner asked for "Run agent" + "Create agent" on
 * `/agents` and "New project" on `/projects` — surfaced inside the DC
 * toolbar (where "Edit dashboard" lives), NOT in the PageHeader actions
 * slot.
 *
 * The injection is:
 *   - CSS + DOM-tagging only (no DC-node reparenting),
 *   - route-scoped via the shell's `data-cinatra-page-anchor` attribute
 *     (no parallel observer or selector pattern per surface),
 *   - idempotent (the polish hook re-runs on every DC re-render and the
 *     `[data-cinatra-page-action]` tag dedupes existing injections).
 */
type PageActionDescriptor = {
  /** Stable id used by the `[data-cinatra-page-action]` dedupe + CSS hook. */
  id: string;
  /** Plain anchor — works under CSP, preserves middle-click + right-click. */
  href: string;
  label: string;
};

const PAGE_ACTIONS: Readonly<Record<string, readonly PageActionDescriptor[]>> = {
  agents: [
    { id: "run-agent", href: "/agents/run", label: "Run agent" },
    { id: "create-agent", href: "/chat?mode=create-agent", label: "Create agent" },
  ],
  projects: [
    { id: "new-project", href: "/projects/new", label: "New project" },
  ],
  teams: [
    { id: "new-team", href: "/teams/new", label: "New team" },
  ],
};

/** Locate the shell root that owns this toolbar so we can read its
 *  `data-cinatra-page-anchor` attribute. The shell is always an ancestor of
 *  the DC toolbar — `.dashboard-grid-container` is a descendant of the shell
 *  div in `DashboardsClientShell`. */
function findShellAnchor(el: Element): string | null {
  const shell = el.closest<HTMLElement>("[data-cinatra-dashboard-shell]");
  return shell?.getAttribute("data-cinatra-page-anchor") ?? null;
}

/** Build the action anchor as a pure DOM element so React's render pass
 *  never owns or re-allocates it. Tagged with
 *  `data-cinatra-page-action="<id>"` so the polish observer's idempotency
 *  check finds an existing injection and skips. */
function buildActionAnchor(action: PageActionDescriptor): HTMLAnchorElement {
  const a = document.createElement("a");
  a.setAttribute("data-cinatra-page-action", action.id);
  a.href = action.href;
  a.textContent = action.label;
  // role + tabindex are implicit on <a href>; aria-label fallback covers
  // assistive-tech that strips text content during reflow.
  a.setAttribute("aria-label", action.label);
  return a;
}

function injectPageActions(toolbar: HTMLElement): void {
  const anchor = findShellAnchor(toolbar);
  if (!anchor) return;
  const actions = PAGE_ACTIONS[anchor];
  if (!actions) return;
  // Insert in reverse so each `insertBefore(toolbar.firstChild)` puts the
  // result in declared order. The dedupe check is the existing
  // `[data-cinatra-page-action]` tag.
  //
  // The scoped CSS rule that hides the SSR PageHeader.actions fallback
  // keys on the LIVE presence of an injected `[data-cinatra-page-action]`
  // anchor under the matching shell (`:has(...)` in `dashboard-theme.css`),
  // NOT on a persistent body attribute — that way an SPA navigation that
  // unmounts the shell (or a DC mount failure that prevents injection)
  // immediately re-exposes the fallback. No state to clear on teardown.
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    const action = actions[i];
    if (toolbar.querySelector(`:scope > [data-cinatra-page-action="${action.id}"]`)) {
      continue;
    }
    toolbar.insertBefore(buildActionAnchor(action), toolbar.firstChild);
  }
}

/**
 * Walk every DC toolbar inside `root` and polish each Edit/Save button:
 * relabel the visible text and tag the button with
 * `data-cinatra-save-dashboard` so scoped CSS can right-anchor it. Also
 * inject route-scoped primary action anchors at the left of the
 * toolbar based on the shell's `data-cinatra-page-anchor` attribute.
 *
 * Selector: DC's toolbar root is the first `> .dc:sticky` flex child of the
 * `.dashboard-grid-container` wrapper it renders.
 *
 * Exported for the jsdom unit test.
 */
export function polishDashboardToolbarsIn(root: ParentNode): void {
  // Tailwind `dc:sticky` writes the literal class name `dc:sticky` which
  // requires the colon to be escaped in CSS selectors.
  const toolbars = root.querySelectorAll<HTMLElement>(
    ".dashboard-grid-container > .dc\\:sticky",
  );
  toolbars.forEach((tb) => {
    // Tag the toolbar root so scoped CSS in `dashboard-theme.css` has a
    // single semantic hook instead of repeating the DC class signature.
    if (!tb.hasAttribute("data-cinatra-dc-toolbar")) {
      tb.setAttribute("data-cinatra-dc-toolbar", "true");
      tb.setAttribute("role", "toolbar");
      if (!tb.hasAttribute("aria-label")) {
        tb.setAttribute("aria-label", "Dashboard");
      }
    }
    injectPageActions(tb);
    tb.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
      const raw = btn.textContent?.trim() ?? "";
      if (LABEL_MAP[raw]) {
        relabelTrailingText(btn, LABEL_MAP[raw]);
        // Tag — CSS uses this to apply margin-left:auto + order:100.
        btn.setAttribute("data-cinatra-save-dashboard", "true");
        return;
      }
      // Already-polished case: an already-relabeled button still needs the
      // tag if it was emitted by a fresh DC render that lost the attribute.
      if (POLISHED_LABELS.has(raw) && !btn.hasAttribute("data-cinatra-save-dashboard")) {
        btn.setAttribute("data-cinatra-save-dashboard", "true");
      }
    });
  });
}

/**
 * React hook: install a single `MutationObserver` on `shellRef` that polishes
 * every DC toolbar Edit/Save button on mount and on any DC re-render. Used
 * by `DashboardsClientShell` (one observer per dashboard mount).
 *
 * The observer ignores `characterData` changes so the polish itself (which
 * only mutates text-node content) does NOT re-trigger the observer.
 * `childList: true, subtree: true` covers the DC re-renders that swap the
 * toolbar between view-mode and edit-mode (different button DOM nodes).
 */
export function useDashboardToolbarPolish(
  shellRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const root = shellRef.current;
    if (!root) return;
    polishDashboardToolbarsIn(root);
    const obs = new MutationObserver(() => polishDashboardToolbarsIn(root));
    obs.observe(root, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [shellRef]);
}
