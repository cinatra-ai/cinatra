"use client";

import { createElement, type ReactNode } from "react";
import { Copy } from "lucide-react";
import { toast as sonnerToast, type ExternalToast } from "sonner";

/**
 * cinatraToast — the canonical toast wrapper.
 *
 * Wraps `sonner`'s `toast` so every toast carries a Copy action and a
 * Close (X) on the right.
 *
 * Use this instead of importing `toast` directly from "sonner" — the ESLint
 * `no-restricted-imports` sonner ban routes every toast site through this
 * wrapper (the host re-exports it from `@/lib/cinatra-toast`, and extension
 * packages import `@cinatra-ai/sdk-ui/toast`; both resolve to the single host
 * sonner instance because `sonner` is a peerDependency of sdk-ui). Callers
 * that need a non-Copy action can override the `action` field; passing
 * `action: null` opts out of the Copy default.
 *
 * The five toast variants live as named exports — `cinatraToast.success`,
 * `cinatraToast.error`, `cinatraToast.warning`, `cinatraToast.info`, and
 * `cinatraToast.message` (default).
 */

type ToastMessage = string | ReactNode;

type CinatraToastOptions = ExternalToast & {
  /** Pass null to opt out of the default Copy action. */
  action?: ExternalToast["action"] | null;
  /** Text used by the Copy action; defaults to the toast message when it's a string. */
  copyText?: string;
};

/**
 * THE DRAWING'S GHOST ICON CONTROLS (cinatra#3566).
 *
 * The components drawing's Toast / Sonner section draws BOTH right-hand controls
 * of a toast — the Copy action and the Close (X) — with one declaration,
 * `background:transparent;border:0;padding:0;cursor:pointer;color:currentColor;
 * opacity:0.55;display:inline-grid;place-items:center`, each around ONE glyph at
 * `width:13px;height:13px` on `stroke="currentColor"`: the copy glyph at
 * stroke-width 2.2, the close glyph at stroke-width 2.4.
 *
 * WHY THE TREATMENT LIVES HERE AND NOT IN A STYLESHEET. Both controls are made
 * in `buildOptions` below, and the toast library paints them itself from a
 * stylesheet it injects at run time. Those rules are UNLAYERED, and a NORMAL
 * declaration in a layer loses to an unlayered one of the same origin whatever
 * its specificity, so a plain layered utility cannot reach past them:
 *   - `[data-sonner-toast][data-styled=true] [data-button]` grounds the action
 *     button on `background: var(--normal-text)` with `color: var(--normal-bg)`,
 *     `height: 24px` and 8px of side padding — the solid labelled button;
 *   - the close control is grounded and bordered three times over, by the plain
 *     `[data-sonner-toast][data-styled=true] [data-close-button]` rule, by the
 *     dark-palette rule, and by the rich-colours per-type rule
 *     `[data-rich-colors=true][data-sonner-toast][data-type=error]
 *     [data-close-button]`, which is the most specific of those rules.
 *
 * So each control takes the drawing by the hook the library offers for it PER
 * TOAST, and by no stylesheet rule: the action button by `actionButtonStyle`, an
 * inline style that outranks every NORMAL stylesheet rule, and the close control
 * by `classNames.closeButton`, whose ground, border and ink therefore carry
 * `!important` — an important declaration outranks a normal one wherever it
 * sits, layered or not, and the library offers no inline style hook for that
 * control at all.
 *
 * THE ONE TOKEN THAT IS DELIBERATELY *NOT* IMPORTANT AND NOT INLINE IS OPACITY,
 * for both controls. The library fades a collapsed back toast by an unlayered
 * `[data-sonner-toast][data-expanded=false][data-front=false][data-styled=true]
 * > *{opacity:0}` on every DIRECT child of the toast — which both of these
 * controls are. A normal layered utility loses to that rule, so the drawing's
 * 0.55 reads at rest and the library's stacking animation still fades both
 * controls with the rest of the toast; an inline or important 0.55 would pin the
 * control visible over a faded toast. Hence `opacity-[0.55]` rides
 * `classNames.actionButton` / `classNames.closeButton` and never the inline hook.
 *
 * The drawing gives the two controls NO focus ring and NO hover reading, so
 * nothing here removes the library's focus treatment or the close control's
 * keyboard reach; only the library's hover repaint is neutralised, so a ghost
 * control stays ghost under the pointer. `cursor: pointer` is not written here
 * because the library's own rules already declare it on both controls and
 * nothing in this treatment overrides it.
 */
const GHOST_ACTION_BUTTON_STYLE: NonNullable<
  ExternalToast["actionButtonStyle"]
> = {
  background: "transparent",
  border: 0,
  padding: 0,
  height: "auto",
  color: "currentColor",
  display: "inline-grid",
  placeItems: "center",
};

