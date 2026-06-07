"use client";

// ---------------------------------------------------------------------------
// ScopeFilterCombobox — the shared scope dropdown used by the /connectors and
// /skills list pages. It wraps AccessComboboxHierarchical and owns the `?scope=`
// URL param: it reads the current selection from props (server-resolved) and,
// on change, writes the token back to the URL while preserving every other
// query param. The default token ("workspace") is removed from the URL.
//
// Route-agnostic: it derives the path from usePathname(), so both /connectors
// and /skills (and any future surface) can drop it in unchanged.
// ---------------------------------------------------------------------------

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AccessComboboxHierarchical,
  type AvailableScopes,
} from "@/components/access-combobox-hierarchical";
import {
  DEFAULT_SCOPE_TOKEN,
  comboboxValueToScopeToken,
  scopeTokenToComboboxValue,
  type ScopeToken,
} from "@/lib/scope-filter";

type ScopeFilterComboboxProps = {
  /** The current scope token (server-resolved from the URL). */
  value: ScopeToken;
  scopes: AvailableScopes;
  /** URL param to read/write. Defaults to "scope". */
  paramName?: string;
  id?: string;
  /** Whether the "Workspace: Admins only" row is offered. Defaults to true. */
  showAdmin?: boolean;
};

export function ScopeFilterCombobox({
  value,
  scopes,
  paramName = "scope",
  id,
  showAdmin = true,
}: ScopeFilterComboboxProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function handleChange(comboboxValue: string) {
    const token = comboboxValueToScopeToken(comboboxValue);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (token === DEFAULT_SCOPE_TOKEN) {
      params.delete(paramName);
    } else {
      params.set(paramName, token);
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <AccessComboboxHierarchical
      id={id}
      value={scopeTokenToComboboxValue(value)}
      onChange={handleChange}
      scopes={scopes}
      showAdmin={showAdmin}
    />
  );
}
