"use client";

/**
 * Re-evaluate-all cost-estimate modal.
 *
 * Two-click flow:
 *   click 1: opens modal, fires getBatchEstimateAction (dryRun=true) so the
 *            admin sees provider/model, run mode, pair count, and — when the
 *            model is priced — USD before confirming.
 *   click 2: confirms, fires runBatchNowAction (dryRun=false). The status
 *            panel polls /api/admin/skills/match-status to surface progress.
 *
 * Provider prose is DERIVED from the dry-run's frozen run context (setup-flow
 * S6) — no hardcoded provider names. Cost display honesty: `estimatedUsd` is
 * nullable; an unpriced model/provider shows an explicit unavailability note,
 * never $0 and never a substituted price.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { getBatchEstimateAction, runBatchNowAction } from "./actions";

type Estimate = {
  pairCount: number;
  provider: string | null;
  model: string | null;
  mode: "batch" | "synchronous" | null;
  estimatedInputTokens: number | null;
  estimatedOutputTokens: number | null;
  estimatedUsd: number | null;
  pricingVersion: string | null;
  costUnavailableReason: string | null;
};

export function MatchesBatchModal() {
  const [open, setOpen] = useState(false);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function handleOpen(next: boolean) {
    setOpen(next);
    if (!next) {
      // Reset transient state when the modal closes so re-opening fetches
      // a fresh estimate (the pair set may have changed in the meantime).
      setEstimate(null);
      setEstimateError(null);
      setSubmitted(false);
      setSubmitError(null);
      return;
    }
    try {
      const res = (await getBatchEstimateAction()) as { dryRun: true } & Estimate;
      setEstimate({
        pairCount: res.pairCount,
        provider: res.provider ?? null,
        model: res.model ?? null,
        mode: res.mode ?? null,
        estimatedInputTokens: res.estimatedInputTokens ?? null,
        estimatedOutputTokens: res.estimatedOutputTokens ?? null,
        estimatedUsd: res.estimatedUsd ?? null,
        pricingVersion: res.pricingVersion ?? null,
        costUnavailableReason: res.costUnavailableReason ?? null,
      });
    } catch (err) {
      console.error("[MatchesBatchModal] estimate failed", err);
      setEstimateError(err instanceof Error ? err.message : "Unable to estimate cost.");
    }
  }

  function handleConfirm() {
    setSubmitError(null);
    startTransition(async () => {
      try {
        await runBatchNowAction();
        setSubmitted(true);
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : "Submit failed.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        <Button variant="default">Re-evaluate all</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Re-evaluate all skill matches</DialogTitle>
          <DialogDescription>
            {estimate?.provider
              ? estimate.mode === "synchronous"
                ? `This evaluates every pair on ${estimate.provider} (${estimate.model}) as a background run with live progress.`
                : `This submits a batch run to ${estimate.provider} (${estimate.model}). Provider batch processing may take up to 24 hours.`
              : "This re-evaluates every (agent, skill) pair on the configured LLM provider."}{" "}
            Status updates appear in the panel above.
          </DialogDescription>
        </DialogHeader>
        {submitted ? (
          <div className="text-sm text-foreground">
            Batch submitted. Track progress in the &quot;Last batch run&quot; panel above.
          </div>
        ) : estimateError ? (
          <div className="text-sm text-destructive">{estimateError}</div>
        ) : !estimate ? (
          <div className="text-sm text-muted-foreground">Estimating cost…</div>
        ) : (
          <div className="flex flex-col gap-1.5 text-sm">
            <div>
              Pairs: <span className="font-medium text-foreground">{estimate.pairCount.toLocaleString()}</span>
            </div>
            {estimate.estimatedUsd !== null &&
            estimate.estimatedInputTokens !== null &&
            estimate.estimatedOutputTokens !== null ? (
              <>
                <div>
                  Estimated input tokens:{" "}
                  <span className="font-medium text-foreground">{estimate.estimatedInputTokens.toLocaleString()}</span>
                </div>
                <div>
                  Estimated output tokens:{" "}
                  <span className="font-medium text-foreground">{estimate.estimatedOutputTokens.toLocaleString()}</span>
                </div>
                <div className="font-semibold text-foreground">
                  Estimated cost: ${estimate.estimatedUsd.toFixed(4)} USD
                </div>
                <div className="text-xs text-muted-foreground">Pricing snapshot: {estimate.pricingVersion}</div>
              </>
            ) : (
              <div className="text-xs text-muted-foreground">
                {estimate.costUnavailableReason ?? "Cost estimate unavailable for this model/provider."}
              </div>
            )}
          </div>
        )}
        {submitError ? <div className="text-xs text-destructive">{submitError}</div> : null}
        <DialogFooter>
          {submitted ? (
            <Button onClick={() => handleOpen(false)}>Close</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => handleOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={pending || !estimate || estimate.provider === null}
              >
                {pending ? "Submitting…" : "Confirm & submit"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
