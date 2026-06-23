"use client";
/**
 * DcModalA11yScope adapts drizzle-cube modals to the app shell.
 *
 * drizzle-cube/client ships a hand-rolled `<Modal>` component
 * (used internally by `<PortletAnalysisModal>`, `<DashboardEditModal>`,
 * `<FieldSearchModal>`, `<ConfirmModal>` etc.) that does NOT use Radix
 * `<FocusScope>` — tab focus escapes when an edit modal is open.
 *
 * We can't fix this inside drizzle-cube — DC's internal modal chunks
 * pull `Modal` from a private chunk, not the public named export, so
 * a Turbopack alias would not reach them.
 *
 * Approach:
 *
 * - Subscribe to DC's modal-state via `useDashboardStore`, computing
 *   `isAnyModalOpen` from the FOUR relevant flags
 *   (`isPortletModalOpen`, `isFilterConfigModalOpen`, `isTextModalOpen`,
 *   `deleteConfirmPortletId !== null` — the delete-confirm modal also
 *   bypasses FocusScope and must be included).
 *
 * - Wrap children in Radix `<FocusScope trapped={isAnyModalOpen}>`.
 *   `loop` is also gated on `isAnyModalOpen` so keydown handling is
 *   inert when no modal is open. We prevent mount/unmount auto-focus
 *   side effects unconditionally — Radix would otherwise grab focus
 *   when our component mounts.
 *
 * - While trapped, find the first `[role="dialog"][aria-modal="true"]`
 *   in the document via a `MutationObserver` watching `document.body`
 *   subtree. As the dialog DOM appears, mounts, swaps, or unmounts,
 *   we re-apply the inert pass to the new ancestor chain.
 *
 * - `inertSiblingsAlongAncestorChain` (in `dc-modal-a11y-helpers.ts`)
 *   walks from the dialog UP and inerts every HTMLElement sibling at
 *   every level. This prevents focus from reaching dashboard controls
 *   inside the FocusScope container — Radix only constrains focus to
 *   its container, not to the dialog specifically.
 *
 * - Bind ONE document-level Escape handler while any modal is open
 *   (`useDcModalEscapeToClose`) so ESC closes EVERY dashboard modal
 *   consistently. DC's modals disagree here: the three rendered through
 *   DC's shared `<Modal>` close on ESC, but the hand-rolled
 *   `TextPortletModal` ("Add text") does not — cinatra#438. The matching
 *   backdrop-token normalization (TextPortletModal paints `bg-black/50`
 *   instead of `var(--dc-overlay)`) lives in `dashboard-theme.css`.
 */
import { useEffect, useMemo, useRef } from "react";
import { FocusScope } from "@radix-ui/react-focus-scope";
import { useDashboardStore, type DashboardStore } from "drizzle-cube/client";

import {
  inertSiblingsAlongAncestorChain,
  resolveDcModalEscapeClose,
  type DcModalEscapeState,
} from "./dc-modal-a11y-helpers";

const DASHBOARD_MODAL_OPEN_ATTR = "data-cinatra-dashboard-modal-open";
const DASHBOARD_MODAL_TOP_VAR = "--cinatra-dashboard-modal-top";
const DASHBOARD_MODAL_RIGHT_VAR = "--cinatra-dashboard-modal-right";
const DASHBOARD_MODAL_BOTTOM_VAR = "--cinatra-dashboard-modal-bottom";
const DASHBOARD_MODAL_LEFT_VAR = "--cinatra-dashboard-modal-left";

/**
 * Selector returning true when ANY DC modal is open. Covers the four
 * DC modal flags. Stable identity so `useDashboardStore` doesn't
 * re-subscribe on every render.
 */
function selectIsAnyModalOpen(state: DashboardStore): boolean {
  return (
    state.isPortletModalOpen ||
    state.isFilterConfigModalOpen ||
    state.isTextModalOpen ||
    state.deleteConfirmPortletId !== null
  );
}

// Per-field selectors for the ESC resolver. Each returns a STABLE value
// (a primitive flag or a stable Zustand action identity), so the matching
// `useDashboardStore` call re-renders only when that field actually
// changes — never on a fresh object every render (which would loop). The
// flags + actions are recombined into `DcModalEscapeState` via `useMemo`
// in the component.
const selectIsPortletModalOpen = (s: DashboardStore) => s.isPortletModalOpen;
const selectIsTextModalOpen = (s: DashboardStore) => s.isTextModalOpen;
const selectIsFilterConfigModalOpen = (s: DashboardStore) =>
  s.isFilterConfigModalOpen;
const selectDeleteConfirmPortletId = (s: DashboardStore) =>
  s.deleteConfirmPortletId;
const selectClosePortletModal = (s: DashboardStore) => s.closePortletModal;
const selectCloseTextModal = (s: DashboardStore) => s.closeTextModal;
const selectCloseFilterConfigModal = (s: DashboardStore) =>
  s.closeFilterConfigModal;
const selectCloseDeleteConfirm = (s: DashboardStore) => s.closeDeleteConfirm;

