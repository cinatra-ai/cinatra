"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X, CheckCheck, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ReviewDisposition } from "@/lib/artifacts/artifact-review-decision";
import {
  reviewDecideDisabledReason,
  type ReviewDecisionPermissions,
  type ReviewSubmitOutcome,
} from "@/app/artifacts/review/review-surface-model";

import { ReviewGateBlocked } from "./review-gate-states";

export type SubmitReviewDecisionAction = (input: {
  disposition: ReviewDisposition;
  comment: string | null;
}) => Promise<ReviewSubmitOutcome>;

/**
 * The host DECISION BAR (cinatra#1795 S12 item 4; spec design@30a0f9c9 §IV/§V):
 * one bar at the foot of the gate governing EVERY target under it. Exactly three
 * affordances — Approve (primary, terminal), Reject (destructive, terminal),
 * Comment (ghost, non-terminal annotation) — plus one optional rationale field.
 * There is NO "request changes" decision; a reviewer who wants changes without
 * deciding leaves a Comment, which keeps the gate open.
 *
 * The decision is display + DECIDE only (epic #1620 ADR): the client submits only
 * the disposition + rationale; the server re-validates the whole gate, resolves
 * it atomically, and derives provenance from the type. A gate that changed under
 * the reviewer does not slip through — the surface shows a BLOCKED state (§V),
 * never a silent commit. Submitting the same decision twice is safe (idempotent).
 *
 * Permission-gated (§V): a terminal Approve/Reject needs approve access; Comment
 * needs respond access. A reviewer who may see but not act gets the affordances
 * DISABLED with a one-line reason, never a live control that fails on click.
 *
 * Conformance anchors: `review-decision-bar`; the disabled sub-state is
 * `review-decision-disabled`; a post-submit block reuses `review-gate-blocked`.
 */
