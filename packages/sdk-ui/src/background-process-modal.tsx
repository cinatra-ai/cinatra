"use client";

import { useMemo, useState } from "react";
import { AppDialog } from "./app-dialog";
import { ProcessProgressList, type ProcessProgressStep } from "./process-progress";
import { BackgroundProcessModalActions } from "./background-process-modal-actions";
import { BackgroundProcessStatusBanner } from "./background-process-status-banner";

type BackgroundProcessModalProps = {
  open: boolean;
  title: string;
  message: string;
  /** When omitted or empty, the progress list is not rendered. */
  steps?: ProcessProgressStep[];
  updatedAt?: string;
  /**
   * Explicit outcome status. When provided, bypasses text-based inference of
   * failure/stopped/success states. Shorthand: `running={true}` is equivalent
   * to `status="running"`.
   */
  status?: "running" | "succeeded" | "failed" | "stopped";
  /** Convenience shorthand for `status="running"`. Ignored when `status` is set. */
  running?: boolean;
  onClose?: () => void;
  onStop?: () => void;
  maxWidthClassName?: string;
  stopLabel?: string;
  stopAriaLabel?: string;
};

export function BackgroundProcessModal({
  open,
  title,
  message,
  steps,
  updatedAt,
  status,
  running = false,
  onClose,
  onStop,
  maxWidthClassName = "max-w-lg",
  stopLabel = "Stop",
  stopAriaLabel = "Stop background process",
}: BackgroundProcessModalProps) {
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  // Resolve the effective running flag from the explicit status or the shorthand.
  const effectiveRunning = status === "running" || (status === undefined && running);

  const viewKey = useMemo(
    () => [open ? "open" : "closed", effectiveRunning ? "running" : "idle", title, message, updatedAt ?? ""].join("::"),
    [message, open, effectiveRunning, title, updatedAt],
  );
  const dismissed = dismissedKey === viewKey;

  if (!open || dismissed) {
    return null;
  }

  // Determine failure/stopped/success either from the explicit status prop or
  // by falling back to text-pattern inference for backward compatibility.
  let impliesFailure: boolean;
  let impliesStopped: boolean;

  if (status !== undefined) {
    impliesFailure = status === "failed";
    impliesStopped = status === "stopped";
  } else {
    const combinedStatusText = `${title} ${message}`;
    impliesFailure = !effectiveRunning && /(?:^|\b)(failed|error)(?:\b|$)/i.test(combinedStatusText);
    impliesStopped = !effectiveRunning && /(?:^|\b)(stopped|canceled|cancelled)(?:\b|$)/i.test(combinedStatusText);
  }

  const normalizedSteps = (steps ?? []).length === 0
    ? []
    : (() => {
        const hasFailedStep = steps!.some((step) => step.status === "failed");

        if (impliesFailure && !hasFailedStep) {
          return steps!.map((step, index) => {
            const failureIndex = (() => {
              const runningIndex = steps!.findIndex((entry) => entry.status === "running");
              if (runningIndex >= 0) return runningIndex;
              const pendingIndex = steps!.findIndex((entry) => entry.status === "pending");
              if (pendingIndex >= 0) return pendingIndex;
              return steps!.length - 1;
            })();

            return index === failureIndex ? { ...step, status: "failed" as const } : step;
          });
        }

        if (!effectiveRunning && !impliesStopped && !hasFailedStep && steps!.some((step) => step.status !== "pending")) {
          return steps!.map((step) => ({ ...step, status: "completed" as const }));
        }

        return steps!;
      })();

  const allTasksCompleted = normalizedSteps.length > 0 && normalizedSteps.every((step) => step.status === "completed");
  const hasFailedNormalizedStep = normalizedSteps.some((step) => step.status === "failed");
  const showErrorState = impliesFailure || hasFailedNormalizedStep || status === "failed";
  const showSuccessState =
    (status === "succeeded" || (!effectiveRunning && !impliesStopped && !showErrorState && allTasksCompleted));
  const showStop = effectiveRunning && Boolean(onStop);
  const showDismissClose = Boolean(onClose) && !showStop;

  function handleClose() {
    setDismissedKey(viewKey);
    onClose?.();
  }

  return (
    <AppDialog
      open={true}
      onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}
      maxWidth={maxWidthClassName}
      dismissible={!effectiveRunning}
      showCloseButton={showDismissClose}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[1.65rem] font-semibold tracking-tight text-foreground">{title}</h2>
          {showErrorState ? (
            <BackgroundProcessStatusBanner variant="error" message={message} />
          ) : showSuccessState ? (
            <BackgroundProcessStatusBanner variant="success" message={message} />
          ) : (
            <p className="mt-3 text-sm leading-6 text-muted-foreground">{message}</p>
          )}
        </div>
        <BackgroundProcessModalActions
          showStop={showStop}
          showClose={false}
          onStop={onStop}
          onClose={handleClose}
          stopLabel={stopLabel}
          stopAriaLabel={stopAriaLabel}
        />
      </div>
      {normalizedSteps.length > 0 ? (
        <ProcessProgressList steps={normalizedSteps} className="mt-5" />
      ) : null}
    </AppDialog>
  );
}
