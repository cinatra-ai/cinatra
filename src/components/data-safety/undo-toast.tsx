"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { toast } from "@/lib/cinatra-toast";
import type { MutationResult } from "@/lib/object-history";
import { canRestoreChangeSetAction } from "@/components/data-safety/restore-change-set-action";

// The data-safety "Saved … [Undo]" toast.
//
// On a successful mutation that produced a change-set, fires a toast whose
// Undo action deep-links to the consolidated undo surface, carrying the
// change-set id so that exact row's restore modal auto-opens
// (/artifacts?mode=undo&openRestore=<changeSetId> — the former
// /data-safety change-set route was retired in cinatra#1431 §VII; the flat
// undo list carries the per-row restore modal and honours the deep-link).
// On failure, an error toast.
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
  // The per-change-set restore route was retired (cinatra#1431 §VII); the Undo
  // toast now lands on the consolidated undo surface. The change-set id rides in
  // `openRestore` so the flat undo list auto-opens THIS change-set's restore
  // modal (the same deep-open the retired detail route gave via ?openRestore).
  return `/artifacts?mode=undo&openRestore=${encodeURIComponent(changeSetId)}`;
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