export function ReviewDecisionBar({
  permissions,
  submitAction,
}: {
  permissions: ReviewDecisionPermissions;
  submitAction: SubmitReviewDecisionAction;
}) {
  const router = useRouter();
  const [comment, setComment] = useState("");
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<ReviewSubmitOutcome | null>(null);

  const disabledReason = reviewDecideDisabledReason(permissions);
  const decided = outcome?.kind === "decided";
  // A landed `changes-requested` (the lifecycle prompt-window path) also RESOLVES
  // the gate, so it settles the bar exactly like a terminal decision.
  const settled = decided || outcome?.kind === "changes-requested";

  function submit(disposition: ReviewDisposition) {
    setOutcome(null);
    startTransition(async () => {
      const result = await submitAction({
        disposition,
        comment: comment.trim() === "" ? null : comment.trim(),
      });
      setOutcome(result);
      // A landed terminal decision — or a changes-requested that resolved the gate
      // into a repair — resolves the gate; reflect the live (now blocked) state.
      if (result.kind === "decided" || result.kind === "changes-requested") router.refresh();
    });
  }

  // A gate that changed under the reviewer (§IV/V) — blocked, never a slip.
  if (outcome?.kind === "blocked") {
    return <ReviewGateBlocked reason={outcome.reason} />;
  }

  return (
    <div
      data-conformance-id="review-decision-bar"
      className="overflow-hidden rounded-control border border-line bg-surface-strong"
    >
      {/* Decision rationale (§IV) — optional on approve, expected on reject, the
          substance of a comment. Travels into the audit trail + the resume note. */}
      <div className="px-4 pt-3">
        <label
          htmlFor="review-rationale"
          className="mb-1.5 block font-mono text-badge-2xs uppercase tracking-widest text-muted-foreground"
        >
          Decision rationale{" "}
          <span className="normal-case tracking-normal">(optional on approve, expected on reject)</span>
        </label>
        <Textarea
          id="review-rationale"
          data-testid="review-rationale"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          disabled={pending || settled}
          placeholder="Add a note for the run and the audit trail…"
          className="min-h-[44px] text-xs"
        />
      </div>

      {settled ? (
        outcome.kind === "decided" ? (
          <ReviewDecidedNotice outcome={outcome} />
        ) : (
          <ReviewChangesRequestedNotice outcome={outcome} />
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2.5 px-4 pb-3 pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-action="comment-review -> annotated"
              disabled={!permissions.canComment || pending}
              onClick={() => submit("comment")}
            >
              Comment
            </Button>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                data-action="reject-review -> resolved"
                disabled={!permissions.canDecide || pending}
                aria-disabled={!permissions.canDecide}
                onClick={() => submit("reject")}
              >
                <X aria-hidden="true" />
                Reject
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                data-action="approve-review -> resolved"
                disabled={!permissions.canDecide || pending}
                aria-disabled={!permissions.canDecide}
                onClick={() => submit("approve")}
              >
                <Check aria-hidden="true" />
                Approve
              </Button>
            </div>
          </div>

          {/* §V — disabled reason (a viewer who may see but not decide). */}
          {disabledReason ? (
            <p
              data-conformance-id="review-decision-disabled"
              className="border-t border-line px-4 py-2.5 text-xs leading-relaxed text-muted-foreground"
            >
              {disabledReason}
            </p>
          ) : null}

          {/* §IV — a non-terminal comment landed; the gate stays pending. */}
          {outcome?.kind === "annotated" ? (
            <p
              role="status"
              data-review-outcome="annotated"
              className="border-t border-line px-4 py-2.5 text-xs text-green"
            >
              Comment recorded. The gate stays open — nothing has resumed.
            </p>
          ) : null}
          {outcome?.kind === "not-permitted" ? (
            <p
              role="alert"
              data-review-outcome="not-permitted"
              className="border-t border-line px-4 py-2.5 text-xs text-destructive"
            >
              {outcome.message}
            </p>
          ) : null}
          {outcome?.kind === "error" ? (
            <p
              role="alert"
              data-review-outcome="error"
              className="border-t border-line px-4 py-2.5 text-xs text-destructive"
            >
              {outcome.message} The decision did not commit — you can retry.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The terminal-decision success notice (§IV) — the gate resolved; an approve
 * releases the run to continue, a reject turns it back (or ends it). */
function ReviewDecidedNotice({
  outcome,
}: {
  outcome: Extract<ReviewSubmitOutcome, { kind: "decided" }>;
}) {
  const approved = outcome.disposition === "approve";
  return (
    <p
      role="status"
      data-review-outcome="decided"
      data-review-disposition={outcome.disposition}
      className="flex items-center gap-2 border-t border-line px-4 py-3 text-xs text-foreground"
    >
      <CheckCheck aria-hidden="true" className="size-4 text-green" />
      {approved
        ? "Approved. The gate is resolved and the run has been released to continue."
        : "Rejected. The gate is resolved and the reviewed work has been turned back."}
      {outcome.idempotent ? " (This decision had already been recorded.)" : ""}
    </p>
  );
}

/** The lifecycle prompt-window notice (cinatra#2063): the typed feedback closed the
 * gate as `changes_requested` and opened a repair. `requested` — a repair-capable
 * producer's repair is in flight; `escalated` — routed to a human / org route (or
 * the cycle bound tripped). Either way the gate is resolved and the held effect
 * stays held until the repair's successor is approved. NOT a fourth decision
 * affordance — it is the Comment path's outcome on a lifecycle gate. */
function ReviewChangesRequestedNotice({
  outcome,
}: {
  outcome: Extract<ReviewSubmitOutcome, { kind: "changes-requested" }>;
}) {
  return (
    <p
      role="status"
      data-review-outcome="changes-requested"
      data-changes-status={outcome.status}
      className="flex items-center gap-2 border-t border-line px-4 py-3 text-xs text-foreground"
    >
      <RotateCcw aria-hidden="true" className="size-4 text-mustard-ink" />
      {outcome.status === "requested"
        ? "Changes requested. The gate is resolved and the reviewed work has been turned back for repair — a repair is now in flight."
        : "Changes requested. The gate is resolved and the reviewed work has been turned back — escalated because no automatic repair is available; the effect stays held."}
      {outcome.idempotent ? " (This had already been recorded.)" : ""}
    </p>
  );
}
