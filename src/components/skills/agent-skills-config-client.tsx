"use client";

// ---------------------------------------------------------------------------
// The §V Skills section's interactive half (cinatra#2349 S4, epic #2345).
//
// The design contract this implements, in one paragraph: a labelled typeahead
// that narrows server-side, chosen skills as removable rows beneath it, a count
// hint that always states how many of the three allowed are chosen, the field
// closed off at three, no floor on removal, and saves that happen immediately
// with a visible in-flight state and a rollback + explanation on failure.
//
// THREE things here are deliberate and would be wrong if "simplified":
//
//   1. THE PICKER IS THE SHARED ONE. `EntitySearchCombobox` already owns the
//      debounce, the stale-response guards, the keyboard contract and — the
//      part that matters most here — an ERROR row that is distinct from the
//      empty row. Re-deriving the widget would re-derive that distinction
//      wrongly, which is how "we could not look" starts rendering as "nothing
//      matched". It is mounted with `clearQueryOnPick`, the one adaptation a
//      REPEAT picker needs (cinatra#2349): after adding one skill you search
//      for a different one, and a stale needle silently narrows the next list.
//
//   2. THE SAVE IS EXPLICIT, BECAUSE `onPick` IS NOT. The shared picker hands
//      over a synchronous callback. The write is asynchronous, so the async
//      boundary is drawn HERE: the row is added optimistically inside a
//      transition, carries a Saving badge and an inert remove control while the
//      write is in flight, and is TAKEN BACK OUT on refusal with the reason
//      surfaced beneath the list. An unhandled promise inside `onPick` would
//      lose the refusal entirely and leave a row the server never accepted.
//
//   3. THE CAP AND THE FLOOR ARE UI, NOT ENFORCEMENT. Disabling the field at
//      three and enabling remove at one row are affordances; the server
//      re-checks the cap atomically and applies no last-row floor at all. This
//      component must never be the only thing standing between a caller and a
//      fourth assignment — and it isn't.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";
import {
  EntitySearchCombobox,
  type EntitySearchPage,
} from "@/components/entity-search-combobox";
import { cn } from "@/lib/utils";

/** The lifecycle condition of a chosen skill, as S1's hydrated read reports it. */
export type AgentSkillRowStatus = "ok" | "archived" | "role-changed" | "missing" | "unavailable";

/** ONE chosen skill, as this section renders it. */
export type AgentSkillRow = {
  skillId: string;
  /** The skill's own name (falls back to the raw id when the catalog row is gone). */
  skillName: string;
  /** The providing extension's title (falls back to its package name). */
  displayName: string;
  /** The providing extension's vendor byline, or null. */
  vendorName: string | null;
  status: AgentSkillRowStatus;
};

/** ONE offered skill, as the picker renders it. */
export type AgentSkillCandidate = {
  skillId: string;
  skillName: string;
  displayName: string;
  vendorName: string | null;
  /** The providing install's lifecycle badge. */
  status: "active" | "locked";
};

export type AgentSkillsSearchResponse =
  | { ok: true; results: AgentSkillCandidate[]; hasMore: boolean }
  | { ok: false; reason: string };

export type AgentSkillsWriteResponse = { ok: true } | { ok: false; reason: string };

export type AgentSkillsConfigClientProps = {
  cap: number;
  initialRows: AgentSkillRow[];
  search: (query: string, page: EntitySearchPage) => Promise<AgentSkillsSearchResponse>;
  assign: (skillId: string) => Promise<AgentSkillsWriteResponse>;
  remove: (skillId: string) => Promise<AgentSkillsWriteResponse>;
};

const FIELD_ID = "agent-skills-search";

/**
 * The shape the shared picker carries. `id` / `name` / `secondary` are its own
 * contract; `candidate` rides along so a pick needs no second lookup to build
 * the optimistic row (and so the chosen row is labelled by exactly the bytes
 * the picked row displayed).
 */
type SkillPickerItem = {
  id: string;
  name: string;
  secondary: string;
  candidate: AgentSkillCandidate;
};

/**
 * Why a write or a search refused, in words an admin can act on.
 *
 * The two server slices refuse with the SAME vocabulary on purpose, so one
 * table explains both. An unrecognised member degrades to a truthful generic
 * rather than rendering a raw machine token at a user.
 */
export function agentSkillRefusalText(reason: string): string {
  switch (reason) {
    case "forbidden":
      return "you no longer have permission to change this";
    case "unknown-agent":
      return "this agent could not be found";
    case "ambiguous-agent":
      return "this agent's name matches more than one installed extension";
    case "not-an-agent":
      return "this extension can't be given skills";
    case "assistant":
      return "assistants don't take chosen skills";
    case "eligibility-unreadable":
      return "the extension registry couldn't be read";
    case "unknown-skill":
    case "not-assignable":
      return "that skill is no longer available";
    case "cap-exceeded":
      return "the limit of three is already reached";
    default:
      return "the change couldn't be saved";
  }
}

