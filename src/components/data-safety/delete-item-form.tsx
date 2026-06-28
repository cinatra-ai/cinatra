"use client";

import { useActionState, useEffect, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/cinatra-toast";
import { showUndoToast } from "@/components/data-safety/undo-toast";
import type { MutationResult } from "@/lib/object-history";

// The delete variant of <MutationResultForm>. Deletes differ
// from create/update on two axes:
//   1. UX: a list-row delete should fire the toast and refresh the list IN PLACE
//      (the deleted row disappears) — NOT navigate. Detail-page deletes DO
//      navigate (staying on the deleted object's page is wrong), via a string
//      successHref known at server render (the parent/list id) — so no RSC
//      callback island is needed.
//   2. Undo: object deletes carry a changeSetId (legacy soft-delete change_set)
//      → "Deleted … [Undo]". Non-object deletes (skills) carry NO changeSetId;
//      showUndoToast intentionally no-ops there, so we show a plain "Deleted".
export type DeleteItemFormProps<T = unknown> = {
  action: (formData: FormData) => Promise<MutationResult<T>>;
  /** Hidden inputs carrying the delete target (e.g. objectId / parent id). */
  hiddenFields: Array<{ name: string; value: string }>;
  /**
   * Where to navigate on success. OMIT for in-row deletes (refresh in place).
   * Provide a server-computed string for detail-page deletes (e.g. an item
   * detail → its parent index page). String-only on purpose: keeps this
   * client component server-renderable with no callback prop.
   */
  successHref?: string;
  /** Toast title on success (defaults to "Deleted"). */
  deletedTitle?: string;
  /** Submit-button content (an icon for rows, a label for detail forms). */
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  title?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  pendingLabel?: ReactNode;
};

export function DeleteItemForm<T = unknown>({
  action,
  hiddenFields,
  successHref,
  deletedTitle = "Deleted",
  children,
  className,
  ariaLabel,
  title,
  variant,
  pendingLabel,
}: DeleteItemFormProps<T>) {
  const router = useRouter();
  const [state, formAction] = useActionState<MutationResult<T> | null, FormData>(
    async (_prev, formData) => action(formData),
    null,
  );

  useEffect(() => {
    if (!state) return;
    if (state.ok && !state.changeSetId) {
      // Success with nothing to undo (e.g. skills — not an object write).
      // showUndoToast no-ops without a changeSetId, so toast explicitly.
      toast.success(deletedTitle);
    } else {
      // ok + changeSetId → "Deleted … [Undo]" (app-shell UndoToastHost provides
      // the default Undo deep-link); error → toast.error.
      showUndoToast(state, { title: deletedTitle });
    }
    if (state.ok) {
      if (successHref) router.push(successHref);
      // Always refresh: in-row deletes (no href) drop the row in place; nav
      // deletes refresh the destination's server data. NOTE: not full server
      // redirect()+revalidate parity — browser UAT must confirm no stale row.
      router.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={formAction}>
      {hiddenFields.map((field) => (
        <Input key={field.name} type="hidden" name={field.name} value={field.value} />
      ))}
      <DeleteSubmit
        className={className}
        ariaLabel={ariaLabel}
        title={title}
        variant={variant}
        pendingLabel={pendingLabel}
      >
        {children}
      </DeleteSubmit>
    </form>
  );
}

// Pending-aware submit button — disables + swaps content during submission to
// prevent a double-delete (the plain server-action button allowed it).
function DeleteSubmit({
  children,
  className,
  ariaLabel,
  title,
  variant,
  pendingLabel,
}: {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  title?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  pendingLabel?: ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={pending}
      className={className}
      aria-label={ariaLabel}
      title={title}
      variant={variant}
    >
      {pending ? (pendingLabel ?? children) : children}
    </Button>
  );
}
