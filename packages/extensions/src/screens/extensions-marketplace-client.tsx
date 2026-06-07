"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useRef } from "react";
import {
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
  ToolbarButton,
  ToolbarSearchGroup,
  ToolbarSearchInput,
} from "@/components/ui/toolbar";
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
  // (includes "unknown" for contexts/dashboards/unmapped — shown only under "All").
  kind: "agent" | "skill" | "connector" | "artifact" | "workflow" | "unknown" | null;
};

type Props = {
  cards: Array<{ meta: CardMeta; node: ReactNode }>;
};

export function ExtensionsMarketplaceClient({ cards }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab") ?? "all";
  const search = (searchParams.get("q") ?? "").toLowerCase();

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
    router.replace(`?${next.toString()}`, { scroll: false });
  };

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

  const tabs: Array<{ value: string; label: string }> = [
    { value: "all", label: "All" },
    { value: "agent", label: "Agents" },
    { value: "skill", label: "Skills" },
    { value: "connector", label: "Connectors" },
    { value: "artifact", label: "Artifacts" },
    { value: "workflow", label: "Workflows" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <Toolbar aria-label="Marketplace filters">
        <ToolbarGroup>
          {tabs.map((t) => (
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
        <Empty className="border border-line bg-surface">
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {cards.map((c) => (
            <div key={c.meta.packageName} style={{ display: matches(c.meta) ? undefined : "none" }}>
              {c.node}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
