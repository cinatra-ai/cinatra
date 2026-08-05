"use client";

// ---------------------------------------------------------------------------
// §I Library toolbar — search · facet · scope · Upload (cinatra#2449, spec
// design@f4489c5d `specs/app-artifacts.html` L311–319: "Toolbar: search ·
// facet · scope — no mode control, the library is the lone view").
//
// Replaces the former GET-form shell (static "Scope: Workspace" span + an
// "Apply" submit no other filter bar has) with the canonical live-filtering
// composition the other list pages use: the shared <Toolbar> primitives, a
// debounced URL-backed search, the Type facet Select navigating on change,
// and the canonical <ScopeFilterCombobox> (the SAME shared control
// /connectors and /skills mount) owning `?scope=`.
//
// URL mechanics mirror SkillsToolbar: search and facet clone the CURRENT
// search params and mutate only their own key (`pushWith` over a ref that is
// optimistically advanced before navigating), so q / facet / scope changes
// preserve one another; the scope picker is the route-agnostic combobox,
// which reads the latest committed params itself and preserves every other
// key on write.
//
// The Upload affordance (§VI) stays at the toolbar's right edge; it is
// composed by the server-side shell (library-mode.tsx) and passed in as
// `uploadAction`, so the §VI ownership pins stay where they live.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Toolbar,
  ToolbarGroup,
  ToolbarSearchGroup,
  ToolbarSearchInput,
  ToolbarSeparator,
} from "@/components/ui/toolbar";
import { ScopeFilterCombobox } from "@/components/scope-filter-combobox";
import type { AvailableScopes } from "@/components/access-scope";
import type { ScopeToken } from "@/lib/scope-filter";

const ALL_FACETS = "__all__";

type LibraryToolbarProps = {
  /** The committed `?q=` value (server-resolved). */
  query?: string;
  facetOptions: Array<{ value: string; label: string }>;
  selectedFacet?: string;
  /** The active scope selection (server-resolved by the canonical parser). */
  scopeValue: ScopeToken[];
  scopes: AvailableScopes;
  /** The §VI Upload affordance, composed by the server shell. */
  uploadAction: React.ReactNode;
};

export function LibraryToolbar({
  query,
  facetOptions,
  selectedFacet,
  scopeValue,
  scopes,
  uploadAction,
}: LibraryToolbarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Committed-query reconcile happens DURING render (the sanctioned
  // prop-change pattern; a setState-in-effect is a lint error).
  const committedQuery = query ?? "";
  const [syncedQuery, setSyncedQuery] = useState(committedQuery);
  const [searchValue, setSearchValue] = useState(committedQuery);
  if (syncedQuery !== committedQuery) {
    setSyncedQuery(committedQuery);
    setSearchValue(committedQuery);
  }

  // Always read the LATEST params at push time (the SkillsToolbar ref
  // pattern): the debounced search timeout closes over the render at
  // typing-start; without this ref it would push a stale facet/scope set and
  // silently revert them — breaking the URL-as-source-of-truth guarantee.
  const searchParamsRef = useRef(searchParams?.toString() ?? "");
  useEffect(() => {
    searchParamsRef.current = searchParams?.toString() ?? "";
  }, [searchParams]);

  function pushWith(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParamsRef.current);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    const qs = params.toString();
    // Optimistically advance the ref BEFORE navigating so a second push fired
    // before this navigation commits reads the just-applied params instead of
    // reverting them. The [searchParams] effect later reconciles with reality.
    searchParamsRef.current = qs;
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  // Debounced search → `?q=`, preserving facet/scope.
  useEffect(() => {
    const trimmed = searchValue.trim();
    if (trimmed === committedQuery) return;
    const timeoutId = window.setTimeout(() => {
      pushWith({ q: trimmed || null });
    }, 180);
    return () => window.clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchValue]);

  // OPTIMISTIC facet value, reconciled from the server-resolved prop during
  // render (the sanctioned prop-change pattern) — the trigger label must not
  // lag the pick while the navigation commits.
  const serverFacet = selectedFacet ?? ALL_FACETS;
  const [syncedFacet, setSyncedFacet] = useState(serverFacet);
  const [facetValue, setFacetValue] = useState(serverFacet);
  if (syncedFacet !== serverFacet) {
    setSyncedFacet(serverFacet);
    setFacetValue(serverFacet);
  }

  function selectFacet(next: string) {
    setFacetValue(next);
    // The cleared facet ("Type: All") drops the param, like the cleared scope.
    pushWith({ facet: next === ALL_FACETS ? null : next });
  }

  return (
    <Toolbar aria-label="Artifacts filters">
      <ToolbarSearchGroup>
        <ToolbarSearchInput
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          placeholder="Search artifacts"
          aria-label="Search artifacts"
        />
      </ToolbarSearchGroup>
      <ToolbarSeparator />
      <ToolbarGroup>
        <Select value={facetValue} onValueChange={selectFacet}>
          <SelectTrigger
            data-testid="artifacts-facet"
            data-conformance-id="artifacts-facet"
            data-action="filter-facet -> filtered"
            className="h-[34px] w-auto gap-1.5 rounded-md border-line bg-surface-strong px-3 text-xs text-foreground"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_FACETS}>Type: All</SelectItem>
            {facetOptions.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup>
        {/* Artifacts carry no admin-only visibility tier, so the "Workspace:
            Admins only" row is not offered (a stale ?scope=admin collapses to
            the default via the canonical parser). */}
        <ScopeFilterCombobox
          id="artifacts-scope-filter"
          value={scopeValue}
          scopes={scopes}
          showAdmin={false}
        />
      </ToolbarGroup>
      <div aria-hidden className="flex-1" />
      <ToolbarGroup>{uploadAction}</ToolbarGroup>
    </Toolbar>
  );
}
