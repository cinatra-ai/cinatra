"use client";

import { useEffect, useRef } from "react";
import type { FieldRendererProps } from "./field-renderer-registry";
import { EmailDraftsReviewRenderer } from "./email-drafts-review-renderer";
import { CampaignRecipientsReviewRenderer } from "./campaign-recipients-review-renderer";
import { SchemaFieldRenderer } from "./schema-field-renderer";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

// Condition: the reviewer-agent manifest binding (kind "reviewer-output") and
// the host-registered legacy-scope alias each resolve to this component with
// strict ID matching — see register-default-renderers.ts.

// Summary is the LLM-supplied one-line context line; render only when
// non-empty. Styling: muted-foreground, small, with bottom margin for
// separation from the inner renderer. Owned here (not by inner renderers) so
// every dispatch branch — drafts, followups, contacts-list, fallback — shows
// the summary in the same position with the same styling.
function SummaryLine({ summary }: { summary?: string }) {
  if (!summary || summary.trim().length === 0) return null;
  return <p className="text-sm text-muted-foreground mb-2">{summary}</p>;
}

// LLM-driven dispatch: props.value carries
//   { contentBundle, contentType, summary? }
// where contentType is the LLM rendering advisor's choice (NOT a leaf literal)
// and summary is the LLM's one-line description of what the human is reviewing.
// The dispatcher reads contentType to pick the inner renderer, projects the
// inner contentBundle as `value` to that renderer (so existing renderers still
// see their pre-existing wire format), and renders the summary above the inner
// renderer in every branch.
//
// Context-tolerant fallback: when the upstream node didn't produce a
// `{contentType, contentBundle, summary}` envelope, `value` may carry the
// review context directly as top-level keys (e.g. `{title, summaryLine, url,
// userResponse}`). The default branch surfaces THOSE fields via
// `SchemaFieldRenderer` instead of projecting an empty `contentBundle ?? {}`.
// Net effect: the user sees the title / summary line being reviewed inline
// with the userResponse input instead of just an empty form.
export function ReviewerAgentOutputRenderer(props: FieldRendererProps) {
  const value = (props.value ?? {}) as {
    contentType?: string;
    contentBundle?: unknown;
    summary?: string;
    [extraKey: string]: unknown;
  };
  const contentType = value.contentType;
  const summary = value.summary;
  const innerProps: FieldRendererProps = {
    ...props,
    value: value.contentBundle ?? {},
  };
  switch (contentType) {
    case "email-drafts":
    case "email-followups":
      return (
        <>
          <SummaryLine summary={summary} />
          <EmailDraftsReviewRenderer {...innerProps} />
        </>
      );
    case "contacts-list":
      return (
        <>
          <SummaryLine summary={summary} />
          <CampaignRecipientsReviewRenderer {...innerProps} />
        </>
      );
    case "text": {
      // Minimal "text" envelope for orchestrators whose reviewer subflow
      // doesn't yet construct a typed bundle. execution.ts synthesizes this
      // envelope from `output` (history-derived LLM text) when no upstream
      // contentType was set. Renders the LLM text as the summary, then
      // owns its own Continue button — the orchestrator panel suppresses
      // the outer Continue for the LAST HITL step in the stepper, so
      // every renderer that's wired to a "last" step must surface its
      // own approval action.
      return <ReviewerTextEnvelope props={props} value={value} summary={summary} />;
    }
    default: {
      // Tolerate the no-envelope case. When contentBundle is absent but the
      // value object itself has fields beyond the envelope keys, surface those
      // directly so the gate's actual fields (title, summaryLine, url,
      // userResponse) render via SchemaFieldRenderer.
      const ENVELOPE_KEYS = new Set(["contentType", "contentBundle", "summary"]);
      const extraEntries = Object.entries(value).filter(
        ([k]) => !ENVELOPE_KEYS.has(k),
      );
      const hasContentBundle =
        value.contentBundle !== undefined && value.contentBundle !== null;
      const fallbackValue = hasContentBundle
        ? value.contentBundle
        : Object.fromEntries(extraEntries);
      // Strip x-renderer from the schema before passing into
      // SchemaFieldRenderer. Without this, the inner SchemaFieldRenderer's
      // registerFlush effect calls fieldRendererRegistry.resolve with the
      // same schema, re-matches us (ReviewerAgentOutputRenderer), and skips
      // its flush registration. That left the inner input's local state
      // unable to flush to bufferedHitlValue when the outer panel's Continue
      // button fired — handleContinue then sent `{approved:true,...}` to the
      // server with no `userResponse`, and WayFlow's reviewer subflow looped
      // waiting for the expected approval text.
      const fallbackSchema = (() => {
        const s = (props.schema ?? {}) as Record<string, unknown>;
        const { "x-renderer": _xr, ...rest } = s;
        void _xr;
        return rest;
      })();
      const fallbackProps: FieldRendererProps = {
        ...props,
        value: fallbackValue,
        schema: fallbackSchema,
      };
      // Surface the "we couldn't classify the bundle" alert only when the
      // bundle envelope WAS provided but with an unrecognized contentType —
      // in the no-envelope case the renderer is just being used as a generic
      // gate dispatcher and surfacing an "unknown layout" warning is noise.
      const showUnknownAlert = contentType !== undefined && contentType !== null;
      return (
        <>
          <SummaryLine summary={summary} />
          {showUnknownAlert ? (
            <Alert variant="default">
              <AlertTitle>Review this content</AlertTitle>
              <AlertDescription>
                We couldn&apos;t match this content to a known review layout. Inspect the data below and approve or reject as usual.
              </AlertDescription>
            </Alert>
          ) : null}
          <SchemaFieldRenderer {...fallbackProps} />
        </>
      );
    }
  }
}

