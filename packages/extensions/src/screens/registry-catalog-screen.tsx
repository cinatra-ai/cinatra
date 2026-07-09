import { Package, Settings, Upload } from "lucide-react";
import Link from "next/link";
import { requireAuthSession } from "@/lib/auth-session";
// "More details" opens the §V detail modal in place (cinatra#948 reopen, §VI
// L902) — the full-page marketplace route is no longer this page's target, so
// an installed-but-unlisted or unscoped package can never dead-end on a 404
// (the modal renders its own graceful `notfound` state instead).
import { MarketplaceDetailModal } from "./marketplace-detail-modal";
// §VI empty states — extracted (cinatra#986) so the design-conformance seeded
// harness renders the SAME presentations this screen does.
import { ActiveEmptyState, ArchivedEmptyState } from "./installed-empty-states";
import type { MarketplaceCardData } from "./marketplace-card-model";
import { marketplaceDetailHref } from "./marketplace-card-model";
// Installed-extension row model + loader — the SHARED hydration path the
// per-extension Settings page (design §V) also consumes, so a package's card
// and its settings header never disagree on display fields (cinatra#1114).
import {
  KIND_LABEL,
  loadInstalledCardRows,
  rowKey,
  type InstalledCardRow,
} from "./installed-rows";
import { Button } from "@/components/ui/button";
import {
  Toolbar,
  ToolbarButton,
  ToolbarGroup,
} from "@/components/ui/toolbar";
import { ExtensionsTabSelect } from "@/components/extensions/extensions-tab-select";
import { InstallBatchPanel } from "@/components/extensions/install-batch-panel";
import { InstallBatchLiveRefresh } from "@/components/extensions/install-batch-live-refresh";
import {
  InstalledExtensionCard,
  InstalledStatusIndicator,
} from "@/components/extensions/installed-extension-card";
import {
  extensionKindEmblem,
  type ExtensionEmblemKind,
} from "@/components/extension-kind-emblem";
import { deriveExtensionAccent } from "@/lib/extension-accent";
import { hasActiveInstallBatch } from "@/lib/extension-dependency-ux";
import { listRecentInstallBatches } from "@/lib/extension-install-batch-ops";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";

// ---------------------------------------------------------------------------
// RegistryCatalogScreen
//
// Card row model + hydration live in ./installed-rows (shared with the §V
// Settings page). This screen owns ONLY the toolbar / batch panel / card
// rendering.
// ---------------------------------------------------------------------------

