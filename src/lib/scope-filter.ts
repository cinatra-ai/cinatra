// ---------------------------------------------------------------------------
// Shared scope-filter vocabulary.
//
// The `/connectors` and `/skills` list pages share a single scope dropdown
// (rendered by <ScopeFilterCombobox>, which wraps AccessComboboxHierarchical).
// This module owns the URL-param token vocabulary and a normalized match
// predicate so each surface can filter its own resources without importing the
// other's internals.
//
// URL tokens (the `?scope=` param):
//   personal | workspace | admin | team:<id> | org:<id> | project:<id>
//
// The default ("workspace" = "Workspace: All") is the broadest view and is
// omitted from the URL. Note: the picker's internal value for "personal" is
// "owner" (it shares AgentAuthPolicy's visibility vocabulary), so the token
// "personal" is mapped to/from "owner" at the wrapper boundary.
// ---------------------------------------------------------------------------

export type ScopeToken = string;

export const DEFAULT_SCOPE_TOKEN: ScopeToken = "workspace";

/** Normalized scope of a single listed resource (a connector, a skill, …). */
export type NormalizedResourceScope = {
  /** Where the resource lives. */
  locus: "personal" | "team" | "organization" | "project" | "workspace";
  /**
   * The id of the owning team/org/project, when the resource is tied to a
   * specific one. Omit it for resources that are locus-level but not bound to a
   * particular id (e.g. connectors that are "organization-level" workspace-wide
   * rather than scoped to one org) — those match any selection of that locus.
   */
  locusId?: string;
  /** True when the resource is restricted to workspace admins. */
  adminOnly?: boolean;
};

/** Map a URL token to the AccessComboboxHierarchical value it renders. */
export function scopeTokenToComboboxValue(token: ScopeToken): string {
  return token === "personal" ? "owner" : token;
}

/** Map an AccessComboboxHierarchical value back to a URL token. */
export function comboboxValueToScopeToken(value: string): ScopeToken {
  return value === "owner" ? "personal" : value;
}

/**
 * Does a resource match the selected scope token?
 *
 * - `workspace` (default) → everything (the broadest view)
 * - `personal` → personal-locus resources
 * - `admin` → admin-only resources (visibility tier, NOT "any non-personal")
 * - `org:<id>` / `team:<id>` / `project:<id>` → resources of that locus; if the
 *   resource carries a `locusId`, it must match the selected id, otherwise a
 *   locus-level resource matches any id of that locus.
 */
export function scopeSelectionMatches(
  token: ScopeToken,
  resource: NormalizedResourceScope,
): boolean {
  if (token === DEFAULT_SCOPE_TOKEN) return true;
  if (token === "personal") return resource.locus === "personal";
  if (token === "admin") return resource.adminOnly === true;

  const [locus, id] = token.includes(":") ? token.split(":", 2) : [token, undefined];
  if (locus !== "org" && locus !== "team" && locus !== "project") return false;
  const expectedLocus = locus === "org" ? "organization" : locus;
  if (resource.locus !== expectedLocus) return false;
  if (resource.locusId === undefined || id === undefined) return true;
  return resource.locusId === id;
}
