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
// DISPLAY-ONLY in this slice: the no-reload APPLY (a surface-registered apply
// capability writing through the CMS MCP integration under OBO) is out of scope
// (#1214 / #1037 P4.1), so there is no Accept button wired to a write here.
// ---------------------------------------------------------------------------

import type { ContentChangeProposalView } from "@cinatra-ai/agent-ui-protocol/renderable-views";

function targetLabel(view: ContentChangeProposalView): string | undefined {
  if (view.postId) return `post #${view.postId}`;
  if (view.nodeId) return `node #${view.nodeId}`;
  return undefined;
}

export function ContentChangeProposalCard({
  view,
}: {
  view: ContentChangeProposalView;
}) {
  const heading =
    view.title ?? (view.fields.length > 0 ? "Proposed changes" : "Content update");
  const target = targetLabel(view);

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
    </div>
  );
}
