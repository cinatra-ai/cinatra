"use client";

// ---------------------------------------------------------------------------
// The assignment page's Skills pane, for ONE exact scope (cinatra#2814,
// per-scope assignment S2; the drawing's per-agent assignment page).
//
// The chooser, the chosen rows and each of their states are the drawing's,
// "unchanged from the section this page took them from": a labelled typeahead
// that narrows on the server, chosen skills as removable rows beneath it, a
// count hint that always states how many of the five allowed are chosen, the
// field closed off at five, no floor on removal, and saves that happen at once
// with a visible in-flight state and a rollback plus an explanation on
// failure.
//
// THE CONTROLS FOLLOW THE SERVER'S DECISION. `canWrite` is S1's decision for
// this exact scope, computed on the server; when it refuses, the field and the
// remove controls do not render and the refusal is said in words. The controls
// are affordances only: every write re-resolves the package, the scope and the
// reader's authority on the server, which is the enforcement.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";
import { EntitySearchCombobox } from "@/components/entity-search-combobox";
import {
  assignScopeSkillAction,
  removeScopeSkillAction,
  searchScopeAssignableSkillsAction,
} from "@/lib/scope-assignment/scope-assignment-actions";
import {
  SCOPE_ASSIGNMENT_SKILLS_PER_SCOPE,
  scopeAssignmentActionRefusalText,
  type ScopeAssignmentActionResult,
  type ScopeAssignmentActionTarget,
  type ScopeAssignmentSkillCandidate,
  type ScopeAssignmentSkillRow,
  type ScopeAssignmentSkillStatus,
  type ScopeAssignmentSurface,
} from "@/lib/scope-assignment/scope-assignment-model";
import { cn } from "@/lib/utils";

/** The pill a chosen row's condition renders. */
export function scopeSkillStatusPill(status: ScopeAssignmentSkillStatus): {
  status: StatusPillStatus;
  label: string;
} {
  switch (status) {
    case "ok":
      return { status: "approved", label: "Active" };
    case "archived":
      return { status: "hold", label: "Archived" };
    case "role-changed":
      return { status: "hold", label: "Role changed" };
    case "missing":
      return { status: "hold", label: "Not installed" };
    default:
      return { status: "hold", label: "Unavailable" };
  }
}

/** The count hint: always how many of the five are chosen, and at five what
 *  to do about it. */
export function scopeSkillsCountHint(
  count: number,
  surface: ScopeAssignmentSurface,
  cap: number = SCOPE_ASSIGNMENT_SKILLS_PER_SCOPE,
): string {
  const noun = surface === "assistant" ? "assistant" : "agent";
  return count >= cap
    ? `${count} of ${cap} skills chosen. Remove one to choose another.`
    : `${count} of ${cap} skills chosen. A chosen skill reaches this ${noun} on every run, alongside the ones it picks up on its own.`;
}

type SkillPickerItem = {
  id: string;
  name: string;
  secondary: string;
  candidate: ScopeAssignmentSkillCandidate;
};

function secondaryLine(displayName: string, vendorName: string | null): string {
  return vendorName ? `${displayName} · by ${vendorName}` : displayName;
}

