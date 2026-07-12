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
//
// Two modes, discriminated by `multiple` (cinatra#1072, multi-scope W3):
//
//   • multiple={false} (DEFAULT) — single-select. `value: string`,
//     `onChange(next: string)`. A trailing Check marks the selected row and the
//     popover closes on select. This is the FILTER-surface shape (scope-filter,
//     skills toolbar); multi-scope filters are a later wave (#1074), so these
//     callers are untouched.
//
//   • multiple={true} — checkbox multi-select. `value: string[]`,
//     `onChange(next: string[])`. Each row leads with a Checkbox, the trailing
//     Check is gone, the popover stays OPEN on toggle (Esc / outside closes),
//     and the selection canonicalises through `normalizeVisibilitySelection`
//     live (workspace collapses to just workspace; owner auto-clears when mixed
//     with a broader grant). Downward implication is DISPLAY-ONLY: a checked
//     org renders its own team rows checked+disabled ("Included via <org>"), a
//     checked workspace implies every scope row, and projects are never implied
//     by org/team. The trigger shows one token as "Type: Name" and N>1 as a
//     composed per-category summary ("1 project, 1 team") with the full list in
//     a tooltip. This is the GRANT
//     surface shape (permissions form, extension access control).
// ---------------------------------------------------------------------------

import { useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AgentAuthPolicyVisibility } from "@cinatra-ai/agents/auth-policy";
import {
  type AvailableScopes,
  type AccessRowState,
  resolveAccessParts,
  resolveAccessLabel,
  resolveAccessSummary,
  accessRowState,
  toggleAccessSelection,
} from "@/components/access-scope";

// Re-export the pure helpers so existing callers keep importing them from here.
export { resolveAccessParts, resolveAccessLabel, resolveAccessSummary };
export type { AvailableScopes };

// ---------------------------------------------------------------------------
// AccessCombobox — searchable dropdown for the access selector
// ---------------------------------------------------------------------------

