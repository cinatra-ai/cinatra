"use client";

// ---------------------------------------------------------------------------
// Skills list toolbar.
//
// Far-left "Create skill" primary action (linking to /skills/new with a +
// icon), then search, scope picker, spacer, and an icon-only Table/Cards
// view-mode menu at the far right.
//
// The standalone Table/Cards <ToggleGroup>, the "Skill name" sort-trigger
// label, and every Sort-by / direction option in the right-side flyout
// have been removed. Table-header sortability lives in plugin-pages.tsx
// and is untouched — the URL contract (?sort=, ?dir=) is still honoured by
// the column headers.
//
// Unlike ListControls (which rebuilds the URL from scratch and would drop
// the ?scope= param), every control here clones the CURRENT search params
// and mutates only its own key, so search / view / scope changes preserve
// one another. To keep a single URL owner (no cross-control race), the
// scope dropdown is the shared AccessComboboxHierarchical wired through
// the same pushWith path — it owns the ?scope= URL param that deep links
// rely on.
// ---------------------------------------------------------------------------

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, LayoutGrid, Plus, Table2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "@/components/ui/toolbar";
import { AccessComboboxHierarchical } from "@/components/access-combobox-hierarchical";
import { getListViewCookieName } from "@/lib/list-view";
import type { AvailableScopes } from "@/components/access-scope";
import {
  DEFAULT_SCOPE_TOKEN,
  comboboxValueToScopeToken,
  scopeTokenToComboboxValue,
} from "@/lib/scope-filter";

type SkillsToolbarProps = {
  basePath: string;
  query: string;
  view: "cards" | "table";
  scopeValue: string;
  scopes: AvailableScopes;
  showAdmin: boolean;
};

export function SkillsToolbar({
  basePath,
  query,
  view,
  scopeValue,
  scopes,
  showAdmin,
}: SkillsToolbarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [searchValue, setSearchValue] = useState(query);

  // Always read the LATEST params at push time. The debounced search timeout
  // closes over the render at typing-start; without this ref it would push a
  // stale scope/view set if the user changes those during the debounce
  // window (and silently revert them) — breaking the URL-as-source-of-truth
  // guarantee for the scope filter (deep-link + browser-back must hold).
  // Stored as a string so plain URLSearchParams can be written back to it.
  const searchParamsRef = useRef(searchParams?.toString() ?? "");
  useEffect(() => {
    searchParamsRef.current = searchParams?.toString() ?? "";
  }, [searchParams]);

  useEffect(() => {
    setSearchValue(query);
  }, [query]);

  function pushWith(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParamsRef.current);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    const qs = params.toString();
    // Optimistically advance the ref BEFORE navigating so a second push fired
    // before this navigation commits (e.g. a debounced search firing right
    // after a scope/view change) reads the just-applied params instead of
    // reverting them. The [searchParams] effect later reconciles with reality.
    searchParamsRef.current = qs;
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function selectScope(comboboxValue: string) {
    const token = comboboxValueToScopeToken(comboboxValue);
    pushWith({ scope: token === DEFAULT_SCOPE_TOKEN ? null : token });
  }

  // Debounced search → preserves scope/view.
  useEffect(() => {
    const trimmed = searchValue.trim();
    if (trimmed === query) return;
    const timeoutId = window.setTimeout(() => {
      pushWith({ q: trimmed || null });
    }, 180);
    return () => window.clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchValue]);

  function selectView(nextView: "cards" | "table") {
    document.cookie = `${getListViewCookieName(basePath)}=${nextView}; path=/; max-age=31536000; samesite=lax`;
    pushWith({ view: nextView });
  }

  const ViewIcon = view === "table" ? Table2 : LayoutGrid;

  return (
    <Toolbar aria-label="Skills filters">
      <ToolbarGroup>
        <ToolbarButton asChild>
          <Link href="/skills/new">
            <Plus data-icon="inline-start" aria-hidden="true" />
            Create skill
          </Link>
        </ToolbarButton>
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup>
        <Input
          type="search"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          placeholder="Search skills or extensions"
          className="h-8 w-[180px] lg:w-[260px]"
        />
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup>
        <AccessComboboxHierarchical
          id="skills-scope-filter"
          value={scopeTokenToComboboxValue(scopeValue)}
          onChange={selectScope}
          scopes={scopes}
          showAdmin={showAdmin}
        />
      </ToolbarGroup>
      <div aria-hidden className="flex-1" />
      <ToolbarGroup>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground"
              aria-label="View mode"
            >
              <ViewIcon data-icon="inline-start" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => selectView("table")}>
              <Table2 />
              <span className="flex-1">Table</span>
              {view === "table" && <Check />}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => selectView("cards")}>
              <LayoutGrid />
              <span className="flex-1">Cards</span>
              {view === "cards" && <Check />}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ToolbarGroup>
    </Toolbar>
  );
}
