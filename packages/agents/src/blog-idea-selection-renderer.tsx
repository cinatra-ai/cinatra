"use client";

import { useState } from "react";
import type { FieldRendererProps } from "./field-renderer-registry";
import { SchemaOnlyFloorRenderer } from "./schema-field-renderer";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

// Host-bundled renderer for blog-pipeline's `idea_selection_gate`
// (cinatra#1796). It is keyed in RENDERER_KIND_TABLE under the neutral
// kind "blog-idea-selection" and activated by the DEDICATED binding id
// `@cinatra-ai/blog-pipeline-agent:idea-selection` (strict-id condition — see
// register-default-renderers.ts). The idea-chooser relocated OFF the shared
// (now RETIRED) reviewer binding onto this dedicated one
// (blog-pipeline-agent#40); that shared binding, its package and the
// reviewer-output dispatcher the inline chooser lived in were all deleted by the
// cinatra#1796 retirement teardown, so this is the sole idea-selection renderer.
//
// PAYLOAD CONTRACT (ground truth: this renderer's tests + the blog OAS
// idea_selection_gate
// InputMessageNode): the gate is an InputMessageNode whose one string output
// (`selectedIdeaJson`) becomes the WayFlow resume text (`userResponse`). The
// chosen idea is committed as JSON.stringify(idea) into BOTH keys. Nothing is
// selected or committed on mount (cinatra#3035, design app-artifact-review I.1):
// the person picks a row, and the card's Continue waits for that pick (the kind
// declares holdsContinueUntilPicked), so the run never resumes with no pick.

/**
 * The idea-selection field renderer. Reads the generated ideas from
 * `props.value.ideas` (surfaced from the gate's pendingApproval render input).
 * An empty offered list draws the binding's declared empty-state message;
 * otherwise, with no offered ideas, it degrades to the schema-driven floor
 * (SchemaOnlyFloorRenderer — the registry-bypass floor that never re-enters the
 * registry) so the HITL surface is never blank.
 */
export function BlogIdeaSelectionRenderer(props: FieldRendererProps) {
  const value = (props.value ?? {}) as {
    ideas?: unknown;
    summary?: string;
    [extraKey: string]: unknown;
  };
  const ideas = Array.isArray(value.ideas)
    ? (value.ideas as Array<Record<string, unknown>>)
    : null;
  if (!ideas || ideas.length === 0) {
    // cinatra#3035 (design I.1): an empty list draws the agent's declared message as written and commits nothing (the Continue stays held).
    const emptyMessage = props.bindingParams?.emptyStateMessage;
    if (ideas && typeof emptyMessage === "string" && emptyMessage.trim() !== "") {
      return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
    }
    return <SchemaOnlyFloorRenderer {...props} />;
  }
  const summary =
    typeof value.summary === "string" && value.summary.trim().length > 0
      ? value.summary
      : undefined;
  return (
    <>
      {summary ? (
        <p className="text-sm text-muted-foreground mb-2">{summary}</p>
      ) : null}
      <IdeaChooser
        ideas={ideas}
        onChange={props.onChange}
        disabled={props.disabled}
      />
    </>
  );
}

/**
 * Radio-per-idea chooser for the dedicated idea-selection binding. Commits the
 * chosen idea as
 * JSON.stringify(idea) into { selectedIdeaJson, userResponse } — the exact shape
 * idea_selection_gate + its downstream `selected_idea` passthrough seam expect.
 */
function IdeaChooser({
  ideas,
  onChange,
  disabled,
}: {
  ideas: Array<Record<string, unknown>>;
  onChange: (next: unknown) => void;
  disabled?: boolean;
}) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const commit = (idx: number) => {
    const json = JSON.stringify(ideas[idx]);
    void onChange({ selectedIdeaJson: json, userResponse: json });
  };
  const ideaLabel = (idea: Record<string, unknown>, idx: number) =>
    typeof idea.title === "string" && idea.title.trim().length > 0
      ? idea.title
      : `Idea ${idx + 1}`;
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
        value={selectedIndex === null ? "" : String(selectedIndex)}
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