/** The drawing's opacity for the Copy action — layered, see the note above. */
const GHOST_ACTION_BUTTON_CLASS = "opacity-[0.55]";

const GHOST_CLOSE_BUTTON_CLASS = [
  "bg-transparent!",
  "hover:bg-transparent!",
  "border-0!",
  "hover:border-0!",
  "text-current!",
  "opacity-[0.55]",
  "[&>svg]:size-[13px]",
  "[&>svg]:[stroke-width:2.4]",
].join(" ");

function extractCopyText(message: ToastMessage, override?: string): string {
  if (override) return override;
  if (typeof message === "string") return message;
  return "";
}

export function buildOptions(
  message: ToastMessage,
  options: CinatraToastOptions = {},
): ExternalToast {
  const { copyText, action, ...rest } = options;
  const text = extractCopyText(message, copyText);
  const next: ExternalToast = { ...rest };
  let ghostCopyAction = false;

  if (action === null) {
    // explicit opt-out — leave action undefined
  } else if (action) {
    next.action = action;
  } else if (text) {
    next.action = {
      // The drawing's clipboard mark, never the word Copy: the accessible name
      // stays the word, carried by the glyph rather than by visible text.
      label: createElement(Copy, {
        size: 13,
        strokeWidth: 2.2,
        role: "img",
        "aria-label": "Copy",
      }),
      onClick: () => {
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          navigator.clipboard.writeText(text).catch(() => {
            // Silently swallow — clipboard access can be blocked; the
            // toast UX should not throw in that case.
          });
        }
      },
    };
    // Only the DEFAULT Copy action takes the ghost treatment: the drawing gives
    // it to the Copy and Close pair and says nothing about a labelled action, so
    // a caller's own labelled action above is handed through unstyled. Anything
    // else the caller declared for that button (a margin, say) is kept; the
    // drawing's own tokens are written last so they are the ones that read.
    next.actionButtonStyle = {
      ...next.actionButtonStyle,
      ...GHOST_ACTION_BUTTON_STYLE,
    };
    ghostCopyAction = true;
  }

  // Sonner ships a built-in close button; we ensure it's always on for
  // this wrapper. Callers can still pass closeButton: false to override
  // if a specific toast (e.g. progress) needs to live until done.
  if (typeof next.closeButton === "undefined") {
    next.closeButton = true;
  }

  // The close control stays the library's OWN button — its keyboard reach and
  // its accessible name are untouched — and takes the drawing's ghost paint
  // through the one per-toast hook the library offers for it. A caller's own
  // class is kept and the ghost class appended after it, and every other
  // per-toast class the caller passed is carried through untouched.
  next.classNames = {
    ...next.classNames,
    closeButton: [next.classNames?.closeButton, GHOST_CLOSE_BUTTON_CLASS]
      .filter(Boolean)
      .join(" "),
    ...(ghostCopyAction
      ? {
          actionButton: [
            next.classNames?.actionButton,
            GHOST_ACTION_BUTTON_CLASS,
          ]
            .filter(Boolean)
            .join(" "),
        }
      : {}),
  };

  return next;
}

export const cinatraToast = Object.assign(
  function cinatraToast(message: ToastMessage, options?: CinatraToastOptions) {
    return sonnerToast(message as string, buildOptions(message, options));
  },
  {
    success(message: ToastMessage, options?: CinatraToastOptions) {
      return sonnerToast.success(message as string, buildOptions(message, options));
    },
    error(message: ToastMessage, options?: CinatraToastOptions) {
      return sonnerToast.error(message as string, buildOptions(message, options));
    },
    warning(message: ToastMessage, options?: CinatraToastOptions) {
      return sonnerToast.warning(message as string, buildOptions(message, options));
    },
    info(message: ToastMessage, options?: CinatraToastOptions) {
      return sonnerToast.info(message as string, buildOptions(message, options));
    },
    message(message: ToastMessage, options?: CinatraToastOptions) {
      return sonnerToast.message(message as string, buildOptions(message, options));
    },
    promise: sonnerToast.promise,
    loading: sonnerToast.loading,
    dismiss: sonnerToast.dismiss,
  },
);

// Re-export the canonical `toast` symbol so a single import is the
// migration path: `import { toast } from "@cinatra-ai/sdk-ui/toast";`
// (the cinatra-app host additionally re-exports this same symbol from its
// app-local lib path so in-app call sites keep one stable import). The path is
// intentionally NOT written here as a quoted `from` example: this module is
// reachable from the consumer-portable `./marketplace` entry, and the pack-smoke
// gate's import scanner would read an app-local `@/…` string in a comment as a
// real non-portable import.
export const toast = cinatraToast;
export type { CinatraToastOptions };
