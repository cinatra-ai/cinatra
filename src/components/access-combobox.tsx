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
// The unknown-entity fallback is the ONE shared helper (cinatra#1509 §4.0-a):
// this flat picker and the hierarchical `resolveAccessParts` both delegate here
// so the "Unknown team" / "Unknown project" contract has a single definition
// and no truncated-id copy drifts (cinatra#1508).
import {
  resolveScopeEntityName,
  unknownScopeEntityName,
} from "@/components/access-scope";

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
    /**
     * Active organization id. Multi-scope W1 retired the bare `"org"` token in
     * favour of the id-carrying `org:<id>`; the org row emits `org:${orgId}` so
     * its value, selected-state, and disabled-scope lookup line up with the
     * server-built install-target rows. Optional: when absent (no active org),
     * the row degrades to the legacy bare `"org"` token rather than emit a
     * malformed `org:` with an empty tail.
     */
    orgId?: string;
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
  /**
   * cinatra#1527: in installMode, ALSO render the two always-offered workspace
   * scopes — "Whole Workspace" (value `"workspace"`) and "Admins only" (value
   * `"admin"`) — as SERVER-DRIVEN target rows: their enabled/disabled + reason
   * state comes from `disabledScopes` / `disabledReasons` (the buildInstallTargets
   * rows), exactly like the org/team/project rows, NOT from the client `isAdmin`
   * gate. Ignored outside installMode (the permissions tab keeps its own
   * isAdmin-gated workspace row + always-on admin row). Default false so the
   * agent at-scope install picker, which does not offer these scopes, is
   * unaffected.
   */
  installWorkspaceScopes?: boolean;
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
  // Multi-scope W1 retired the bare `"org"` token for the id-carrying
  // `org:<id>`. The bare form is still ACCEPTED for read-compatibility with any
  // persisted legacy value (AgentAuthPolicyVisibilitySchema still validates the
  // literal "org"); it denotes the active org by definition, so it resolves to
  // the active org's name.
  if (value === "org") {
    const orgName = availableScopes.orgName || "your organization";
    return { type: null, name: `Anyone in ${orgName}` };
  }
  // An id-carrying `org:<id>` token: assert the active org's NAME only when the
  // token is CONFIRMED to scope the active org (its embedded id equals the
  // supplied `orgId`). On the install surfaces the value is always
  // `org:<activeOrgId>`, so it always resolves to the name. But this component
  // also renders the read-only project Permissions tab, where the value is the
  // PROJECT's own owning-org token (`org:<projectOwnerOrgId>`) while `orgName`
  // is the VIEWER's active org — a co-owner viewing a project owned by ANOTHER
  // org (the co-owner short-circuit grants read across the cross-org guard)
  // would otherwise be shown the WRONG org's name on a permissions-review
  // surface. When the id is unconfirmed (no `orgId` supplied, or a different
  // id), fall back to a neutral, id-free label rather than a possibly-wrong
  // specific name — and never leak the raw token.
  if (value.startsWith("org:")) {
    const { orgId, orgName } = availableScopes;
    if (orgId && value.slice("org:".length) === orgId) {
      return { type: null, name: `Anyone in ${orgName || "your organization"}` };
    }
    return { type: null, name: "Anyone in the organization" };
  }
  if (value.startsWith("team:")) {
    const id = value.slice("team:".length);
    const team = availableScopes.teams.find((t) => t.id === id);
    return { type: "Team", name: resolveScopeEntityName("team", id, team?.name) };
  }
  if (value.startsWith("project:")) {
    const id = value.slice("project:".length);
    const project = availableScopes.projects.find((p) => p.id === id);
    return { type: "Project", name: resolveScopeEntityName("project", id, project?.name) };
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
 * Hierarchy (cinatra#1509 §3.3, narrow → broad — typed headings, no bare org
 * name):
 *   1. "Only me" (no group heading)
 *   2. Projects group — heading "Projects"; rendered if there are projects or
 *      an unhydrated project selection to synthesize
 *   3. Teams group — heading "Teams"; rendered if there are teams or an
 *      unhydrated team selection to synthesize (ABOVE the org row)
 *   4. Organization group — heading "Organization: <name>"; always rendered
 *   5. Workspace group — disabled + tooltip for non-admins
 *   6. Admin group
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
  installWorkspaceScopes = false,
}: AccessComboboxProps) {
  const [open, setOpen] = useState(false);

  const { projects, teams, orgName, orgId } = availableScopes;
  const resolvedOrgName = orgName || "Your organization";
  // Org row value: the id-carrying `org:<id>` token (multi-scope W1), matched to
  // the server-built install-target row value `org:<activeOrgId>` EXACTLY so the
  // selected-state, checkmark, and disabledScopes lookup line up — including the
  // no-active-org case, where the server emits `org:` (empty tail) and the row
  // must key on the same token or the disabled-scope membership check would miss.
  // Falls back to the legacy bare `"org"` only when no org id is SUPPLIED at all
  // (`orgId` undefined — e.g. the read-only Permissions tab, popover disabled).
  // A stray empty-tail `org:` click is rejected by the value→target adapter guard.
  const orgRowValue = orgId != null ? `org:${orgId}` : "org";

  const selected = resolveAccessLabel(value, availableScopes);

  // Selected-scope synthesis (cinatra#1509 §3.2 / #1508): a `team:<id>` /
  // `project:<id>` selection that does not hydrate to any available row (the
  // team/project belongs to another org, or the viewer isn't a member) would
  // otherwise render NO row — so the selection had no checkmark and looked
  // unselected. Synthesize an explicit, checked "Unknown team" / "Unknown
  // project" row so a selection is ALWAYS visible with its checkmark,
  // independent of hydration.
  const needsSynthTeam =
    value.startsWith("team:") && !teams.some((t) => `team:${t.id}` === value);
  const needsSynthProject =
    value.startsWith("project:") && !projects.some((p) => `project:${p.id}` === value);

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

  // Row visual contract, aligned to the hierarchical picker (cinatra#1261 /
  // cinatra#1509 §3.2): idle rows are WHITE (`bg-surface-strong`), hover /
  // keyboard-active rows are `bg-surface-muted` (a DISTINCT, visible state —
  // this is #1508's "pointer gets lost" fix), and the selected row keeps the
  // muted tint. Replaces the old invisible variant where the idle and hover
  // tokens were identical, so the pointer row was indistinguishable.
  const itemClass = (itemValue: string) =>
    cn(
      "rounded-none px-3 py-2 cursor-pointer bg-surface-strong hover:bg-surface-muted data-[selected=true]:bg-surface-muted",
      value === itemValue && "bg-surface-muted",
    );

  const renderCheckmark = (itemValue: string) => (
    <Check
      className={cn("ml-auto size-4", value === itemValue ? "opacity-100" : "opacity-0")}
    />
  );

  // A synthesized, checked, selectable row for an unhydrated selection
  // (rowValue === the current value, so `itemClass` marks it selected and
  // `renderCheckmark` shows its check). Label is the shared "Unknown …"
  // fallback (§4.0-a) — never a raw id.
  const renderSynthRow = (rowValue: string, label: string) => (
    <CommandItem
      value={rowValue}
      onSelect={() => {
        onValueChange(rowValue);
        setOpen(false);
      }}
      className={itemClass(rowValue)}
    >
      <div className="flex items-center w-full">
        <span className="text-foreground whitespace-nowrap">{label}</span>
        {renderCheckmark(rowValue)}
      </div>
    </CommandItem>
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
            // No `h-9` override: the shared form-control height is the Button
            // default (`h-8`), matching Input + the hierarchical picker trigger
            // (cinatra#1509 §3.2 — the mechanism behind #1505's misaligned rows).
            className="w-full justify-between rounded-control border-line font-normal"
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

              {/* Group 2 — Projects (typed heading; rendered when there are
                  projects OR an unhydrated project selection to synthesize) */}
              {(projects.length > 0 || needsSynthProject) && (
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
                  {needsSynthProject &&
                    renderSynthRow(value, unknownScopeEntityName("project"))}
                </CommandGroup>
              )}

              {/* Group 3 — Teams (typed heading, ABOVE the org row per the
                  #1508 hierarchy Only me → Projects → Teams → Organization →
                  Workspace → Admin; rendered when there are teams OR an
                  unhydrated team selection to synthesize) */}
              {(teams.length > 0 || needsSynthTeam) && (
                <CommandGroup
                  className="p-0"
                  heading={
                    <span className="text-xs uppercase tracking-wide text-muted-foreground px-3 py-1 block">
                      Teams
                    </span>
                  }
                >
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
                        className={itemClass(itemValue)}
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
                  {needsSynthTeam &&
                    renderSynthRow(value, unknownScopeEntityName("team"))}
                </CommandGroup>
              )}

              {/* Group 4 — Organization (typed heading `Organization: <name>`,
                  never a bare org name — this is #1508's "Default" heading fix.
                  Always rendered) */}
              <CommandGroup
                className="p-0"
                heading={
                  <span className="text-xs uppercase tracking-wide text-muted-foreground px-3 py-1 block">
                    Organization: {resolvedOrgName}
                  </span>
                }
              >
                {/* Org item — id-carrying `org:<id>` value (multi-scope W1) so
                    the selected-state, checkmark, and disabledScopes lookup all
                    match the server-built install-target rows. */}
                {renderTargetRow(
                  orgRowValue,
                  <CommandItem
                    value={orgRowValue}
                    onSelect={() => {
                      onValueChange(orgRowValue);
                      setOpen(false);
                    }}
                    className={itemClass(orgRowValue)}
                  >
                    <div className="flex items-center w-full">
                      <span className="text-foreground whitespace-nowrap">
                        Anyone in {resolvedOrgName}
                      </span>
                      {renderCheckmark(orgRowValue)}
                    </div>
                  </CommandItem>,
                )}
              </CommandGroup>

              {/* Group 5 — Workspace.
                  • installMode + installWorkspaceScopes (cinatra#1527): a
                    SERVER-DRIVEN target row (renderTargetRow consults
                    disabledScopes/disabledReasons — platform-admin-only, disabled
                    + reason otherwise), exactly like org/team/project.
                  • non-installMode (permissions tab): the isAdmin-gated row.
                  • installMode without the scopes (agent picker): hidden. */}
              {installMode
                ? installWorkspaceScopes && (
                    <CommandGroup
                      className="p-0"
                      heading={
                        <span className="text-xs uppercase tracking-wide text-muted-foreground px-3 py-1 block">
                          Workspace
                        </span>
                      }
                    >
                      {renderTargetRow(
                        "workspace",
                        <CommandItem
                          value="workspace"
                          onSelect={() => {
                            onValueChange("workspace");
                            setOpen(false);
                          }}
                          className={itemClass("workspace")}
                        >
                          <div className="flex items-center w-full">
                            <span className="text-foreground whitespace-nowrap">
                              Whole Workspace
                            </span>
                            {renderCheckmark("workspace")}
                          </div>
                        </CommandItem>,
                      )}
                    </CommandGroup>
                  )
                : (
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

              {/* Group 6 — Admin.
                  • installMode + installWorkspaceScopes (cinatra#1527):
                    SERVER-DRIVEN target row (platform-admin-only).
                  • non-installMode (permissions tab): the always-selectable row.
                  • installMode without the scopes (agent picker): hidden. */}
              {installMode
                ? installWorkspaceScopes && (
                    <CommandGroup
                      className="p-0"
                      heading={
                        <span className="text-xs uppercase tracking-wide text-muted-foreground px-3 py-1 block">
                          Admin
                        </span>
                      }
                    >
                      {renderTargetRow(
                        "admin",
                        <CommandItem
                          value="admin"
                          onSelect={() => {
                            onValueChange("admin");
                            setOpen(false);
                          }}
                          className={itemClass("admin")}
                        >
                          <div className="flex items-center w-full">
                            <span className="text-foreground whitespace-nowrap">
                              Admins only
                            </span>
                            {renderCheckmark("admin")}
                          </div>
                        </CommandItem>,
                      )}
                    </CommandGroup>
                  )
                : (
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
