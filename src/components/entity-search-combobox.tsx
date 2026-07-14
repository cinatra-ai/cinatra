"use client";

// ---------------------------------------------------------------------------
// EntitySearchCombobox — the shared server-searched entity typeahead
// (cinatra#1509 §4.0-b).
//
// This is an EXTRACTION, not an invention: the Input-anchored + debounced +
// server-searched cmdk list already exists byte-similar in
// `resource-ownership-panel.tsx` (co-owner add) and `permissions-form.tsx`
// (which adds lazy pagination). This component is the presentational shell of
// that pattern, generalized so entity pickers (a user, a team, an agent
// template, …) can mount ONE hardened typeahead instead of re-deriving it.
//
// Scope guard (codex F3): v1 is the shell + its tests, mounted by NOTHING yet.
// The child lanes (#1505 user grant, #1501 customer invite) mount it; converging
// the two EXISTING adopters (ResourceOwnershipPanel, PermissionsForm) onto it is
// a separate, non-blocking follow-up — child lanes must never wait on refactors
// of surfaces that already work.
//
// It owns exactly the picker mechanics the interaction/perf contract requires:
//   - debounce (0 ms on open / an empty query, 300 ms while typing — §3.5),
//   - stale-result ignoring (a cancelled flag; a late response for an old query
//     never overwrites the current query's results — §3.4),
//   - an EXPLICIT error row ("Couldn't search — try again.") distinct from the
//     empty state ("No matches.") — the shared component FIXES the panels'
//     silent failure→empty coercion (§3.4),
//   - loading row (Loader2 + "Searching…"),
//   - optional `hasMore` lazy pagination (limit 20, fetch next page near the
//     list bottom — §3.5),
//   - the cmdk background-specificity overrides (`bg-surface-strong` on
//     PopoverContent / Command / CommandList / CommandItem — Pitfall 5), and
//   - Input-anchored focus (keeps focus in the Input on open — §3.4).
// It owns NO server logic: the host passes an `onSearch` action + an `onPick`
// callback. The server action is the authority; this is only the affordance.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The minimum shape a searched entity must expose. `id` is the stable
 * identity (CommandItem value + React key); `name` is the primary line;
 * `secondary` is the optional muted secondary line (email / slug / package id).
 * Callers with richer rows pass a `renderRow` override.
 */
export type EntitySearchItem = {
  id: string;
  name: string;
  secondary?: string;
};

export type EntitySearchPage = { offset: number; limit: number };

/** One page of results. `hasMore` gates lazy pagination (omit / false ⇒ no
 *  further pages). */
export type EntitySearchResult<T> = {
  results: T[];
  hasMore?: boolean;
};

export type EntitySearchComboboxProps<T extends EntitySearchItem> = {
  /**
   * Server search. Called on open (0 ms) and after typing (300 ms debounce),
   * and again per page as the list scrolls. RESOLVE with a page of results;
   * REJECT (throw) to surface the explicit error row — never coerce a failure
   * to an empty list (§3.4).
   */
  onSearch: (query: string, page: EntitySearchPage) => Promise<EntitySearchResult<T>>;
  /** Invoked with the chosen entity when a row is selected. */
  onPick: (item: T) => void;
  /** Row renderer. Default: name (foreground) + optional secondary (muted). */
  renderRow?: (item: T) => React.ReactNode;
  /** Ids to hide client-side (e.g. already-granted principals). */
  excludeIds?: readonly string[];
  placeholder?: string;
  /** Copy for the empty state. Default "No matches.". */
  emptyText?: string;
  /** Rows requested per page. Default 20 (the server `limit 20` reference). */
  pageSize?: number;
  disabled?: boolean;
  /** HTML id for the anchoring Input (label association). */
  id?: string;
};

// ---------------------------------------------------------------------------
// Pure reducers (unit-tested in __tests__/entity-search-combobox-reducer.test.ts)
// ---------------------------------------------------------------------------

/** Debounce delay: 0 ms on an empty query (immediate on open), 300 ms while
 *  typing (§3.5). Pure. */
export function entitySearchDebounceMs(query: string): number {
  return query.length === 0 ? 0 : 300;
}

/**
 * Merge a freshly-fetched next page into the existing results, de-duping by
 * `id` and preserving order (existing rows first, then genuinely-new rows).
 * Returns the same array when the page adds nothing new so callers can avoid a
 * needless state write. Pure — this is the pagination reducer.
 */
export function mergeEntityPages<T extends { id: string }>(
  prev: readonly T[],
  next: readonly T[],
): T[] {
  const seen = new Set(prev.map((r) => r.id));
  const additions = next.filter((r) => !seen.has(r.id));
  return additions.length > 0 ? [...prev, ...additions] : [...prev];
}

/** Drop excluded ids (already-selected / already-granted rows) client-side so
 *  an optimistic pick disappears immediately. Pure. */
