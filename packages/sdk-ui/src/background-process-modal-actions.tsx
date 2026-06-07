"use client";

import { Button } from "./ui/button";

type BackgroundProcessModalActionsProps = {
  showStop: boolean;
  showClose: boolean;
  onStop?: () => void;
  onClose?: () => void;
  stopLabel?: string;
  stopAriaLabel?: string;
};

export function BackgroundProcessModalActions({
  showStop,
  showClose,
  onStop,
  onClose,
  stopLabel = "Stop",
  stopAriaLabel = "Stop background process",
}: BackgroundProcessModalActionsProps) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      {showStop ? (
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onStop}
          aria-label={stopAriaLabel}
          title={stopLabel}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-destructive/30 bg-destructive/10 text-destructive transition hover:border-destructive hover:bg-destructive hover:text-destructive-foreground"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-4.5 w-4.5">
            <rect x="6.5" y="6.5" width="11" height="11" rx="1.75" />
          </svg>
        </Button>
      ) : null}
      {showClose ? (
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onClose}
          aria-label="Close background process window"
          title="Close"
          className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface-strong text-muted-foreground transition hover:border-primary hover:text-foreground"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4.5 w-4.5">
            <path d="M6 6l12 12" />
            <path d="M18 6L6 18" />
          </svg>
        </Button>
      ) : null}
    </div>
  );
}
