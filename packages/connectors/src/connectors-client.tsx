"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDownAZ, ArrowLeftRight, ArrowUpAZ, Check, PlugZap, Plus, SlidersHorizontal, Unplug, X } from "lucide-react";
import { ConnectorBadge } from "./connector-badge";
// Paired-logo brand marks (the bidirectional assistant connectors render a
// `[brand] ⇄ [Cinatra]` pair, not a single mark). The single-mark map lives in
// the shared `@/components/connector-brand-icons` leaf (cinatra#1325).
import SiWordpress from "@icons-pack/react-simple-icons/icons/SiWordpress.mjs";
import SiDrupal from "@icons-pack/react-simple-icons/icons/SiDrupal.mjs";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
} from "@/components/ui/toolbar";
import { iconForSlug } from "@/components/connector-brand-icons";
import { CinatraLogo } from "@/app/cinatra-logo";
import { ScopeFilterCombobox } from "@/components/scope-filter-combobox";
import type { AvailableScopes } from "@/components/access-combobox-hierarchical";

// ---------------------------------------------------------------------------
// Public catalog-driven shape: cards keep their look while the boolean-prop
// surface is replaced by a single `cards` array.
// ---------------------------------------------------------------------------

export type ConnectorCardData = {
  slug: string;
  name: string;
  /**
   * Sanitized inline-SVG data URI from the extension's own manifest
   * (`cinatra.logo`). When null the card falls back to the host `ICON_BY_SLUG`
   * map, so a bundled connector keeps its existing icon and a marketplace
   * connector can render its own logo with no host edit.
   */
  logo?: string | null;
  connected: boolean;
  connectedLabel?: string;
  href: string;
};

type ConnectorsClientProps = {
  cards: ConnectorCardData[];
  /**
   * Scope filter state — server-resolved from the URL `?scope=` token and the
   * actor's accessible scopes. The client component only displays the picker
   * (which writes the token back to the URL); the server is what filters the
   * cards.
   */
  /** The active scope selection (server-resolved by the canonical parser). */
  scopeValue: string[];
  /** The actor's accessible scopes, used to populate the scope picker. */
  scopes: AvailableScopes;
};

type FilterType = "connected" | "available";
type SortOrder = "asc" | "desc";

// ---------------------------------------------------------------------------
// Paired logos — the bidirectional assistant connectors render
// `[brand] ⇄ [Cinatra]` in the card's logo area instead of the single brand
// mark. (The plain MCP connectors keep their single mark via ICON_BY_SLUG.)
// ---------------------------------------------------------------------------

const PAIRED_BRAND_BY_SLUG = new Map<string, { brand: string; icon: ReactNode }>([
  ["drupal-assistant-connector", { brand: "Drupal", icon: <SiDrupal size={20} color="default" aria-hidden="true" /> }],
  ["wordpress-assistant-connector", { brand: "WordPress", icon: <SiWordpress size={20} color="default" aria-hidden="true" /> }],
]);

