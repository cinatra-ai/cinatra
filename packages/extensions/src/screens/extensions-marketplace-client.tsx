"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import {
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
  ToolbarButton,
  ToolbarSearchGroup,
  ToolbarSearchInput,
} from "@/components/ui/toolbar";
import { MARKETPLACE_TABS, resolveMarketplaceTab } from "./marketplace-tab-model";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";

// ---------------------------------------------------------------------------
// ExtensionsMarketplaceClient — filter-only client component
// Card rendering lives in the server component (ExtensionsMarketplaceScreen)
// so that per-row server-action .bind() calls stay server-side.
// This component receives pre-rendered card nodes + lightweight metadata and
// applies tab/search filtering via display:none keyed on metadata.
// ---------------------------------------------------------------------------

type CardMeta = {
  packageName: string;
  title: string;
  description: string | null;
  // Storefront-parity: author is dropped. `kind` is the normalized slug
  // (the four extension kinds, plus "unknown" for contexts/dashboards/unmapped
  // AND the removed "workflow" kind — cinatra#1035; "unknown" cards show only
  // under "All").
  kind: "agent" | "skill" | "connector" | "artifact" | "unknown" | null;
};

type Props = {
  cards: Array<{ meta: CardMeta; node: ReactNode }>;
};

/**
 * The grid region's loading presentation — the Suspense fallback
 * ExtensionsMarketplaceScreen renders while this client mounts. Exported as a
 * single source of truth so the design-conformance harness (cinatra#986) can
 * force the SAME loading treatment through the same Suspense machinery.
 * data-testid: conformance stable-id contract (testid-contract.json).
 */
export function MarketplaceGridLoadingFallback() {
  return (
    <div data-testid="marketplace-grid-loading" className="text-muted-foreground text-sm">
      Loading filters...
    </div>
  );
}

export function ExtensionsMarketplaceClient({ cards }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get("tab");
  // Canonicalize the tab query value. A stale/bookmarked `?tab=workflow` (the
  // removed kind — cinatra#1035) or any other unknown value resolves to the
  // default "all" tab and is flagged stale so the effect below strips it — the
  // route stays valid (never a 404, never a dead/empty tab).
  const { activeTab: tab, stale: tabStale } = resolveMarketplaceTab(rawTab);
  const search = (searchParams.get("q") ?? "").toLowerCase();

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
    router.replace(`?${next.toString()}`, { scroll: false });
  };

  // Strip a stale/unknown `?tab=` value (e.g. the removed "workflow") from the
  // URL so the canonical route carries no obsolete query. Keyed on `rawTab`
  // (via useSearchParams, which is reactive to a direct load, a client-side
  // navigation, AND back/forward), so all three navigation paths canonicalize;
  // `setParam("tab", null)` is a `router.replace`, so it never pushes history.
  useEffect(() => {
    if (tabStale) setParam("tab", null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawTab, tabStale]);

  // Debounce search input to avoid a router.replace on every keystroke.
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = (value: string) => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => setParam("q", value), 200);
  };

  const matches = (m: CardMeta) => {
    if (tab !== "all" && m.kind !== tab) return false;
    if (!search) return true;
    return (
      m.title.toLowerCase().includes(search) ||
      (m.description ?? "").toLowerCase().includes(search) ||
      m.packageName.toLowerCase().includes(search)
    );
  };

  const visibleCount = cards.filter((c) => matches(c.meta)).length;

  return (
    <div className="flex flex-col gap-6">
      <Toolbar aria-label="Marketplace filters">
        <ToolbarGroup>
          {MARKETPLACE_TABS.map((t) => (
            <ToolbarButton
              key={t.value}
              active={tab === t.value}
              onClick={() => setParam("tab", t.value === "all" ? null : t.value)}
            >
              {t.label}
            </ToolbarButton>
          ))}
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarSearchGroup className="w-full max-w-md flex-none">
          <ToolbarSearchInput
            placeholder="Search by name, description, or package…"
            defaultValue={searchParams.get("q") ?? ""}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </ToolbarSearchGroup>
      </Toolbar>
      {visibleCount === 0 ? (
        // data-testid: conformance stable-id contract (testid-contract.json) —
        // the extension-listing-grid `empty` state variant.
        <Empty data-testid="marketplace-grid-empty" className="border border-line bg-surface">
          <EmptyHeader>
            <EmptyTitle>
              {cards.length === 0 ? "No extensions available" : "No extensions found"}
            </EmptyTitle>
            <EmptyDescription>
              {cards.length === 0
                ? "There are no extensions in the storefront catalog yet."
                : "Try a different search term or tab."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        // auto-rows-fr locks every grid row to equal heights (design spec §IV
        // "grid-auto-rows: 1fr"); each card stretches (h-full on the card +
        // h-full on this wrapper) so bodies align across a row.
        // data-testid attrs: conformance stable-id contract — grid root +
        // per-card item wrappers (exact-cardinality assertions count VISIBLE
        // items, so the display:none filter path stays honestly counted).
        <div
          data-testid="marketplace-grid"
          className="grid auto-rows-fr grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {cards.map((c) => (
            <div
              key={c.meta.packageName}
              data-testid="marketplace-grid-item"
              className="h-full"
              style={{ display: matches(c.meta) ? undefined : "none" }}
            >
              {c.node}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
