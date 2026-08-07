// ---------------------------------------------------------------------------
// Pure (server- and client-safe) access-scope label helpers.
//
// Split out of the access picker (a "use client" module) so that server
// components and shared libs can resolve scope labels without pulling a client
// component into their graph. The unified access-combobox.tsx re-exports these
// for existing callers.
//
// Labels are title-case ("Workspace: All", "Workspace: Admins only", etc.) and
// are the single source of truth for the trigger, the dropdown rows, and any
// permission-summary text.
// ---------------------------------------------------------------------------

import type {
  AgentAuthPolicyVisibility,
  AgentAuthPolicyVisibilitySelection,
} from "@cinatra-ai/agents/auth-policy";
import { normalizeVisibilitySelection } from "@cinatra-ai/agents/auth-policy-types";

export type AvailableScopes = {
  orgs: Array<{ id: string; name: string; teams: Array<{ id: string; name: string }> }>;
  projects: Array<{ id: string; name: string }>;
  canGrantWorkspace: boolean;
};

// ---------------------------------------------------------------------------
// Unknown-entity fallback — the ONE shared source of truth for BOTH pickers
// (cinatra#1509 §4.0-a). Replaces every silent `id.slice(-6)` fallback so an
// unresolvable scope id NEVER leaks a truncated id into a human label. Both the
// hierarchical `resolveAccessParts` (below) AND the flat picker's local
// `resolveAccessLabel` (src/components/access-combobox.tsx) delegate here, so
// the "Unknown team" / "Unknown project" / … contract (§3.2) has a single
// definition instead of two copies that drift (cinatra#1508's `Team: 288b9a`).
// ---------------------------------------------------------------------------

export type ScopeEntityKind = "team" | "project" | "user" | "org" | "template";

const UNKNOWN_SCOPE_ENTITY_LABEL: Record<ScopeEntityKind, string> = {
  team: "Unknown team",
  project: "Unknown project",
  user: "Unknown user",
  org: "Unknown organization",
  template: "Unknown template",
};

/**
 * The explicit "Unknown <kind>" label shown when an entity id cannot be
 * resolved to a name. NEVER contains the id — an unresolved scope reads as
 * "Unknown team", not a truncated id suffix (§3.2). Callers relegate the raw id
 * to a tooltip / secondary `font-mono` line, never into this label.
 */
export function unknownScopeEntityName(kind: ScopeEntityKind): string {
  return UNKNOWN_SCOPE_ENTITY_LABEL[kind];
}

/**
 * Resolve an entity id to a display name: the resolved name when present and
 * non-empty, otherwise the explicit "Unknown <kind>" fallback. The `id` is
 * accepted so callers pass the full (kind, id, name?) triple, but is
 * DELIBERATELY never leaked into the returned label (cinatra#1508 — the
 * previous `id.slice(-6)` fallbacks surfaced a raw id as if it were a name).
 */
export function resolveScopeEntityName(
  kind: ScopeEntityKind,
  id: string,
  resolvedName?: string | null,
): string {
  void id; // accepted for a stable call shape; never interpolated into the label.
  const trimmed = resolvedName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : unknownScopeEntityName(kind);
}

/**
 * Resolve a visibility token to (type, name) for rendering. The closed trigger
 * shows `<type>: <name>`; dropdown rows reuse the same decomposition so the
 * Project / Team / Organization / Workspace / Personal prefixes stay consistent.
 */
export function resolveAccessParts(
  visibility: AgentAuthPolicyVisibility,
  scopes: AvailableScopes,
): { type: string | null; name: string } {
  if (visibility === "owner") return { type: "Personal", name: "Only me" };
  if (visibility === "admin") return { type: "Workspace", name: "Admins only" };
  if (visibility === "workspace") return { type: "Workspace", name: "All" };
  if (typeof visibility === "string" && visibility.startsWith("org:")) {
    const id = visibility.slice("org:".length);
    const name = scopes.orgs.find((o) => o.id === id)?.name ?? scopes.orgs[0]?.name ?? "your organization";
    return { type: "Organization", name };
  }
  if (visibility === "org") {
    return { type: "Organization", name: scopes.orgs[0]?.name ?? "your organization" };
  }
  if (typeof visibility === "string" && visibility.startsWith("team:")) {
    const id = visibility.slice("team:".length);
    const owner = scopes.orgs.find((o) => o.teams.some((t) => t.id === id));
    const team = owner?.teams.find((t) => t.id === id);
    return {
      type: "Team",
      name: resolveScopeEntityName("team", id, owner && team ? `${owner.name} - ${team.name}` : undefined),
    };
  }
  if (typeof visibility === "string" && visibility.startsWith("project:")) {
    const id = visibility.slice("project:".length);
    return {
      type: "Project",
      name: resolveScopeEntityName("project", id, scopes.projects.find((p) => p.id === id)?.name),
    };
  }
  return { type: null, name: visibility };
}

