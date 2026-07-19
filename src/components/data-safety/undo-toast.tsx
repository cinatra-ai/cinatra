"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { toast } from "@/lib/cinatra-toast";
import type { MutationResult } from "@/lib/object-history";
import { canRestoreChangeSetAction } from "@/components/data-safety/restore-change-set-action";

// The data-safety "Saved … [Undo]" toast.
//
// On a successful mutation that produced a change-set, fires a toast whose
// Undo action deep-links to that single change set's targeted-restore route
// nested under the Artifacts console
// (/configuration/artifacts/restore/<changeSetId>, cinatra#1786), which
// re-checks the same per-object eligibility and auto-opens the restore
// confirmation. On failure, an error toast.
// On success WITHOUT a change-set id, nothing. Uses the project's
// cinatra-toast wrapper (owner-mandated; never sonner directly).
//
// §VI eligibility (design@94cfbcf5): the Undo affordance renders ONLY when the
// acting user is eligible to restore this change-set — per-object-authorized
// for every affected object and the change-set still restorable, no
// administrator bypass. An ineligible actor gets NO toast Undo action; per the
// ruling's "suppression over a disabled/ask-an-admin control", and consistent
// with the existing "no change-set id → nothing" contract, the toast is
// suppressed entirely rather than dead-ending on a control that cannot act.
// The check runs server-side (canRestoreChangeSetAction), so the render is
// async; failure fails closed (no affordance).
//
// App-shell-hosted: <UndoToastHost> mounts once in the app
// providers and owns the default Undo navigation, so any `showUndoToast` call
// from any client component routes through the shell host. If the host isn't
// mounted (tests, isolated renders), showUndoToast renders directly — same
// toast, just without the host's default router navigation.

export function undoDeepLink(changeSetId: string): string {
  // The entry affordances (this toast + the in-chat "Undo last action" chip)
  // deep-link to the SINGLE addressed change set's targeted-restore surface,
  // nested under the Artifacts console (cinatra#1786, spec design@923fa0d8 §IV).
  // That route holds to the same per-object eligibility the affordance already
  // checked and auto-opens the restore confirmation, so a rendered control never
  // dead-ends on the not-authorized panel.
  return `/configuration/artifacts/restore/${encodeURIComponent(changeSetId)}`;
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
  | ((result: MutationResult, opts: UndoToastOptions) => void | Promise<void>)
  | null = null;

async function renderUndoToast(
  result: MutationResult,
  opts: UndoToastOptions,
): Promise<void> {
  if (!result.ok) {
    toast.error(result.error);
    return;
  }
  if (!result.changeSetId) return; // nothing to undo → no toast
  const changeSetId = result.changeSetId;
  // Suppress the Undo affordance unless the actor is eligible to restore this
  // change-set (§VI, no admin bypass). Fail closed on any error.
  let eligible = false;
  try {
    ({ eligible } = await canRestoreChangeSetAction({ changeSetId }));
  } catch {
    eligible = false;
  }
  if (!eligible) return; // ineligible → render nothing (no toast Undo action)
  toast.success(opts.title ?? `Saved ${opts.objectLabel ?? "object"}`, {
    action: {
      label: "Undo",
      onClick: () => opts.onUndo?.(changeSetId),
    },
  });
}

export function showUndoToast(
  result: MutationResult,
  opts: UndoToastOptions = {},
): void {
  void (appShellHandler ?? renderUndoToast)(result, opts);
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