/**
 * Renderer for the synthesized "text" envelope.
 *
 * Reads the LLM output text + url from the contentBundle and renders a
 * read-only review panel + an inline Continue button. The button calls
 * `props.onChange({ userResponse: <text>, approved: true, approvedAt:
 * <iso> })` — the chat panel and the orchestrator stepper both treat that
 * shape correctly (the chat panel wraps + forwards, the stepper merges
 * into bufferedHitlValue and triggers the approval handler).
 *
 * We own the button (not the outer panel) because the orchestrator
 * stepper hides the external Continue when the gate is the LAST HITL
 * step. Without an inline button, the only way to advance is via the
 * panel's `handleContinue` — which isn't reachable for last-step gates.
 */
function ReviewerTextEnvelope(args: {
  props: FieldRendererProps;
  value: { contentBundle?: unknown; [key: string]: unknown };
  summary: string | undefined;
}) {
  // The orchestrator stepper's outer Continue button is always visible for
  // midRun gates now. We commit `userResponse` via onChange so handleContinue
  // reads it from bufferedHitlValue when the outer button fires; the renderer
  // itself is read-only.
  const { props, value, summary } = args;
  const bundle =
    (value.contentBundle as { text?: string; url?: string } | undefined) ?? {};
  // Commit a default `userResponse` into the parent's bufferedHitlValue on
  // MOUNT (useEffect, not a useState initializer — calling the parent's
  // onChange/setState during render is a React anti-pattern and silently
  // no-ops). The orchestrator stepper's outer Continue button reads
  // bufferedHitlValue when it fires; without this commit the payload is `{}`
  // and the WayFlow reviewer subflow loops waiting for a non-empty
  // userResponse. `onChangeRef` keeps the effect dependency-stable so it runs
  // exactly once per gate.
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const defaultResponse = bundle.text ?? summary ?? "Approved.";
  useEffect(() => {
    void onChangeRef.current({ userResponse: defaultResponse });
  }, [defaultResponse]);
  return (
    <div className="flex flex-col gap-3">
      {summary ? (
        <p className="text-sm text-muted-foreground">{summary}</p>
      ) : null}
      {bundle.url ? (
        <p className="text-xs text-muted-foreground">{bundle.url}</p>
      ) : null}
      <div className="rounded-control border border-line bg-surface-muted p-3 whitespace-pre-wrap text-sm">
        {bundle.text ?? summary ?? "(no review content)"}
      </div>
    </div>
  );
}
