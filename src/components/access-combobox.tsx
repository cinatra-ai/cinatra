"use client";

import React, { useState } from "react";
import { Check, ChevronDown, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccessComboboxProps = {
  value: string;
  onValueChange: (value: string) => void;
  availableScopes: {
    projects: { id: string; name: string }[];
    teams: { id: string; name: string }[];
    orgName: string;
    workspaceExposed: boolean;
  };
  isAdmin: boolean;
  disabled?: boolean;
  id?: string;
  /**
   * Per-row disable list. Values must be access expressions the combobox can
   * render (`"org"`, `"team:<id>"`, `"project:<id>"`). Rows whose value
   * appears here are RENDERED but NOT selectable. The owner / admin /
   * workspace rows are NOT participating in this list (they have separate
   * semantics — workspace already gates on `isAdmin`, owner/admin are not
   * install targets in any caller that uses this prop).
   */
  disabledScopes?: string[];
  /**
   * Tooltip text per disabled value. Missing entries fall back to a generic
   * "Not available" string. The tooltip is wired through a wrapper `<span>`
   * OUTSIDE the disabled CommandItem because disabled CommandItems suppress
   * pointer events on their content (so a Tooltip placed *inside* the disabled
   * item would never appear). The wrapper span receives hover/focus while the
   * inner item stays unselectable.
   */
  disabledReasons?: Record<string, string>;
  /**
   * When `true`, hides the "Only me" (owner), "Admins only" (admin), and
   * "Whole Workspace" (workspace) rows entirely. These three are valid
   * permissions-tab values but are NOT install-target scopes; the
   * InstallScopeDialog passes installMode=true so the picker only shows org /
   * team:* / project:* rows.
   *
   * Why a flag instead of a wrapper component? The full Popover + Command
   * + Tooltip wiring is non-trivial; adding a thin filter prop is cheaper
   * than maintaining two component shells. The behavior is one-way (only
   * removes rows; never alters their semantics).
   */
  installMode?: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the human-readable label for a given access value.
 * Used by the trigger button to display the current selection.
 */
export function resolveAccessLabel(
  value: string,
  availableScopes: AccessComboboxProps["availableScopes"],
): { type: string | null; name: string } {
  if (value === "owner") return { type: null, name: "Only me" };
  if (value === "admin") return { type: null, name: "Admins only" };
  if (value === "workspace") return { type: null, name: "Whole Workspace" };
  if (value === "org") {
    const orgName = availableScopes.orgName || "your organization";
    return { type: null, name: `Anyone in ${orgName}` };
  }
  if (value.startsWith("team:")) {
    const id = value.slice("team:".length);
    const team = availableScopes.teams.find((t) => t.id === id);
    return { type: "Team", name: team?.name ?? id.slice(-6) };
  }
  if (value.startsWith("project:")) {
    const id = value.slice("project:".length);
    const project = availableScopes.projects.find((p) => p.id === id);
    return { type: "Project", name: project?.name ?? `Project ${id.slice(-6)}` };
  }
  return { type: null, name: value };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Hierarchical access-level combobox extracted from permissions-tab-client.tsx.
 * Presentational only — no auth decisions, no session reads, no fetch calls.
 *
 * Hierarchy:
 *   1. "Only me" (no group heading)
 *   2. Projects group — only if projects.length > 0
 *   3. Org + Teams group — always rendered; heading is orgName
 *   4. Workspace group — disabled + tooltip for non-admins
 *   5. Admin group
 */
export function AccessCombobox({
  value,
  onValueChange,
  availableScopes,
  isAdmin,
  disabled = false,
  id,
  disabledScopes,
  disabledReasons,
  installMode = false,
}: AccessComboboxProps) {
  const [open, setOpen] = useState(false);

  const { projects, teams, orgName } = availableScopes;
  const resolvedOrgName = orgName || "Your organization";

  const selected = resolveAccessLabel(value, availableScopes);

  // ---------------------------------------------------------------------------
  // Disabled-row helper.
  //
  // The disabled CommandItem suppresses pointer events on its content (cmdk
  // sets pointer-events: none on the inner element when `disabled` is true),
  // so a Tooltip wired to the CommandItem itself would never receive
  // hover/focus. Instead, the wrapper <span> below holds the TooltipTrigger;
  // the wrapper span receives pointer events while the inner CommandItem
  // stays unselectable.
  //
  // Used by the org row, the team:* loop, and the project:* loop.
  // Owner / admin / workspace rows do NOT consult this — they have their own
  // semantics (workspace already gates on isAdmin; owner/admin are not
  // install-target scopes).
  // ---------------------------------------------------------------------------
  // Single gate consulted by org / team:* / project:* rows. Centralizing
  // here keeps the disabledScopes membership check off the owner/admin rows
  // (which have separate semantics — workspace already gates on isAdmin and
  // owner/admin are not install-target scopes).
  const renderTargetRow = (
    rowValue: string,
    item: React.ReactElement,
  ): React.ReactElement => {
    const rowIsDisabled = disabledScopes?.includes(rowValue) ?? false;
    if (!rowIsDisabled) return item;
    const tooltipText = disabledReasons?.[rowValue] ?? "Not available";
    // Disabled treatment: prevent select + flag for AT.
    // Cast to a permissive props bag because cmdk's CommandItem props are
    // not exposed publicly enough for cloneElement's strict generic.
    const disabledItem = React.cloneElement(
      item as React.ReactElement<Record<string, unknown>>,
      {
        disabled: true,
        onSelect: undefined,
        "aria-disabled": true,
      },
    );
    // Wrapper span receives hover/focus; the disabled CommandItem cannot, so
    // the tooltip would never appear without this wrapper-span outside the
    // disabled CommandItem.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span aria-disabled="true">{disabledItem}</span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-[240px]">
          {tooltipText}
        </TooltipContent>
      </Tooltip>
    );
  };

  const itemClass = (itemValue: string) =>
    cn(
      "rounded-none px-3 py-2 cursor-pointer bg-surface hover:bg-surface-strong data-[selected=true]:bg-surface-strong",
      value === itemValue && "bg-surface-strong",
    );

  const renderCheckmark = (itemValue: string) => (
    <Check
      className={cn("ml-auto size-4", value === itemValue ? "opacity-100" : "opacity-0")}
    />
  );

  return (
    <TooltipProvider>
      <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="w-full h-9 justify-between rounded-control border-line font-normal"
          >
            <span className="flex items-center min-w-0 gap-1">
              {selected.type && (
                <span className="text-xs uppercase tracking-wide text-muted-foreground shrink-0">
                  {selected.type}:
                </span>
              )}
              <span className="text-foreground truncate">{selected.name}</span>
            </span>
            <ChevronDown className="size-4 opacity-50 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-auto min-w-[var(--radix-popover-trigger-width)] max-w-[min(28rem,calc(100vw-2rem))] p-0"
        >
          <Command shouldFilter={false}>
            <CommandList className="max-h-72">
              <CommandEmpty>No matches.</CommandEmpty>

              {/* Group 1 — Only me (no heading). Hidden in installMode because owner is not an install target. */}
              {!installMode && (
                <CommandGroup className="p-0">
                  <CommandItem
                    value="owner"
                    onSelect={() => {
                      onValueChange("owner");
                      setOpen(false);
                    }}
                    className={itemClass("owner")}
                  >
                    <div className="flex items-center w-full">
                      <span className="text-foreground whitespace-nowrap">Only me</span>
                      {renderCheckmark("owner")}
                    </div>
                  </CommandItem>
                </CommandGroup>
              )}

              {/* Group 2 — Projects (only if non-empty) */}
              {projects.length > 0 && (
                <CommandGroup
                  className="p-0"
                  heading={
                    <span className="text-xs uppercase tracking-wide text-muted-foreground px-3 py-1 block">
                      Projects
                    </span>
                  }
                >
                  {projects.map((p) => {
                    const itemValue = `project:${p.id}`;
                    const item = (
                      <CommandItem
                        key={p.id}
                        value={itemValue}
                        onSelect={() => {
                          onValueChange(itemValue);
                          setOpen(false);
                        }}
                        className={itemClass(itemValue)}
                      >
                        <div className="flex items-center w-full">
                          <span className="text-foreground whitespace-nowrap">{p.name}</span>
                          {renderCheckmark(itemValue)}
                        </div>
                      </CommandItem>
                    );
                    return (
                      <React.Fragment key={p.id}>
                        {renderTargetRow(itemValue, item)}
                      </React.Fragment>
                    );
                  })}
                </CommandGroup>
              )}

              {/* Group 3 — Org + Teams (always rendered) */}
              <CommandGroup
                className="p-0"
                heading={
                  <span className="text-xs uppercase tracking-wide text-muted-foreground px-3 py-1 block">
                    {resolvedOrgName}
                  </span>
                }
              >
                {/* Org item — disabledScopes?.includes gate via renderTargetRow */}
                {renderTargetRow(
                  "org",
                  <CommandItem
                    value="org"
                    onSelect={() => {
                      onValueChange("org");
                      setOpen(false);
                    }}
                    className={itemClass("org")}
                  >
                    <div className="flex items-center w-full">
                      <span className="text-foreground whitespace-nowrap">
                        Anyone in {resolvedOrgName}
                      </span>
                      {renderCheckmark("org")}
                    </div>
                  </CommandItem>,
                )}

                {/* Team items */}
                {teams.map((t) => {
                  const itemValue = `team:${t.id}`;
                  const item = (
                    <CommandItem
                      key={t.id}
                      value={itemValue}
                      onSelect={() => {
                        onValueChange(itemValue);
                        setOpen(false);
                      }}
                      className={cn(itemClass(itemValue), "pl-6")}
                    >
                      <div className="flex items-center w-full">
                        <span className="text-foreground whitespace-nowrap">{t.name}</span>
                        {renderCheckmark(itemValue)}
                      </div>
                    </CommandItem>
                  );
                  return (
                    <React.Fragment key={t.id}>
                      {renderTargetRow(itemValue, item)}
                    </React.Fragment>
                  );
                })}
              </CommandGroup>

              {/* Group 4 — Workspace. Hidden in installMode because workspace is not an install target. */}
              {!installMode && (
              <CommandGroup
                className="p-0"
                heading={
                  <span className="text-xs uppercase tracking-wide text-muted-foreground px-3 py-1 block">
                    Workspace
                  </span>
                }
              >
                {isAdmin ? (
                  <CommandItem
                    value="workspace"
                    onSelect={() => {
                      onValueChange("workspace");
                      setOpen(false);
                    }}
                    className={itemClass("workspace")}
                  >
                    <div className="flex items-center w-full">
                      <span className="text-foreground whitespace-nowrap">Whole Workspace</span>
                      {renderCheckmark("workspace")}
                    </div>
                  </CommandItem>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <CommandItem
                        value="workspace"
                        disabled
                        className="rounded-none px-3 py-2 text-muted-foreground cursor-not-allowed"
                      >
                        <div className="flex items-center w-full gap-1">
                          <span>Whole Workspace</span>
                          <Lock aria-hidden className="size-3.5" />
                        </div>
                      </CommandItem>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[240px]">
                      Only platform admins can scope this to the whole workspace.
                    </TooltipContent>
                  </Tooltip>
                )}
              </CommandGroup>
              )}

              {/* Group 5 — Admin. Hidden in installMode because admin is not an install target. */}
              {!installMode && (
              <CommandGroup
                className="p-0"
                heading={
                  <span className="text-xs uppercase tracking-wide text-muted-foreground px-3 py-1 block">
                    Admin
                  </span>
                }
              >
                <CommandItem
                  value="admin"
                  onSelect={() => {
                    onValueChange("admin");
                    setOpen(false);
                  }}
                  className={itemClass("admin")}
                >
                  <div className="flex items-center w-full">
                    <span className="text-foreground whitespace-nowrap">Admins only</span>
                    {renderCheckmark("admin")}
                  </div>
                </CommandItem>
              </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}
