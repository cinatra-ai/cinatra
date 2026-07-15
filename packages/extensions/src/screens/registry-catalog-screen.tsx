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
// §II modal-footer update flow (cinatra#1041 outcome 2): the dry-run planner
// action + the batch-routed apply, bound per row for the update-available state.
import { updateExtensionPackageFormAction } from "../actions";
import { planExtensionUpdateFormAction } from "./update-plan-action";
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
  UpdateAvailableChip,
} from "@/components/extensions/installed-extension-card";
import {
  extensionKindEmblem,
  type ExtensionEmblemKind,
} from "@/components/extension-kind-emblem";
import { deriveExtensionAccent } from "@/lib/extension-accent";
import { resolveVendorPresentation } from "@/lib/vendor-presentation";
import { hasActiveInstallBatch } from "@/lib/extension-dependency-ux";
import { listRecentInstallBatches } from "@/lib/extension-install-batch-ops";
// §III per-extension update-available chip (cinatra#1041 outcome 3): the
// cached read model + the pure chip-state derivation.
import { deriveExtensionCompatState } from "@/lib/extension-compat-badge";
import { readInstalledUpdateReadouts } from "@/lib/extension-update-read-model-store";
import { deriveInstalledUpdateChipState } from "./installed-update-chip";
import type { InstalledUpdateReadout } from "@cinatra-ai/registries/src/update-read-model";
// Register the built-in per-connector readiness probes (side effect) — the
// SAME import the /connectors grid + setup routes carry (connector-setup-badge
// pins it). Without it a cold extensions-page load would probe unregistered
// connectors as default "not connected", falsely flagging configured agents as
// needing setup (cinatra #1057).
import "@/lib/connector-readiness.server";
import { resolveConfigurationNeedsForAgents } from "@/lib/configuration-needs.server";
import { syncAgentConfigurationNeedsNotifications } from "@/lib/agent-configuration-needs-notifications";
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
  // accepted; any other value falls through to "active". A locked/system
  // extension is live, so it renders in the Active partition by design — a
  // dedicated "Locked" view (which would concentrate these cards) is the
  // separate status-filter expansion (cinatra#1571, blocked by #1570), not a
  // narrowing this screen adds here.
  const tab = resolvedSearchParams?.tab === "archived" ? "archived" : "active";
  // §V settings-row deep link (cinatra#1041): `?update=<packageName>` opens the
  // matching row's detail modal directly (its footer carries the update flow
  // when one is available — otherwise the modal opens details-only, graceful).
  const openUpdateFor =
    typeof resolvedSearchParams?.update === "string" ? resolvedSearchParams.update : null;
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

  // §III per-extension "Update available" chip source (cinatra#1041 outcome 3).
  // The cached update read model is refreshed per-package by the hourly
  // catalog-sync loop and read HERE in one batched query (no per-render
  // packument storm; works on gatekept instances that cannot enumerate
  // registry versions live). Best-effort: a read failure degrades to "no
  // chips" (fail-quiet) — an update indicator must never blank the list.
  const updateReadoutByName = new Map<string, InstalledUpdateReadout>();
  {
    const installedPackageNames = [...activeRows, ...archivedRows].map(
      (row) => row.packageName,
    );
    const readouts = await readInstalledUpdateReadouts(installedPackageNames).catch(
      (err: unknown) => {
        console.warn(
          "[registry-catalog] could not read the update model (chips omitted):",
          err instanceof Error ? err.message : err,
        );
        return [] as InstalledUpdateReadout[];
      },
    );
    for (const readout of readouts) updateReadoutByName.set(readout.packageName, readout);
  }

  // Post-install "needs configuration" affordance (cinatra #1057): for each
  // installed AGENT whose REQUIRED connector dependencies are not yet
  // configured, probe each connector's own readiness (same probe the
  // /connectors card grid + setup badge read) and surface the unconfigured ones
  // on the agent's card — the greyed archived treatment + a needs-review strip.
  // Only agent-kind rows are considered (owner ruling #1057 (a)); a non-agent
  // never gates on configuration. User-scoped to the current viewer, so the
  // affordance reflects this operator's connection state. Best-effort: a
  // resolution failure degrades to no affordance, never blanking the list.
  const configurationNeedsByPackage = await resolveConfigurationNeedsForAgents(
    activeRows.flatMap((row) =>
      row.kind === "agent" && row.canonical
        ? [
            {
              packageName: row.packageName,
              kind: row.kind,
              dependencies: row.canonical.dependencies,
            },
          ]
        : [],
    ),
    { userId: session.user?.id ?? null },
  ).catch((err: unknown) => {
    console.warn(
      "[registry-catalog] could not resolve post-install configuration needs (affordance omitted):",
      err instanceof Error ? err.message : err,
    );
    return {} as Record<string, never>;
  });

  // Reconcile the bell flyout's `Set up connections for "<name>":` entries
  // (cinatra #1057 ruling (c)) from the SAME per-connector derivation that
  // drives the card strip above, so the bell and the card can never disagree:
  // one entry per gated agent, created on install-completion / when an agent
  // becomes gated, and DELETED the moment the agent becomes runnable. SKIPPED
  // when a search filter is active — a filtered active list is a partial view,
  // and reconciling it would wrongly clear entries for gated agents it hides.
  // Best-effort (the sync swallows + logs its own failures) so a notification
  // write never blanks the Extensions list.
  if (!query) {
    const gatedAgents = activeRows.flatMap((row) => {
      const needs = configurationNeedsByPackage[row.packageName]?.needs;
      if (!needs || needs.length === 0) return [];
      return [
        {
          agentPackageName: row.packageName,
          agentDisplayName: row.displayName,
          connectors: needs.map((need) => ({
            displayName: need.displayName,
            packageName: need.packageName,
            settingsHref: need.settingsHref,
          })),
        },
      ];
    });
    await syncAgentConfigurationNeedsNotifications({
      userId: session.user?.id ?? null,
      gatedAgents,
    });
  }

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
      // cinatra#1325 icon-chain tiers — the §VI installed-detail shell resolves
      // its emblem from the row's kind; the manifest-logo / client-icon-map
      // tiers are the marketplace-browse card's concern.
      manifestLogoUrl: null,
      iconSlug: null,
      iconUrl: null,
      vendorLogoUrl: null,
      // Storefront-owned like the assets above (#1003 added the publisher ref
      // to the card model): the §VI shell carries no vendor block; the modal
      // hydrates the vendor byline from the fetched detail on open.
      vendor: null,
      sdkAbiRange: null,
    };
    // §II modal-footer update flow (cinatra#1041 outcome 2): ONLY the
    // update-available state wires a footer — "Update now" dry-runs the
    // resolver, the admin confirms the rendered plan, and the apply rides the
    // planner/batch path (progress on this page's InstallBatchPanel). Every
    // other state keeps the details-only modal (no footer bar) — the update
    // runs ONLY from this footer; the card's actions stay exactly Settings +
    // More details.
    const { state, latestVersion } = updateInfoFor(row);
    const updatable = !isArchived && state === "update-available" && latestVersion != null;
    return (
      <MarketplaceDetailModal
        card={modalCard}
        // §VI actions panel: More details is a real <a> (never a button) — the
        // active row's underlined indigo `.btn.link`; the archived row's
        // muted, non-underlined `.btn.ghost`.
        linkTrigger={{
          variant: isArchived ? "ghost" : "link",
          href: modalCard.detailHref,
        }}
        // §V settings-row deep link: `?update=<pkg>` opens this row's modal on
        // mount (details-only when no update is available — graceful).
        defaultOpen={openUpdateFor === row.packageName}
        {...(updatable
          ? {
              cta: { state: "update" as const, disabled: false },
              updateAction: updateExtensionPackageFormAction.bind(null, {
                packageName: row.packageName,
                packageVersion: latestVersion,
              }),
              planUpdateAction: planExtensionUpdateFormAction.bind(null, {
                packageName: row.packageName,
                targetVersion: latestVersion,
              }),
            }
          : {})}
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

  // §III update affordance (cinatra#1041 outcome 3) → the card's spec-line
  // props. Derives the chip state from the cached read model and the newer
  // version's ABI compat, then maps it to the presentational bits:
  //   • update-available → the blue chip
  //   • incompatible     → greyed spec line (the §I ABI-compat treatment), no text
  //   • non-comparable / up-to-date / none (stale/missing, fail-quiet) → nothing
  // The chip is the ONLY update information the card carries (design §III;
  // owner direction 2026-07-12): the explanatory per-state wordings surface on
  // the §V settings page's Maintenance · Update row, never here.
  // Only ACTIVE rows carry it — an archived (fully greyed) card shows no chip.
  // The row's update verdict — ONE derivation feeding both the §III chip and
  // the §II modal-footer flow, so the two can never disagree (cinatra#1041).
  const updateInfoFor = (row: InstalledCardRow) => {
    const readout = updateReadoutByName.get(row.packageName) ?? null;
    const latestVersion = readout?.entry?.latestVersion ?? null;
    const state = deriveInstalledUpdateChipState({
      installedVersion: row.rawVersion,
      latestVersion,
      latestCompat: deriveExtensionCompatState(readout?.entry?.latestSdkAbiRange),
      stale: readout?.stale ?? true,
    });
    return { state, latestVersion };
  };

  const updateAffordanceFor = (row: InstalledCardRow, isArchived: boolean) => {
    if (isArchived) return {} as const;
    const { state } = updateInfoFor(row);
    switch (state) {
      case "update-available":
        return { updateChip: <UpdateAvailableChip /> } as const;
      case "incompatible":
        return { specLineMuted: true } as const;
      case "non-comparable":
      case "up-to-date":
      case "none":
      default:
        return {} as const;
    }
  };

  const renderCard = (row: InstalledCardRow, isArchived: boolean) => (
    <InstalledExtensionCard
      key={rowKey(row.kind, row.packageName)}
      name={row.displayName}
      accentColor={deriveExtensionAccent(row.packageName)}
      emblem={extensionKindEmblem(row.kind as ExtensionEmblemKind)}
      kindIcon={extensionKindEmblem(row.kind as ExtensionEmblemKind, "size-3.5")}
      kindLabel={KIND_LABEL[row.kind]}
      // §III byline (cinatra#1528): resolve the manifest/registry vendor name
      // (already free of any package scope) through the single resolver — an
      // absent name renders the explicit missing-vendor placeholder, never a
      // silently dropped "by" clause.
      vendor={resolveVendorPresentation(
        { name: row.vendor },
        { surface: "registry-catalog-screen", ref: row.packageName },
      )}
      description={row.description}
      version={row.versionLabel}
      status={renderStatus(row)}
      {...updateAffordanceFor(row, isArchived)}
      actions={renderCardActions(row, isArchived)}
      // Archived extensions render the fully-greyed §VI card (cinatra#957):
      // category ground → light grey, muted logo tile, all text/status/actions
      // muted. Active cards keep their category colour.
      archived={isArchived}
      // Post-install "needs configuration" (cinatra#1057): an active agent with
      // unconfigured required connectors wears the same greyed treatment + a
      // needs-review strip. Only active rows carry it — an archived card is
      // already greyed and unrunnable.
      configurationNeeds={
        isArchived ? undefined : configurationNeedsByPackage[row.packageName]?.needs
      }
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