export async function RegistryCatalogScreen({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAuthSession();

  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  // URL-driven tab selection. Server-side narrowing: only "archived" is
  // accepted; any other value falls through to "active".
  const tab = resolvedSearchParams?.tab === "archived" ? "archived" : "active";
  const queryValue = resolvedSearchParams?.q;
  const query =
    typeof queryValue === "string"
      ? queryValue
      : Array.isArray(queryValue)
        ? queryValue[0]
        : undefined;

  const {
    active: activeRows,
    archived: archivedRows,
    scope,
  } = await loadInstalledCardRows(session, { query });

  // Recent dependency-install batches (cinatra #209 item 2, surfaces 2 & 3):
  // the durable `extension_install_batches` ledger drives the per-member
  // install progress + the batch compensation outcomes. READ-ONLY.
  //
  // ORG-SCOPED (security): pass the actor's active org so this read returns
  // ONLY the current organization's batches — never another tenant's. The ops
  // layer filters NULL-safe (`org_id IS NOT DISTINCT FROM $1`), so a member
  // with no active org (`null`) correctly sees only platform-scoped batches.
  // Best-effort: a ledger read failure must never blank the Extensions list,
  // so it degrades to "no recent installs" with a logged warning.
  const recentBatches = await listRecentInstallBatches({
    limit: 10,
    orgId: scope.organizationId,
  }).catch((err: unknown) => {
    console.warn(
      "[registry-catalog] could not read recent install batches (panel omitted):",
      err instanceof Error ? err.message : err,
    );
    return [] as Awaited<ReturnType<typeof listRecentInstallBatches>>;
  });

  // -------------------------------------------------------------------------
  // Card renderers
  // -------------------------------------------------------------------------

  // §VI spec version line: ONLY the mono version + the lifecycle indicator
  // (cinatra#948 reopen, gap 3; §VI drawing, refreshed 2026-07-05 —
  // green-check Active / grey-cross Archived + mono label, not the §VII
  // StatusPill). The indicator carries the row's TRUE status (cinatra#957):
  // active → green check "Active"; locked → green check with the distinct
  // "Locked" label + tooltip (a system extension is live); archived → muted
  // cross. This is the card's ONLY status affordance — the owner ruling
  // (2026-07-05) removed every non-spec chip (Required / visibility / risk)
  // from the card entirely.
  const renderStatus = (row: InstalledCardRow) => <InstalledStatusIndicator status={row.status} />;

  // ---------------------------------------------------------------------------
  // "More details" → the §V detail modal, in place (cinatra#948 reopen, §VI
  // L902). Rendered for EVERY row — scoped, unscoped, and installed-but-
  // unlisted packages alike: the modal fetches the public listing on open and
  // renders its own graceful "Extension unavailable" notfound state for the
  // class that used to 404 on the full-page route. For an installed extension
  // the modal is DETAILS-ONLY (owner ruling, 2026-07-05): no footer CTA and no
  // manage actions — this page passes only the card shell + the §VI link
  // trigger, so the modal renders no footer bar at all. The modal component
  // itself belongs to the §V lane (PR #995 / #989); this page only consumes
  // its public entry points.
  // ---------------------------------------------------------------------------
  const renderDetailModal = (row: InstalledCardRow, isArchived: boolean) => {
    // Reuses the browse-card wire shape; storefront-owned fields (rating,
    // badge, freshness, assets) stay null — the modal hydrates them from the
    // fetched detail, so the card shell only carries install identity + the
    // already-hydrated display fields (the human-readable displayName the
    // modal title renders, never the package slug).
    const modalCard: MarketplaceCardData = {
      packageName: row.packageName,
      packageVersion: row.rawVersion ?? "",
      displayName: row.displayName,
      description: row.description,
      kindSlug: row.kind,
      kindLabel: KIND_LABEL[row.kind],
      badge: null,
      freshnessAt: null,
      rating: null,
      detailHref: marketplaceDetailHref(row.packageName),
      installCount: null,
      iconUrl: null,
      vendorLogoUrl: null,
      // Storefront-owned like the assets above (#1003 added the publisher ref
      // to the card model): the §VI shell carries no vendor block; the modal
      // hydrates the vendor byline from the fetched detail on open.
      vendor: null,
      sdkAbiRange: null,
    };
    return (
      <MarketplaceDetailModal
        card={modalCard}
        // §VI actions panel: More details is a real <a> (never a button) — the
        // active row's underlined indigo `.btn.link`; the archived row's
        // muted, non-underlined `.btn.ghost`. No footer props are passed, so
        // the modal is details-only with no footer bar.
        linkTrigger={{
          variant: isArchived ? "ghost" : "link",
          href: modalCard.detailHref,
        }}
      />
    );
  };

  // §VI card actions — EXACTLY Settings + More details, ALWAYS both, for every
  // kind and both active/archived rows (owner ruling, 2026-07-05). Settings is
  // a button (primary on active, muted `secondary` on archived) linking to the
  // per-extension Settings page (design §V, see `settingsHrefFor`); More
  // details is the link-styled anchor that opens the §V modal in place.
  const renderCardActions = (row: InstalledCardRow, isArchived: boolean) => (
    <>
      <Button
        asChild
        size="sm"
        variant={isArchived ? "secondary" : "default"}
        className={isArchived ? "text-muted-foreground" : undefined}
      >
        <Link href={row.settingsHref}>
          <Settings data-icon="inline-start" />
          Settings
        </Link>
      </Button>
      {renderDetailModal(row, isArchived)}
    </>
  );

  const renderCard = (row: InstalledCardRow, isArchived: boolean) => (
    <InstalledExtensionCard
      key={rowKey(row.kind, row.packageName)}
      name={row.displayName}
      accentColor={deriveExtensionAccent(row.packageName)}
      emblem={extensionKindEmblem(row.kind as ExtensionEmblemKind)}
      kindIcon={extensionKindEmblem(row.kind as ExtensionEmblemKind, "size-3.5")}
      kindLabel={KIND_LABEL[row.kind]}
      vendor={row.vendor}
      description={row.description}
      version={row.versionLabel}
      status={renderStatus(row)}
      actions={renderCardActions(row, isArchived)}
      // Archived extensions render the fully-greyed §VI card (cinatra#957):
      // category ground → light grey, muted logo tile, all text/status/actions
      // muted. Active cards keep their category colour.
      archived={isArchived}
    />
  );

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Extensions"
        description="Manage installed agents, skills, connectors, and artifacts."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {/* Toolbar layout per the design system's Installed-extensions
            section: the Active/Archived status filter on the left;
            "Marketplace" + "Upload" on the right. */}
        <Toolbar aria-label="Extensions filters">
          <ToolbarGroup>
            <ExtensionsTabSelect value={tab} />
          </ToolbarGroup>
          <div aria-hidden className="flex-1" />
          <ToolbarGroup>
            <ToolbarButton asChild>
              <Link href="/configuration/marketplace">
                <Package data-icon="inline-start" />
                Marketplace
              </Link>
            </ToolbarButton>
            <ToolbarButton asChild>
              <Link href="/configuration/extensions/upload">
                <Upload data-icon="inline-start" />
                Upload
              </Link>
            </ToolbarButton>
          </ToolbarGroup>
        </Toolbar>

        {tab === "active" ? (
          <div className="flex flex-col gap-6">
            {/* Recent dependency-install batches: per-member progress +
                compensation outcomes from the durable ledger (cinatra #209
                item 2, surfaces 2 & 3). Renders nothing when there are no
                batches. While any batch is non-terminal, poll
                router.refresh() so the server snapshot below stays live
                (cinatra #851 finding 3). */}
            <InstallBatchLiveRefresh active={hasActiveInstallBatch(recentBatches)} />
            <InstallBatchPanel batches={recentBatches} />
            {activeRows.length === 0 ? (
              <ActiveEmptyState />
            ) : (
              <div className="grid gap-3">{activeRows.map((row) => renderCard(row, false))}</div>
            )}
          </div>
        ) : (
          <div>
            {archivedRows.length === 0 ? (
              <ArchivedEmptyState />
            ) : (
              <div className="grid gap-3">{archivedRows.map((row) => renderCard(row, true))}</div>
            )}
          </div>
        )}
      </PageContent>
    </Main>
  );
}
