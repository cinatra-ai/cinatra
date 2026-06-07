"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { RenameWorkflowActionResult } from "@/app/workflows/[workflowId]/actions";

// WPP-07 — inline-edit affordance rendered inside the spec h1 via
// PageHeader.titleContent. Click to edit → input → Enter or blur to save →
// Esc to cancel. The static span and the inline <input> both inherit the
// PageHeader h1's Archivo italic 800 typography (this component never
// reapplies font / size classes — it lets the parent <h1> own them).
//
// `editable=false` (read-only access, or workflow in a non-manageable status)
// renders a plain span, no click handler — the action call would be rejected
// anyway, and the affordance shouldn't suggest otherwise.

export interface WorkflowEditableTitleProps {
  initialName: string;
  lockVersion: number;
  editable: boolean;
  rename: (newName: string, expectedLockVersion: number) => Promise<RenameWorkflowActionResult>;
}

export function WorkflowEditableTitle({
  initialName,
  lockVersion,
  editable,
  rename,
}: WorkflowEditableTitleProps) {
  const [name, setName] = React.useState(initialName);
  const [draft, setDraft] = React.useState(initialName);
  const [editing, setEditing] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [version, setVersion] = React.useState(lockVersion);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  React.useEffect(() => {
    setName(initialName);
    setVersion(lockVersion);
  }, [initialName, lockVersion]);

  if (!editable) {
    return <span>{name}</span>;
  }

  function startEdit() {
    if (pending) return;
    setDraft(name);
    setEditing(true);
  }

  function cancel() {
    setDraft(name);
    setEditing(false);
  }

  async function commit() {
    const trimmed = draft.trim();
    if (trimmed === "" || trimmed === name) {
      cancel();
      return;
    }
    setPending(true);
    try {
      const result = await rename(trimmed, version);
      if (result.ok) {
        setName(trimmed);
        setVersion(result.lockVersion);
        setEditing(false);
      } else {
        // Stale / invalid / forbidden — bounce back to read mode with the
        // current state. revalidatePath will pull fresh server truth.
        setEditing(false);
        setDraft(name);
      }
    } finally {
      setPending(false);
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        disabled={pending}
        // Inherit the h1 typography from PageHeader; only override the
        // chrome (border, padding, background) so the input visually melts
        // into the heading.
        className={cn(
          "bg-transparent font-display italic font-extrabold leading-[1.05] tracking-[-0.018em] text-balance",
          "border-b border-line outline-none focus:border-foreground",
          "w-full min-w-[8rem] max-w-full",
          "text-inherit",
          pending && "opacity-60",
        )}
        aria-label="Rename workflow"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      // Same trick — never reapply h1 typography; only override chrome.
      className={cn(
        "cursor-text bg-transparent text-left",
        "border-b border-transparent hover:border-line",
        "text-inherit",
      )}
      title="Click to rename"
    >
      {name}
    </button>
  );
}
