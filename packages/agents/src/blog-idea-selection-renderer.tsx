"use client";

import { useState } from "react";
import { SchemaOnlyFloorRenderer } from "./schema-field-renderer";
import {
  choiceBody,
  choiceReference,
  choiceTitle,
  offerableChoices,
  statedReason,
  type FieldRendererProps,
  type OfferedChoice,
} from "./field-renderer-registry";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

// Host-bundled renderer for the idea-selection gate (cinatra#1796). It is keyed
// in RENDERER_KIND_TABLE under the neutral kind "blog-idea-selection" and
// activated by the DEDICATED binding id the declaring pack names (strict-id
// condition — see register-default-renderers.ts).
//
// PAYLOAD CONTRACT (cinatra#3035, epic #3023 W11; plan (C) §5.1, §8.4 "the gate
// renderer"). The gate is an InputMessageNode whose one string output
// (`selectedIdeaJson`) becomes the WayFlow resume text (`userResponse`), and the
// pick is committed as JSON into BOTH keys. NOTHING IS PICKED FOR ANYONE: the
// list starts with no selection and commits only what a person actually chooses,
// and what it commits is the REFERENCE the offer named, never a title. Both the
// reference shape and the title/body split are the generic offered-choice road
// on `field-renderer-registry.ts`, which knows no pack.

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
  const offered = offerableChoices(value.ideas);
  const reason = statedReason(value.reason);
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
  ideas: OfferedChoice[];
  onChange: (next: unknown) => void;
  disabled?: boolean;
}) {
  // No index: nothing is chosen until someone chooses.
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const commit = (idx: number) => {
    const reference = choiceReference(ideas[idx]);
    if (!reference) return;
    const json = JSON.stringify(reference);
    void onChange({ selectedIdeaJson: json, userResponse: json });
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
          const sub = choiceBody(idea);
          return (
            <label
              key={idx}
              className={`flex cursor-pointer items-start gap-2 rounded-control border p-3 text-sm ${
                selected ? "border-primary bg-surface-muted" : "border-line"
              } ${disabled ? "pointer-events-none opacity-60" : ""}`}
            >
              <RadioGroupItem value={String(idx)} className="mt-1" />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{choiceTitle(idea, idx, "Idea")}</span>
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
