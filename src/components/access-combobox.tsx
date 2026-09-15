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

import React, { useEffect, useState } from "react";
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
  resolveAccessParts,
  resolveAccessLabel as resolveAccessScopeLabel,
  resolveAccessSummary,
  accessRowState,
  toggleAccessSelection,
  type AvailableScopes,
  type AccessRowState,
  // The canonical flat access-option model (cinatra#2372, mkt-install S1): the
  // ONE resolver the trigger, every dropdown row, AND every single-mode
  // consumer's submit-committability gate read a value's label/committability
  // from — trigger ≡ row holds BY CONSTRUCTION because both call this same
  // function for the same value. Lives in access-scope.ts (not a new sibling
  // module) so no new reachable first-party module is added to any route that
  // transitively imports the picker (route-graph no-new-rot ratchet).
  // Re-exported below so consumers never need a second import path.
  resolveFlatAccessOption,
  type FlatAccessOption,
} from "@/components/access-scope";
// Containment algebra (cinatra#1607 §VI): the first-class `parentScope` +
// `allowedScopes` narrowing, in the pure sibling module. Both modes consult it;
// with no constraint supplied the predicate admits everything (a no-op).
import {
  hasContainment,
  isScopeOffered,
  reconcileSelection,
  type AllowedScopes,
  type ContainmentConstraints,
  type ContainmentContext,
  type ScopeIdentity,
} from "@/components/access-containment";

// Re-export the pure helpers + nested-scope types so callers that imported them
// from the former `access-combobox-hierarchical` module keep a stable path
// through the unified picker module (cinatra#1607).
export { resolveAccessParts, resolveAccessSummary } from "@/components/access-scope";
export type { AvailableScopes, AccessRowState } from "@/components/access-scope";
// The flat model (cinatra#2372) — re-exported so every single-mode consumer
// (the install dialogs today; a future card/modal panel) gates its submit
// control on `resolveFlatAccessOption(...).committable` via ONE import path.
export { resolveFlatAccessOption } from "@/components/access-scope";
export type {
  FlatAccessOption,
  FlatAccessAvailableScopes,
  FlatAccessResolveContext,
} from "@/components/access-scope";
export type {
  AllowedScopes,
  ScopeIdentity,
  ScopeKind,
} from "@/components/access-containment";

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
   * When `true`, hides the "Personal: Only me" (owner), "Workspace: Admins
   * only" (admin), and "Workspace: All" (workspace) rows entirely. These three
   * are valid
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
   * scopes — "Workspace: All" (value `"workspace"`) and "Workspace: Admins
   * only" (value `"admin"`) — as SERVER-DRIVEN target rows: their
   * enabled/disabled + reason
   * state comes from `disabledScopes` / `disabledReasons` (the buildInstallTargets
   * rows), exactly like the org/team/project rows, NOT from the client `isAdmin`
   * gate. Ignored outside installMode (the permissions tab keeps its own
   * isAdmin-gated workspace row + always-on admin row). Default false so the
   * agent at-scope install picker, which does not offer these scopes, is
   * unaffected.
   */
  installWorkspaceScopes?: boolean;
  /**
   * Containment (cinatra#1607 §VI). `parentScope` restricts the offered options
   * to strict descendants of the parent, plus Personal always (§6.1): an org
   * parent → only its teams/projects; a leaf/Personal/unknown parent →
   * Personal-only (fail closed, §6.3). Typed `{ kind, id }` (§6.7), distinct
   * from the selected `value`. Default: no parent → all options.
   */
  parentScope?: ScopeIdentity | null;
  /**
   * Lower-level containment constraint (§6.4) — a set of typed identities or a
   * predicate, intersected with `parentScope`. The agent-run form's three-field
   * visibility intersection maps onto THIS, not onto a single `parentScope`.
   */
  allowedScopes?: AllowedScopes;
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
   * Whether to render the "Personal: Only me" (owner) row. Defaults to true.
   *
   * A FILTER surface whose resources can never carry a personal locus passes
   * false, so the row is not offered at all (cinatra#2688: an assistant's scope
   * comes from its `assistant_audience` grants, which have no per-user subject
   * kind, so a Personal selection on /assistants could only ever return an empty
   * directory). Same one-way, rows-only contract as `installMode`: it removes a
   * row, never alters any row's semantics.
   */
  showPersonal?: boolean;
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
  /**
   * Override the closed trigger's summary text (cinatra#3229). Default: the
   * shared `resolveAccessSummary` composition ("Workspace: All", "Team: …",
   * "1 project, 1 team"). A surface whose drawing reads the control as
   * "{Field}: {value}" passes its own reading; the rows and the selection
   * semantics are untouched.
   */
  summarizeSelection?: (selection: readonly string[], scopes: AvailableScopes) => string;
  /**
   * Containment (cinatra#1607 §VI) — same contract as the single mode.
   * `parentScope` narrows offered options to strict descendants + Personal
   * always (§6.1); `allowedScopes` is the lower-level set/predicate (§6.4),
   * intersected. On a containment change an out-of-scope selection is dropped
   * and the invalidation surfaced inline (§6.6), never silently retained.
   */
  parentScope?: ScopeIdentity | null;
  allowedScopes?: AllowedScopes;
};

