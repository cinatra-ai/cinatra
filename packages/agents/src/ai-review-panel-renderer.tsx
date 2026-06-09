"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/lib/cinatra-toast";
import type {
  FieldRendererCondition,
  FieldRendererProps,
} from "./field-renderer-registry";
import {
  getReviewCheckState,
  runReviewCheck,
  dismissReviewRecommendation,
  applyReviewRecommendation,
  type StageReviewCheck,
} from "./email-outreach-stage-actions";

// ---------------------------------------------------------------------------
// Condition
// ---------------------------------------------------------------------------

export const isAiReviewPanelField: FieldRendererCondition = (_fieldName, schema) =>
  (["@cinatra/email-reviewer-agent:ai-review-panel","ai-review-panel"] as string[]).includes((schema as { ["x-renderer"]?: string })["x-renderer"] ?? "");

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function AiReviewPanelRenderer({
  value,
  onChange,
  disabled,
  schema,
}: FieldRendererProps) {
  const campaignId = (value as { campaignId?: string } | null)?.campaignId;
  const approved = (value as { approved?: boolean } | null)?.approved;

  // serviceId: prefer value, then schema annotation x-service-id
  const serviceId =
    (value as { serviceId?: string } | null)?.serviceId ??
    (schema as { ["x-service-id"]?: string })["x-service-id"] ??
    null;

  const [state, setState] = useState<StageReviewCheck | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [working, setWorking] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!campaignId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getReviewCheckState(campaignId);
      setState(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load review state");
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!campaignId) {
    return (
      <p className="text-sm text-muted-foreground">
        No campaign selected yet. Complete the previous setup steps first.
      </p>
    );
  }

  const handleRun = async () => {
    if (!serviceId) {
      toast.error("Service ID not available — cannot run review.");
      return;
    }
    setRunning(true);
    try {
      await runReviewCheck({ serviceId, campaignId });
      toast.success("Review check started");
      await load();
    } catch {
      toast.error("Could not run the review check.");
    } finally {
      setRunning(false);
    }
  };

  const handleDismiss = async (id: string) => {
    if (!serviceId) {
      toast.error("Service ID not available — cannot dismiss.");
      return;
    }
    setWorking((prev) => new Set(prev).add(id));
    try {
      await dismissReviewRecommendation({ serviceId, campaignId, ids: [id] });
      toast.success("Recommendation dismissed");
      await load();
    } catch {
      toast.error("Could not dismiss the recommendation.");
    } finally {
      setWorking((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleApply = async (id: string) => {
    if (!serviceId) {
      toast.error("Service ID not available — cannot apply.");
      return;
    }
    setWorking((prev) => new Set(prev).add(id));
    try {
      await applyReviewRecommendation({ serviceId, campaignId, ids: [id] });
      toast.success("Recommendation applied");
      await load();
    } catch {
      toast.error("Could not apply the recommendation.");
    } finally {
      setWorking((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleApproveReview = () => {
    onChange({ campaignId, approved: true, reviewedAt: new Date().toISOString() });
    toast.success("Review approved");
  };

  const recommendations = state?.recommendations ?? [];

  return (
    <div className="soft-panel flex flex-col gap-4 p-4">
      {/* Heading with status and run button */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">AI Review</span>
          {state?.status && (
            <Badge variant="outline">{state.status}</Badge>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRun}
          disabled={running || disabled || !serviceId}
        >
          {running ? "Running..." : "Run review"}
        </Button>
      </div>

      {/* No service ID notice */}
      {!serviceId && (
        <p className="text-xs text-muted-foreground">
          Service ID not available — review mutation buttons are disabled.
        </p>
      )}

      {/* Loading state */}
      {loading && (
        <p className="text-sm text-muted-foreground">Loading review state...</p>
      )}

      {/* Error state */}
      {error && !loading && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      )}

      {/* Recommendations */}
      {!loading && !error && recommendations.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No recommendations yet. Run a review to get AI feedback.
        </p>
      )}

      {!loading && !error && recommendations.length > 0 && (
        <div className="flex flex-col gap-2">
          {recommendations.map((rec) => {
            const isWorking = working.has(rec.id);
            return (
              <div key={rec.id} className="soft-panel flex flex-col gap-2 p-3">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{rec.severity}</Badge>
                  <span className="text-sm font-medium text-foreground">{rec.title}</span>
                </div>
                {rec.description && (
                  <p className="text-xs text-muted-foreground">{rec.description}</p>
                )}
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDismiss(rec.id)}
                    disabled={isWorking || disabled || !serviceId}
                  >
                    {isWorking ? "..." : "Dismiss"}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => handleApply(rec.id)}
                    disabled={isWorking || disabled || !serviceId}
                  >
                    {isWorking ? "..." : "Apply"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Approved state message */}
      {approved === true && (
        <p className="text-sm text-muted-foreground">Approved — step complete.</p>
      )}

      {/* Footer approve button */}
      <Button
        onClick={handleApproveReview}
        disabled={disabled || approved === true}
      >
        Approve review
      </Button>
    </div>
  );
}
