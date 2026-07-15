"use client";
/**
 * EntityDashboardNameDialog — the shared name-entry dialog for BOTH the
 * "+ New dashboard" flow and Rename. The epic's flow is "prompt for a name →
 * create empty dashboard"; this is that prompt, as a design-system `<Dialog>`
 * (not a raw `window.prompt`), so it can show a server-side validation failure
 * (e.g. a name conflict) inline on the field and stay open for a retry.
 *
 * `onSubmit` returns an already-reduced outcome: `{ ok: true }` closes the
 * dialog; `{ ok: false, message }` keeps it open with the message on the field.
 * The dialog owns only transient input/busy/error state — never the list.
 */
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import type { EntityDashboardsToolbarOutcome } from "./entity-dashboards-context";

export type EntityDashboardNameDialogProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly submitLabel: string;
  /** Pre-fills the field (rename); empty for create. */
  readonly initialName?: string;
  readonly onSubmit: (name: string) => Promise<EntityDashboardsToolbarOutcome>;
};

export function EntityDashboardNameDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  initialName = "",
  onSubmit,
}: EntityDashboardNameDialogProps) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset transient state on each OPEN transition so a reused instance never
  // shows a stale value/error — the React "adjust state while rendering" pattern
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders),
  // not an effect: it applies before paint with no cascading render.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName(initialName);
      setError(null);
      setBusy(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a dashboard name.");
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await onSubmit(trimmed);
    if (outcome.ok) {
      setBusy(false);
      onOpenChange(false);
      return;
    }
    setBusy(false);
    setError(outcome.message);
    inputRef.current?.focus();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Ignore close attempts while a submit is in flight.
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} noValidate>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? (
              <DialogDescription>{description}</DialogDescription>
            ) : null}
          </DialogHeader>
          <div className="py-4">
            <Input
              ref={inputRef}
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="Dashboard name"
              aria-invalid={error ? true : undefined}
              disabled={busy}
              maxLength={120}
              placeholder="Dashboard name"
            />
            {error ? (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