type AccessComboboxHierarchicalBaseProps = {
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

/** Single-select (filter surfaces). Trailing Check, closes on select. */
export type AccessComboboxHierarchicalSingleProps =
  AccessComboboxHierarchicalBaseProps & {
    multiple?: false;
    value: string;
    onChange: (next: string) => void;
  };

/** Checkbox multi-select (grant surfaces). Stays open, implied-display. */
export type AccessComboboxHierarchicalMultiProps =
  AccessComboboxHierarchicalBaseProps & {
    multiple: true;
    value: string[];
    onChange: (next: string[]) => void;
    /**
     * Override the toggle semantics (default: the GRANT-mode
     * `toggleAccessSelection` — owner/workspace exclusivity, owner-strip,
     * non-empty floor). FILTER surfaces (cinatra#1074 W5) pass the
     * filter-mode toggle from `@/lib/scope-filter`, where "personal" is an
     * ordinary OR-token and "workspace" is the cleared default.
     */
    toggleSelection?: (value: string, selection: readonly string[]) => string[];
    /**
     * Override the per-row checked/disabled derivation (default: the
     * GRANT-mode `accessRowState` with org/workspace implied-display).
     * FILTER surfaces pass the implication-free filter row state.
     */
    rowState?: (
      value: string,
      selection: readonly string[],
      scopes: AvailableScopes,
    ) => AccessRowState;
  };

export type AccessComboboxHierarchicalProps =
  | AccessComboboxHierarchicalSingleProps
  | AccessComboboxHierarchicalMultiProps;

export function AccessComboboxHierarchical(
  props: AccessComboboxHierarchicalProps,
) {
  const {
    scopes,
    disabled = false,
    id,
    showAdmin = true,
    disabledScopes,
    disabledReasons,
  } = props;
  const multiple = props.multiple === true;

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

  // -------------------------------------------------------------------------
  // Selection as an array for uniform internal logic. Single mode wraps its
  // one value; multi mode uses the array verbatim. The toggle + implication
  // logic lives in the pure, unit-tested access-selection module.
  // -------------------------------------------------------------------------
  const selection: string[] = multiple ? props.value : [props.value];

  const toggleMulti = (itemValue: string) => {
    if (props.multiple !== true) return;
    // Default (grant mode): owner + workspace are EXCLUSIVE; scoped tokens +
    // admin add/remove and canonicalise. Implied rows are disabled, so this
    // only fires on a row whose checked state equals its explicit membership.
    // Filter surfaces override via `toggleSelection` (cinatra#1074 W5).
    const toggle =
      props.toggleSelection ??
      ((value: string, current: readonly string[]) =>
        toggleAccessSelection(value, current) as string[]);
    props.onChange(toggle(itemValue, selection));
  };

  // Single-mode selected-row background (unchanged behaviour).
  const itemClass = (itemValue: string) =>
    cn(
      "rounded-none px-3 py-2 bg-surface-strong hover:bg-surface-muted data-[selected=true]:bg-surface-muted",
      // Multi mode: cmdk stamps data-[selected]="false" on EVERY row, and the
      // shared CommandItem base tints any present-[data-selected] row with
      // bg-primary/8% — greying the whole list (owner review: the access-picker
      // dropdown background must be WHITE, cinatra#1261). Redeclaring the same
      // data-selected bg group drops that tint (tailwind-merge) and restores a
      // white idle row; the active/hover row (data-[selected]="true") keeps the
      // muted highlight via the !-flagged value-matched variant.
      multiple && "data-selected:bg-surface-strong data-[selected=true]:!bg-surface-muted",
      !multiple && props.value === itemValue && "bg-surface-muted",
    );

  // Row content for SINGLE mode: type/name + trailing Check on the selected.
  const renderSingleRow = (itemValue: string) => {
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
            !multiple && props.value === itemValue ? "opacity-100" : "opacity-0",
          )}
        />
      </div>
    );
  };

  // Row content for MULTI mode: leading Checkbox + type/name (+ implied note).
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
  // semantics stay uniform across both modes. A disabled row (per-scope lock,
  // or an implied row in multi mode) wraps the entire disabled CommandItem in a
  // <span> — the wrapper span is what receives hover/focus, since a disabled
  // CommandItem suppresses pointer events on its content — carrying the
  // reason tooltip, and sets aria-disabled.
  const renderSelectableItem = (itemValue: string) => {
    const lockDisabled = disabledScopes?.includes(itemValue) ?? false;
    const state: AccessRowState =
      props.multiple === true
        ? (props.rowState ?? accessRowState)(itemValue, selection, scopes)
        : { checked: false, impliedDisabled: false };
    const rowDisabled = lockDisabled || state.impliedDisabled;
    const body = multiple
      ? renderMultiRow(itemValue, state)
      : renderSingleRow(itemValue);

    if (rowDisabled) {
      const reason = disabledReasons?.[itemValue] ?? state.impliedNote;
      return (
        <span key={itemValue} title={reason} className="block cursor-not-allowed">
          <CommandItem
            value={itemValue}
            disabled
            aria-disabled="true"
            role="option"
            aria-checked={multiple ? state.checked : undefined}
            className={cn(
              "rounded-none px-3 py-2 bg-surface-strong",
              // Same white-dropdown fix as the enabled rows (cinatra#1261):
              // override cmdk's present-[data-selected] bg-primary/8% tint.
              multiple && "data-selected:bg-surface-strong",
              // Implied-checked rows keep the selected-row tint; pure locks mute.
              multiple && state.checked
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
        aria-checked={multiple ? state.checked : undefined}
        onSelect={() => {
          if (multiple) {
            toggleMulti(itemValue);
            // Popover stays OPEN on toggle (Esc / outside click closes).
          } else {
            props.onChange(itemValue);
            setOpen(false);
          }
        }}
        className={cn(
          itemClass(itemValue),
          // Checked rows keep the selected-row tint; use the data-selected group
          // so it beats the idle white restored above (cinatra#1261).
          multiple && state.checked && "data-selected:bg-surface-muted",
        )}
      >
        {body}
      </CommandItem>
    );
  };

  // Trigger width = longest option (no clipping, no jitter) — SINGLE mode only.
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

  // -------------------------------------------------------------------------
  // Trigger label
  // -------------------------------------------------------------------------
  const renderSingleTriggerLabel = () => {
    const parts = resolveAccessParts(props.value as AgentAuthPolicyVisibility, scopes);
    return (
      <span className="relative inline-flex items-center">
        {/* Hidden width template: the widest option label sets the trigger's
            natural width, so the selection-visible span overlays without
            clipping or jitter when the selection changes. */}
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
          {parts.type && (
            <span className="text-xs tracking-wide text-muted-foreground mr-1 shrink-0">
              {parts.type}:
            </span>
          )}
          <span className="text-foreground truncate">{parts.name}</span>
        </span>
      </span>
    );
  };

  const multiSelection = multiple ? props.value : [];
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
      {multiple ? renderMultiTriggerLabel() : renderSingleTriggerLabel()}
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
      {multiple && multiSelection.length > 1 ? (
        <TooltipProvider>
          <Tooltip>
            <PopoverTrigger asChild>
              <TooltipTrigger asChild>{triggerButton}</TooltipTrigger>
            </PopoverTrigger>
            <TooltipContent align="start" className="max-w-xs">
              <ul className="flex flex-col gap-0.5">
                {multiSelection.map((v) => (
                  <li key={v} className="text-xs whitespace-nowrap">
                    {resolveAccessLabel(v as AgentAuthPolicyVisibility, scopes)}
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
                      {multiple
                        ? renderMultiRow("workspace", { checked: false, impliedDisabled: true })
                        : renderSingleRow("workspace")}
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