export function ScopeAssignmentSkills({
  target,
  fieldId,
  initialRows,
  canWrite,
  readOnlyMessage,
}: {
  target: ScopeAssignmentActionTarget;
  fieldId: string;
  initialRows: ScopeAssignmentSkillRow[];
  canWrite: boolean;
  readOnlyMessage?: string | null;
}) {
  const [rows, setRows] = useState<ScopeAssignmentSkillRow[]>(initialRows);
  const [savingIds, setSavingIds] = useState<readonly string[]>([]);
  // One message per skill: two changes can fail at once, and a single slot
  // would let the second refusal silently replace the first.
  const [failures, setFailures] = useState<readonly { skillId: string; message: string }[]>([]);
  const [, startTransition] = useTransition();

  const cap = SCOPE_ASSIGNMENT_SKILLS_PER_SCOPE;
  const atCap = rows.length >= cap;
  const busy = (id: string) => savingIds.includes(id);
  const clearFailure = (skillId: string) =>
    setFailures((prev) => prev.filter((f) => f.skillId !== skillId));
  const recordFailure = (skillId: string, message: string) =>
    setFailures((prev) => [...prev.filter((f) => f.skillId !== skillId), { skillId, message }]);
  const noun = target.surface === "assistant" ? "assistant" : "agent";

  const run = async (write: () => Promise<ScopeAssignmentActionResult>) => {
    try {
      return await write();
    } catch {
      return { ok: false, reason: "network" } as const;
    }
  };

  const handlePick = (item: SkillPickerItem) => {
    const { candidate } = item;
    if (rows.length >= cap || rows.some((r) => r.skillId === candidate.skillId)) return;
    setRows((prev) => [
      ...prev,
      {
        skillId: candidate.skillId,
        skillName: candidate.skillName,
        displayName: candidate.displayName,
        vendorName: candidate.vendorName,
        status: "ok",
      },
    ]);
    setSavingIds((prev) => [...prev, candidate.skillId]);
    clearFailure(candidate.skillId);
    startTransition(async () => {
      const result = await run(() => assignScopeSkillAction(target, candidate.skillId));
      setSavingIds((prev) => prev.filter((id) => id !== candidate.skillId));
      if (!result.ok) {
        setRows((prev) => prev.filter((r) => r.skillId !== candidate.skillId));
        recordFailure(
          candidate.skillId,
          `Couldn't add ${candidate.skillName}: ${scopeAssignmentActionRefusalText(result.reason)}. Nothing was changed.`,
        );
      }
    });
  };

  const handleRemove = (row: ScopeAssignmentSkillRow) => {
    if (busy(row.skillId)) return;
    setSavingIds((prev) => [...prev, row.skillId]);
    clearFailure(row.skillId);
    startTransition(async () => {
      const result = await run(() => removeScopeSkillAction(target, row.skillId));
      setSavingIds((prev) => prev.filter((id) => id !== row.skillId));
      if (result.ok) {
        setRows((prev) => prev.filter((r) => r.skillId !== row.skillId));
      } else {
        recordFailure(
          row.skillId,
          `Couldn't remove ${row.skillName}: ${scopeAssignmentActionRefusalText(result.reason)}. Nothing was changed.`,
        );
      }
    });
  };

  return (
    <div data-slot="scope-skills" data-can-write={canWrite ? "true" : "false"} className="flex flex-col gap-1.5">
      {canWrite ? (
        <>
          <Label htmlFor={fieldId} className="text-sm font-normal text-foreground">
            {`Which skills should this ${noun} always use?`}
          </Label>
          <EntitySearchCombobox<SkillPickerItem>
            id={fieldId}
            placeholder="Search installed skills…"
            emptyText="No matches."
            disabled={atCap}
            clearQueryOnPick
            excludeIds={rows.map((r) => r.skillId)}
            onSearch={async (query, page) => {
              const response = await searchScopeAssignableSkillsAction(target, query, page);
              // A refusal is a failure to look, never an empty result.
              if (!response.ok) throw new Error(response.reason);
              return {
                results: response.results.map((c) => ({
                  id: c.skillId,
                  name: c.skillName,
                  secondary: secondaryLine(c.displayName, c.vendorName),
                  candidate: c,
                })),
                hasMore: response.hasMore,
              };
            }}
            renderRow={(item) => (
              <div className="flex w-full items-center gap-2">
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate text-foreground">{item.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{item.secondary}</span>
                </span>
                <StatusPill
                  status={item.candidate.status === "locked" ? "idle" : "approved"}
                  className="shrink-0"
                >
                  {item.candidate.status === "locked" ? "Locked" : "Active"}
                </StatusPill>
              </div>
            )}
            onPick={handlePick}
          />
        </>
      ) : (
        <p data-slot="scope-skills-read-only" className="text-sm text-muted-foreground">
          {readOnlyMessage ?? "These assignments can't be changed from this page."}
        </p>
      )}

      <p data-slot="scope-skills-count" className="text-xs text-muted-foreground">
        {scopeSkillsCountHint(rows.length, target.surface, cap)}
      </p>

      {rows.length > 0 ? (
        <ul className="mt-1 flex flex-col">
          {rows.map((row, index) => {
            const isLast = index === rows.length - 1;
            const saving = busy(row.skillId);
            const pill = scopeSkillStatusPill(row.status);
            return (
              <li
                key={row.skillId}
                data-slot="scope-skills-row"
                data-skill-id={row.skillId}
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
                    {row.skillName}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {secondaryLine(row.displayName, row.vendorName)}
                  </span>
                </div>
                <StatusPill status={saving ? "hold" : pill.status} className="shrink-0">
                  {saving ? "Saving" : pill.label}
                </StatusPill>
                {canWrite ? (
                  <Button
                    type="button"
                    data-slot="scope-skills-remove"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${row.skillName}`}
                    onClick={() => handleRemove(row)}
                    disabled={saving}
                    className="size-8 rounded-control text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                  >
                    {saving ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {failures.length > 0 ? (
        <div
          data-slot="scope-skills-error"
          role="alert"
          className="mt-1 flex flex-col gap-1 rounded-control border border-destructive/35 bg-destructive/6 px-2.75 py-2 text-xs text-destructive"
        >
          {failures.map((failure) => (
            <p key={failure.skillId}>{failure.message}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
