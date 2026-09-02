"use client";

import { useState } from "react";
import type { FieldRendererProps } from "./field-renderer-registry";
import { SchemaOnlyFloorRenderer } from "./schema-field-renderer";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

// Host-bundled renderer for blog-pipeline's `idea_selection_gate`
// (cinatra#1796). It is keyed in RENDERER_KIND_TABLE under the neutral
// kind "blog-idea-selection" and activated by the DEDICATED binding id
// `@cinatra-ai/blog-pipeline-agent:idea-selection` (strict-id condition — see
// register-default-renderers.ts).
//
// PAYLOAD CONTRACT (cinatra#3035, epic #3023 W11; plan (C) §5.1, §8.4 "the gate
// renderer"). The gate is an InputMessageNode whose one string output
// (`selectedIdeaJson`) becomes the WayFlow resume text (`userResponse`), and the
// chosen idea is committed as JSON into BOTH keys. TWO THINGS CHANGED IN W11:
//
//   NOTHING IS PICKED FOR ANYONE. The renderer used to commit `ideas[0]` on
//   mount, so a person who only pressed Continue drafted whichever idea happened
//   to be first and never knew they had chosen. The list now starts with no
//   selection and commits only what a person actually picks; the gate's own
//   validation refuses an empty pick with a stated reason, which is the answer a
//   silent default was hiding.
//
//   WHAT IS COMMITTED IS A REFERENCE, NEVER A TITLE. The pick is
//   `{artifactId, representationRevisionId}` — the idea artifact and the exact
//   revision the list offered — because that is what the reservation row is
//   written from and what "this draft came from this idea" means. A title is not
//   an identity: two ideas may share one, and rewriting an idea changes it.

type OfferedIdea = {
  artifactId?: unknown;
  representationRevisionId?: unknown;
  title?: unknown;
  text?: unknown;
  [extraKey: string]: unknown;
};

type IdeaReference = { artifactId: string; representationRevisionId: string };

/** The reference an offered entry names, or null when it names none — an entry
 *  that cannot be committed is not offered, since picking it could only fail at
 *  the gate. */
function referenceOf(idea: OfferedIdea): IdeaReference | null {
  const artifactId = idea.artifactId;
  const representationRevisionId = idea.representationRevisionId;
  if (typeof artifactId !== "string" || artifactId.length === 0) return null;
  if (
    typeof representationRevisionId !== "string" ||
    representationRevisionId.length === 0
  ) {
    return null;
  }
  return { artifactId, representationRevisionId };
}

/**
 * The idea-selection field renderer. Reads the offered ideas from
 * `props.value.ideas` (surfaced from the gate's pendingApproval render input)
 * and the run-ending sentence, when there is one, from `props.value.reason`.
 *
 * With no offered ideas and a stated reason it draws the reason: "an empty list
 * ends the run with a plain reason" is something a person must be able to READ,
 * not a state the surface leaves blank. With no ideas and no reason it degrades
 * to the schema-driven floor as before.
 */
export function BlogIdeaSelectionRenderer(props: FieldRendererProps) {
  const value = (props.value ?? {}) as {
    ideas?: unknown;
    summary?: string;
    reason?: unknown;
    [extraKey: string]: unknown;
  };
  const offered = Array.isArray(value.ideas)
    ? (value.ideas as OfferedIdea[]).filter((idea) => referenceOf(idea) !== null)
    : [];
  const reason =
    typeof value.reason === "string" && value.reason.trim().length > 0
      ? value.reason.trim()
      : null;
  if (offered.length === 0) {
    if (reason) {
      return (
        <p className="text-sm text-muted-foreground" role="status">
          {reason}
        </p>
      );
    }
    // Never blank: no offered ideas and nothing said -> schema-driven floor.
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
        ideas={offered}
        onChange={props.onChange}
        disabled={props.disabled}
      />
    </>
  );
}

/**
 * Radio-per-idea chooser. Commits `JSON.stringify({artifactId,
 * representationRevisionId})` into { selectedIdeaJson, userResponse } — and only
 * ever in response to a person choosing.
 */
function IdeaChooser({
  ideas,
  onChange,
  disabled,
}: {
  ideas: OfferedIdea[];
  onChange: (next: unknown) => void;
  disabled?: boolean;
}) {
  // No index: nothing is chosen until someone chooses.
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const commit = (idx: number) => {
    const reference = referenceOf(ideas[idx]);
    if (!reference) return;
    const json = JSON.stringify(reference);
    void onChange({ selectedIdeaJson: json, userResponse: json });
  };
  const ideaLabel = (idea: OfferedIdea, idx: number) =>
    typeof idea.title === "string" && idea.title.trim().length > 0
      ? idea.title
      : `Idea ${idx + 1}`;
  // The idea's own words, below its title. An idea is one piece of plain text
  // whose first line is the title, so what is shown here is the rest of it.
  const ideaBody = (idea: OfferedIdea) => {
    const text = typeof idea.text === "string" ? idea.text : "";
    const body = text.split(/\r?\n/).slice(1).join("\n").trim();
    return body.length > 0 ? body : "";
  };
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
          const sub = ideaBody(idea);
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
                  <span className="text-muted-foreground whitespace-pre-line">{sub}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </div>
  );
}
