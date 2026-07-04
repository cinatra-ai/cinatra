"use client";

import { useEffect, useRef, useState } from "react";
import type { FieldRendererProps } from "./field-renderer-registry";
import { EmailDraftsReviewRenderer } from "./email-drafts-review-renderer";
import { CampaignRecipientsReviewRenderer } from "./campaign-recipients-review-renderer";
import { SchemaFieldRenderer } from "./schema-field-renderer";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

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
  // #839: idea-selection gate. When the compiled InputMessageNode schema
  // requires a `selectedIdeaJson` string AND the gate's `ideas[]` render input
  // is present (surfaced from pendingApproval by execution.ts), render an idea
  // chooser INSTEAD of the reviewer text envelope — whose mount auto-commit
  // would otherwise post a placeholder userResponse as the gate's
  // selectedIdeaJson output and yield an empty draft. Strictly gated on the
  // selectedIdeaJson schema so pure-approval reviewer gates and the #824
  // context-selector path are untouched.
  const schema = (props.schema ?? {}) as {
    required?: unknown;
    properties?: Record<string, { type?: string } | undefined>;
  };
  const requiresSelectedIdeaJson =
    Array.isArray(schema.required) &&
    schema.required.includes("selectedIdeaJson") &&
    schema.properties?.selectedIdeaJson?.type === "string";
  const ideas = Array.isArray(value.ideas)
    ? (value.ideas as Array<Record<string, unknown>>)
    : null;
  if (requiresSelectedIdeaJson && ideas && ideas.length > 0) {
    return (
      <>
        <SummaryLine summary={summary} />
        <IdeaChooserRenderer
          ideas={ideas}
          onChange={props.onChange}
          disabled={props.disabled}
        />
      </>
    );
  }
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

/**
 * #839 idea-selection chooser for blog-pipeline's `idea_selection_gate`.
 *
 * The gate is an InputMessageNode whose one string output (`selectedIdeaJson`)
 * becomes the WayFlow resume text (`userResponse`). We render a radio list of
 * the generated ideas and commit the chosen idea as
 * `JSON.stringify(idea)` into BOTH `selectedIdeaJson` (seam clarity) and
 * `userResponse` (the load-bearing resume text). The gate still PAUSES the run
 * (a real HITL interrupt); this replaces the placeholder-committing text
 * envelope so a human's pick actually reaches the draft writer.
 *
 * A default selection (ideas[0]) is committed on mount so the buffered value is
 * always a valid, offered idea — the seam validates it by title and the run can
 * never resume with an empty/placeholder selection. The user may change the
 * pick before pressing the panel's Continue.
 */
function IdeaChooserRenderer({
  ideas,
  onChange,
  disabled,
}: {
  ideas: Array<Record<string, unknown>>;
  onChange: (next: unknown) => void;
  disabled?: boolean;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const commit = (idx: number) => {
    const json = JSON.stringify(ideas[idx]);
    void onChange({ selectedIdeaJson: json, userResponse: json });
  };
  // Commit the default selection once on mount (an effect — never call the
  // parent setter during render). Uses the mount-time `onChange`, which is
  // valid; radio changes below re-commit via the current-render closure.
  useEffect(() => {
    commit(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const ideaLabel = (idea: Record<string, unknown>, idx: number) =>
    (typeof idea.title === "string" && idea.title.trim().length > 0
      ? idea.title
      : `Idea ${idx + 1}`);
  const ideaSummary = (idea: Record<string, unknown>) =>
    (typeof idea.summary === "string" && idea.summary) ||
    (typeof idea.angle === "string" && idea.angle) ||
    (typeof idea.description === "string" && idea.description) ||
    "";
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        Select one blog idea to draft.
      </p>
      <RadioGroup
        aria-label="Select one blog idea to draft"
        value={String(selectedIndex)}
        disabled={disabled}
        onValueChange={(v) => {
          const idx = Number(v);
          setSelectedIndex(idx);
          commit(idx);
        }}
        className="flex flex-col gap-2"
      >
        {ideas.map((idea, idx) => {
          const selected = idx === selectedIndex;
          const sub = ideaSummary(idea);
          return (
            <label
              key={idx}
              className={`flex cursor-pointer items-start gap-2 rounded-control border p-3 text-sm ${
                selected ? "border-primary bg-surface-muted" : "border-line"
              } ${disabled ? "pointer-events-none opacity-60" : ""}`}
            >
              <RadioGroupItem value={String(idx)} className="mt-1" />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{ideaLabel(idea, idx)}</span>
                {sub ? (
                  <span className="text-muted-foreground">{sub}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </div>
  );
}
