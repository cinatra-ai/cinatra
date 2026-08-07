"use client";

// ---------------------------------------------------------------------------
// CardFaceSwitcher (cinatra#2373) — in-place card body swap for the §I/§IV
// marketplace ListingCard.
//
// The card itself stays a PURE server component. This client shell holds the
// only piece of state the interaction needs — which of TWO server-rendered
// faces is showing — and mounts EXACTLY ONE of them at a time:
//
//   - idle face:    the ordinary listing card, whose install CTA is an
//                   `<InstallPanelOpenButton>` that flips the switcher;
//   - install face: the same card shell whose BODY is the shared
//                   `ExtensionInstallScopePanel`, with a close ✕ in the
//                   header band and a Cancel in the footer, both of which flip
//                   it back.
//
// WHY exactly one face: a hidden-but-mounted second face would keep a stale
// open panel (and its selection, and its ids) alive behind the card, would
// double every stable testid the conformance contract keys on, and would let
// a keyboard user tab into an invisible picker. `{open ? install : idle}` is
// the whole guarantee — there is no `hidden` face to go stale.
//
// The grid still receives ONE opaque node per extension, so the filter-only
// client grid (`extensions-marketplace-client.tsx`) is unchanged in shape; it
// UNMOUNTS a filtered-out node, which resets any open panel to idle for free.
//
// IDS: every id inside the panel derives from this switcher's `useId()`
// prefix, so N cards can hold N open panels concurrently without colliding.
//
// FOCUS: open → the panel moves focus to its first enabled control (owned by
// the panel, which knows which control that is under each availability state);
// close → the idle face remounts and focus returns to the Install CTA. The
// CTA registers itself through the context, so the restore target is always
// the freshly-mounted button, never a detached node.
// ---------------------------------------------------------------------------

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

type CardFaceContextValue = {
  /** True while the INSTALL face is the mounted one. */
  open: boolean;
  openPanel: () => void;
  closePanel: () => void;
  /** `useId()`-derived prefix — every panel-owned id hangs off this. */
  idPrefix: string;
  /** Called by the idle CTA so close can restore focus to the live node. */
  registerCta: (node: HTMLButtonElement | null) => void;
};

const CardFaceContext = createContext<CardFaceContextValue | null>(null);

export function useCardFace(): CardFaceContextValue {
  const ctx = useContext(CardFaceContext);
  if (!ctx) {
    throw new Error(
      "useCardFace must be used inside a <CardFaceSwitcher> — the install panel and its CTA only exist as faces of one.",
    );
  }
  return ctx;
}

export function CardFaceSwitcher({
  idleFace,
  installFace,
}: {
  /** Server-rendered idle card node. */
  idleFace: ReactNode;
  /** Server-rendered install-face node (card shell + panel body). */
  installFace: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const idPrefix = useId();
  const ctaRef = useRef<HTMLButtonElement | null>(null);
  // Only an explicit close restores focus — never the initial mount, and never
  // a close that happened while the card was being unmounted by the filter.
  const restoreFocusRef = useRef(false);

  const openPanel = useCallback(() => setOpen(true), []);
  const closePanel = useCallback(() => {
    restoreFocusRef.current = true;
    setOpen(false);
  }, []);
  const registerCta = useCallback((node: HTMLButtonElement | null) => {
    ctaRef.current = node;
  }, []);

  useEffect(() => {
    if (open || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    // The idle face has just remounted in this same commit, so the ref
    // callback above already points at the NEW button.
    ctaRef.current?.focus();
  }, [open]);

  return (
    <CardFaceContext.Provider
      value={{ open, openPanel, closePanel, idPrefix, registerCta }}
    >
      {open ? installFace : idleFace}
    </CardFaceContext.Provider>
  );
}

/**
 * The idle face's install CTA. Replaces the popup trigger: it opens the
 * in-card panel, so no dialog is mounted anywhere on the card path.
 *
 * `aria-expanded` (not `aria-controls`) is the honest annotation — the panel
 * does not exist in the DOM while the idle face is up, so an `aria-controls`
 * target would dangle.
 */
export function InstallPanelOpenButton({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const { open, openPanel, registerCta } = useCardFace();
  return (
    <Button
      ref={registerCta}
      type="button"
      size="sm"
      className={className}
      aria-expanded={open}
      onClick={openPanel}
      // Conformance contract (cinatra#985 testid-contract.json): the stable
      // hook the `install -> panel-open` driver clicks.
      data-testid="extension-install-panel-open"
    >
      {children}
    </Button>
  );
}

/**
 * The install face's header ✕ (design spec §I.1: "A close ✕ in the header's
 * corner does the same thing as Cancel — it returns the card to its idle
 * state, discarding the in-progress selection").
 */
export function InstallPanelCloseButton() {
  const { closePanel } = useCardFace();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={closePanel}
      aria-label="Close install panel"
      data-testid="extension-install-panel-close"
      // On the coloured banner ground: inherit the banner's fg (white) and
      // keep the hover wash subtle, matching the spec's 0.85-opacity mark.
      className="size-6 rounded-control text-current opacity-85 hover:bg-foreground/10 hover:text-current"
    >
      <X className="size-3.5" aria-hidden="true" />
    </Button>
  );
}

/** The install face's footer Cancel — identical outcome to the header ✕. */
export function InstallPanelCancelButton() {
  const { closePanel } = useCardFace();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={closePanel}
      data-testid="extension-install-panel-cancel"
    >
      Cancel
    </Button>
  );
}