function clearDashboardModalBounds(body: HTMLElement): void {
  body.removeAttribute(DASHBOARD_MODAL_OPEN_ATTR);
  body.style.removeProperty(DASHBOARD_MODAL_TOP_VAR);
  body.style.removeProperty(DASHBOARD_MODAL_RIGHT_VAR);
  body.style.removeProperty(DASHBOARD_MODAL_BOTTOM_VAR);
  body.style.removeProperty(DASHBOARD_MODAL_LEFT_VAR);
}

function applyDashboardModalBounds(body: HTMLElement): void {
  const inset = document.querySelector<HTMLElement>(
    '[data-slot="sidebar-inset"]',
  );
  const insetRect = inset?.getBoundingClientRect();
  const header = inset?.querySelector<HTMLElement>("header");
  const headerRect = header?.getBoundingClientRect();

  const left = Math.max(0, Math.round(insetRect?.left ?? 0));
  const right = Math.max(
    0,
    Math.round(window.innerWidth - (insetRect?.right ?? window.innerWidth)),
  );
  const top = Math.max(
    0,
    Math.round(headerRect?.bottom ?? insetRect?.top ?? 0),
  );

  body.setAttribute(DASHBOARD_MODAL_OPEN_ATTR, "true");
  body.style.setProperty(DASHBOARD_MODAL_TOP_VAR, `${top}px`);
  body.style.setProperty(DASHBOARD_MODAL_RIGHT_VAR, `${right}px`);
  body.style.setProperty(DASHBOARD_MODAL_BOTTOM_VAR, "0px");
  body.style.setProperty(DASHBOARD_MODAL_LEFT_VAR, `${left}px`);
}

/**
 * DC modals use fixed full-viewport overlays. In Cinatra, the visible app
 * chrome (sidebar + sticky header) sits above that overlay, so the modal
 * looks centered in the browser instead of the usable content pane. While a
 * dashboard modal is open, expose the current content bounds as body-level
 * CSS variables consumed by dashboard-theme.css.
 */
function useDashboardModalBounds(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (typeof document === "undefined") return;
    const body = document.body;
    if (!body) return;

    let frame = 0;
    const scheduleApply = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        applyDashboardModalBounds(body);
      });
    };

    applyDashboardModalBounds(body);
    window.addEventListener("resize", scheduleApply);
    window.addEventListener("orientationchange", scheduleApply);

    const sidebarInset = document.querySelector<HTMLElement>(
      '[data-slot="sidebar-inset"]',
    );
    const sidebarWrapper = document.querySelector<HTMLElement>(
      '[data-slot="sidebar-wrapper"]',
    );
    const header = sidebarInset?.querySelector<HTMLElement>("header");

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(scheduleApply)
        : null;
    if (sidebarInset) resizeObserver?.observe(sidebarInset);
    if (header) resizeObserver?.observe(header);

    const mutationObserver = new MutationObserver(scheduleApply);
    if (sidebarWrapper) {
      mutationObserver.observe(sidebarWrapper, {
        attributes: true,
        subtree: true,
        attributeFilter: ["class", "style", "data-state", "data-collapsible"],
      });
    }

    return () => {
      window.removeEventListener("resize", scheduleApply);
      window.removeEventListener("orientationchange", scheduleApply);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
      clearDashboardModalBounds(body);
    };
  }, [active]);
}

/**
 * React hook: while `trapped` is true, observes `document.body` for
 * any `[role="dialog"][aria-modal="true"]` node and inerts every
 * sibling along its ancestor chain up to body. Re-applies when DC
 * swaps the active dialog (true→true transitions across DC modals).
 *
 * Uses MutationObserver instead of RAF polling so we react to slow
 * mounts and dialog swaps without an arbitrary timeout.
 */
function useInertSiblingsAlongActiveDialog(trapped: boolean): void {
  // Restore-fn ref so cleanup can run synchronously inside the
  // mutation handler when we replace the active dialog node.
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!trapped) return;
    if (typeof document === "undefined") return;
    const body = document.body;
    if (!body) return;

    let activeDialog: HTMLElement | null = null;

    function apply(): void {
      const next = document.querySelector<HTMLElement>(
        '[role="dialog"][aria-modal="true"]',
      );
      if (next === activeDialog) return; // unchanged
      // Restore the previous pass before starting a new one.
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      activeDialog = next;
      if (next) {
        cleanupRef.current = inertSiblingsAlongAncestorChain(body, next);
      }
    }

    apply();
    const observer = new MutationObserver(() => {
      apply();
    });
    observer.observe(body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      activeDialog = null;
    };
  }, [trapped]);
}

