"use client";

// ---------------------------------------------------------------------------
// content_change_proposal renderer — the change-diff card (cinatra#1220, S4).
//
// Successor to the CMS widgets' vanilla `renderDiffCard`, living in the S3
// shared renderer so `/chat`, the generic embedded view and each CMS iframe
// draw the change-diff IDENTICALLY. All LLM/tool-controlled strings (field
// names, before/after values, title) are rendered as React text nodes — never
// `dangerouslySetInnerHTML` — so a `<script>`-bearing value is inert by
// construction (the XSS defense this family requires).
//
// APPLY SEMANTICS (Option A — owner decision 2026-07-10, recorded on #1220):
// the agent already saved the change as a DRAFT during the run through the CMS
// MCP integration (#1214), so accepting performs NO server write — it refreshes
// the editor in place to the saved draft. When the payload carries the
// correlation ids (`proposalId` / `changeSetId`) linking it to that draft, this
// card shows the applied/refresh affordance: a "draft saved" badge + the
// refresh explanation, with the ids exposed as data attributes for the S5
// editor-patch consumer (#1221) to key on. DISPLAY-ONLY here: no interactive
// control is wired on this surface — the refresh executor lives in the CMS
// widgets (S5), exactly like the change_history card's display-only `undoable`
// badge.
// ---------------------------------------------------------------------------

import type { ContentChangeProposalView } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { Button } from "@/components/ui/button";

// §6e (cinatra#1221 S5 Lane B) — the apply-intent gesture reference. The ONLY
// apply-eligible S4 view is `content_change_proposal`; the payload carries
// EXACTLY ONE of `proposalId`/`changeSetId` as the UNTRUSTED SELECTOR the CMS
// parent re-checks (§6f). Never an open string — an arbitrary value must never
// choose behaviour.
export type ApplyIntentRef =
  | { proposalId: string; viewType: "content_change_proposal" }
  | { changeSetId: string; viewType: "content_change_proposal" };

function targetLabel(view: ContentChangeProposalView): string | undefined {
  if (view.postId) return `post #${view.postId}`;
  if (view.nodeId) return `node #${view.nodeId}`;
  return undefined;
}

export function ContentChangeProposalCard({
  view,
  onApplyIntent,
}: {
  view: ContentChangeProposalView;
  /**
   * §6e apply-intent seam. When injected by a surface that owns an apply flow
   * (the S5 embed), the card renders an EXPLICIT apply affordance whose click —
   * an explicit end-user GESTURE — emits the intent (NO auto-emit on render).
   * The default surfaces (`/chat`) inject nothing, so the card stays
   * DISPLAY-ONLY exactly as before.
   */
  onApplyIntent?: (ref: ApplyIntentRef) => void;
}) {
  const heading =
    view.title ?? (view.fields.length > 0 ? "Proposed changes" : "Content update");
  const target = targetLabel(view);
  // Option A: a correlation id means the agent already saved this change as a
  // draft during the run — show the applied/refresh affordance.
  const draftCorrelated =
    view.proposalId !== undefined || view.changeSetId !== undefined;

  return (
    <div
      className="my-3 rounded-lg border border-line bg-surface p-4"
      data-view-type="content_change_proposal"
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="text-sm font-semibold text-foreground">{heading}</div>
        {target && (
          <div className="text-xs text-muted-foreground">{target}</div>
        )}
      </div>

      {view.fields.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          {view.rich
            ? "Rich content edit — a field-level diff is not available for this change."
            : "No field-level changes."}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {view.fields.map((f, i) => (
            <li
              key={`${f.field}-${i}`}
              className="flex flex-col gap-0.5 text-sm"
              data-field={f.field}
            >
              <span className="font-medium text-foreground">{f.field}</span>
              {f.before !== undefined && f.before !== "" && (
                <span className="text-xs text-muted-foreground line-through">
                  {f.before}
                </span>
              )}
              <span className="text-xs text-foreground">
                {f.after !== undefined && f.after !== "" ? f.after : "(removed)"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {draftCorrelated && (
        <div
          className="mt-3 flex items-center gap-2 border-t border-line pt-2"
          data-affordance="applied-refresh"
          data-proposal-id={view.proposalId}
          data-change-set-id={view.changeSetId}
        >
          <span className="shrink-0 rounded border border-line px-1.5 py-0.5 text-badge-2xs uppercase tracking-wide text-muted-foreground">
            draft saved
          </span>
          <span className="text-xs text-muted-foreground">
            Already saved as a draft — applying refreshes the editor to it. No
            additional write is performed.
          </span>
          {onApplyIntent && (
            // §6e: emitted ONLY on this explicit user gesture. Prefer proposalId;
            // else changeSetId — exactly one selector (§5). Carries NO content and
            // NO tool call; the parent treats the id as an UNTRUSTED SELECTOR (§6f).
            <Button
              type="button"
              data-apply-intent
              variant="outline"
              size="sm"
              className="ml-auto shrink-0"
              onClick={() => {
                if (view.proposalId !== undefined) {
                  onApplyIntent({
                    proposalId: view.proposalId,
                    viewType: "content_change_proposal",
                  });
                } else if (view.changeSetId !== undefined) {
                  onApplyIntent({
                    changeSetId: view.changeSetId,
                    viewType: "content_change_proposal",
                  });
                }
              }}
            >
              Apply
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
