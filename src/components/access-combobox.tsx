"use client";

// ---------------------------------------------------------------------------
// AccessCombobox — the ONE access-picker implementation (cinatra#1607 AC1).
//
// A single component, parameterized by `selectionMode` ("single" | "multiple"),
// replaces the two former parallel pickers:
//
//   • selectionMode="single" (DEFAULT) — the flat combobox: a single-select
//     dropdown over a single active org's { orgName, orgId, teams, projects }
//     scope shape, with typed group headings, "Unknown …" synthesis for an
//     unhydrated selection, per-row disable + reason, and the install-target
//     modes (installMode / installWorkspaceScopes). Trailing Check, closes on
//     select. Callers: the install-scope dialogs, agent-decision-actions, the
//     read-only project Permissions tab.
//
//   • selectionMode="multiple" — the checkbox multi-select picker: a searchable
//     dropdown over a nested { orgs[].teams[], projects, canGrantWorkspace }
//     scope shape (`AvailableScopes`), each row led by a Checkbox, display-only
//     downward implication ("Included via <org>"), a composed per-category
//     trigger summary, and injectable filter-mode toggle/rowState overrides.
//     Stays OPEN on toggle. Callers: the permissions grant form, the
//     extension-access-control panel, and the /connectors + /skills scope
//     FILTERs (via ScopeFilterCombobox / SkillsToolbar).
//
// The two selection modes render different UIs (combobox vs checkbox list) — as
// the discriminated union below encodes — but share ONE component contract,
// ONE import, and the ONE pure label/selection module (access-scope.ts).
// Compatibility data shapes stay per-mode (cinatra#1607 AC1: adapters may
// remain; a single universal upstream data model is NOT required).
// ---------------------------------------------------------------------------

import React, { useState } from "react";
import { Check, ChevronDown, Lock, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AgentAuthPolicyVisibility } from "@cinatra-ai/agents/auth-policy";
// The unknown-entity fallback is the ONE shared helper (cinatra#1509 §4.0-a):
// this flat picker and the hierarchical `resolveAccessParts` both delegate here
// so the "Unknown team" / "Unknown project" contract has a single definition
// and no truncated-id copy drifts (cinatra#1508). The multi-select mode adds
// the nested-shape label/summary + selection helpers from the same module.
import {
  resolveScopeEntityName,
  unknownScopeEntityName,
  resolveAccessParts,
  resolveAccessLabel as resolveAccessScopeLabel,
  resolveAccessSummary,
  accessRowState,
  toggleAccessSelection,
  type AvailableScopes,
  type AccessRowState,
} from "@/components/access-scope";