export function resolveAccessLabel(
  visibility: AgentAuthPolicyVisibility,
  scopes: AvailableScopes,
): string {
  const parts = resolveAccessParts(visibility, scopes);
  return parts.type ? `${parts.type}: ${parts.name}` : parts.name;
}

// Scope-category grouping for the multi-token trigger summary. Every token maps
// to exactly one category carrying a (singular, plural) noun; categories render
// in a FIXED order (narrow → broad) so the composed summary is stable regardless
// of the selection order. `owner`/`workspace` are exclusive singletons — they
// never co-occur in an N>1 selection — but are classified defensively.
type ScopeCategory = "project" | "team" | "organization" | "admin" | "workspace" | "owner";

const SCOPE_CATEGORY_ORDER: readonly ScopeCategory[] = [
  "project",
  "team",
  "organization",
  "admin",
  "workspace",
  "owner",
];

const SCOPE_CATEGORY_NOUNS: Record<ScopeCategory, readonly [string, string]> = {
  project: ["project", "projects"],
  team: ["team", "teams"],
  organization: ["organization", "organizations"],
  admin: ["admin scope", "admin scopes"],
  workspace: ["workspace", "workspaces"],
  owner: ["personal scope", "personal scopes"],
};

function scopeCategory(visibility: AgentAuthPolicyVisibility): ScopeCategory {
  if (typeof visibility === "string") {
    if (visibility.startsWith("project:")) return "project";
    if (visibility.startsWith("team:")) return "team";
    if (visibility === "org" || visibility.startsWith("org:")) return "organization";
    if (visibility === "admin") return "admin";
    if (visibility === "workspace") return "workspace";
  }
  return "owner";
}

/**
 * Summarize a visibility SELECTION for a compact trigger label. A single token
 * renders as its full `Type: Name` label; N>1 tokens render as a composed,
 * pluralised, stable-ordered breakdown BY scope category — e.g. `1 project,
 * 1 team` or `2 teams, 1 organization` — replacing the earlier opaque
 * `N scopes` (owner review, cinatra#1261). An empty selection falls back to the
 * owner label. Additive — the single-token `resolveAccessParts` /
 * `resolveAccessLabel` are unchanged.
 */
