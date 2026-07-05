"use client";

// ---------------------------------------------------------------------------
// AccessCombobox (hierarchical) is shared by extension kinds that need the
// same access-level picker: skill packages, individual skills, and upload-time
// policy capture.
//
// Naming disambiguates from src/components/access-combobox.tsx, the
// install-scope picker that uses a flat {orgs, teams, projects}
// availableScopes shape. This component uses the nested {orgs: [{teams: []}],
// projects, canGrantWorkspace} shape that matches AgentAuthPolicy's
// `team:` / `project:` / `org:` visibility scheme.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { AgentAuthPolicyVisibility } from "@cinatra-ai/agents/auth-policy";
import {
  type AvailableScopes,
  resolveAccessParts,
  resolveAccessLabel,
} from "@/components/access-scope";

// Re-export the pure helpers so existing callers keep importing them from here.
export { resolveAccessParts, resolveAccessLabel };
export type { AvailableScopes };

// ---------------------------------------------------------------------------
// AccessCombobox — searchable dropdown for the access selector
// ---------------------------------------------------------------------------

export type AccessComboboxHierarchicalProps = {
  value: string;
  onChange: (next: string) => void;
  scopes: AvailableScopes;
  disabled?: boolean;
  /** Optional HTML id for the underlying trigger button (used by Labels). */
  id?: string;
  /**
   * Whether to render the "Workspace: Admins only" row. Defaults to true
   * (grant surfaces always offer it). Filter surfaces gated to non-admins can
   * pass false so admin-only scopes are never selectable by them.
   */
  showAdmin?: boolean;
  /**
   * PER-SCOPE disable (cinatra#953 W3 — mirrors the flat access-combobox
   * contract): option VALUES ("owner" | "workspace" | "admin" | `org:<id>` |
   * `team:<id>` | `project:<id>`) rendered non-selectable. Used by the
   * connection share surface to render a connector's `access.scope.only`
   * ceiling as a locked picker — the disable is an AFFORDANCE; the server
   * write path independently rejects out-of-ceiling grants.
   */
  disabledScopes?: string[];
  /** Tooltip text per disabled value (shown via a wrapper span — a disabled
   * CommandItem suppresses pointer events on its own content). */
  disabledReasons?: Record<string, string>;
};

