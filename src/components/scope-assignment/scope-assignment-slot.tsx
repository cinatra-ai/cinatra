"use client";

// ---------------------------------------------------------------------------
// One declared context slot on the assignment page's Artifacts pane, for ONE
// exact scope (cinatra#2814, per-scope assignment S2; the drawing's per-agent
// assignment page).
//
// The drawing draws "one group per slot: the slot's name, the artifact kind it
// takes and its bounds, and beneath them the same labelled typeahead the
// Skills pane uses", with the same searching / no matches / search failed
// states and the same chosen-row chrome. There is no cap line: storage is
// uncapped, and a slot at its upper bound greys its field with the hint that
// says what to do about it. A slot with nothing chosen is a normal state.
//
// Every choice is made by hand and saved at once; a refusal takes the row
// back out and names the store's typed reason (an artifact the reader cannot
// see, a wrong kind, a slot the agent no longer declares). The move controls
// reorder the slot's rows for THIS scope.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { StatusPill } from "@/components/ui/status-pill";
import { EntitySearchCombobox } from "@/components/entity-search-combobox";
import {
  assignScopeContextArtifactAction,
  removeScopeContextArtifactAction,
  reorderScopeContextArtifactsAction,
  searchScopeContextArtifactsAction,
} from "@/lib/scope-assignment/scope-assignment-actions";
import {
  contextSlotBoundHint,
  scopeAssignmentActionRefusalText,
  type ScopeAssignmentActionResult,
  type ScopeAssignmentActionTarget,
  type ScopeAssignmentArtifactCandidate,
  type ScopeAssignmentArtifactRow,
  type ScopeAssignmentSlotGroup,
} from "@/lib/scope-assignment/scope-assignment-model";
import { cn } from "@/lib/utils";

/** A chosen row's title: a row the reader may not see is never named. */
export function scopeArtifactRowTitle(row: ScopeAssignmentArtifactRow): string {
  if (row.status === "not-visible") return "An artifact you can't see";
  if (row.status === "deleted") return row.title ?? "A deleted artifact";
  return row.title ?? "Untitled artifact";
}

/** The pill a degraded row carries; `null` for a row in order. */
export function scopeArtifactRowPill(row: ScopeAssignmentArtifactRow): string | null {
  switch (row.status) {
    case "deleted":
      return "Deleted";
    case "not-visible":
      return "Not visible here";
    case "incompatible":
      return "No longer available";
    default:
      return null;
  }
}

type ArtifactPickerItem = {
  id: string;
  name: string;
  secondary: string;
  candidate: ScopeAssignmentArtifactCandidate;
};

