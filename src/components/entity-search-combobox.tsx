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
//   - stale-result ignoring for BOTH request paths (a cancelled flag on the
//     first-page search AND an epoch guard on the pagination path; a late
//     response for an old query / a closed popover never overwrites or merges
//     into the current results — §3.4),
//   - the full §3.4 keyboard contract with focus staying in the anchoring
//     Input: the Input is the combobox (role="combobox", aria-expanded,
//     aria-controls, aria-activedescendant); ArrowDown/ArrowUp open the list or
//     move the active row (key events are forwarded to cmdk's root, which owns
//     selection movement, disabled-row skipping, and scroll-into-view); Enter
//     selects the active row; Escape closes (focus never left the Input); Tab
//     closes and moves on (no trap),
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
import { useCommandState } from "cmdk";
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
// a11y bridge — mirrors cmdk's popup identity + active option onto the
// EXTERNAL input.
//
// Focus lives in the anchoring Input (outside the Command tree), so the input
// is the combobox and must carry `aria-controls` (the popup listbox's id) and
// `aria-activedescendant` (the active option's DOM id) per the ARIA combobox
// pattern. cmdk owns both ids (its List/Item override any user-supplied `id`)
// and tracks the active option as `selectedItemId` in its store; this bridge
// renders INSIDE the Command (where the store context exists), subscribes via
// cmdk's public `useCommandState`, and syncs both onto the input as DOM
// attributes. It must live inside the popover content: the content is
// portal-mounted a commit AFTER the parent's `open` state flips, so a parent
// effect keyed on `open` runs too early to see the listbox — this component
// mounts exactly when the listbox does (and its cleanup runs exactly when the
// popup unmounts). Attribute sync (not React state) — the input is an
// external system here, and this avoids cascading renders.
// ---------------------------------------------------------------------------
function CommandComboboxA11yBridge({
  inputRef,
  commandRef,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  commandRef: React.RefObject<HTMLDivElement | null>;
}) {
  const activeId = useCommandState((state) => state.selectedItemId);
  const activeValue = useCommandState((state) => state.value);

  // aria-controls: resolvable on mount — refs are attached before effects run,
  // and this bridge mounts in the same commit as the listbox.
  useEffect(() => {
    const input = inputRef.current;
    const listId = commandRef.current?.querySelector("[cmdk-list]")?.id;
    if (!input || !listId) return;
    input.setAttribute("aria-controls", listId);
    return () => input.removeAttribute("aria-controls");
  }, [inputRef, commandRef]);

  // aria-activedescendant: tracks cmdk's active option live. cmdk populates
  // `selectedItemId` lazily (its internal scheduler resolves the id from the
  // DOM, and on the INITIAL auto-select that lookup can run a commit before
  // the row's aria-selected is stamped, leaving the id undefined while a row
  // is visibly active) — so this also subscribes to the store's `value` and
  // falls back to the committed DOM, which a passive effect observes reliably.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const id =
      activeId ??
      commandRef.current?.querySelector('[cmdk-item][aria-selected="true"]')?.id;
    if (id) {
      input.setAttribute("aria-activedescendant", id);
    } else {
      input.removeAttribute("aria-activedescendant");
    }
    return () => input.removeAttribute("aria-activedescendant");
  }, [activeId, activeValue, inputRef, commandRef]);

  return null;
}

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
  const commandRef = useRef<HTMLDivElement>(null);
  const [results, setResults] = useState<T[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Results epoch: bumped whenever the results generation changes (open/close,
  // query change). The pagination path captures the epoch when its request
  // starts and DROPS the response if the epoch moved — a late second page for
  // an old query / a closed popover must never merge into the current list
  // (§3.4; codex merge-review finding 2 — the first-page effect's `cancelled`
  // flag did not cover handleListScroll).
  const epochRef = useRef(0);

  // Reset the transient search state when the popover closes. Done in the
  // open-change handler (NOT synchronously inside the effect) so the effect
  // never triggers a cascading render — react-hooks/set-state-in-effect.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      epochRef.current += 1; // invalidate in-flight page merges immediately
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
    // Any open/query transition starts a new results generation: in-flight
    // page merges for the previous generation become stale NOW (not after the
    // 300 ms debounce), so a late page response can never race the new query.
    epochRef.current += 1;
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
    const epoch = epochRef.current;
    void onSearch(query, { offset, limit: pageSize })
      .then((result) => {
        setLoadingMore(false);
        if (epochRef.current !== epoch) return; // stale page — query changed / closed
        setResults((prev) => mergeEntityPages(prev, result.results));
        setHasMore(result.hasMore ?? false);
      })
      .catch(() => {
        setLoadingMore(false);
        if (epochRef.current !== epoch) return; // stale failure — don't surface
        setError(true);
      });
  };

  // §3.4 keyboard contract, with focus staying in the anchoring Input. cmdk
  // owns selection movement (disabled-row skipping, group traversal,
  // scroll-into-view), so ArrowUp/ArrowDown/Enter are FORWARDED to its root
  // element as bubbling KeyboardEvents rather than re-implemented — cmdk's
  // root onKeyDown handles them exactly as if its own input had focus. The
  // active row is reflected back onto this input by
  // CommandActiveDescendantBridge. Home/End are NOT forwarded: in a text
  // input they move the caret, which wins (matching native combobox inputs).
  const forwardKeyToList = (key: string) => {
    commandRef.current?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); // never move the caret
      if (!open) {
        handleOpenChange(true); // closed combobox: arrows open the list
        return;
      }
      forwardKeyToList(e.key);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault(); // never submit a surrounding form
      if (open) forwardKeyToList("Enter"); // select the active row
      return;
    }
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        handleOpenChange(false); // focus already lives here — nothing to restore
      }
      return;
    }
    if (e.key === "Tab" && open) {
      // §3.4: Tab closes the popover and moves focus onward (no trap) —
      // deliberately NOT preventDefault.
      handleOpenChange(false);
    }
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
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) handleOpenChange(true);
          }}
          // Open-only: clicking back into an OPEN input (to place the caret)
          // must not close the list — close is Escape / outside click /
          // selection (codex merge-review finding 3).
          onClick={() => {
            if (!open) handleOpenChange(true);
          }}
          onKeyDown={handleInputKeyDown}
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
        <Command ref={commandRef} shouldFilter={false} className="bg-surface-strong">
          <CommandComboboxA11yBridge inputRef={inputRef} commandRef={commandRef} />
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
