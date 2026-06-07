"use client";

import { toast as sonnerToast, type ExternalToast } from "sonner";

/**
 * cinatraToast.
 *
 * Wraps `sonner`'s `toast` so every toast carries a Copy action and a
 * Close (X) on the right.
 *
 * Use this instead of importing `toast` directly from "sonner". Callers
 * that need a non-Copy action can override the `action` field; passing
 * `action: null` opts out of the Copy default.
 *
 * The five toast variants live as named exports — `cinatraToast.success`,
 * `cinatraToast.error`, `cinatraToast.warning`, `cinatraToast.info`, and
 * `cinatraToast.message` (default).
 */

type ToastMessage = string | React.ReactNode;

type CinatraToastOptions = ExternalToast & {
  /** Pass null to opt out of the default Copy action. */
  action?: ExternalToast["action"] | null;
  /** Text used by the Copy action; defaults to the toast message when it's a string. */
  copyText?: string;
};

function extractCopyText(message: ToastMessage, override?: string): string {
  if (override) return override;
  if (typeof message === "string") return message;
  return "";
}

function buildOptions(
  message: ToastMessage,
  options: CinatraToastOptions = {},
): ExternalToast {
  const { copyText, action, ...rest } = options;
  const text = extractCopyText(message, copyText);
  const next: ExternalToast = { ...rest };

  if (action === null) {
    // explicit opt-out — leave action undefined
  } else if (action) {
    next.action = action;
  } else if (text) {
    next.action = {
      label: "Copy",
      onClick: () => {
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          navigator.clipboard.writeText(text).catch(() => {
            // Silently swallow — clipboard access can be blocked; the
            // toast UX should not throw in that case.
          });
        }
      },
    };
  }

  // Sonner ships a built-in close button; we ensure it's always on for
  // this wrapper. Callers can still pass closeButton: false to override
  // if a specific toast (e.g. progress) needs to live until done.
  if (typeof next.closeButton === "undefined") {
    next.closeButton = true;
  }

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
// migration path: `import { toast } from "@/lib/cinatra-toast";`.
export const toast = cinatraToast;
export type { CinatraToastOptions };
