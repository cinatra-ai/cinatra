"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDownAZ, ArrowLeftRight, ArrowUpAZ, Check, LayoutGrid, Plus, SlidersHorizontal, Unplug, X } from "lucide-react";
// The Connected mark is the first-party joined plug (cinatra#2356) — the two
// halves of `Unplug` with the gap closed. It is defined ONCE in sdk-ui (which
// sits BELOW this package in the dependency graph) so the toggle segment, the
// card badge and the setup surfaces all draw the identical glyph.
import { PlugConnected } from "@cinatra-ai/sdk-ui/icons";
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
import type { AvailableScopes } from "@/components/access-combobox";
import { cn } from "@/lib/utils";

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
  /**
   * Whether this actor can actually reach the in-app marketplace — the
   * destination BOTH install affordances lead to (cinatra#2357, spec §I: "Both
   * this button and the toolbar's + Connector appear only for a reader who can
   * actually reach the marketplace — where that access is absent, neither is
   * rendered. A control that leads nowhere is never shown.").
   *
   * `/configuration/marketplace` is `requireAdminSession`-gated, so the server
   * resolves this from the SAME platform-admin fact that gate reads. Required
   * (no default) so every mount decides explicitly rather than silently
   * rendering a dead action.
   */
  canReachMarketplace: boolean;
};

// cinatra#2357 (epic #2353): the filter is THREE-state and lands on "all".
// "available" stays the disconnected segment's internal value (its visible
// label has read "Disconnected" since #683) so the existing `connected` vs
// `!connected` semantics are untouched; "all" is the new pass-all predicate.
type FilterType = "all" | "connected" | "available";
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

