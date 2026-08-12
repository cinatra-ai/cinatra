"use client";

// ---------------------------------------------------------------------------
// /assistants directory client (cinatra#2688).
//
// The /assistants surface was a bare PageHeader over a server-rendered list: no
// add affordance and no filter bar. This component gives it the SAME toolbar
// /connectors carries (packages/connectors/src/connectors-client.tsx), built
// from the same primitives and in the same left-to-right order:
//
//   type ToggleGroup · search · ScopeFilterCombobox · + Assistant · sort
//
// The division of labour is the connectors one exactly. The SERVER resolves and
// applies `?scope=` (the canonical parser + the audience fold in
// assistants-directory.server.ts); this component only DISPLAYS the picker,
// which writes the token back to the URL. Type / search / sort are plain
// component state — never written to the URL or to storage — so a returning
// reader always lands on the default view.
// ---------------------------------------------------------------------------

import { useState } from "react";
import Link from "next/link";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Check,
  ExternalLink,
  LayoutGrid,
  MessageSquare,
  Plus,
  SlidersHorizontal,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Toolbar, ToolbarGroup, ToolbarSeparator } from "@/components/ui/toolbar";
import { ScopeFilterCombobox } from "@/components/scope-filter-combobox";
import type { AvailableScopes } from "@/components/access-combobox";
import type { AssistantDirectoryRow } from "@/lib/assistants-directory.server";

type AssistantsDirectoryClientProps = {
  /** The rows the server resolver already audience- AND scope-filtered. */
  rows: AssistantDirectoryRow[];
  /** The active scope selection (server-resolved by the canonical parser). */
  scopeValue: string[];
  /** The actor's accessible scopes, used to populate the scope picker. */
  scopes: AvailableScopes;
  /**
   * Whether this actor can reach `/configuration/marketplace` — the destination
   * of the menu's "Get one from the marketplace" entry. That route is
   * `requireAdminSession`-gated, so the server resolves this from the SAME
   * platform-admin fact the gate reads, and a reader who cannot reach it is
   * never shown the entry (the /connectors doctrine: "A control that leads
   * nowhere is never shown."). Required — no default — so every mount decides
   * explicitly rather than silently rendering a dead action.
   */
  canReachMarketplace: boolean;
  /**
   * Whether this actor can reach `/configuration/extensions/upload`. Read from
   * that route's OWN gate (also `requireAdminSession` today). It is a SEPARATE
   * prop rather than a reuse of `canReachMarketplace` because the two
   * destinations are two different gates: should either move, the menu keeps
   * hiding exactly the entry that became unreachable.
   */
  canUploadExtension: boolean;
};

// The type filter is THREE-state and lands on "all", mirroring the /connectors
// segment set. The axis here is the assistant's LAUNCH topology, the one fact a
// directory reader actually chooses between: an assistant answered by the host
// runtime, versus one that expands per connected site.
type FilterType = "all" | "local" | "remote";
type SortOrder = "asc" | "desc";