export function AccessComboboxHierarchical({
  value,
  onChange,
  scopes,
  disabled = false,
  id,
  showAdmin = true,
  disabledScopes,
  disabledReasons,
}: AccessComboboxHierarchicalProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const matches = (text: string) => {
    if (search.trim().length === 0) return true;
    return text.toLowerCase().includes(search.trim().toLowerCase());
  };
  const filteredProjects = scopes.projects.filter((p) => matches(`project ${p.name}`));
  const filteredTeams = scopes.orgs
    .flatMap((org) => org.teams.map((t) => ({ org, t })))
    .filter(({ org, t }) => matches(`team ${org.name} ${t.name}`));
  const filteredOrgs = scopes.orgs.filter((o) => matches(`organization ${o.name}`));
  const showOnlyMe = matches("only me");
  const showWorkspaceAll = matches("workspace all");
  const showAdminsOnly = showAdmin && matches("workspace admins only");
  const itemClass = (itemValue: string) =>
    cn(
      "rounded-none px-3 py-2 bg-surface-strong hover:bg-surface-muted data-[selected=true]:bg-surface-muted",
      value === itemValue && "bg-surface-muted",
    );
  const renderRow = (itemValue: string) => {
    const parts = resolveAccessParts(itemValue as AgentAuthPolicyVisibility, scopes);
    return (
      <div className="flex items-center w-full">
        {parts.type && (
          <span className="text-xs tracking-wide text-muted-foreground mr-1">
            {parts.type}:
          </span>
        )}
        <span className="text-foreground whitespace-nowrap">{parts.name}</span>
        <Check
          className={cn(
            "ml-auto size-4",
            value === itemValue ? "opacity-100" : "opacity-0",
          )}
        />
      </div>
    );
  };

  // ONE selectable-row builder for every scope class so the per-scope disable
  // semantics stay uniform. A disabled row wraps the entire disabled
  // CommandItem in a <span> (the wrapper span is what receives hover/focus —
  // a disabled CommandItem suppresses pointer events on its content) carrying
  // the disabledReasons tooltip, and sets aria-disabled.
  const renderSelectableItem = (itemValue: string) => {
    if (disabledScopes?.includes(itemValue)) {
      const reason = disabledReasons?.[itemValue];
      return (
        <span key={itemValue} title={reason} className="block cursor-not-allowed">
          <CommandItem
            value={itemValue}
            disabled
            aria-disabled="true"
            className="rounded-none px-3 py-2 bg-surface-strong text-muted-foreground opacity-60"
          >
            {renderRow(itemValue)}
          </CommandItem>
        </span>
      );
    }
    return (
      <CommandItem
        key={itemValue}
        value={itemValue}
        onSelect={() => {
          onChange(itemValue);
          setOpen(false);
        }}
        className={itemClass(itemValue)}
      >
        {renderRow(itemValue)}
      </CommandItem>
    );
  };

  // Trigger width = longest option (no clipping, no jitter).
  // Collect every visibility string the user could select, resolve its parts,
  // and pick the parts whose "type: name" string is longest. A hidden-but-
  // -laid-out template inside the trigger then dictates the button's natural
  // width via an absolute-overlay pattern — the visible selection renders on
  // top without changing the box width.
  //
  // The visibility literals here MUST match the actual values the picker
  // emits and that `resolveAccessParts` recognises ("owner", "workspace",
  // "admin", "org:<id>", "team:<id>", "project:<id>") — see access-scope.ts.
  const allVisibilities: string[] = [
    "owner",
    "workspace",
    ...(showAdmin ? ["admin"] : []),
    ...scopes.orgs.map((o) => `org:${o.id}`),
    ...scopes.orgs.flatMap((o) => o.teams.map((t) => `team:${t.id}`)),
    ...scopes.projects.map((p) => `project:${p.id}`),
  ];
  const longestParts: { type: string | null; name: string } = allVisibilities
    .map((v) => resolveAccessParts(v as AgentAuthPolicyVisibility, scopes))
    .reduce<{ type: string | null; name: string }>(
      (best, parts) => {
        const len = (parts.type ?? "").length + (parts.name ?? "").length;
        const bestLen = (best.type ?? "").length + (best.name ?? "").length;
        return len > bestLen ? parts : best;
      },
      { type: null, name: "" },
    );

  return (
    <Popover open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
      <PopoverTrigger asChild>
        <Button
          id={id ?? "access"}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-auto justify-between bg-surface-strong font-normal"
        >
          <span className="relative inline-flex items-center">
            {/* Hidden width template: the widest option label sets the
                trigger's natural width, so the selection-visible span overlays
                without clipping or jitter when the selection changes. */}
            <span
              aria-hidden="true"
              className="invisible inline-flex items-center whitespace-nowrap"
            >
              {longestParts.type && (
                <span className="text-xs tracking-wide mr-1">{longestParts.type}:</span>
              )}
              <span>{longestParts.name}</span>
            </span>
            <span className="absolute inset-0 flex items-center">
              {(() => {
                const parts = resolveAccessParts(
                  value as AgentAuthPolicyVisibility,
                  scopes,
                );
                return (
                  <>
                    {parts.type && (
                      <span className="text-xs tracking-wide text-muted-foreground mr-1 shrink-0">
                        {parts.type}:
                      </span>
                    )}
                    <span className="text-foreground truncate">{parts.name}</span>
                  </>
                );
              })()}
            </span>
          </span>
          <ChevronDown className="size-4 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto min-w-[var(--radix-popover-trigger-width)] max-w-[min(28rem,calc(100vw-2rem))] p-0 bg-surface-strong"
      >
        <Command shouldFilter={false} className="bg-surface-strong">
          <div className="p-2 border-b border-line">
            {/* §VII: a small ✕ clears the flyout search once it holds a query
                (cinatra#1014), mirroring the toolbar search's clear affordance. */}
            <div className="relative">
              <Input
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="bg-surface-strong h-8 pr-7"
              />
              {search ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                  className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
                >
                  <X aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          </div>
          <CommandList className="max-h-72 bg-surface-strong">
            <CommandEmpty>No matches.</CommandEmpty>
            {showOnlyMe && (
              <CommandGroup className="p-0">
                {renderSelectableItem("owner")}
              </CommandGroup>
            )}

            {filteredProjects.length > 0 && (
              <>
                {showOnlyMe && <CommandSeparator />}
                <CommandGroup className="p-0">
                  {filteredProjects.map((p) => renderSelectableItem(`project:${p.id}`))}
                </CommandGroup>
              </>
            )}

            {filteredTeams.length > 0 && (
              <>
                {(showOnlyMe || filteredProjects.length > 0) && <CommandSeparator />}
                <CommandGroup className="p-0">
                  {filteredTeams.map(({ t }) => renderSelectableItem(`team:${t.id}`))}
                </CommandGroup>
              </>
            )}

            {filteredOrgs.length > 0 && (
              <>
                {(showOnlyMe || filteredProjects.length > 0 || filteredTeams.length > 0) && <CommandSeparator />}
                <CommandGroup className="p-0">
                  {filteredOrgs.map((org) => renderSelectableItem(`org:${org.id}`))}
                </CommandGroup>
              </>
            )}

            {(showWorkspaceAll || showAdminsOnly) && (
              <>
                {(showOnlyMe || filteredProjects.length > 0 || filteredTeams.length > 0 || filteredOrgs.length > 0) && <CommandSeparator />}
                <CommandGroup className="p-0">
                  {showWorkspaceAll && (scopes.canGrantWorkspace ? (
                    renderSelectableItem("workspace")
                  ) : (
                    <CommandItem
                      value="workspace"
                      disabled
                      className="rounded-none px-3 py-2 text-muted-foreground cursor-not-allowed bg-surface-strong"
                    >
                      {renderRow("workspace")}
                    </CommandItem>
                  ))}
                  {showAdminsOnly && renderSelectableItem("admin")}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
