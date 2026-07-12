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
   * specific one. A resource WITHOUT a `locusId` matches NOTHING under an
   * id-carrying org/team/project selection (fail-closed, cinatra#953 W3) —
   * locus-level-but-unbound resources appear only under the default
   * ("workspace") view.
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
 * - `org:<id>` / `team:<id>` / `project:<id>` → resources of that locus whose
 *   CONCRETE `locusId` equals the selected id. FAIL-CLOSED (cinatra#953 W3):
 *   a resource WITHOUT a `locusId` matches NOTHING under an id-carrying
 *   selection, and a bare id-less locus token matches nothing — an org/team/
 *   project selection means "genuinely granted to THAT locus", never "any
 *   resource that merely lives at that locus level" (the killed overmatch).
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
  if (resource.locusId === undefined || id === undefined) return false;
  return resource.locusId === id;
}

// ---------------------------------------------------------------------------
// Multi-scope OR-filtering (cinatra#1074, multi-scope W5).
//
// `?scope=` is a comma-separated multi-value OR-filter. This section is the
// ONE canonical parser/serializer pair for it — every reader (the /connectors
// and /skills server pages) and every writer (the scope-filter combobox, the
// skills toolbar, sortable-header hrefs) goes through these, so the token
// grammar can never drift per surface.
// ---------------------------------------------------------------------------

/**
 * Parse the raw `?scope=` search param into the effective scope selection.
 *
 * Canonicalization, in order:
 *   1. Next.js repeated-param arrays collapse to the FIRST value (matching the
 *      previous single-scope readers).
 *   2. Split on ",", trim each token, drop empties.
 *   3. Dedupe (order-preserving).
 *   4. Validate each token against `accessibleScopeTokens` — the CALLER's
 *      accessible set — and DROP invalid/inaccessible tokens (never honor a
 *      scope the actor can't see; a stale or hand-crafted token silently
 *      narrows to the remaining valid ones).
 *   5. `workspace` present ⇒ the whole selection collapses to the default
 *      (workspace already means match-everything, mirroring the W1
 *      workspace-collapse invariant on grant selections).
 *   6. Nothing left ⇒ the default selection `["workspace"]`.
 *
 * The result is therefore NON-EMPTY, deduped, and either exactly
 * `[DEFAULT_SCOPE_TOKEN]` or free of the default token.
 */
export function parseScopeFilterParam(
  raw: string | string[] | undefined,
  accessibleScopeTokens: ReadonlySet<string>,
): ScopeToken[] {
  const first = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (typeof first !== "string" || first.length === 0) return [DEFAULT_SCOPE_TOKEN];
  const seen = new Set<string>();
  const tokens: ScopeToken[] = [];
  for (const part of first.split(",")) {
    const token = part.trim();
    if (token.length === 0 || seen.has(token)) continue;
    seen.add(token);
    if (!accessibleScopeTokens.has(token)) continue;
    tokens.push(token);
  }
  if (tokens.length === 0) return [DEFAULT_SCOPE_TOKEN];
  if (tokens.includes(DEFAULT_SCOPE_TOKEN)) return [DEFAULT_SCOPE_TOKEN];
  return tokens;
}

/** Is a selection exactly the canonical default (the broadest, match-all view)? */
export function isDefaultScopeSelection(tokens: readonly ScopeToken[]): boolean {
  return tokens.length === 1 && tokens[0] === DEFAULT_SCOPE_TOKEN;
}

/**
 * Serialize a scope selection back to the `?scope=` param value, or `null`
 * when the param should be OMITTED (the default selection — writers drop the
 * default from the URL, unchanged from the single-scope behaviour). Dedupes
 * and applies the same workspace-collapse invariant as the parser, so
 * serialize→parse round-trips for any accessible selection.
 */
export function serializeScopeFilterTokens(tokens: readonly ScopeToken[]): string | null {
  if (tokens.length === 0 || tokens.includes(DEFAULT_SCOPE_TOKEN)) return null;
  return [...new Set(tokens)].join(",");
}

/**
 * Does a resource match ANY token of the selection? (The OR-predicate —
 * `scopeSelectionMatches` lifted over the multi-token selection.) An empty
 * selection matches NOTHING (fail-closed; the canonical parser never emits
 * one — the empty selection is `[DEFAULT_SCOPE_TOKEN]`).
 */
export function scopeSelectionMatchesAny(
  tokens: readonly ScopeToken[],
  resource: NormalizedResourceScope,
): boolean {
  return tokens.some((token) => scopeSelectionMatches(token, resource));
}

// ---------------------------------------------------------------------------
// Filter-mode multi-select picker behaviour (cinatra#1074, the W5 UI half).
//
// The GRANT picker's toggle/row-state semantics (owner-strip-when-mixed, the
// owner floor, org→team implied display — src/components/access-scope.ts) are
// grant rules and deliberately do NOT apply to the FILTER:
//   - "personal" is an ordinary OR-token (personal + team:<id> is a
//     meaningful union: "my stuff or that team's stuff");
//   - nothing is implied: an org:<id> selection matches org-granted resources
//     only, never the org's teams' resources (fail-closed, cinatra#953 W3),
//     so no row may render "included via" another;
//   - "Workspace: All" IS the cleared filter: selecting it (or unchecking the
//     last token) returns to the default match-all selection.
// These operate in URL-token space; the *ComboboxValue variants map through
// the personal<->owner wrapper boundary for the picker.
// ---------------------------------------------------------------------------

/** Toggle one filter token, returning the canonical next selection. */
export function toggleScopeFilterToken(
  token: ScopeToken,
  selection: readonly ScopeToken[],
): ScopeToken[] {
  // Selecting "Workspace: All" clears the filter back to the default.
  if (token === DEFAULT_SCOPE_TOKEN) return [DEFAULT_SCOPE_TOKEN];
  const without = selection.filter((t) => t !== token && t !== DEFAULT_SCOPE_TOKEN);
  const next = selection.includes(token) ? without : [...without, token];
  if (next.length === 0) return [DEFAULT_SCOPE_TOKEN];
  return [...new Set(next)];
}

/**
 * Checkbox + disabled state for one filter row. The workspace row is checked
 * exactly when the selection is the default and is disabled then too (it is
 * already the cleared state — re-clicking would be a surprising no-op, the
 * same rationale as the grant picker's sole-owner floor). Every other row is
 * independent: checked iff explicitly selected, never implied, never locked.
 */
export function scopeFilterRowState(
  token: ScopeToken,
  selection: readonly ScopeToken[],
): { checked: boolean; impliedDisabled: boolean } {
  if (token === DEFAULT_SCOPE_TOKEN) {
    const isDefault = isDefaultScopeSelection(selection);
    return { checked: isDefault, impliedDisabled: isDefault };
  }
  return { checked: selection.includes(token), impliedDisabled: false };
}

/** `toggleScopeFilterToken` in the picker's combobox-value space. */
export function toggleScopeFilterComboboxValue(
  value: string,
  comboboxSelection: readonly string[],
): string[] {
  return toggleScopeFilterToken(
    comboboxValueToScopeToken(value),
    comboboxSelection.map(comboboxValueToScopeToken),
  ).map(scopeTokenToComboboxValue);
}

/** `scopeFilterRowState` in the picker's combobox-value space. */
export function scopeFilterComboboxRowState(
  value: string,
  comboboxSelection: readonly string[],
): { checked: boolean; impliedDisabled: boolean } {
  return scopeFilterRowState(
    comboboxValueToScopeToken(value),
    comboboxSelection.map(comboboxValueToScopeToken),
  );
}
