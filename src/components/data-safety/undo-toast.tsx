"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { toast } from "@/lib/cinatra-toast";
import type { MutationResult } from "@/lib/object-history";

// The data-safety "Saved … [Undo]" toast.
//
// On a successful mutation that produced a change-set, fires a toast whose
// Undo action deep-links to the change-set's restore modal
// (/data-safety/change-sets/[id]?openRestore=1). On failure, an error toast.
// On success WITHOUT a change-set id, nothing. Uses the project's
// cinatra-toast wrapper (owner-mandated; never sonner directly).
//
// App-shell-hosted: <UndoToastHost> mounts once in the app
// providers and owns the default Undo navigation, so any `showUndoToast` call
// from any client component routes through the shell host. If the host isn't
// mounted (tests, isolated renders), showUndoToast renders directly — same
// toast, just without the host's default router navigation.

export function undoDeepLink(changeSetId: string): string {
  return `/data-safety/change-sets/${changeSetId}?openRestore=1`;
}

export type UndoToastOptions = {
  /** Toast title; defaults to `Saved ${objectLabel ?? "object"}`. */
  title?: string;
  objectLabel?: string;
  /** Called when the user clicks "Undo"; receives the change-set id. */
  onUndo?: (changeSetId: string) => void;
};

// The app-shell host installs this. Until then, showUndoToast renders directly.
let appShellHandler:
  | ((result: MutationResult, opts: UndoToastOptions) => void)
  | null = null;

function renderUndoToast(result: MutationResult, opts: UndoToastOptions): void {
  if (result.ok) {
    if (!result.changeSetId) return; // nothing to undo → no toast
    const changeSetId = result.changeSetId;
    toast.success(opts.title ?? `Saved ${opts.objectLabel ?? "object"}`, {
      action: {
        label: "Undo",
        onClick: () => opts.onUndo?.(changeSetId),
      },
    });
    return;
  }
  toast.error(result.error);
}

export function showUndoToast(
  result: MutationResult,
  opts: UndoToastOptions = {},
): void {
  (appShellHandler ?? renderUndoToast)(result, opts);
}

/**
 * App-shell host. Mount ONCE in the providers tree. It
 * installs the global handler so every `showUndoToast` call app-wide routes
 * through here, supplying the default Undo navigation (deep-link to the
 * restore modal). Renders nothing.
 */
export function UndoToastHost() {
  const router = useRouter();
  useEffect(() => {
    appShellHandler = (result, opts) =>
      renderUndoToast(result, {
        ...opts,
        onUndo: opts.onUndo ?? ((id) => router.push(undoDeepLink(id))),
      });
    return () => {
      appShellHandler = null;
    };
  }, [router]);
  return null;
}