/** The pill treatment for a chosen row's condition. Pure. */
export function agentSkillStatusPill(status: AgentSkillRowStatus): {
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

/**
 * The count hint. Always present, and at the cap it says what to do about it —
 * the limit is explained in place, never as a refusal after the fact.
 */
export function agentSkillsCountHint(count: number, cap: number): string {
  return count >= cap
    ? `${count} of ${cap} skills chosen — remove one to choose another.`
    : `${count} of ${cap} skills chosen. A chosen skill reaches this agent on every run, alongside the ones it picks up on its own.`;
}

export function AgentSkillsConfigClient({
  cap,
  initialRows,
  search,
  assign,
  remove,
}: AgentSkillsConfigClientProps) {
  const [rows, setRows] = useState<AgentSkillRow[]>(initialRows);
  const [savingIds, setSavingIds] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const atCap = rows.length >= cap;
  const busy = (id: string) => savingIds.includes(id);

  const handlePick = (item: SkillPickerItem) => {
    const { candidate } = item;
    // Guard the affordance's own invariant: a race between a pick and a
    // concurrent add must not push the list past the cap client-side either.
    if (rows.length >= cap || rows.some((r) => r.skillId === candidate.skillId)) return;

    const optimistic: AgentSkillRow = {
      skillId: candidate.skillId,
      skillName: candidate.skillName,
      displayName: candidate.displayName,
      vendorName: candidate.vendorName,
      status: "ok",
    };
    setRows((prev) => [...prev, optimistic]);
    setSavingIds((prev) => [...prev, candidate.skillId]);
    setError(null);

    startTransition(async () => {
      let result: AgentSkillsWriteResponse;
      try {
        result = await assign(candidate.skillId);
      } catch {
        result = { ok: false, reason: "network" };
      }
      setSavingIds((prev) => prev.filter((id) => id !== candidate.skillId));
      if (!result.ok) {
        // Roll the list back to exactly what it was, and say so.
        setRows((prev) => prev.filter((r) => r.skillId !== candidate.skillId));
        setError(
          `Couldn't add ${candidate.skillName} — ${agentSkillRefusalText(result.reason)}. Nothing was changed.`,
        );
      }
    });
  };

  const handleRemove = (row: AgentSkillRow) => {
    if (busy(row.skillId)) return;
    setSavingIds((prev) => [...prev, row.skillId]);
    setError(null);

    startTransition(async () => {
      let result: AgentSkillsWriteResponse;
      try {
        result = await remove(row.skillId);
      } catch {
        result = { ok: false, reason: "network" };
      }
      setSavingIds((prev) => prev.filter((id) => id !== row.skillId));
      if (result.ok) {
        setRows((prev) => prev.filter((r) => r.skillId !== row.skillId));
      } else {
        setError(
          `Couldn't remove ${row.skillName} — ${agentSkillRefusalText(result.reason)}. Nothing was changed.`,
        );
      }
    });
  };

  return (
    <div data-slot="agent-skills-section" className="flex flex-col gap-1.5">
      <Label htmlFor={FIELD_ID} className="text-sm font-normal text-foreground">
        Which skills should this agent always use?
      </Label>

      <EntitySearchCombobox<SkillPickerItem>
        id={FIELD_ID}
        placeholder="Search installed skills…"
        emptyText="No matches."
        disabled={atCap}
        clearQueryOnPick
        excludeIds={rows.map((r) => r.skillId)}
        onSearch={async (query, page) => {
          const response = await search(query, page);
          // The shared picker turns a REJECTION into its explicit error row.
          // A refusal is a failure to look, not an empty result — coercing it
          // to `[]` here is exactly the conflation the widget exists to avoid.
          if (!response.ok) throw new Error(response.reason);
          return {
            results: response.results.map((c) => ({
              id: c.skillId,
              name: c.skillName,
              secondary: c.vendorName ? `${c.displayName} · by ${c.vendorName}` : c.displayName,
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

      <p data-slot="agent-skills-count" className="text-xs text-muted-foreground">
        {agentSkillsCountHint(rows.length, cap)}
      </p>

      {rows.length > 0 ? (
        <ul className="mt-1 flex flex-col">
          {rows.map((row, index) => {
            // HOUSE RAIL: the last row's missing rule comes from an explicit
            // isLast flag, never `:last-child` — a conditionally-rendered
            // trailing element would silently move the rule to the wrong row.
            const isLast = index === rows.length - 1;
            const saving = busy(row.skillId);
            const pill = agentSkillStatusPill(row.status);
            return (
              <li
                key={row.skillId}
                data-slot="agent-skills-row"
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
                      "truncate text-sm font-medium",
                      row.status === "ok" && !saving ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {row.skillName}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {row.vendorName ? `${row.displayName} · by ${row.vendorName}` : row.displayName}
                  </span>
                </div>
                {saving ? (
                  <StatusPill status="hold" className="shrink-0">
                    Saving
                  </StatusPill>
                ) : (
                  <StatusPill status={pill.status} className="shrink-0">
                    {pill.label}
                  </StatusPill>
                )}
                {/* No last-row floor: remove stays live down to zero rows, and
                    stays live on a degraded row — clearing it is exactly what
                    the admin came here to do. */}
                <Button
                  type="button"
                  data-slot="agent-skills-remove"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${row.skillName}`}
                  onClick={() => handleRemove(row)}
                  disabled={saving}
                  className="size-8 rounded-control text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                >
                  {saving ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {error ? (
        <p
          data-slot="agent-skills-error"
          role="alert"
          className="mt-1 rounded-control border border-destructive/35 bg-destructive/6 px-2.75 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