export function ScopeAssignmentSlot({
  target,
  fieldId,
  group,
  canWrite,
}: {
  target: ScopeAssignmentActionTarget;
  fieldId: string;
  group: ScopeAssignmentSlotGroup;
  canWrite: boolean;
}) {
  const [rows, setRows] = useState<ScopeAssignmentArtifactRow[]>(group.rows);
  const [savingIds, setSavingIds] = useState<readonly string[]>([]);
  const [failures, setFailures] = useState<readonly { key: string; message: string }[]>([]);
  // A reorder rewrites the whole slot's order, so while one is in flight the
  // slot takes no other edit: a rollback to the order before it can then never
  // hide an addition or bring back a removal made in the meantime.
  const [reordering, setReordering] = useState(false);
  const [, startTransition] = useTransition();

  const atBound = group.maxItems !== null && rows.length >= group.maxItems;
  const boundHint = contextSlotBoundHint(rows.length, group.maxItems ?? undefined);
  const busy = (id: string) => savingIds.includes(id);
  const clearFailure = (key: string) => setFailures((prev) => prev.filter((f) => f.key !== key));
  const recordFailure = (key: string, message: string) =>
    setFailures((prev) => [...prev.filter((f) => f.key !== key), { key, message }]);

  const run = async (write: () => Promise<ScopeAssignmentActionResult>) => {
    try {
      return await write();
    } catch {
      return { ok: false, reason: "network" } as const;
    }
  };

  const handlePick = (item: ArtifactPickerItem) => {
    const { candidate } = item;
    if (reordering || atBound || rows.some((r) => r.artifactId === candidate.artifactId)) return;
    setRows((prev) => [
      ...prev,
      { artifactId: candidate.artifactId, title: candidate.title, kindLabel: candidate.kindLabel, status: "ok" },
    ]);
    setSavingIds((prev) => [...prev, candidate.artifactId]);
    clearFailure(candidate.artifactId);
    startTransition(async () => {
      const result = await run(() =>
        assignScopeContextArtifactAction(target, group.slotId, candidate.artifactId),
      );
      setSavingIds((prev) => prev.filter((id) => id !== candidate.artifactId));
      if (!result.ok) {
        setRows((prev) => prev.filter((r) => r.artifactId !== candidate.artifactId));
        recordFailure(
          candidate.artifactId,
          `Couldn't add ${candidate.title}: ${scopeAssignmentActionRefusalText(result.reason)}. Nothing was changed.`,
        );
      }
    });
  };

  const handleRemove = (row: ScopeAssignmentArtifactRow) => {
    if (reordering || busy(row.artifactId)) return;
    const title = scopeArtifactRowTitle(row);
    setSavingIds((prev) => [...prev, row.artifactId]);
    clearFailure(row.artifactId);
    startTransition(async () => {
      const result = await run(() =>
        removeScopeContextArtifactAction(target, group.slotId, row.artifactId),
      );
      setSavingIds((prev) => prev.filter((id) => id !== row.artifactId));
      if (result.ok) {
        setRows((prev) => prev.filter((r) => r.artifactId !== row.artifactId));
      } else {
        recordFailure(
          row.artifactId,
          `Couldn't remove ${title}: ${scopeAssignmentActionRefusalText(result.reason)}. Nothing was changed.`,
        );
      }
    });
  };

  const handleMove = (index: number, delta: -1 | 1) => {
    const to = index + delta;
    if (to < 0 || to >= rows.length || reordering || savingIds.length > 0) return;
    const before = rows;
    const next = [...rows];
    [next[index], next[to]] = [next[to], next[index]];
    setRows(next);
    setReordering(true);
    clearFailure("order");
    startTransition(async () => {
      const result = await run(() =>
        reorderScopeContextArtifactsAction(
          target,
          group.slotId,
          next.map((r) => r.artifactId),
        ),
      );
      setReordering(false);
      if (!result.ok) {
        setRows(before);
        recordFailure(
          "order",
          `Couldn't reorder ${group.title}: ${scopeAssignmentActionRefusalText(result.reason)}. Nothing was changed.`,
        );
      }
    });
  };

  return (
    <div
      data-slot="scope-context-slot"
      data-slot-id={group.slotId}
      data-can-write={canWrite ? "true" : "false"}
      className="flex flex-col gap-1.5 border-b border-line py-4 last:border-b-0"
    >
      <div className="text-sm font-bold text-foreground">{group.title}</div>
      <p data-slot="scope-context-slot-takes" className="text-xs text-muted-foreground">
        {group.takesText}
      </p>

      {canWrite ? (
        <>
          <Label htmlFor={fieldId} className="mt-1 text-sm font-normal text-foreground">
            Which artifact should fill this slot?
          </Label>
          <EntitySearchCombobox<ArtifactPickerItem>
            id={fieldId}
            placeholder={group.placeholder}
            emptyText="No matches."
            disabled={atBound || reordering}
            clearQueryOnPick
            excludeIds={rows.map((r) => r.artifactId)}
            onSearch={async (query, page) => {
              const response = await searchScopeContextArtifactsAction(target, group.slotId, query, page);
              if (!response.ok) throw new Error(response.reason);
              return {
                results: response.results.map((c) => ({
                  id: c.artifactId,
                  name: c.title,
                  secondary: c.kindLabel,
                  candidate: c,
                })),
                hasMore: response.hasMore,
              };
            }}
            renderRow={(item) => (
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-foreground">{item.name}</span>
                <span className="truncate text-xs text-muted-foreground">{item.secondary}</span>
              </span>
            )}
            onPick={handlePick}
          />
        </>
      ) : null}

      {boundHint ? (
        <p data-slot="scope-context-slot-bound" className="text-xs text-muted-foreground">
          {boundHint}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p data-slot="scope-context-slot-empty" className="text-xs text-muted-foreground">
          No artifact chosen. The run uses what it finds in its own context.
        </p>
      ) : (
        <ul className="mt-1 flex flex-col">
          {rows.map((row, index) => {
            const isLast = index === rows.length - 1;
            const saving = busy(row.artifactId);
            const pill = scopeArtifactRowPill(row);
            const title = scopeArtifactRowTitle(row);
            return (
              <li
                key={row.artifactId}
                data-slot="scope-context-row"
                data-artifact-id={row.artifactId}
                data-status={saving ? "saving" : row.status}
                className={cn(
                  "flex items-center gap-3 py-2",
                  !isLast && "border-b border-line",
                  saving && "opacity-60",
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span
                    className={cn(
                      "truncate text-sm font-semibold",
                      row.status === "ok" && !saving ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {title}
                  </span>
                  {row.kindLabel ? (
                    <span className="truncate text-xs text-muted-foreground">{row.kindLabel}</span>
                  ) : null}
                </div>
                {saving ? (
                  <StatusPill status="hold" className="shrink-0">
                    Saving
                  </StatusPill>
                ) : pill ? (
                  <StatusPill status="hold" className="shrink-0">
                    {pill}
                  </StatusPill>
                ) : null}
                {canWrite ? (
                  <div className="flex shrink-0 items-center">
                    <Button
                      type="button"
                      data-slot="scope-context-move-up"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move ${title} up`}
                      onClick={() => handleMove(index, -1)}
                      disabled={index === 0 || reordering || savingIds.length > 0}
                      className="size-8 rounded-control text-muted-foreground disabled:opacity-40"
                    >
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      data-slot="scope-context-move-down"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move ${title} down`}
                      onClick={() => handleMove(index, 1)}
                      disabled={isLast || reordering || savingIds.length > 0}
                      className="size-8 rounded-control text-muted-foreground disabled:opacity-40"
                    >
                      <ArrowDown className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      data-slot="scope-context-remove"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${title}`}
                      onClick={() => handleRemove(row)}
                      disabled={saving || reordering}
                      className="size-8 rounded-control text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                    >
                      {saving ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {failures.length > 0 ? (
        <div
          data-slot="scope-context-error"
          role="alert"
          className="mt-1 flex flex-col gap-1 rounded-control border border-destructive/35 bg-destructive/6 px-2.75 py-2 text-xs text-destructive"
        >
          {failures.map((failure) => (
            <p key={failure.key}>{failure.message}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