/**
 * React hook: binds ONE document-level bubble-phase `keydown` listener
 * while a DC dashboard modal is open, and routes Escape to the close
 * action of whichever modal is open (via `resolveDcModalEscapeClose`).
 *
 * Why this is needed: DC `0.5.7`'s modals disagree on ESC. The three that
 * render through DC's shared `<Modal>` already close on ESC, but
 * `TextPortletModal` ("Add text") hand-rolls its own overlay with NO key
 * handling — so ESC behaviour is inconsistent (cinatra#438). We can't
 * reach DC's private modal chunks, so we standardize ESC at this seam.
 *
 * BUBBLE phase (NOT capture) is deliberate: nested editors inside a modal
 * (e.g. the analysis-builder field search) must get first crack at ESC. A
 * deeper handler that `stopPropagation()`s prevents the event from ever
 * reaching `document`, and one that `preventDefault()`s is observed by our
 * `event.defaultPrevented` guard — both only work if we listen AFTER the
 * event has descended, i.e. on the bubble phase. A capture-phase listener
 * would fire first and close the dashboard modal out from under the editor.
 *
 * Idempotence: DC's own `<Modal>` also binds an ESC listener on `document`
 * (bubble), so for the three Modal-backed dialogs both handlers run and
 * call the same close action. Calling a close action whose modal is
 * already closed is a harmless no-op, so the redundant close is safe. We
 * never `preventDefault`/`stopPropagation`, so we don't interfere with
 * DC's handler or anyone else's. `state` is read from a ref so the
 * listener is bound once per open-cycle yet always sees the current flags.
 */
function useDcModalEscapeToClose(state: DcModalEscapeState): void {
  const active =
    state.isPortletModalOpen ||
    state.isTextModalOpen ||
    state.isFilterConfigModalOpen ||
    state.deleteConfirmPortletId !== null;

  // Keep the latest state in a ref so the keydown listener — bound once
  // per open-cycle — always reads the current flags/actions without
  // re-binding on every render. The ref is written in an effect (never
  // during render) to satisfy React's rules-of-refs.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  useEffect(() => {
    if (!active) return;
    if (typeof document === "undefined") return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const close = resolveDcModalEscapeClose(stateRef.current);
      if (close) close();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active]);
}

export type DcModalA11yScopeProps = {
  readonly children: React.ReactNode;
};

/**
 * Wraps children in a Radix `<FocusScope>` whose trap + loop turn on
 * only when a DC modal is open. While trapped, observes the body
 * subtree and inerts every sibling along the active dialog's ancestor
 * chain — so background page chrome AND background dashboard grid
 * controls become uninteractive in tandem.
 *
 * Mount this INSIDE `<DashboardProvider>` (drizzle-cube `0.5.7` creates
 * a per-instance store there, so `useDashboardStore` must resolve THAT
 * store to see the modal flags) and AROUND the composable pieces (so the
 * FocusScope contains the inline-rendered modal subtree). See
 * `composed-dashboard.tsx`.
 */
export function DcModalA11yScope({ children }: DcModalA11yScopeProps) {
  const isAnyModalOpen = useDashboardStore(selectIsAnyModalOpen);

  // Each selector returns a stable value, so these subscriptions don't
  // loop; recombine into the resolver's input shape.
  const isPortletModalOpen = useDashboardStore(selectIsPortletModalOpen);
  const isTextModalOpen = useDashboardStore(selectIsTextModalOpen);
  const isFilterConfigModalOpen = useDashboardStore(
    selectIsFilterConfigModalOpen,
  );
  const deleteConfirmPortletId = useDashboardStore(
    selectDeleteConfirmPortletId,
  );
  const closePortletModal = useDashboardStore(selectClosePortletModal);
  const closeTextModal = useDashboardStore(selectCloseTextModal);
  const closeFilterConfigModal = useDashboardStore(
    selectCloseFilterConfigModal,
  );
  const closeDeleteConfirm = useDashboardStore(selectCloseDeleteConfirm);

  const escapeState = useMemo<DcModalEscapeState>(
    () => ({
      isPortletModalOpen,
      isTextModalOpen,
      isFilterConfigModalOpen,
      deleteConfirmPortletId,
      closePortletModal,
      closeTextModal,
      closeFilterConfigModal,
      closeDeleteConfirm,
    }),
    [
      isPortletModalOpen,
      isTextModalOpen,
      isFilterConfigModalOpen,
      deleteConfirmPortletId,
      closePortletModal,
      closeTextModal,
      closeFilterConfigModal,
      closeDeleteConfirm,
    ],
  );

  useDashboardModalBounds(isAnyModalOpen);
  useInertSiblingsAlongActiveDialog(isAnyModalOpen);
  // Uniform ESC-to-close across all four DC modals (cinatra#438): the
  // hand-rolled TextPortletModal has no ESC handler of its own.
  useDcModalEscapeToClose(escapeState);

  // Radix `<FocusScope>` is NOT a no-op when trapped=false — it still
  // runs mount autofocus + `loop` keydown handling. Gate `loop` on
  // `isAnyModalOpen` so keydown is inert when no modal is open, and
  // prevent both auto-focus events unconditionally so mounting/unmounting
  // this wrapper doesn't steal focus from the surrounding app shell.
  const preventAutoFocus = useMemo(
    () => (e: Event) => e.preventDefault(),
    [],
  );

  return (
    <FocusScope
      trapped={isAnyModalOpen}
      loop={isAnyModalOpen}
      onMountAutoFocus={preventAutoFocus}
      onUnmountAutoFocus={preventAutoFocus}
    >
      {children}
    </FocusScope>
  );
}
