"use client";

import { useActionState, useEffect, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { showUndoToast } from "@/components/data-safety/undo-toast";
import type { MutationResult } from "@/lib/object-history";

// The reusable client wrapper for migrating a redirect()-based
// server-action form to the MutationResult + UndoToast contract. THE reference
// pattern for every per-area write migration.
//
// Wrap server-rendered field markup as children; pass the migrated server
// action (which now returns MutationResult instead of redirecting). On success
// it fires the app-shell <UndoToastHost> "Saved … [Undo]" toast (Undo deep-
// links via the result's changeSetId) and performs the navigation the old
// redirect() did. On failure it surfaces an error toast.
//
// ADAPTER TRADEOFF: React's useActionState expects a
// `(prevState, formData)` action, but the migrated actions keep the cleaner
// `(formData) => MutationResult` signature so any direct (non-form) caller can
// use them too. The inline `(_, fd) => action(fd)` adapter bridges the two —
// the action stays form-agnostic; this wrapper owns the useActionState shape.
export type MutationResultFormProps<T = unknown> = {
  action: (formData: FormData) => Promise<MutationResult<T>>;
  /**
   * Where to navigate on success (the nav the old redirect() performed). The
   * function form receives the typed success result so callers can read
   * `result.data` (e.g. a created object's id only known post-write). Generic
   * `T` flows from the action's MutationResult<T> return.
   *
   * The string form is server-callable. The FUNCTION form is a client-only
   * closure: pass it from a Client Component (a thin "use client" island), never
   * directly from a Server Component — RSC can't serialize a callback prop into
   * this "use client" component. Wrap it in a thin "use client" island that
   * owns the typed-result successHref closure.
   */
  successHref?:
    | string
    | ((result: Extract<MutationResult<T>, { ok: true }>) => string);
  /** Toast title on success (defaults to "Saved"). */
  successTitle?: string;
  className?: string;
  children: ReactNode;
};

export function MutationResultForm<T = unknown>({
  action,
  successHref,
  successTitle = "Saved",
  className,
  children,
}: MutationResultFormProps<T>) {
  const router = useRouter();
  const [state, formAction] = useActionState<MutationResult<T> | null, FormData>(
    async (_prev, formData) => action(formData),
    null,
  );

  useEffect(() => {
    if (!state) return;
    // Routes through the app-shell UndoToastHost (default Undo navigation);
    // handles both ok (Saved … [Undo]) and error (toast.error).
    showUndoToast(state, { title: successTitle });
    if (state.ok) {
      const href =
        typeof successHref === "function" ? successHref(state) : successHref;
      if (href) {
        router.push(href);
        // router.refresh() re-renders the current route's server data. NOTE:
        // this is NOT full server redirect()+revalidation parity — browser UAT
        // must confirm the detail/list reflects the write (no stale cache).
        router.refresh();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={formAction} className={className}>
      {children}
    </form>
  );
}

// Pending-aware submit button for use INSIDE a <MutationResultForm> (or any
// form). useFormStatus reads the enclosing form's submission state, so the
// button disables + shows a busy label during submission — prevents the
// double-submit the plain server-action <Button> allowed. Part of the
// reference pattern so per-area migrations inherit it.
export type MutationResultSubmitProps = {
  children: ReactNode;
  pendingLabel?: string;
  className?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
};

export function MutationResultSubmit({
  children,
  pendingLabel,
  className,
  variant,
}: MutationResultSubmitProps) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className={className} variant={variant}>
      {pending ? (pendingLabel ?? "Saving…") : children}
    </Button>
  );
}
