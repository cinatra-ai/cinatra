"use client";

// ---------------------------------------------------------------------------
// ScopeFilterCombobox — the shared scope dropdown used by the /connectors and
// /skills list pages. It wraps the unified AccessCombobox in checkbox
// selectionMode="multiple" (cinatra#1074, multi-scope W5) and owns the `?scope=` URL
// param: it reads the current selection from props (server-resolved by the
// canonical parser) and, on change, writes the comma-joined selection back to
// the URL while preserving every other query param. The default selection
// ("workspace" = "Workspace: All" = the cleared filter) is removed from the
// URL.
//
// Toggle/row-state semantics are the FILTER-mode helpers from
// `@/lib/scope-filter` (personal is an ordinary OR-token; nothing is implied;
// workspace clears), NOT the grant-mode canonicalisation.
//
// Route-agnostic: it derives the path from usePathname(), so both /connectors
// and /skills (and any future surface) can drop it in unchanged.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AccessCombobox,
  type AvailableScopes,
} from "@/components/access-combobox";
import {
  comboboxValueToScopeToken,
  scopeFilterComboboxRowState,
  scopeTokenToComboboxValue,
  serializeScopeFilterTokens,
  toggleScopeFilterComboboxValue,
  type ScopeToken,
} from "@/lib/scope-filter";

type ScopeFilterComboboxProps = {
  /** The current scope selection (server-resolved from the URL by the canonical parser). */
  value: ScopeToken[];
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

  // OPTIMISTIC local selection: the popover stays open on toggle, so a second
  // toggle can fire BEFORE the navigation commits and the server-resolved
  // `value` prop catches up. Toggling against the stale prop would drop the
  // first toggle (codex round-1), so toggles compose against this local state,
  // reconciled whenever the server value changes — adjusted DURING render (the
  // sanctioned prop-change pattern; a setState-in-effect is a lint error).
  const serverKey = value.join(" ");
  const [syncedKey, setSyncedKey] = useState(serverKey);
  const [selection, setSelection] = useState<ScopeToken[]>(value);
  if (syncedKey !== serverKey) {
    setSyncedKey(serverKey);
    setSelection(value);
  }

  function handleChange(nextComboboxSelection: string[]) {
    const tokens = nextComboboxSelection.map(comboboxValueToScopeToken);
    setSelection(tokens);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    const serialized = serializeScopeFilterTokens(tokens);
    if (serialized === null) {
      params.delete(paramName);
    } else {
      params.set(paramName, serialized);
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <AccessCombobox
      id={id}
      selectionMode="multiple"
      value={selection.map(scopeTokenToComboboxValue)}
      onChange={handleChange}
      toggleSelection={toggleScopeFilterComboboxValue}
      rowState={scopeFilterComboboxRowState}
      scopes={scopes}
      showAdmin={showAdmin}
    />
  );
}