// Re-export the pure helpers + nested-scope types so callers that imported them
// from the former `access-combobox-hierarchical` module keep a stable path
// through the unified picker module (cinatra#1607).
export { resolveAccessParts, resolveAccessSummary } from "@/components/access-scope";
export type { AvailableScopes, AccessRowState } from "@/components/access-scope";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccessComboboxProps = {
  /**
   * Single-select mode (cinatra#1607). Optional and defaults to "single" so the
   * install / permissions callers stay unchanged; the discriminant is what the
   * unified `AccessCombobox` dispatches on.
   */
  selectionMode?: "single";
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
// Multi-select (checkbox) props — the former AccessComboboxHierarchical multi
// contract, now the `selectionMode="multiple"` half of the unified picker
// (cinatra#1607). Distinct `scopes` (nested AvailableScopes) + `string[]` value
// shape; single mode keeps the flat `availableScopes` + scalar shape above.
// ---------------------------------------------------------------------------
export type AccessComboboxMultiProps = {
  selectionMode: "multiple";
  scopes: AvailableScopes;
  value: string[];
  onChange: (next: string[]) => void;
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
   * PER-SCOPE disable (cinatra#953 W3 — mirrors the flat single-mode contract):
   * option VALUES ("owner" | "workspace" | "admin" | `org:<id>` | `team:<id>` |
   * `project:<id>`) rendered non-selectable. Used by the connection share
   * surface to render a connector's `access.scope.only` ceiling as a locked
   * picker — the disable is an AFFORDANCE; the server write path independently
   * rejects out-of-ceiling grants.
   */
  disabledScopes?: string[];
  /** Tooltip text per disabled value (shown via a wrapper span — a disabled
   * CommandItem suppresses pointer events on its own content). */
  disabledReasons?: Record<string, string>;
  /**
   * Override the toggle semantics (default: the GRANT-mode
   * `toggleAccessSelection` — owner/workspace exclusivity, owner-strip,
   * non-empty floor). FILTER surfaces (cinatra#1074 W5) pass the filter-mode
   * toggle from `@/lib/scope-filter`, where "personal" is an ordinary OR-token
   * and "workspace" is the cleared default.
   */
  toggleSelection?: (value: string, selection: readonly string[]) => string[];
  /**
   * Override the per-row checked/disabled derivation (default: the GRANT-mode
   * `accessRowState` with org/workspace implied-display). FILTER surfaces pass
   * the implication-free filter row state.
   */
  rowState?: (
    value: string,
    selection: readonly string[],
    scopes: AvailableScopes,
  ) => AccessRowState;
};

/** The unified picker's discriminated prop contract (cinatra#1607). */
export type AnyAccessComboboxProps = AccessComboboxProps | AccessComboboxMultiProps;

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
// Component — the unified public entry point (cinatra#1607).
//
// Dispatches on `selectionMode`: "multiple" renders the checkbox multi-select
// picker; anything else (the default "single") renders the flat single-select
// combobox. ONE exported component, ONE import, ONE contract; each mode keeps
// its own render treatment + data shape (adapters may remain — AC1).
// ---------------------------------------------------------------------------
export function AccessCombobox(props: AnyAccessComboboxProps) {
  if (props.selectionMode === "multiple") {
    return <AccessComboboxMultiSelect {...props} />;
  }
  return <AccessComboboxSingleSelect {...props} />;
}

/**
 * Single-select (flat) access-level combobox extracted from
 * permissions-tab-client.tsx. Presentational only — no auth decisions, no
 * session reads, no fetch calls.
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
function AccessComboboxSingleSelect({
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

// ---------------------------------------------------------------------------
// Multi-select (checkbox) render — the former AccessComboboxHierarchical multi
// mode (cinatra#1072 / #1074 / #1261), now the `selectionMode="multiple"` half
// of the unified picker. Behaviour is byte-identical to the multi mode it
// replaces; the redundant single-select variant that component ALSO carried is
// dropped — single-select is served by AccessComboboxSingleSelect above, which
// is the render every live single-select caller already used (cinatra#1607 AC1;
// no live caller mounted the hierarchical picker in single mode).
// ---------------------------------------------------------------------------
function AccessComboboxMultiSelect({
  scopes,
  value,
  onChange,
  disabled = false,
  id,
  showAdmin = true,
  disabledScopes,
  disabledReasons,
  toggleSelection,
  rowState,
}: AccessComboboxMultiProps) {
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

  // Explicit selection as an array (multi mode uses the value verbatim). The
  // toggle + implication logic lives in the pure, unit-tested access-scope
  // module.
  const selection: string[] = value;

  const toggleMulti = (itemValue: string) => {
    // Default (grant mode): owner + workspace are EXCLUSIVE; scoped tokens +
    // admin add/remove and canonicalise. Implied rows are disabled, so this
    // only fires on a row whose checked state equals its explicit membership.
    // Filter surfaces override via `toggleSelection` (cinatra#1074 W5).
    const toggle =
      toggleSelection ??
      ((v: string, current: readonly string[]) =>
        toggleAccessSelection(v, current) as string[]);
    onChange(toggle(itemValue, selection));
  };

  // Row background. Multi mode: cmdk stamps data-[selected]="false" on EVERY
  // row, and the shared CommandItem base tints any present-[data-selected] row
  // with bg-primary/8% — greying the whole list (owner review: the access-picker
  // dropdown background must be WHITE, cinatra#1261). Redeclaring the same
  // data-selected bg group drops that tint (tailwind-merge) and restores a white
  // idle row; the active/hover row (data-[selected]="true") keeps the muted
  // highlight via the !-flagged variant.
  const rowClassName = cn(
    "rounded-none px-3 py-2 bg-surface-strong hover:bg-surface-muted data-[selected=true]:bg-surface-muted",
    "data-selected:bg-surface-strong data-[selected=true]:!bg-surface-muted",
  );

  // Row content: leading Checkbox + type/name (+ implied note). The trailing
  // Check icon is single-mode only — multi rows lead with the Checkbox.
  const renderMultiRow = (itemValue: string, state: AccessRowState) => {
    const parts = resolveAccessParts(itemValue as AgentAuthPolicyVisibility, scopes);
    return (
      <div className="flex items-center w-full gap-2">
        <Checkbox
          checked={state.checked}
          disabled={state.impliedDisabled}
          aria-hidden="true"
          tabIndex={-1}
          className="pointer-events-none"
        />
        <span className="flex items-baseline gap-1 min-w-0">
          {parts.type && (
            <span className="text-xs tracking-wide text-muted-foreground shrink-0">
              {parts.type}:
            </span>
          )}
          <span className="text-foreground whitespace-nowrap">{parts.name}</span>
        </span>
        {state.impliedNote && (
          <span className="ml-auto text-xs italic text-muted-foreground whitespace-nowrap">
            {state.impliedNote}
          </span>
        )}
      </div>
    );
  };

  // ONE selectable-row builder for every scope class so the per-scope disable
  // semantics stay uniform. A disabled row (per-scope lock, or an implied row)
  // wraps the entire disabled CommandItem in a <span> — the wrapper span is what
  // receives hover/focus, since a disabled CommandItem suppresses pointer events
  // on its content — carrying the reason tooltip, and sets aria-disabled.
  const renderSelectableItem = (itemValue: string) => {
    const lockDisabled = disabledScopes?.includes(itemValue) ?? false;
    const state: AccessRowState = (rowState ?? accessRowState)(
      itemValue,
      selection,
      scopes,
    );
    const rowDisabled = lockDisabled || state.impliedDisabled;
    const body = renderMultiRow(itemValue, state);

    if (rowDisabled) {
      const reason = disabledReasons?.[itemValue] ?? state.impliedNote;
      return (
        <span key={itemValue} title={reason} className="block cursor-not-allowed">
          <CommandItem
            value={itemValue}
            disabled
            aria-disabled="true"
            role="option"
            aria-checked={state.checked}
            className={cn(
              "rounded-none px-3 py-2 bg-surface-strong",
              // Same white-dropdown fix as the enabled rows (cinatra#1261):
              // override cmdk's present-[data-selected] bg-primary/8% tint.
              "data-selected:bg-surface-strong",
              // Implied-checked rows keep the selected-row tint; pure locks mute.
              state.checked
                ? "data-selected:bg-surface-muted text-foreground opacity-80"
                : "text-muted-foreground opacity-60",
            )}
          >
            {body}
          </CommandItem>
        </span>
      );
    }
    return (
      <CommandItem
        key={itemValue}
        value={itemValue}
        role="option"
        aria-checked={state.checked}
        onSelect={() => {
          toggleMulti(itemValue);
          // Popover stays OPEN on toggle (Esc / outside click closes).
        }}
        className={cn(
          rowClassName,
          // Checked rows keep the selected-row tint; use the data-selected group
          // so it beats the idle white restored above (cinatra#1261).
          state.checked && "data-selected:bg-surface-muted",
        )}
      >
        {body}
      </CommandItem>
    );
  };

  const multiSelection = value;
  const multiSummary = resolveAccessSummary(
    multiSelection as AgentAuthPolicyVisibility[],
    scopes,
  );
  const renderMultiTriggerLabel = () => (
    <span className="flex items-center truncate">
      <span className="text-foreground truncate">{multiSummary}</span>
    </span>
  );

  const triggerButton = (
    <Button
      id={id ?? "access"}
      type="button"
      variant="outline"
      role="combobox"
      aria-expanded={open}
      disabled={disabled}
      className="w-auto justify-between bg-surface-strong font-normal"
    >
      {renderMultiTriggerLabel()}
      <ChevronDown className="size-4 opacity-50 shrink-0" />
    </Button>
  );

  return (
    <Popover open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
      {/* N>1 selections surface the full list in a tooltip on the trigger.
          BOTH triggers must compose onto the SAME real DOM node: PopoverTrigger's
          asChild Slot forwards its open handler + ref to its direct child, and
          TooltipTrigger's asChild Slot forwards its own onto the Button beneath.
          Nesting PopoverTrigger around <TooltipProvider> (which renders no DOM
          node and forwards nothing) silently dropped the popover's open handler,
          so a multi-scope trigger could never open (cinatra#1261). Keeping
          PopoverTrigger → TooltipTrigger → Button chains both onto the Button. */}
      {multiSelection.length > 1 ? (
        <TooltipProvider>
          <Tooltip>
            <PopoverTrigger asChild>
              <TooltipTrigger asChild>{triggerButton}</TooltipTrigger>
            </PopoverTrigger>
            <TooltipContent align="start" className="max-w-xs">
              <ul className="flex flex-col gap-0.5">
                {multiSelection.map((v) => (
                  <li key={v} className="text-xs whitespace-nowrap">
                    {resolveAccessScopeLabel(v as AgentAuthPolicyVisibility, scopes)}
                  </li>
                ))}
              </ul>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
      )}
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
                      {renderMultiRow("workspace", { checked: false, impliedDisabled: true })}
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
