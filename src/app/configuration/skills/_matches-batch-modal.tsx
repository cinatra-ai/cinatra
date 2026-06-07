"use client";

/**
 * Re-evaluate-all cost-estimate modal.
 *
 * Two-click flow:
 *   click 1: opens modal, fires getBatchEstimateAction (dryRun=true) so the
 *            admin sees pair count + USD before paying for an OpenAI Batch.
 *   click 2: confirms, fires runBatchNowAction (dryRun=false). The status
 *            panel polls /api/admin/skills/match-status to surface progress.
 *
 * Disclaimer in the modal description names the OpenAI Batch SLA (24h)
 * because the admin's expectation is otherwise "real-time" and a 24h delay
 * looks like a hung job otherwise.
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
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedUsd: number;
  pricingVersion: string;
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
        estimatedInputTokens: res.estimatedInputTokens,
        estimatedOutputTokens: res.estimatedOutputTokens,
        estimatedUsd: res.estimatedUsd,
        pricingVersion: res.pricingVersion,
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
            This submits a batch to OpenAI. Per the OpenAI Batch API SLA, results may take up to 24 hours
            to complete. Status updates appear in the panel above.
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
              <Button onClick={handleConfirm} disabled={pending || !estimate}>
                {pending ? "Submitting…" : "Confirm & submit"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