function PairedConnectorLogo({ brand, icon }: { brand: string; icon: ReactNode }) {
  return (
    <div
      role="img"
      aria-label={`${brand} connects to Cinatra`}
      className="inline-flex h-10 items-center gap-1.5 rounded-control border border-line bg-white px-2.5 text-foreground"
    >
      {icon}
      <ArrowLeftRight className="size-4 text-muted-foreground" aria-hidden="true" />
      {/* Cinatra mark renders in brand mustard (the app-icon treatment) rather
          than the default ink. `CinatraLogo` fills with currentColor, so the
          `text-brand-mustard` token is sufficient and stays scoped to the card. */}
      <CinatraLogo className="size-5 text-brand-mustard" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main client component
// ---------------------------------------------------------------------------
//
// The per-card connection-status badge is the SHARED `ConnectorBadge`
// (`./connector-badge`), the same component the host injects into the connector
// setup-page header — so the card badge and the setup-page badge stay
// byte-identical.

export function ConnectorsClient({ cards, scopeValue, scopes }: ConnectorsClientProps) {
  const router = useRouter();
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState<FilterType>("connected");
  const [sort, setSort] = useState<SortOrder>("asc");
  // cinatra#1092: the connection filter is intentionally NOT persisted. Every
  // visit starts on the "connected" default above; toggling to Disconnected
  // works within the visit but is never written to storage, so a returning
  // user always lands back on Connected.

  const filteredConnectors = [...cards]
    .sort((a, b) => sort === "asc" ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name))
    .filter((c) => filterType === "connected" ? c.connected : !c.connected)
    .filter((c) => c.name.toLowerCase().includes(searchTerm.toLowerCase()));

  // cinatra#1092 empty-connected edge: with zero connected connectors, stay on
  // the Connected filter and show an empty state with a "Connect a service"
  // CTA that switches to the Disconnected/Available list, instead of silently
  // falling back to Available (which would make the default unpredictable).
  const hasConnectedConnectors = cards.some((c) => c.connected);
  const showConnectedEmptyState = filterType === "connected" && !hasConnectedConnectors;

  return (
    <>
      {/* Toolbar layout (cinatra#1014, design system §VII "Connectors"):
          connection-state ToggleGroup LEADS · search · scope-filter Select ·
          + Connector (hairline dividers before AND after it) · flex-1 spacer ·
          sort dropdown anchored far right. The Toolbar replaces the section
          rule under PageHeader (PageHeader divider stays default because the
          connectors page does not need a banner). */}
      <Toolbar aria-label="Connectors filters">
        <ToolbarGroup>
          {/* Design-system Toggle / Toggle-group spec (#604, refined #1014):
              one outer hairline border with hairline dividers between
              segments, no gaps, 7px radius. Each segment carries its OWN
              semantic status colour at all times — never grey (§VII): the
              idle state is a muted tint of that colour and the selected
              state is the SOLID colour with a white icon + label (replacing
              the prior indigo/primary soft-tint selection). Labels stay
              `font-medium` (not bold) in both states. */}
          <ToggleGroup
            type="single"
            size="sm"
            value={filterType}
            onValueChange={(v) => v && setFilterType(v as FilterType)}
            aria-label="Filter by connection state"
            className="overflow-hidden rounded-[7px] border border-line [&>*:not(:first-child)]:border-l [&>*:not(:first-child)]:border-line"
          >
            {/* Each item leads with the SAME plug glyph the cards use (#605):
                connected → PlugZap, disconnected → Unplug. The second item's
                visible label is "Disconnected" (#683), but its `value` stays
                "available" so the filter semantics (`connected` vs
                `!connected`) are unchanged. */}
            <ToggleGroupItem
              value="connected"
              className="rounded-none bg-success/10 text-success hover:bg-success/15 data-[state=on]:bg-success data-[state=on]:text-success-foreground data-[state=on]:hover:bg-success"
            >
              <PlugZap data-icon="inline-start" aria-hidden="true" />
              Connected
            </ToggleGroupItem>
            <ToggleGroupItem
              value="available"
              className="rounded-none bg-destructive/10 text-destructive hover:bg-destructive/15 data-[state=on]:bg-destructive data-[state=on]:text-destructive-foreground data-[state=on]:hover:bg-destructive"
            >
              <Unplug data-icon="inline-start" aria-hidden="true" />
              Disconnected
            </ToggleGroupItem>
          </ToggleGroup>
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup>
          {/* Search field (§VII): renamed placeholder + a small ✕ that clears
              the query, shown only while the field holds text. */}
          <div className="relative">
            <Input
              placeholder="Search connectors"
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
          <ScopeFilterCombobox
            id="connectors-scope-filter"
            value={scopeValue}
            scopes={scopes}
          />
        </ToolbarGroup>
        <ToolbarSeparator />
        {/* "+ Connector" action (#681): jump to the marketplace pre-filtered
            to connectors. `?tab=connector` is honoured by the marketplace
            client (extensions-marketplace-client: searchParams.get("tab") →
            the "connector" tab). §VII moves it next to the scope dropdown,
            with a hairline divider on both sides. */}
        <ToolbarGroup>
          <Button asChild variant="ghost" size="sm">
            <Link href="/configuration/marketplace?tab=connector">
              <Plus data-icon="inline-start" aria-hidden="true" />
              Connector
            </Link>
          </Button>
        </ToolbarGroup>
        <ToolbarSeparator />
        <div aria-hidden className="flex-1" />
        <ToolbarSeparator />
        {/* Sort control anchors the FAR right of the toolbar (§VII). */}
        <ToolbarGroup>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                aria-label="Sort connectors"
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

      {showConnectedEmptyState ? (
        <section className="soft-panel rounded-card mt-4 flex flex-col items-center justify-center gap-4 py-16 text-center">
          <h2 className="text-lg font-semibold">No connected services yet</h2>
          <p className="text-muted-foreground text-sm max-w-md">
            You have not connected any services yet. Connect one to start using
            it across your agents and skills.
          </p>
          <Button type="button" onClick={() => setFilterType("available")}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            Connect a service
          </Button>
        </section>
      ) : (
      <ul className="faded-bottom no-scrollbar grid gap-4 overflow-auto pt-4 pb-16 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {filteredConnectors.map((connector) => {
          const paired = PAIRED_BRAND_BY_SLUG.get(connector.slug);
          return (
            <li
              key={connector.slug}
              // Conformance stable-id contract (cinatra#986, testid-contract.json):
              // the card root carries its slug + connection state so the
              // functional-acceptance suite can assert exact counts, the
              // manifest displayName binding, and the fail-soft error card.
              data-testid="connector-card"
              data-connector-slug={connector.slug}
              data-connected={connector.connected ? "" : undefined}
              className="group flex flex-col gap-4 rounded-card border border-line bg-surface p-5 shadow-sm transition hover:border-foreground/30 hover:bg-surface-muted cursor-pointer"
              onClick={() => router.push(connector.href)}
            >
              <div className="flex items-start justify-between gap-3">
                {paired ? (
                  <PairedConnectorLogo brand={paired.brand} icon={paired.icon} />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-control border border-line bg-white text-foreground">
                    {connector.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element -- bounded, sanitized inline-SVG data URI (no remote fetch); Next <Image> is unnecessary
                      <img src={connector.logo} alt="" aria-hidden="true" className="size-5" />
                    ) : (
                      iconForSlug(connector.slug)
                    )}
                  </div>
                )}
                <ConnectorBadge
                  connected={connector.connected}
                  label={connector.connectedLabel}
                />
              </div>
              <div>
                {/* Conformance field binding: the card name renders the
                    connector manifest displayName (never the slug) — see
                    packages/connectors/src/pages.tsx card assembly. */}
                <h3 data-slot="connector-card-name" className="text-base font-semibold text-foreground">
                  {connector.name}
                </h3>
              </div>
            </li>
          );
        })}
      </ul>
      )}
    </>
  );
}
