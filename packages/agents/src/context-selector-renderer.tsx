"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import type {
  FieldRendererCondition,
  FieldRendererProps,
} from "./field-renderer-registry";

// ---------------------------------------------------------------------------
// ContextSelector HITL Renderer.
//
// Interactive selection UI for an agent's contextSlot. The renderer
// expects the parent surface to PRE-POPULATE `value.candidates` with the
// resolved refs. The renderer does NOT call the resolver itself
// (separation: resolver runs on the server; renderer is presentational +
// selection-state).
//
// Display rules:
//   - Each ref is tagged with its source scope (project / team / org /
//     workspace / user).
//   - Refs are grouped by source scope, narrow→broad.
//   - Override/accumulate manifest mode is displayed in the header.
//   - readableOnly is reserved for a capability-registry gate; the
//     renderer reads the flag for a UI label only.
//   - `resolutionMode === "override"` → radio-style single-pick.
//     `resolutionMode === "accumulate"` → checkbox-style multi-pick
//     bounded by `minItems` / `maxItems`.
//
// Output value shape:
//   {
//     selectedRefs: ResolvedContextRef[],
//   }
// ---------------------------------------------------------------------------

// This renderer id is canonical. It is composed at render-time from the
// template packageName and is never persisted, so paused runs do not
// depend on renderer-id snapshots.
export const CONTEXT_SELECTOR_RENDERER_ID =
  "@cinatra-ai/context-selection-agent:context-selector";

export const isContextSelectorField: FieldRendererCondition = (_f, schema) =>
  (
    [
      CONTEXT_SELECTOR_RENDERER_ID,
      "context-selector",
    ] as string[]
  ).includes((schema as { ["x-renderer"]?: string })["x-renderer"] ?? "");

// ---------------------------------------------------------------------------
// Value shape
// ---------------------------------------------------------------------------

export type ContextSelectorSourceScope =
  | "user"
  | "team"
  | "organization"
  | "workspace"
  | "project";

export type ContextSelectorCandidate = {
  artifactId: string;
  representationRevisionId: string;
  semanticAssertionId: string;
  extension: string;
  sourceScope: ContextSelectorSourceScope;
  ownerId: string;
  /** Optional display fields the parent agent may supply (the resolver
   *  does NOT compute these; an UI-side enrichment step does). */
  displayName?: string;
  description?: string;
};

export type ContextSelectorValue = {
  /** What the runtime resolved before opening this gate.
   *  Provided by the parent surface (context-agent or HITL host). */
  candidates: ContextSelectorCandidate[];
  /** The user's selection. Subset of `candidates`. */
  selectedRefs: ContextSelectorCandidate[];
  /** Manifest data echoed from the slot — drives display only. */
  slotMeta?: {
    slotId: string;
    resolutionMode: "override" | "accumulate";
    selectionMode: "interactive" | "autonomous";
    minItems?: number;
    maxItems?: number;
    readableOnly?: boolean;
    acceptedArtifactExtensions: string[];
  };
};

function toContextSelectorValue(value: unknown): ContextSelectorValue {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    return {
      candidates: Array.isArray(v.candidates)
        ? (v.candidates as ContextSelectorCandidate[])
        : [],
      selectedRefs: Array.isArray(v.selectedRefs)
        ? (v.selectedRefs as ContextSelectorCandidate[])
        : [],
      slotMeta: (v.slotMeta && typeof v.slotMeta === "object"
        ? (v.slotMeta as ContextSelectorValue["slotMeta"])
        : undefined),
    };
  }
  return { candidates: [], selectedRefs: [] };
}

// ---------------------------------------------------------------------------
// Source-scope display helpers
// ---------------------------------------------------------------------------

const SCOPE_LABELS: Record<ContextSelectorSourceScope, string> = {
  project: "Project",
  user: "Personal",
  team: "Team",
  organization: "Organization",
  workspace: "Workspace",
};

