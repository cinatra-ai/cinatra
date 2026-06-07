"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppDialog } from "@/components/app-dialog";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/lib/cinatra-toast";

type AgentListItemActionsProps = {
  agentId: string;
  agentName: string;
  editHref: string;
  dataCounts: Array<{ type: string; count: number }>;
};

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

export function AgentListItemActions({ agentId, agentName, editHref, dataCounts }: AgentListItemActionsProps) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const buttonClass =
    "inline-flex size-10 items-center justify-center rounded-control border border-line bg-surface-strong text-foreground no-underline transition hover:border-primary hover:bg-primary hover:text-primary-foreground focus-visible:text-primary-foreground";

  async function handleDelete() {
    setPending(true);
    try {
      const response = await fetch(`/api/sources/${encodeURIComponent(agentId)}/delete`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Unable to delete the source data.");
      }

      setConfirmOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to delete the source data.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <a href={editHref} aria-label="Edit source" title="Edit source" className={buttonClass}>
          <PencilIcon />
        </a>
        <Button type="button" aria-label="Delete source data" title="Delete source data" className={buttonClass} onClick={() => setConfirmOpen(true)}>
          <TrashIcon />
        </Button>
      </div>

      <AppDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${agentName} data?`}
        dismissible={!pending}
      >
        <p className="text-sm leading-6 text-muted-foreground">
          This clears the data currently stored for this source. The source itself will remain available in the workspace.
        </p>

        <div className="mt-4 rounded-control border border-line bg-surface-muted px-4 py-4">
          <p className="text-sm font-medium text-foreground">Related data</p>
          <ul className="mt-3 grid gap-2 text-sm text-muted-foreground">
            {dataCounts.map((item) => (
              <li key={item.type}>
                {item.type}: {item.count}
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-4 rounded-control border border-line bg-surface-strong px-4 py-4 text-sm text-foreground">
          This removes the related accounts, contacts, and their stored historical source entries.
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={pending}>Cancel</Button>
          <Button variant="destructive" onClick={handleDelete} disabled={pending}>
            {pending ? "Deleting..." : "Delete data"}
          </Button>
        </DialogFooter>
      </AppDialog>
    </>
  );
}
