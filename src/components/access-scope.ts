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