export function ConnectorsClient({
  cards,
  scopeValue,
  scopes,
  canReachMarketplace,
}: ConnectorsClientProps) {
  const router = useRouter();
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [sort, setSort] = useState<SortOrder>("asc");
  // cinatra#1092 (DEFAULT half superseded by epic cinatra#2353 / #2357): every
  // visit now starts on "all" — the widest view — not "connected". The
  // NON-PERSISTENCE half of #1092 is retained exactly: the filter is plain
  // component state, never written to the URL or to storage, so a returning
  // user always lands back on the default rather than on a stale selection.

  const filteredConnectors = [...cards]
    .sort((a, b) => sort === "asc" ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name))
    // cinatra#2357: "all" is the PASS-ALL predicate — it names no connection
    // status and therefore narrows nothing.
    .filter((c) => filterType === "all" ? true : filterType === "connected" ? c.connected : !c.connected)
    .filter((c) => c.name.toLowerCase().includes(searchTerm.toLowerCase()));

  // ---------------------------------------------------------------------
  // Empty-state matrix (cinatra#2357 scope 2; spec §I "An empty grid is a
  // real state under every segment, and each has its own answer").
  //
  // Both panels key off the SERVER-resolved `cards` — never the
  // search-narrowed list. Their copy names scope / visibility / nothing-
  // installed as the causes, and a client-side search miss is none of those:
  // a query that matches nothing must leave a bare list, not a panel
  // asserting "nothing is connected".
  //
  //   All + 0          → the scope-neutral "No connectors to show" panel,
  //                      carrying the SINGLE install CTA (and no button at
  //                      all for an actor who cannot reach the marketplace).
  //   Connected + 0    → the "No connected services in this view" panel with
  //                      its own "Connect a service" action.
  //   Disconnected + 0 → no panel: an empty Disconnected list asks nothing of
  //                      the reader, so the grid area is simply bare.
  // ---------------------------------------------------------------------
  const hasConnectedConnectors = cards.some((c) => c.connected);
  const showConnectedEmptyState = filterType === "connected" && !hasConnectedConnectors;
  const showAllEmptyState = filterType === "all" && cards.length === 0;
  // The bottom CTA renders wherever the page renders EXCEPT the All+0 panel,
  // whose own button IS the single CTA — one screen never shows the same call
  // to action twice (spec §I). Under Connected+0 it is NOT suppressed: that
  // panel's action ("Connect a service") is a different one. Gated on the same
  // marketplace access as the toolbar's "+ Connector".
  const showInstallCta = canReachMarketplace && !showAllEmptyState;

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
            {/* Each STATUS item leads with the SAME plug glyph the cards use
                (#605): connected → PlugConnected (cinatra#2356 — the joined
                plug that pairs with the disconnected mark), disconnected →
                Unplug. The disconnected item's
                visible label is "Disconnected" (#683), but its `value` stays
                "available" so the filter semantics (`connected` vs
                `!connected`) are unchanged.

                cinatra#2357: "All" leads the group. It names NO connection
                status, so it takes neither status colour and neither plug: the
                page's own `--ink` navy (solid selected with a white icon +
                label, a soft navy tint idle) and the four-square
                `LayoutGrid` — the whole grid, every card — so the plug family
                stays exclusive to status. Deliberately NOT `bg-primary`: the
                indigo primary is reserved for a page's action of record and a
                filter segment is never that (the §VII selected-primary
                prohibition below holds unchanged), and deliberately not grey,
                which this system does not use for an idle control. */}
            <ToggleGroupItem
              value="all"
              className="rounded-none bg-foreground/10 text-foreground hover:bg-foreground/15 data-[state=on]:bg-foreground data-[state=on]:text-surface-strong data-[state=on]:hover:bg-foreground"
            >
              <LayoutGrid data-icon="inline-start" aria-hidden="true" />
              All
            </ToggleGroupItem>
            <ToggleGroupItem
              value="connected"
              className="rounded-none bg-success/10 text-success hover:bg-success/15 data-[state=on]:bg-success data-[state=on]:text-success-foreground data-[state=on]:hover:bg-success"
            >
              <PlugConnected data-icon="inline-start" aria-hidden="true" />
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
        {/* "+ Connector" action (#681): jump to the marketplace pre-filtered
            to connectors. `?tab=connector` is honoured by the marketplace
            client (extensions-marketplace-client: searchParams.get("tab") →
            the "connector" tab). §VII moves it next to the scope dropdown,
            with a hairline divider on both sides.

            cinatra#2357 scope 4: the action and ITS LEADING DIVIDER render
            only for an actor who can reach the marketplace. The destination is
            `requireAdminSession`-gated, so this button was a dead action for
            every non-admin — it is fixed as a PAIR with the bottom install CTA
            (spec §I: "A control that leads nowhere is never shown."). The
            divider rides inside the same branch so a hidden action never
            leaves a doubled hairline behind it. */}
        {canReachMarketplace ? (
          <>
            <ToolbarSeparator />
            <ToolbarGroup>
              <Button asChild variant="ghost" size="sm">
                <Link href="/configuration/marketplace?tab=connector">
                  <Plus data-icon="inline-start" aria-hidden="true" />
                  Connector
                </Link>
              </Button>
            </ToolbarGroup>
          </>
        ) : null}
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

      {showAllEmptyState ? (
        // All + 0 (cinatra#2357). Scope-neutral by construction: cards are
        // actor- AND scope-filtered server-side, so a workspace with
        // connectors installed can still show none. The copy therefore NEVER
        // asserts that nothing is installed — it names all three causes
        // (nothing installed here, outside the selected scope, outside what
        // the reader may see) and offers the remedy for each. This panel
        // carries the SINGLE install CTA; the bottom button is suppressed
        // beneath it (see `showInstallCta`).
        <section
          data-conformance-id="connector-empty-panel"
          data-state="empty"
          data-testid="connectors-empty-panel"
          className="soft-panel rounded-card mt-4 flex flex-col items-center justify-center gap-4 py-16 text-center"
        >
          <h2 className="text-lg font-semibold">No connectors to show</h2>
          {canReachMarketplace ? (
            <p className="text-muted-foreground text-sm max-w-md">
              Nothing is visible in this view. It may be that nothing is
              installed here yet, that what is installed sits outside the scope
              you have selected, or that it sits outside what you are allowed
              to see. Try a wider scope, ask for access to what you cannot see,
              or install a connector from the marketplace.
            </p>
          ) : (
            // Same panel, no button: the gating that hides both install
            // buttons hides this one too, and the final clause swaps the
            // install remedy for the one this reader can actually act on. An
            // empty panel whose only action leads nowhere would be worse than
            // none.
            <p className="text-muted-foreground text-sm max-w-md">
              Nothing is visible in this view. It may be that nothing is
              installed here yet, that what is installed sits outside the scope
              you have selected, or that it sits outside what you are allowed
              to see. Try a wider scope, or ask an administrator for access —
              or for an install.
            </p>
          )}
          {canReachMarketplace ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/configuration/marketplace?tab=connector">
                Install more connectors
              </Link>
            </Button>
          ) : null}
        </section>
      ) : showConnectedEmptyState ? (
        // Connected + 0. The #1092 panel stands, held to the same scope-neutral
        // discipline (cinatra#2357): its title and body no longer claim the
        // reader has connected nothing — what is connected may simply sit
        // outside this scope. Its action is unchanged and is NOT the install
        // CTA, so the bottom button keeps rendering beneath it.
        <section
          data-testid="connectors-connected-empty-panel"
          className="soft-panel rounded-card mt-4 flex flex-col items-center justify-center gap-4 py-16 text-center"
        >
          <h2 className="text-lg font-semibold">No connected services in this view</h2>
          <p className="text-muted-foreground text-sm max-w-md">
            Nothing here is connected. Either nothing is installed in this scope
            yet, or what is connected sits outside it. Connect a service to
            start using it across your agents and skills.
          </p>
          <Button type="button" onClick={() => setFilterType("available")}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            Connect a service
          </Button>
        </section>
      ) : (
      // FADE CONTAINMENT (cinatra#2357 scope 3). `.faded-bottom` is an
      // `after:absolute` overlay, so it resolves against the nearest POSITIONED
      // ancestor — this <ul> had none, so the band escaped the list entirely
      // and landed against the initial containing block. `relative` makes the
      // list itself the containing block, which is also what keeps the fade off
      // the CTA: the button is a SIBLING below this element, never a
      // descendant, and nothing positioned wraps the two together.
      //
      // The `pb-16` rework is the other half of containing it, and it is
      // EXACTLY as conditional as the band itself. The overlay is `after:h-32`
      // anchored to this element's bottom, so wherever it renders the trailing
      // gutter must be at least that tall or the band washes the final card row
      // (with the old 64px gutter it would have tinted ~26px of that row the
      // moment `relative` made it land here — a regression the page has never
      // actually shown). But the utility is `md:after:block`: below `md` there
      // is no band, and a 128px gutter there would be pure dead space above the
      // CTA. And with no cards there is nothing to fade at all, so an empty
      // list must not reserve the gutter either. Hence: the fade, its
      // positioning and its gutter ride together, only when there are cards,
      // and the 128px only from `md` up. The CTA then takes the spec's 24px of
      // clearance below the list box.
      // `packages/connectors/src/__tests__/connectors-client-design.test.ts`
      // reads the utility out of globals.css and fails if the gutter and the
      // band's height ever diverge.
      <ul
        className={cn(
          "no-scrollbar grid gap-4 overflow-auto pt-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5",
          filteredConnectors.length > 0 && "faded-bottom relative pb-4 md:pb-32",
        )}
      >
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

      {/* The page's closing CTA (cinatra#2357 scope 3; spec §I). Centred,
          `outline` at the SMALL size, no leading glyph — the plug family
          belongs to status, and the toolbar's "+ Connector" is already the
          compact repeat of this same destination. Deliberately not the primary
          button: the work of this page is connecting what is already
          installed, and installing more is the way out of the page rather than
          its main act.

          It is a SIBLING of the list, outside the positioned block the fade
          lives in, so the two can never overlap — and it carries the spec's
          24px of clearance (`mt-6`) above it. */}
      {showInstallCta ? (
        <div className="mt-6 flex justify-center pb-4">
          <Button
            asChild
            variant="outline"
            size="sm"
            data-conformance-id="connector-install-cta"
            data-testid="connectors-install-cta"
          >
            <Link href="/configuration/marketplace?tab=connector">
              Install more connectors
            </Link>
          </Button>
        </div>
      ) : null}
    </>
  );
}