/** The unified picker's discriminated prop contract (cinatra#1607). */
export type AnyAccessComboboxProps = AccessComboboxProps | AccessComboboxMultiProps;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the human-readable label for a given access value — a thin
 * `{ type, name }` view over `resolveFlatAccessOption` (cinatra#2372), kept
 * for the existing call shape. `type` is now populated for EVERY classified
 * kind (Personal / Workspace / Organization included, not just Team /
 * Project): trigger ≡ row, verbatim, for every scope kind (app-permissions.html
 * c-3.1) — there is no longer a bare-name trigger form for any kind.
 */
export function resolveAccessLabel(
  value: string,
  availableScopes: AccessComboboxProps["availableScopes"],
): { type: string | null; name: string } {
  const option = resolveFlatAccessOption(value, availableScopes);
  return { type: option.type || null, name: option.name };
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
 * Single-select (flat) access-level combobox. Presentational only — no auth
 * decisions, no session reads, no fetch calls.
 *
 * Row list (spec app-permissions.html §III / §3.2, narrow → broad — NO group
 * headings; every row is scope-PREFIXED; consecutive groups divided by a
 * hairline separator):
 *   1. Personal:     "Only me"          (hidden in installMode)
 *   2. Project:      <name> rows        (or a synthesized "Unknown project")
 *   3. Team:         <name> rows        (or a synthesized "Unknown team")
 *   4. Organization: <name>             (always rendered)
 *   5. Workspace:    "All" then "Admins only" (one shared group)
 *
 * Containment (spec §VI): `parentScope` / `allowedScopes` narrow the offered
 * org/team/project/workspace rows to within a parent (Personal never dropped);
 * an out-of-scope selection is reconciled away and surfaced inline (§6.6).
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
  parentScope,
  allowedScopes,
}: AccessComboboxProps) {
  const [open, setOpen] = useState(false);

  const { projects, teams, orgId } = availableScopes;
  // Org row value: the id-carrying `org:<id>` token (multi-scope W1), matched to
  // the server-built install-target row value `org:<activeOrgId>` EXACTLY so the
  // selected-state, checkmark, and disabledScopes lookup line up — including the
  // no-active-org case, where the server emits `org:` (empty tail) and the row
  // must key on the same token or the disabled-scope membership check would miss.
  // Falls back to the legacy bare `"org"` only when no org id is SUPPLIED at all
  // (`orgId` undefined — e.g. the read-only Permissions tab, popover disabled).
  // A stray empty-tail `org:` click is rejected by the value→target adapter guard.
  const orgRowValue = orgId != null ? `org:${orgId}` : "org";

  // ---------------------------------------------------------------------------
  // Containment (spec §VI). With no constraint the predicate admits everything
  // (a no-op — the shipped behaviour); with a `parentScope` / `allowedScopes`
  // it narrows the offered org/team/project/workspace rows. The flat shape is
  // single-org, so every team belongs to the active org.
  // ---------------------------------------------------------------------------
  const constraints: ContainmentConstraints = { parentScope, allowedScopes };
  const containmentOn = hasContainment(constraints);
  const containmentCtx: ContainmentContext = React.useMemo(
    () => ({
      knownOrgIds: new Set(orgId != null ? [orgId] : []),
      // Flat shape is single-org: every flat team AND project belongs to the
      // active org.
      teamOrgOf: (teamId: string) =>
        teams.some((t) => t.id === teamId) ? orgId ?? undefined : undefined,
      projectOrgOf: (projectId: string) =>
        projects.some((p) => p.id === projectId) ? orgId ?? undefined : undefined,
    }),
    [orgId, teams, projects],
  );
  const offered = (token: string) =>
    !containmentOn || isScopeOffered(token, constraints, containmentCtx);

  // §6.6 reconciliation. `outOfScope` is recomputed EACH RENDER from the live
  // value + constraints + data, so a change to ANY of them — including a new
  // `allowedScopes` predicate a serialized key could not distinguish, a `value`
  // that goes out of scope under unchanged constraints, or scope-data changes —
  // is caught. The inline NOTE is set via React's render-time adjust-state
  // pattern (bounded: it flips at most once), so it triggers a re-render and
  // persists past the clear until the next pick; the actual CLEAR is the effect's
  // job (sync the parent — the allowed effect shape).
  const outOfScope = containmentOn && !!value && !offered(value);
  const [invalidated, setInvalidated] = useState(false);
  if (outOfScope && !invalidated) setInvalidated(true);
  else if (!containmentOn && invalidated) setInvalidated(false); // containment removed → drop a stale note
  useEffect(() => {
    if (outOfScope) onValueChange("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outOfScope, value]);

  // Commit a selection: clear any prior invalidation note, propagate, close.
  const commit = (v: string) => {
    setInvalidated(false);
    onValueChange(v);
    setOpen(false);
  };

  // The canonical flat model (cinatra#2372): ONE resolver call per value
  // produces the {type, name} pair BOTH the trigger and its matching row
  // render — trigger ≡ row holds by construction, not by two hand-written
  // strings that happen to agree today.
  const resolveRow = (rowValue: string): FlatAccessOption =>
    resolveFlatAccessOption(rowValue, availableScopes);
  const selectedOption = resolveRow(value);
  const selected = { type: selectedOption.type || null, name: selectedOption.name };

  // Selected-scope synthesis (cinatra#1509 §3.2 / #1508, extended to org tokens
  // by cinatra#2372 c-3.11): a `team:<id>` / `project:<id>` selection that does
  // not hydrate to any available row (the team/project belongs to another org,
  // or the viewer isn't a member), or an org token that does not resolve to the
  // CONFIRMED active org (a mismatched id, an empty tail, or no active org in
  // scope), would otherwise render NO row — so the selection had no checkmark
  // and looked unselected. Synthesize an explicit, checked, display-only row
  // (never committable — `resolveFlatAccessOption` marks it `synthetic`) so a
  // selection is ALWAYS visible with its checkmark, independent of hydration.
  const needsSynthTeam =
    value.startsWith("team:") && !teams.some((t) => `team:${t.id}` === value);
  const needsSynthProject =
    value.startsWith("project:") && !projects.some((p) => `project:${p.id}` === value);
  const needsSynthOrg = value.startsWith("org:") && selectedOption.synthetic;

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
    // The disabled reason is ALSO rendered as sr-only text inside the option
    // content (cinatra#2372 F5): with the "Targets you cannot install at are
    // disabled." helper line removed, the tooltip was the only carrier of the
    // reason and it is pointer-only. Screen readers now get the reason as part
    // of the option's own text. Deliberately NOT a tabIndex on the wrapper —
    // a tabbable role-less element inside the cmdk listbox competes with the
    // combobox's aria-activedescendant keyboard model (F6).
    const disabledItem = React.cloneElement(
      item as React.ReactElement<Record<string, unknown>>,
      {
        disabled: true,
        onSelect: undefined,
        "aria-disabled": true,
      },
      <>
        {(item.props as { children?: React.ReactNode }).children}
        <span className="sr-only"> — {tooltipText}</span>
      </>,
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

  // Scope-prefixed row label (spec §2.3 / §3.2): `<Scope>: <name>`, no heading.
  // The muted title-case prefix matches the multi-mode row prefix so the two
  // modes read consistently.
  const rowLabel = (prefix: string, name: string) => (
    <span className="flex items-baseline gap-1 min-w-0">
      <span className="text-xs tracking-wide text-muted-foreground shrink-0">
        {prefix}:
      </span>
      <span className="text-foreground whitespace-nowrap">{name}</span>
    </span>
  );

  // A synthesized, checked, DISPLAY-ONLY row for an unhydrated/degenerate
  // selection (rowValue === the current value, so `itemClass` marks it
  // selected and `renderCheckmark` shows its check). Scope-prefixed (§3.4)
  // with the shared "Unknown …" fallback (§2.4) — never a raw id.
  // cinatra#2372 c-3.11: synthetic degenerate options are display-only, so
  // the row is disabled (no onSelect) — it exists to make the stored
  // selection visible with its checkmark, never to be re-committed.
  const renderSynthRow = (rowValue: string, prefix: string, name: string) => (
    <CommandItem
      value={rowValue}
      disabled
      aria-disabled="true"
      data-synthetic="true"
      className={itemClass(rowValue)}
    >
      <div className="flex items-center w-full">
        {rowLabel(prefix, name)}
        {renderCheckmark(rowValue)}
      </div>
    </CommandItem>
  );

  // ---------------------------------------------------------------------------
  // Assemble the scope groups, narrow → broad, containment-filtered (spec §3.2).
  // NO group headings; each row is scope-prefixed; consecutive groups divided by
  // a hairline separator inserted between them at render.
  // ---------------------------------------------------------------------------
  const offeredProjects = projects.filter((p) => offered(`project:${p.id}`));
  const offeredTeams = teams.filter((t) => offered(`team:${t.id}`));
  const synthProjectOffered = needsSynthProject && offered(value);
  const synthTeamOffered = needsSynthTeam && offered(value);
  // No second synthetic row when the degenerate selection IS the org row's own
  // value (the no-active-org shape, where orgRowValue is the empty-tail
  // `org:`): the org row itself then renders display-only + checked below —
  // two identical-value rows would double-render the same option.
  const synthOrgOffered = needsSynthOrg && offered(value) && value !== orgRowValue;

  const groupNodes: Array<{ key: string; node: React.ReactNode }> = [];

  // (1) Personal — hidden in installMode (owner is not an install target, §3.7).
  if (!installMode) {
    const personal = resolveRow("owner");
    groupNodes.push({
      key: "personal",
      node: (
        <CommandGroup className="p-0">
          <CommandItem value="owner" onSelect={() => commit("owner")} className={itemClass("owner")}>
            <div className="flex items-center w-full">
              {rowLabel(personal.type, personal.name)}
              {renderCheckmark("owner")}
            </div>
          </CommandItem>
        </CommandGroup>
      ),
    });
  }

  // (2) Project — rendered when there are (offered) projects OR an unhydrated
  //     project selection to synthesize.
  if (offeredProjects.length > 0 || synthProjectOffered) {
    groupNodes.push({
      key: "project",
      node: (
        <CommandGroup className="p-0">
          {offeredProjects.map((p) => {
            const itemValue = `project:${p.id}`;
            const row = resolveRow(itemValue);
            const item = (
              <CommandItem key={p.id} value={itemValue} onSelect={() => commit(itemValue)} className={itemClass(itemValue)}>
                <div className="flex items-center w-full">
                  {rowLabel(row.type, row.name)}
                  {renderCheckmark(itemValue)}
                </div>
              </CommandItem>
            );
            return <React.Fragment key={p.id}>{renderTargetRow(itemValue, item)}</React.Fragment>;
          })}
          {synthProjectOffered && renderSynthRow(value, selectedOption.type, selectedOption.name)}
        </CommandGroup>
      ),
    });
  }

  // (3) Team — its own group above the org row (narrow → broad).
  if (offeredTeams.length > 0 || synthTeamOffered) {
    groupNodes.push({
      key: "team",
      node: (
        <CommandGroup className="p-0">
          {offeredTeams.map((t) => {
            const itemValue = `team:${t.id}`;
            const row = resolveRow(itemValue);
            const item = (
              <CommandItem key={t.id} value={itemValue} onSelect={() => commit(itemValue)} className={itemClass(itemValue)}>
                <div className="flex items-center w-full">
                  {rowLabel(row.type, row.name)}
                  {renderCheckmark(itemValue)}
                </div>
              </CommandItem>
            );
            return <React.Fragment key={t.id}>{renderTargetRow(itemValue, item)}</React.Fragment>;
          })}
          {synthTeamOffered && renderSynthRow(value, selectedOption.type, selectedOption.name)}
        </CommandGroup>
      ),
    });
  }

  // (4) Organization — id-carrying `org:<id>` value so the selected-state,
  //     checkmark, and disabledScopes lookup match the server-built target rows.
  //     Always rendered UNLESS containment excludes the org itself (§6.1). A
  //     degenerate SELECTED org token with a DIFFERENT value (mismatched id)
  //     renders as a SECOND, synthetic, checked row in the same group — the
  //     real active-org row still renders, unselected, with no cross-org
  //     lookup performed for the synthetic one. When the org row's OWN value
  //     is degenerate (no active org in scope → the empty-tail `org:` token,
  //     cinatra#2372 AC2), the row is display-only: server-disabled rows keep
  //     the reasoned disabled treatment (tooltip), and even without a
  //     disabledScopes entry the synthetic resolution renders it
  //     non-selectable — a role cannot make a nonexistent org committable.
  const orgRow = resolveRow(orgRowValue);
  const orgRowServerDisabled = disabledScopes?.includes(orgRowValue) ?? false;
  if (offered(orgRowValue) || synthOrgOffered) {
    groupNodes.push({
      key: "org",
      node: (
        <CommandGroup className="p-0">
          {offered(orgRowValue) &&
            (orgRow.synthetic && !orgRowServerDisabled ? (
              renderSynthRow(orgRowValue, orgRow.type, orgRow.name)
            ) : (
              renderTargetRow(
                orgRowValue,
                <CommandItem value={orgRowValue} onSelect={() => commit(orgRowValue)} className={itemClass(orgRowValue)}>
                  <div className="flex items-center w-full">
                    {rowLabel(orgRow.type, orgRow.name)}
                    {renderCheckmark(orgRowValue)}
                  </div>
                </CommandItem>,
              )
            ))}
          {synthOrgOffered && renderSynthRow(value, selectedOption.type, selectedOption.name)}
        </CommandGroup>
      ),
    });
  }

  // (5) Workspace — the "All" then "Admins only" rows share ONE group (§3.2).
  //     • installMode: shown only with installWorkspaceScopes, as SERVER-DRIVEN
  //       target rows (renderTargetRow consults disabledScopes/disabledReasons).
  //     • non-installMode (permissions tab): the isAdmin-gated "All" row + the
  //       always-selectable "Admins only" row (§3.9).
  //     Both rows drop out under an org / personal containment parent (§6.1).
  const workspaceOffered = offered("workspace");
  const adminOffered = offered("admin");
  const showWorkspaceGroup = installMode
    ? installWorkspaceScopes && (workspaceOffered || adminOffered)
    : workspaceOffered || adminOffered;
  const workspaceRow = resolveRow("workspace");
  const adminRow = resolveRow("admin");
  if (showWorkspaceGroup) {
    groupNodes.push({
      key: "workspace",
      node: (
        <CommandGroup className="p-0">
          {installMode ? (
            <>
              {workspaceOffered &&
                renderTargetRow(
                  "workspace",
                  <CommandItem value="workspace" onSelect={() => commit("workspace")} className={itemClass("workspace")}>
                    <div className="flex items-center w-full">
                      {rowLabel(workspaceRow.type, workspaceRow.name)}
                      {renderCheckmark("workspace")}
                    </div>
                  </CommandItem>,
                )}
              {adminOffered &&
                renderTargetRow(
                  "admin",
                  <CommandItem value="admin" onSelect={() => commit("admin")} className={itemClass("admin")}>
                    <div className="flex items-center w-full">
                      {rowLabel(adminRow.type, adminRow.name)}
                      {renderCheckmark("admin")}
                    </div>
                  </CommandItem>,
                )}
            </>
          ) : (
            <>
              {workspaceOffered &&
                (isAdmin ? (
                  <CommandItem value="workspace" onSelect={() => commit("workspace")} className={itemClass("workspace")}>
                    <div className="flex items-center w-full">
                      {rowLabel(workspaceRow.type, workspaceRow.name)}
                      {renderCheckmark("workspace")}
                    </div>
                  </CommandItem>
                ) : (
                  // Tooltip wiring fix (cinatra#2372): the TooltipTrigger must
                  // wrap an outer <span>, NOT the disabled CommandItem directly
                  // — a disabled CommandItem gets `pointer-events: none` (cmdk),
                  // so a Tooltip mounted on it never receives hover, and (being
                  // outside the tab order) never receives focus either. The
                  // wrapper span below is focusable (tabIndex 0) and receives
                  // both — the same outer-wrapper-span pattern `renderTargetRow`
                  // already uses for the org/team/project disabled rows.
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span aria-disabled="true" tabIndex={0}>
                        <CommandItem
                          value="workspace"
                          disabled
                          aria-disabled="true"
                          onSelect={undefined}
                          className="rounded-none px-3 py-2 text-muted-foreground cursor-not-allowed"
                        >
                          <div className="flex items-center w-full gap-1">
                            {rowLabel(workspaceRow.type, workspaceRow.name)}
                            <Lock aria-hidden className="size-3.5 ml-auto" />
                          </div>
                        </CommandItem>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[240px]">
                      Only platform admins can select Workspace: All.
                    </TooltipContent>
                  </Tooltip>
                ))}
              {adminOffered && (
                <CommandItem value="admin" onSelect={() => commit("admin")} className={itemClass("admin")}>
                  <div className="flex items-center w-full">
                    {rowLabel(adminRow.type, adminRow.name)}
                    {renderCheckmark("admin")}
                  </div>
                </CommandItem>
              )}
            </>
          )}
        </CommandGroup>
      ),
    });
  }

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
            // default (`h-8`), matching Input + the multi-select trigger
            // (cinatra#1509 §3.2 — the mechanism behind #1505's misaligned rows).
            className="w-full justify-between rounded-control border-line font-normal"
          >
            {/* Trigger ≡ row, verbatim (spec c-3.1): EVERY kind carries its
                `<Type>:` prefix, in the SAME casing as the row (no `uppercase`
                transform — that was the old TEAM:/PROJECT: divergence from the
                row's Team:/Project:). Both spans mirror rowLabel's structure
                exactly; only `truncate` (vs. the row's `whitespace-nowrap`) is
                trigger-specific overflow handling, not a text difference. */}
            <span className="flex items-center min-w-0 gap-1">
              {selected.type && (
                <span className="text-xs tracking-wide text-muted-foreground shrink-0">
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
              {groupNodes.map((grp, i) => (
                <React.Fragment key={grp.key}>
                  {i > 0 && <CommandSeparator />}
                  {grp.node}
                </React.Fragment>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {/* §6.6 reconciliation surface: the invalidation of an out-of-scope
          selection is shown inline, never silently retained. */}
      {invalidated && (
        <p role="status" className="mt-1.5 text-xs text-muted-foreground">
          The previous selection is no longer available in this scope. Choose a new one.
        </p>
      )}
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
  showPersonal = true,
  disabledScopes,
  disabledReasons,
  toggleSelection,
  rowState,
  summarizeSelection,
  parentScope,
  allowedScopes,
}: AccessComboboxMultiProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  // ---------------------------------------------------------------------------
  // Containment (spec §VI). With no constraint the predicate admits everything
  // (a no-op). The nested shape gives team→org parentage directly.
  // ---------------------------------------------------------------------------
  const constraints: ContainmentConstraints = { parentScope, allowedScopes };
  const containmentOn = hasContainment(constraints);
  const containmentCtx: ContainmentContext = React.useMemo(
    () => ({
      knownOrgIds: new Set(scopes.orgs.map((o) => o.id)),
      teamOrgOf: (teamId: string) =>
        scopes.orgs.find((o) => o.teams.some((t) => t.id === teamId))?.id,
    }),
    [scopes],
  );
  const offered = (token: string) =>
    !containmentOn || isScopeOffered(token, constraints, containmentCtx);

  const matches = (text: string) => {
    if (search.trim().length === 0) return true;
    return text.toLowerCase().includes(search.trim().toLowerCase());
  };
  const filteredProjects = scopes.projects.filter(
    (p) => offered(`project:${p.id}`) && matches(`project ${p.name}`),
  );
  const filteredTeams = scopes.orgs
    .flatMap((org) => org.teams.map((t) => ({ org, t })))
    .filter(({ org, t }) => offered(`team:${t.id}`) && matches(`team ${org.name} ${t.name}`));
  const filteredOrgs = scopes.orgs.filter(
    (o) => offered(`org:${o.id}`) && matches(`organization ${o.name}`),
  );
  // Personal is never dropped by CONTAINMENT (§6.2); `showPersonal` is a
  // separate, explicit opt-out for a surface where the row can match nothing.
  const showOnlyMe = showPersonal && matches("only me");
  const showWorkspaceAll = offered("workspace") && matches("workspace all");
  const showAdminsOnly = showAdmin && offered("admin") && matches("workspace admins only");

  // §6.6 reconciliation. `reconciled` is recomputed EACH RENDER from the live
  // value + constraints + data, so any relevant change (a new `allowedScopes`
  // predicate, a `value` that drifts out of scope, or scope-data changes) is
  // caught — not just a serialized-key change. The inline NOTE is set via the
  // render-time adjust-state pattern (bounded); the CLEAR (drop the out-of-scope
  // tokens) is the effect's job, keyed on the actual value + drop signatures.
  const reconciled = containmentOn
    ? reconcileSelection(value, constraints, containmentCtx)
    : { kept: value as string[], dropped: [] as string[] };
  const hasDrift = reconciled.dropped.length > 0;
  const [invalidated, setInvalidated] = useState(false);
  if (hasDrift && !invalidated) setInvalidated(true);
  else if (!containmentOn && invalidated) setInvalidated(false); // containment removed → drop a stale note
  const valueSig = value.join("|");
  const dropSig = reconciled.dropped.join("|");
  useEffect(() => {
    if (hasDrift) onChange(reconciled.kept);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueSig, dropSig]);

  // Explicit selection as an array (multi mode uses the value verbatim). The
  // toggle + implication logic lives in the pure, unit-tested access-scope
  // module.
  const selection: string[] = value;

  const toggleMulti = (itemValue: string) => {
    setInvalidated(false);
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
  const multiSummary = summarizeSelection
    ? summarizeSelection(multiSelection, scopes)
    : resolveAccessSummary(multiSelection as AgentAuthPolicyVisibility[], scopes);
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
    <>
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
    {/* §6.6 reconciliation surface: out-of-scope selections were dropped and the
        invalidation is shown inline, never silently retained. */}
    {invalidated && (
      <p role="status" className="mt-1.5 text-xs text-muted-foreground">
        Some selections were removed because they are no longer in scope.
      </p>
    )}
    </>
  );
}