export function resolveAccessSummary(
  selection: readonly AgentAuthPolicyVisibility[],
  scopes: AvailableScopes,
): string {
  if (selection.length <= 1) {
    return resolveAccessLabel(selection[0] ?? "owner", scopes);
  }
  const counts = {} as Record<ScopeCategory, number>;
  for (const token of selection) {
    const category = scopeCategory(token);
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return SCOPE_CATEGORY_ORDER.filter((category) => (counts[category] ?? 0) > 0)
    .map((category) => {
      const n = counts[category];
      const [singular, plural] = SCOPE_CATEGORY_NOUNS[category];
      return `${n} ${n === 1 ? singular : plural}`;
    })
    .join(", ");
}

// ---------------------------------------------------------------------------
// Multi-scope selection logic for the checkbox access picker (cinatra#1072,
// multi-scope W3). Kept here — beside the label helpers, in the pure module the
// picker already imports — rather than in a NEW file, so it adds no reachable
// first-party module to the routes that transitively reach the picker (the
// route-graph no-new-rot ratchet). Pure + node-testable (no DOM), so the toggle
// + implication rules are unit-tested directly.
//
// Semantics (epic #1069 rules 2-4):
//   - Downward implication is DISPLAY-ONLY: a checked org implies its OWN team
//     rows (checked+disabled, "Included via <org>"); a checked workspace
//     implies every scope row; projects are NEVER implied by org/team. Implied
//     tokens are never written into the stored selection.
//   - `owner` ("Only me") and `workspace` ("All") are EXCLUSIVE: toggling
//     either collapses the selection to just that token; unchecking workspace
//     falls back to owner. `owner` is the narrowing floor, never "implied".
//   - Scoped tokens (org/team/project) and `admin` add/remove and canonicalise
//     through normalizeVisibilitySelection (dedupe, owner-strip-when-mixed,
//     non-empty floor, no upward collapse).
// ---------------------------------------------------------------------------

export type AccessRowState = {
  /** Rendered checkbox state (explicit membership OR an implied inclusion). */
  checked: boolean;
  /** Implied (org/workspace) — the checkbox is locked; cannot be toggled here. */
  impliedDisabled: boolean;
  /** Human note explaining an implied lock ("Included via <org>"). */
  impliedNote?: string;
};

/**
 * Derive the checkbox + disabled state for one row VALUE against the current
 * explicit `selection`. `impliedDisabled` rows are display-only inclusions —
 * their token is NOT in `selection` (unless separately checked), so releasing
 * the implier restores the underlying explicit state.
 */
export function accessRowState(
  itemValue: string,
  selection: readonly string[],
  scopes: AvailableScopes,
): AccessRowState {
  const set = new Set(selection);
  const workspaceChecked = set.has("workspace");
  const explicit = set.has(itemValue);

  if (itemValue === "owner") {
    // "Only me" is the narrowing floor, not a widenable scope: never implied.
    // It is DISABLED (a) while workspace is selected (workspace is broader) and
    // (b) when it is already the SOLE selection — the floor cannot be unchecked
    // (there is no emptier state; pick a scope to share instead), so leaving it
    // clickable would be a surprising no-op (codex round-1). It becomes an
    // enabled clear-to-owner action only once a broader scope is also selected.
    const ownerOnly = explicit && selection.length === 1;
    return { checked: explicit, impliedDisabled: workspaceChecked || ownerOnly };
  }
  if (itemValue === "workspace") {
    return { checked: explicit, impliedDisabled: false };
  }
  if (itemValue.startsWith("team:")) {
    const teamId = itemValue.slice("team:".length);
    const owningOrg = scopes.orgs.find((o) => o.teams.some((t) => t.id === teamId));
    const impliedByOrg = owningOrg ? set.has(`org:${owningOrg.id}`) : false;
    if (impliedByOrg) {
      return {
        checked: true,
        impliedDisabled: true,
        impliedNote: `Included via ${owningOrg?.name ?? "organization"}`,
      };
    }
    if (workspaceChecked) {
      return { checked: true, impliedDisabled: true, impliedNote: "Included via Workspace: All" };
    }
    return { checked: explicit, impliedDisabled: false };
  }
  // org / project / admin: implied only by workspace (projects are never
  // implied by org/team — epic #1069 rule 3).
  if (workspaceChecked) {
    return { checked: true, impliedDisabled: true, impliedNote: "Included via Workspace: All" };
  }
  return { checked: explicit, impliedDisabled: false };
}

/**
 * Toggle one row VALUE against the current `selection`, returning the canonical
 * next selection. Callers only ever invoke this for a NON-implied (enabled)
 * row, so the incoming checked state equals explicit membership.
 */
export function toggleAccessSelection(
  itemValue: string,
  selection: readonly string[],
): AgentAuthPolicyVisibilitySelection {
  if (itemValue === "owner") {
    // Clear-to-owner: "Only me" is exclusive.
    return normalizeVisibilitySelection(["owner"]);
  }
  if (itemValue === "workspace") {
    return normalizeVisibilitySelection(
      selection.includes("workspace") ? ["owner"] : ["workspace"],
    );
  }
  const isChecked = selection.includes(itemValue);
  const raw = (
    isChecked
      ? selection.filter((t) => t !== itemValue)
      : [...selection, itemValue]
  ) as AgentAuthPolicyVisibility[];
  return normalizeVisibilitySelection(raw);
}

// ---------------------------------------------------------------------------
// The canonical flat access-option model (cinatra#2372, mkt-install S1).
//
// Kept in THIS file — the pure module the flat picker already imports for the
// "Unknown …" fallback — rather than a new sibling module, so no new
// reachable first-party module is added to any route that transitively
// imports the picker (the route-graph no-new-rot ratchet).
//
// ONE resolver, `resolveFlatAccessOption`, is the single source of truth for
// EVERY selectable value in the flat (single-select) picker's six scope
// kinds — Personal / Project / Team / Organization / Workspace(All) /
// Workspace(Admins only). Both the closed trigger AND the open dropdown row
// read a value's `{ type, name }` off the SAME returned option, so
// "trigger ≡ row, verbatim" (app-permissions.html c-3.1) holds BY
// CONSTRUCTION — there is no second, independently-maintained trigger label
// path that can drift from the row copy (the bug this model replaces: the old
// `resolveAccessLabel` in access-combobox.tsx and the row-building code each
// hand-wrote their own strings for the same value).
//
// A degenerate / legacy / unhydrated value (a stale team/project id, a
// mismatched or empty-tail org token, an org token with no active org in
// scope) still resolves to a SELECTED, visible option — `synthetic: true` —
// so the picker never silently hides what is actually stored
// (app-permissions.html c-3.11). `committable` is `false` for every synthetic
// option and for any option whose value is not currently offered/enabled;
// submit gating in every single-mode consumer reads THIS field instead of
// value-truthiness, closing the reachable defect where an enabled empty-tail
// `org:` default reached a server action that then rejected it.
// ---------------------------------------------------------------------------

/** The four Personal/Team/Project/Organization/Workspace row prefixes the
 * closed trigger and every dropdown row render verbatim (app-permissions.html
 * §II / §3.2). */
export type FlatAccessOptionType =
  | "Personal"
  | "Project"
  | "Team"
  | "Organization"
  | "Workspace";

export type FlatAccessOption = {
  /** The picker value ("owner" | "admin" | "workspace" | "org" | `org:<id>` |
   * `team:<id>` | `project:<id>`, or an arbitrary/degenerate string). */
  value: string;
  /** The row prefix. Empty string only for a value this model cannot classify
   * at all (never reachable through the picker's own rows). */
  type: FlatAccessOptionType | "";
  /** The row's name half — combined with `type` as `${type}: ${name}`, this
   * IS the trigger's rendered text, verbatim (c-3.1). */
  name: string;
  /** True for a display-only row synthesized because the value does not
   * resolve to a live, server-offered, non-synthetic target (c-3.11): an
   * unhydrated team/project id, or a degenerate/legacy/cross-org org token. */
  synthetic: boolean;
  /** True only when this value maps to an enabled, server-offered,
   * non-synthetic target — the ONE signal every single-mode consumer gates
   * its submit control on (never bare value-truthiness). */
  committable: boolean;
};

export type FlatAccessAvailableScopes = {
  projects: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  orgName: string;
  /** Active organization id. Absent OR empty/whitespace (the production
   * no-active-org shape is `""` via `activeOrgId ?? ""`) counts as NO active
   * org: any `org:<id>` token degrades to the neutral synthetic option and
   * the bare legacy `org` token stays display-only (non-committable) — see
   * `resolveFlatAccessOption`. */
  orgId?: string;
};

export type FlatAccessResolveContext = {
  /** Values the server marked non-selectable (still resolved + rendered, just
   * not committable). */
  disabledScopes?: readonly string[];
  /** Whether "owner" (Personal: Only me) is offered as a row at all —
   * `installMode` hides it entirely, so it can never be committable there.
   * Defaults to `true` (the permissions-tab shape, where owner is always the
   * narrowing floor). */
  ownerOffered?: boolean;
  /** Whether "workspace" (Workspace: All) is offered as a row at all.
   * Defaults to `true`; install-mode consumers that did not request the
   * always-offered workspace scopes (`installWorkspaceScopes` /
   * `includeWorkspaceScopes`) must pass `false` so a value of "workspace" can
   * never be committable when the row was never actually rendered. */
  workspaceOffered?: boolean;
  /** Whether "admin" (Workspace: Admins only) is offered as a row at all.
   * Same default / rationale as `workspaceOffered`. */
  adminOffered?: boolean;
};

/** The canonical org row VALUE for the active org — `org:<id>` when an id is
 * supplied, degrading to the legacy bare `"org"` only when no org id is
 * supplied at all (matches the picker's own `orgRowValue` derivation). */
export function canonicalOrgToken(orgId?: string): string {
  return orgId != null ? `org:${orgId}` : "org";
}

/**
 * Resolve ANY picker value — a real row's value or a degenerate/legacy one —
 * to its canonical `FlatAccessOption`. This is the ONE function the trigger,
 * every dropdown row, and every single-mode consumer's submit gate call for a
 * given value; there is no second label or committability path.
 */
export function resolveFlatAccessOption(
  value: string,
  scopes: FlatAccessAvailableScopes,
  ctx: FlatAccessResolveContext = {},
): FlatAccessOption {
  const disabledScopes = ctx.disabledScopes ?? [];
  const isDisabled = (v: string) => disabledScopes.includes(v);

  if (value === "owner") {
    return {
      value,
      type: "Personal",
      name: "Only me",
      synthetic: false,
      committable: (ctx.ownerOffered ?? true) && !isDisabled(value),
    };
  }
  if (value === "admin") {
    return {
      value,
      type: "Workspace",
      name: "Admins only",
      synthetic: false,
      committable: (ctx.adminOffered ?? true) && !isDisabled(value),
    };
  }
  if (value === "workspace") {
    return {
      value,
      type: "Workspace",
      name: "All",
      synthetic: false,
      committable: (ctx.workspaceOffered ?? true) && !isDisabled(value),
    };
  }
  if (value === "org" || value.startsWith("org:")) {
    const { orgId, orgName } = scopes;
    // A genuinely ACTIVE org requires a non-empty, non-whitespace id. The
    // production no-active-organization shape is `orgId === ""` (callers wire
    // `activeOrgId ?? ""`), NOT `undefined` — an emptiness check, never a
    // bare null check, or the empty-tail `org:` token would "confirm" against
    // the empty id and become committable (cinatra#2372 AC2's named defect).
    const hasActiveOrg = typeof orgId === "string" && orgId.trim().length > 0;
    if (value === "org") {
      // The legacy bare "org" token denotes the active org BY DEFINITION
      // (read-compat only — the row itself always emits the id-carrying form
      // when an orgId is supplied), so its LABEL mapping is preserved even
      // with no active org. Committability is gated separately: with no
      // genuinely non-empty active org there is nothing to commit to, so the
      // token is a display-only degenerate (synthetic) — never submittable.
      return {
        value,
        type: "Organization",
        name: orgName || "Your organization",
        synthetic: !hasActiveOrg,
        committable: hasActiveOrg && !isDisabled(canonicalOrgToken(orgId)),
      };
    }
    // An id-carrying token is confirmed to scope the active org only when a
    // genuinely non-empty active org exists AND the embedded id equals it.
    const matchesActiveOrg = hasActiveOrg && value.slice("org:".length) === orgId;
    if (matchesActiveOrg) {
      return {
        value,
        type: "Organization",
        name: orgName || "Your organization",
        synthetic: false,
        committable: !isDisabled(canonicalOrgToken(orgId)),
      };
    }
    // Degenerate: a mismatched org id, an empty tail ("org:"), or no active
    // org in scope at all. No cross-org lookup — a neutral, id-free,
    // NEVER-committable synthetic row (c-3.11 / c-2.5's "never the wrong
    // org's name" rule extended to the flat model's row-label shape).
    return {
      value,
      type: "Organization",
      name: "the organization",
      synthetic: true,
      committable: false,
    };
  }
  if (value.startsWith("team:")) {
    const id = value.slice("team:".length);
    const team = scopes.teams.find((t) => t.id === id);
    // resolveScopeEntityName is the ONE shared "Unknown <kind>" fallback
    // (§4.0-a) — it also trims/blank-checks the resolved name, so a team
    // with a genuinely blank name degrades to "Unknown team" the same way an
    // unhydrated id does, rather than rendering an empty label.
    return {
      value,
      type: "Team",
      name: resolveScopeEntityName("team", id, team?.name),
      synthetic: !team,
      committable: !!team && !isDisabled(value),
    };
  }
  if (value.startsWith("project:")) {
    const id = value.slice("project:".length);
    const project = scopes.projects.find((p) => p.id === id);
    return {
      value,
      type: "Project",
      name: resolveScopeEntityName("project", id, project?.name),
      synthetic: !project,
      committable: !!project && !isDisabled(value),
    };
  }
  // An empty value (no selection yet) or any other non-canonical string —
  // never crash, never committable, and never leak the raw value as if it
  // were a real type/name pair.
  return { value, type: "", name: value, synthetic: true, committable: false };
}

/** Convenience: the exact string the trigger renders for a resolved option —
 * `${type}: ${name}` for every classified kind, or the bare `name` for the
 * unclassified fallback (empty `type`). Used by tests that assert verbatim
 * trigger/row text equality; the component itself composes the same two
 * halves via `rowLabel` so both places render identically without calling
 * this helper. */
export function flatAccessOptionLabel(option: FlatAccessOption): string {
  return option.type ? `${option.type}: ${option.name}` : option.name;
}