const SCOPE_ORDER: ContextSelectorSourceScope[] = [
  "project",
  "user",
  "team",
  "organization",
  "workspace",
];

function scopeBadgeVariant(
  scope: ContextSelectorSourceScope,
): "default" | "secondary" | "outline" {
  // ScopeBadge palette would be ideal here, but the agents package
  // cannot easily import it (cross-package edge). Use the shadcn Badge
  // variant set as a near-substitute; the parent surface can override
  // by wrapping if needed.
  if (scope === "project") return "default";
  if (scope === "user") return "secondary";
  return "outline";
}

/** Group candidates by source scope, ordered narrow→broad. */
export function groupCandidatesByScope(
  candidates: ContextSelectorCandidate[],
): Array<{
  scope: ContextSelectorSourceScope;
  refs: ContextSelectorCandidate[];
}> {
  const byScope = new Map<
    ContextSelectorSourceScope,
    ContextSelectorCandidate[]
  >();
  for (const c of candidates) {
    if (!byScope.has(c.sourceScope)) byScope.set(c.sourceScope, []);
    byScope.get(c.sourceScope)!.push(c);
  }
  return SCOPE_ORDER.filter((s) => byScope.has(s)).map((s) => ({
    scope: s,
    refs: byScope.get(s)!,
  }));
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function ContextSelectorRenderer({
  value,
  onChange,
  disabled,
  fieldName,
}: FieldRendererProps) {
  const v = toContextSelectorValue(value);
  const grouped = useMemo(
    () => groupCandidatesByScope(v.candidates),
    [v.candidates],
  );

  const mode = v.slotMeta?.resolutionMode ?? "accumulate";
  const maxItems = v.slotMeta?.maxItems;
  const minItems = v.slotMeta?.minItems ?? 0;
  const readableOnly = v.slotMeta?.readableOnly === true;
  const isOverride = mode === "override";

  // `selectedKeys` is derived from the same composite-key helper used by
  // toggles, avoiding two sources of truth for selection identity.

  // Use the replay-safe composite identity (artifactId +
  // representationRevisionId + semanticAssertionId) for selection equality.
  // Keying on artifactId alone would collapse multiple eligible assertions
  // on the same artifact (different extensions) into one row.
  const refKey = (r: ContextSelectorCandidate): string =>
    `${r.artifactId}|${r.representationRevisionId}|${r.semanticAssertionId}`;
  const selectedKeys = new Set(v.selectedRefs.map(refKey));
  const isAtCap =
    typeof maxItems === "number" && v.selectedRefs.length >= maxItems;

  // Centralize the userResponse envelope emit so toggle AND clear (and any
  // future caller) both produce a fresh JSON envelope. Without this, the
  // Clear button at the footer emitted `{ ...v, selectedRefs: [] }` WITHOUT
  // updating userResponse; the parent's bufferedHitlValue then merged the
  // new selectedRefs over a STALE userResponse string, and userResponse-wins
  // precedence sent the obsolete payload to WayFlow.
  const emit = (nextSelected: ContextSelectorCandidate[]) => {
    const userResponse = JSON.stringify({
      slotId: v.slotMeta?.slotId,
      resolutionMode: v.slotMeta?.resolutionMode,
      selectedRefs: nextSelected,
    });
    onChange?.({
      ...v,
      selectedRefs: nextSelected,
      userResponse,
    });
  };

  const handleToggle = (ref: ContextSelectorCandidate) => {
    if (disabled) return;
    const key = refKey(ref);
    let nextSelected: ContextSelectorCandidate[];
    if (isOverride) {
      // Single-pick: replace selection with the clicked ref.
      nextSelected = [ref];
    } else {
      const already = selectedKeys.has(key);
      if (already) {
        nextSelected = v.selectedRefs.filter((r) => refKey(r) !== key);
      } else {
        // Cap at maxItems when defined. The UI also disables unchecked
        // checkboxes at-cap (see render below) — this is a defense-in
        // -depth guard for keyboard / programmatic toggles.
        if (isAtCap) return;
        nextSelected = [...v.selectedRefs, ref];
      }
    }
    emit(nextSelected);
  };

  if (v.candidates.length === 0) {
    // When minItems > 0 the slot is REQUIRED; the parent agent must block
    // advancing in that case (the renderer cannot enforce, but the UI copy
    // reflects the reality). minItems === 0 (optional) is the case where the
    // agent runs without context.
    const isRequired = minItems > 0;
    return (
      <Card className="border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle className="text-base">
            {v.slotMeta?.slotId ?? fieldName ?? "Context"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isRequired ? (
            <p className="text-sm text-destructive">
              This slot requires at least {minItems} context{" "}
              {minItems === 1 ? "artifact" : "artifacts"}, but no
              eligible artifacts are available for{" "}
              <code className="text-xs">
                {v.slotMeta?.slotId ?? "this slot"}
              </code>
              . Add a matching artifact in your library before
              continuing — the agent cannot proceed.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No eligible context artifacts available for this slot. The
              agent will run without context for{" "}
              <code className="text-xs">
                {v.slotMeta?.slotId ?? "this slot"}
              </code>
              .
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader className="flex flex-col gap-2">
        <CardTitle className="text-base">
          {v.slotMeta?.slotId ?? fieldName ?? "Context"}
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">
            {isOverride ? "Pick one (override)" : "Combine (accumulate)"}
          </Badge>
          {typeof maxItems === "number" && (
            <span>up to {maxItems}</span>
          )}
          {minItems > 0 && <span>at least {minItems}</span>}
          {readableOnly && (
            <Badge variant="outline">readable-only</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {grouped.map((group, idx) => (
          <div key={group.scope} className="flex flex-col gap-2">
            {idx > 0 && <Separator />}
            <div className="flex items-center gap-2">
              <Badge variant={scopeBadgeVariant(group.scope)}>
                {SCOPE_LABELS[group.scope]}
              </Badge>
              <span className="text-xs text-muted-foreground">
                ({group.refs.length}{" "}
                {group.refs.length === 1 ? "match" : "matches"})
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {group.refs.map((ref) => {
                const key = refKey(ref);
                const isSelected = selectedKeys.has(key);
                // When accumulate mode is at the maxItems cap, DISABLE
                // unchecked checkboxes so the cap is visible at the UI
                // surface instead of a silent no-op on click.
                const capBlocked = !isOverride && isAtCap && !isSelected;
                return (
                  <Label
                    key={key}
                    className="flex items-start gap-2 rounded-control border border-line bg-surface-strong p-2"
                  >
                    <Checkbox
                      checked={isSelected}
                      disabled={disabled === true || capBlocked}
                      onCheckedChange={() => handleToggle(ref)}
                      aria-label={`Select ${ref.displayName ?? ref.artifactId}`}
                    />
                    <div className="flex flex-1 flex-col gap-1">
                      <span className="text-sm font-medium text-foreground">
                        {ref.displayName ?? ref.artifactId}
                      </span>
                      {ref.description && (
                        <span className="text-xs text-muted-foreground">
                          {ref.description}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {ref.extension}
                      </span>
                    </div>
                  </Label>
                );
              })}
            </div>
          </div>
        ))}
        <div className="flex items-center justify-between border-t border-line pt-2 text-xs text-muted-foreground">
          <span>
            {v.selectedRefs.length} selected
            {typeof maxItems === "number" && ` / ${maxItems}`}
            {isAtCap && !isOverride && (
              <span className="ml-2 text-destructive">
                — maximum selected
              </span>
            )}
            {minItems > 0 && v.selectedRefs.length < minItems && (
              <span className="ml-2 text-destructive">
                — need at least {minItems}
              </span>
            )}
          </span>
          {!isOverride && v.selectedRefs.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled === true}
              onClick={() => emit([])}
            >
              Clear
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
