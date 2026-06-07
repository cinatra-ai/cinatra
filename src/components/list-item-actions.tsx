import Link from "next/link";
import { DeleteItemForm } from "@/components/data-safety/delete-item-form";
import type { MutationResult } from "@/lib/object-history";

type ListItemActionsProps = {
  viewHref: string;
  editHref: string;
  // Delete returns a MutationResult so the row delete fires the
  // UndoToast (object deletes carry a changeSetId → "Deleted … [Undo]"; non-object
  // deletes like skills carry none → plain "Deleted"). Rendered via <DeleteItemForm>.
  deleteAction: (formData: FormData) => Promise<MutationResult<unknown>>;
  hiddenFields: Array<{ name: string; value: string }>;
  size?: "sm" | "md";
};

function EyeIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-4">
      <path d="M1.7 10s3.05-5.3 8.3-5.3 8.3 5.3 8.3 5.3-3.05 5.3-8.3 5.3S1.7 10 1.7 10Z" />
      <circle cx="10" cy="10" r="2.5" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-4">
      <path d="M3 17h3.1L15.7 7.4a1.7 1.7 0 0 0 0-2.4l-.7-.7a1.7 1.7 0 0 0-2.4 0L3 13.9V17Z" />
      <path d="m11.7 5.3 3 3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-4">
      <path d="M3.8 5.4h12.4" />
      <path d="M7.2 5.4V4.3a1 1 0 0 1 1-1h3.6a1 1 0 0 1 1 1v1.1" />
      <path d="m5.2 5.4.8 10a1 1 0 0 0 1 .9h6a1 1 0 0 0 1-.9l.8-10" />
      <path d="M8.2 8.6v4.8" />
      <path d="M11.8 8.6v4.8" />
    </svg>
  );
}

export function ListItemActions({ viewHref, editHref, deleteAction, hiddenFields, size = "sm" }: ListItemActionsProps) {
  const buttonClass =
    size === "md"
      ? "inline-flex size-10 items-center justify-center rounded-control border border-line bg-surface-strong text-foreground no-underline transition hover:border-primary hover:bg-primary hover:text-primary-foreground focus-visible:text-primary-foreground"
      : "inline-flex size-8 items-center justify-center rounded-xl border border-line bg-surface-strong text-foreground no-underline transition hover:border-primary hover:bg-primary hover:text-primary-foreground focus-visible:text-primary-foreground";

  return (
    <div className="flex items-center gap-2">
      <Link href={viewHref} aria-label="View details" title="View details" className={buttonClass}>
        <EyeIcon />
      </Link>
      <Link href={editHref} aria-label="Edit item" title="Edit item" className={buttonClass}>
        <PencilIcon />
      </Link>
      <DeleteItemForm
        action={deleteAction}
        hiddenFields={hiddenFields}
        className={buttonClass}
        ariaLabel="Delete item"
        title="Delete item"
      >
        <TrashIcon />
      </DeleteItemForm>
    </div>
  );
}