export function visibleEntityResults<T extends { id: string }>(
  results: readonly T[],
  excludeIds: readonly string[],
): T[] {
  const ex = new Set(excludeIds);
  return results.filter((r) => !ex.has(r.id));
}

const DEFAULT_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EntitySearchCombobox<T extends EntitySearchItem>({
  onSearch,
  onPick,
  renderRow,
  excludeIds = [],
  placeholder = "Search by name or email…",
  emptyText = "No matches.",
  pageSize = DEFAULT_PAGE_SIZE,
  disabled = false,
  id,
}: EntitySearchComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<T[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Reset the transient search state when the popover closes. Done in the
  // open-change handler (NOT synchronously inside the effect) so the effect
  // never triggers a cascading render — react-hooks/set-state-in-effect.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setResults([]);
      setSearching(false);
      setError(false);
      setHasMore(false);
      setLoadingMore(false);
    }
  };

  // Immediate-on-open + debounced typeahead. A `cancelled` flag ignores stale /
  // out-of-order responses so a late reply to an old query never overwrites the
  // current one (§3.4). A rejection sets the explicit error state (§3.4).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setSearching(true);
      setError(false);
      try {
        const result = await onSearch(query, { offset: 0, limit: pageSize });
        if (cancelled) return;
        setResults(result.results);
        setHasMore(result.hasMore ?? false);
      } catch {
        if (cancelled) return;
        setResults([]);
        setHasMore(false);
        setError(true);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, entitySearchDebounceMs(query));
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, query, onSearch, pageSize]);

  const handleListScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!hasMore || loadingMore || searching) return;
    const el = event.currentTarget;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    if (distanceFromBottom > 64) return;
    setLoadingMore(true);
    const offset = results.length;
    void onSearch(query, { offset, limit: pageSize })
      .then((result) => {
        setLoadingMore(false);
        setResults((prev) => mergeEntityPages(prev, result.results));
        setHasMore(result.hasMore ?? false);
      })
      .catch(() => {
        setLoadingMore(false);
        setError(true);
      });
  };

  const visibleResults = visibleEntityResults(results, excludeIds);

  const defaultRenderRow = (item: T): React.ReactNode => (
    <>
      <span className="text-foreground">{item.name}</span>
      {item.secondary ? (
        <span className="ml-2 text-xs text-muted-foreground truncate">
          {item.secondary}
        </span>
      ) : null}
    </>
  );
  const row = renderRow ?? defaultRenderRow;

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : handleOpenChange}>
      <PopoverAnchor asChild>
        <Input
          id={id}
          ref={inputRef}
          disabled={disabled}
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) handleOpenChange(true);
          }}
          onClick={() => handleOpenChange(!open)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
          className="bg-surface-strong"
        />
      </PopoverAnchor>
      {/*
        cmdk specificity note (Pitfall 5): cmdk's Command/CommandList/CommandItem
        ship internal background utilities that win the cascade against
        PopoverContent's semantic tokens; without `bg-surface-strong` on the
        content AND the inner Command / CommandList / CommandItem nodes the
        popover renders cmdk defaults instead of the surface palette. A one-off
        `!bg-popover` fights tokens elsewhere, so every cmdk site is handled the
        same way. `onOpenAutoFocus` prevention keeps focus in the anchoring Input
        (§3.4, the Input-anchored-typeahead exception to focus-into-list).
      */}
      <PopoverContent
        align="start"
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          const target = e.target as HTMLElement;
          if (inputRef.current?.contains(target)) {
            e.preventDefault();
          }
        }}
        className="w-[var(--radix-popover-trigger-width)] max-w-[min(28rem,calc(100vw-2rem))] p-0 bg-surface-strong"
      >
        <Command shouldFilter={false} className="bg-surface-strong">
          <CommandList
            onScroll={handleListScroll}
            className="max-h-72 bg-surface-strong"
          >
            {/* Explicit error state — distinct from empty (§3.4). */}
            {error && (
              <div className="px-3 py-2 text-sm text-destructive">
                Couldn&apos;t search — try again.
              </div>
            )}
            {!error && !searching && visibleResults.length === 0 && (
              <CommandEmpty>{emptyText}</CommandEmpty>
            )}
            {searching && (
              <CommandItem disabled className="italic text-muted-foreground">
                <Loader2 className="size-4 animate-spin mr-2" /> Searching…
              </CommandItem>
            )}
            {!error && !searching && visibleResults.length > 0 && (
              <CommandGroup className="p-0">
                {visibleResults.map((r) => (
                  <CommandItem
                    key={r.id}
                    value={r.id}
                    onSelect={() => onPick(r)}
                    className="text-sm rounded-none px-3 py-2 bg-surface-strong hover:bg-surface-muted data-[selected=true]:bg-surface-muted"
                  >
                    {row(r)}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {loadingMore && (
              <div className="flex items-center justify-center gap-2 px-3 py-2 text-xs italic text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> Loading more…
              </div>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