export function AssistantsDirectoryClient({
  rows,
  scopeValue,
  scopes,
  canReachMarketplace,
  canUploadExtension,
}: AssistantsDirectoryClientProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [sort, setSort] = useState<SortOrder>("asc");

  // The "+ Assistant" menu renders only when it has at least one live entry.
  const showAddMenu = canReachMarketplace || canUploadExtension;

  const query = searchTerm.toLowerCase();
  const visibleRows = [...rows]
    .sort((a, b) =>
      sort === "asc"
        ? a.displayName.localeCompare(b.displayName)
        : b.displayName.localeCompare(a.displayName),
    )
    // "all" is the PASS-ALL predicate — it names no topology and narrows nothing.
    .filter((r) => (filterType === "all" ? true : filterType === "remote" ? r.remoteCapable : !r.remoteCapable))
    // Search matches the display name AND the mention tags, because a reader who
    // knows an assistant only as "@wordpress" must be able to find it by that.
    .filter(
      (r) =>
        r.displayName.toLowerCase().includes(query) ||
        r.handle.toLowerCase().includes(query) ||
        r.aliases.some((a) => a.toLowerCase().includes(query)),
    );

  return (
    <>
      <Toolbar aria-label="Assistants filters">
        <ToolbarGroup>
          <ToggleGroup
            type="single"
            size="sm"
            value={filterType}
            onValueChange={(v) => v && setFilterType(v as FilterType)}
            aria-label="Filter by assistant type"
            className="overflow-hidden rounded-[7px] border border-line [&>*:not(:first-child)]:border-l [&>*:not(:first-child)]:border-line"
          >
            {/* "All" leads the group and names no topology, so it takes the
                page's own ink navy and the four-square LayoutGrid — the same
                treatment the /connectors "All" segment carries. */}
            <ToggleGroupItem
              value="all"
              className="rounded-none bg-foreground/10 text-foreground hover:bg-foreground/15 data-[state=on]:bg-foreground data-[state=on]:text-surface-strong data-[state=on]:hover:bg-foreground"
            >
              <LayoutGrid data-icon="inline-start" aria-hidden="true" />
              All
            </ToggleGroupItem>
            <ToggleGroupItem
              value="local"
              className="rounded-none bg-info/10 text-info hover:bg-info/15 data-[state=on]:bg-info data-[state=on]:text-info-foreground data-[state=on]:hover:bg-info"
            >
              <MessageSquare data-icon="inline-start" aria-hidden="true" />
              In Cinatra
            </ToggleGroupItem>
            {/* A remote-capable assistant expands per CONNECTED site, so this
                segment carries the same success token /connectors gives its
                "Connected" segment — one meaning for one colour across both
                surfaces. */}
            <ToggleGroupItem
              value="remote"
              className="rounded-none bg-success/10 text-success hover:bg-success/15 data-[state=on]:bg-success data-[state=on]:text-success-foreground data-[state=on]:hover:bg-success"
            >
              <ExternalLink data-icon="inline-start" aria-hidden="true" />
              Connected sites
            </ToggleGroupItem>
          </ToggleGroup>
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup>
          <div className="relative">
            <Input
              placeholder="Search assistants"
              className="h-8 w-[180px] pr-7 lg:w-[260px]"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {searchTerm ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setSearchTerm("")}
                aria-label="Clear search"
                className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
              >
                <X aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup>
          <ScopeFilterCombobox id="assistants-scope-filter" value={scopeValue} scopes={scopes} />
        </ToolbarGroup>
        {/* "+ Assistant" (cinatra#2688). An assistant is an extension, so it is
            acquired the ways any extension is — hence a MENU rather than
            "+ Connector"'s single jump: the acquisition paths are plural.

            Each entry is gated on ITS OWN destination's access, and the leading
            divider rides inside the same branch so a hidden action never leaves
            a doubled hairline behind it. */}
        {showAddMenu ? (
          <>
            <ToolbarSeparator />
            <ToolbarGroup>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm">
                    <Plus data-icon="inline-start" aria-hidden="true" />
                    Assistant
                  </Button>
                </DropdownMenuTrigger>
                {/* Sized so neither acquisition label wraps — the menu's
                    intrinsic width breaks both labels across lines. */}
                <DropdownMenuContent align="start" className="w-64">
                  {canReachMarketplace ? (
                    // The marketplace has no assistant tab: assistants live
                    // under Agents (`agent_kind='assistant'`) and the browse
                    // client filters on the extension KIND alone. `?tab=agent`
                    // is therefore the nearest true destination — the same
                    // `?tab=` token "+ Connector" uses — and adding an
                    // assistant tab or category is its own design decision, not
                    // this toolbar's.
                    <DropdownMenuItem asChild>
                      <Link href="/configuration/marketplace?tab=agent">
                        <LayoutGrid aria-hidden="true" />
                        <span className="flex-1">Get from the marketplace</span>
                      </Link>
                    </DropdownMenuItem>
                  ) : null}
                  {canUploadExtension ? (
                    <DropdownMenuItem asChild>
                      <Link href="/configuration/extensions/upload">
                        <Upload aria-hidden="true" />
                        <span className="flex-1">Upload an extension</span>
                      </Link>
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </ToolbarGroup>
          </>
        ) : null}
        <ToolbarSeparator />
        <div aria-hidden className="flex-1" />
        <ToolbarSeparator />
        <ToolbarGroup>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                aria-label="Sort assistants"
              >
                <SlidersHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setSort("asc")}>
                <ArrowUpAZ />
                <span className="flex-1">Ascending</span>
                {sort === "asc" && <Check />}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSort("desc")}>
                <ArrowDownAZ />
                <span className="flex-1">Descending</span>
                {sort === "desc" && <Check />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ToolbarGroup>
      </Toolbar>

      <div className="mt-4 flex flex-col gap-4 pb-8">
        {rows.length === 0 ? (
          // Keyed off the SERVER-resolved rows, never the search-narrowed list:
          // a query that matches nothing must leave a bare list, not a panel
          // asserting that nothing is available. The copy names all three real
          // causes (nothing installed, outside the selected scope, outside what
          // the reader may see) because the rows are audience- AND
          // scope-filtered server-side.
          <section
            data-testid="assistants-empty-panel"
            data-state="empty"
            className="soft-panel rounded-card flex flex-col items-center justify-center gap-4 py-16 text-center"
          >
            <h2 className="text-lg font-semibold">No assistants to show</h2>
            <p className="text-muted-foreground max-w-md text-sm">
              {showAddMenu
                ? "Nothing is visible in this view. It may be that nothing is installed here yet, that what is installed sits outside the scope you have selected, or that it sits outside what you are allowed to see. Try a wider scope, or add an assistant."
                : "Nothing is visible in this view. It may be that nothing is installed here yet, that what is installed sits outside the scope you have selected, or that it sits outside what you are allowed to see. Try a wider scope, or ask an administrator for access — or for an install."}
            </p>
          </section>
        ) : (
          visibleRows.map((row) => (
            <section
              key={row.packageName}
              data-testid="assistant-row"
              className="soft-panel rounded-card flex flex-col gap-4 px-6 py-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-semibold text-foreground">{row.displayName}</h2>
                    <span className="text-xs text-muted-foreground">@{row.handle}</span>
                  </div>
                  {row.aliases.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Also: {row.aliases.map((a) => `@${a}`).join(", ")}
                    </p>
                  )}
                </div>
                {!row.remoteCapable && (
                  <Link
                    href={row.localChatHref}
                    className="inline-flex items-center gap-2 rounded-control border border-line bg-surface-strong px-4 py-2 text-sm font-semibold text-foreground transition hover:border-primary"
                  >
                    <MessageSquare className="size-4" />
                    Chat
                  </Link>
                )}
              </div>

              {row.remoteCapable && (
                <div className="flex flex-col gap-2">
                  {row.remoteInstances.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No connected sites you can access yet.
                    </p>
                  ) : (
                    row.remoteInstances.map((instance) => (
                      <div
                        key={instance.instanceId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line px-4 py-2"
                      >
                        <span className="text-sm text-foreground">{instance.name}</span>
                        <div className="flex items-center gap-2">
                          <Link
                            href={instance.localChatHref}
                            className="inline-flex items-center gap-2 rounded-control border border-line bg-surface-strong px-3 py-1.5 text-sm font-medium text-foreground transition hover:border-primary"
                          >
                            <MessageSquare className="size-4" />
                            Chat locally
                          </Link>
                          <Link
                            href={instance.remoteHref}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-2 rounded-control border border-line px-3 py-1.5 text-sm font-medium text-foreground transition hover:border-primary"
                          >
                            <ExternalLink className="size-4" />
                            Remote chat
                          </Link>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </section>
          ))
        )}
      </div>
    </>
  );
}
