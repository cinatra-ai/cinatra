// The artifacts library's scope-control reading (cinatra#3229).
//
// The ratified drawing (specs/app-artifacts.html §I) draws the library toolbar
// as "Search artifacts", then "Type: All", then "Scope: Workspace" — the scope
// control naming the field first and its value second, exactly as the Type
// control beside it does. The shared summary helper composes "Workspace: All"
// for every other surface; the reading is elected HERE, at the artifacts
// mount, so no other mount of the shared control changes:
//   cleared (the default) → "Scope: Workspace"
//   one scope chosen      → "Scope: {the chosen scope's own label}"
//   more than one         → "Scope: {n} selected"
// The rows inside the control and the selection semantics are untouched.

import type { AgentAuthPolicyVisibility } from "@cinatra-ai/agents/auth-policy";
import { resolveAccessParts, type AvailableScopes } from "@/components/access-scope";
import { DEFAULT_SCOPE_TOKEN, scopeTokenToComboboxValue, type ScopeToken } from "@/lib/scope-filter";

export function readArtifactsScope(
  selection: readonly ScopeToken[],
  scopes: AvailableScopes,
): string {
  const chosen = selection.filter((token) => token !== DEFAULT_SCOPE_TOKEN);
  if (chosen.length === 0) return "Scope: Workspace";
  if (chosen.length === 1) {
    const value = scopeTokenToComboboxValue(chosen[0]) as AgentAuthPolicyVisibility;
    return `Scope: ${resolveAccessParts(value, scopes).name}`;
  }
  return `Scope: ${chosen.length} selected`;
}
