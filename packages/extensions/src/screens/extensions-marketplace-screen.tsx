import { Suspense } from "react";
import Link from "next/link";
import { requireAdminSession, buildCanDoOptsFromSession } from "@/lib/auth-session";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { getEffectiveViewerScope } from "@/lib/marketplace-credentials";
import {
  readActiveExtensionTemplates,
  readArchivedExtensionTemplates,
} from "@cinatra-ai/agents";
// Server-side install-scope picker rows — the SAME shared builder the agent
// registry detail screen uses (single source of truth for enabled/disabled
// state per org/team/project target row).
import { buildInstallTargetPickerContext } from "@cinatra-ai/agents/install-target-picker";
import {
  installExtensionPackageFormAction,
  updateExtensionPackageFormAction,
  restoreExtensionPackageFormAction,
} from "../actions";
import {
  ExtensionsMarketplaceClient,
  MarketplaceGridLoadingFallback,
} from "./extensions-marketplace-client";
import { InstallPanelScopeProvider } from "./extension-install-scope-panel";
import { resolveInstallPanelAvailability } from "./install-panel-availability";
// Per-card node composition (cinatra#2539) — the grid's RSC payload shape.
import { buildMarketplaceCardNodes } from "./marketplace-card-nodes";
import type { MarketplaceCardData } from "./marketplace-card-model";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { readRegistryPolicy } from "../registry-policy";

// ---------------------------------------------------------------------------
// ExtensionsMarketplaceScreen — storefront browse parity
//
// Renders cards sourced from the marketplace `extension_list` ability
// (storefront catalog) as the design spec §IV ListingCard
// (MarketplaceListingCard): banner (icon tile + name), description +
// "{Type} by {Vendor}" publisher line, centred price row, the six-state
// Install now / Installed / Update now / Restore / Installing… / Incompatible
// CTA, the underlined "More details" link, and the two-column footer meta
// (rating + installs LEFT, compat + freshness RIGHT). Install-state still
// resolves against agent_templates keyed by packageName; the ABI verdict
// (deriveExtensionCompatState) feeds the CTA resolver so an incompatible
// listing greys out instead of offering an install the gate would refuse.
// ---------------------------------------------------------------------------

export async function ExtensionsMarketplaceScreen({
  cards,
  registryConnected,
}: {
  cards: MarketplaceCardData[];
  registryConnected: boolean;
}) {
  // Admin-only — no public catalog exposure.
  const session = await requireAdminSession();

  // -------------------------------------------------------------------------
  // Pre-install access selector context (cinatra#805). Server-computed picker
  // rows (org / team / project) shared with the agent install-scope dialog;
  // the connector/artifact/workflow Install CTA swaps the card body to the
  // in-card install panel over these rows (cinatra#2373 — no popup).
  //
  // TWO DIMENSIONS: the rows' enabled/disabled state is installer AUTHORITY
  // (who may install at a target — the server's `assertCanInstallAtTarget` is
  // the boundary; these rows are its UX shadow). The row a viewer PICKS is the
  // AUDIENCE (who may then use the extension). The default below widens the
  // AUDIENCE to `Workspace: All`; it grants no authority the server would not
  // already have granted, because a row the viewer cannot install at stays
  // server-disabled and unselectable.
  // -------------------------------------------------------------------------
  const { orgRole } = await buildCanDoOptsFromSession(session);
  const activeOrgId = session.session?.activeOrganizationId ?? "";
  const { installTargets, ownerEntityNames, defaultValue: pickerFallbackValue } =
    // cinatra#1527: the extension picker ALWAYS offers the two workspace scopes
    // ("Workspace: All" / "Workspace: Admins only" — cinatra#2372 audience
    // relabel), platform-admin-only to install.
    await buildInstallTargetPickerContext({
      session,
      orgRole,
      includeWorkspaceScopes: true,
    });
  // Marketplace-local availability + default (cinatra#2373). The SHARED
  // `pickDefaultPickerValue` the agent registry uses is untouched — it is only
  // consulted here as the fallback when `Workspace: All` is not offered.
  // The panel reads its own default off `availability` (state "ready" carries
  // `defaultValue`); nothing else needs it separately since the detail modal
  // stopped taking an install action at all (cinatra#2406 — the owner-ratified
  // footer removal deleted the modal's `installScope` prop, the only other
  // consumer this value ever had).
  const installPanelAvailability = resolveInstallPanelAvailability({
    activeOrgId,
    installTargets,
    fallbackDefaultValue: pickerFallbackValue,
  });

  // Registry temp-policy declaration (config-driven; default off → no banner).
  // When configured, warn operators that this registry's private packages are
  // provisional and may be deleted without notice.
  const registryPolicy = readRegistryPolicy();

  // Install-state read model: agent_templates, keyed by
  // packageName, with effective status reconciled against the canonical
  // installed_extension lifecycle inside readActive/ArchivedExtensionTemplates.
  // Kind-agnostic (all five kinds). vendorScope guards private-package visibility.
  const identity = readInstanceIdentity();
  const vendorScope = getEffectiveViewerScope(identity);
  const [activeTemplates, archivedTemplates] = await Promise.all([
    readActiveExtensionTemplates(vendorScope),
    readArchivedExtensionTemplates(vendorScope),
  ]);
  const installedVersionByName = new Map<string, { version: string; isArchived: boolean }>();
  for (const t of activeTemplates) {
    if (t.packageName && t.packageVersion) {
      installedVersionByName.set(t.packageName, { version: t.packageVersion, isArchived: false });
    }
  }
  // Archived entries inserted AFTER active so archived wins as defense in depth.
  for (const t of archivedTemplates) {
    if (t.packageName && t.packageVersion) {
      installedVersionByName.set(t.packageName, { version: t.packageVersion, isArchived: true });
    }
  }

  // Per-card node composition (cinatra#2539): extracted verbatim into
  // ./marketplace-card-nodes so the grid's RSC payload shape is a pure,
  // measurable function. The screen keeps the auth/DB reads and the chrome.
  const renderedCards = buildMarketplaceCardNodes({
    cards,
    installedVersionByName,
    registryConnected,
    installAction: installExtensionPackageFormAction,
    updateAction: updateExtensionPackageFormAction,
    restoreAction: restoreExtensionPackageFormAction,
  });


  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Marketplace"
        description="Browse and install extensions from the storefront."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {registryPolicy.temporary && (
          <Alert variant="warning">
            <AlertTitle>Temporary registry policy</AlertTitle>
            <AlertDescription>{registryPolicy.notice}</AlertDescription>
          </Alert>
        )}
        {!registryConnected && (
          <Alert variant="info">
            <AlertTitle>Installing requires the package registry</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3">
              <span>
                Browsing the marketplace catalog works without any setup — these listings come
                straight from the storefront. Installing an extension is what needs the package
                registry connected. Connect it in registry settings to enable Install.
              </span>
              {/* Root-relative link → resolves to this instance's own origin (never a hardcoded
                  host); points at the registries tab on /configuration/environment. */}
              <Button asChild size="sm" variant="outline">
                <Link href="/configuration/environment?tab=registries">Registry settings</Link>
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {/* The card-invariant install context travels ONCE for the whole grid
            (cinatra#2539) instead of once per install-capable card. The
            provider renders no DOM — the picker rows, their enabled state and
            their tooltips are the SAME server-computed values as before. */}
        <InstallPanelScopeProvider
          value={{
            installTargets,
            ownerEntityNames,
            activeOrgId,
            availability: installPanelAvailability,
            // UNBOUND action — the identifiers travel as arguments, so the one
            // panel component serves every card.
            installAction: installExtensionPackageFormAction,
          }}
        >
          <Suspense fallback={<MarketplaceGridLoadingFallback />}>
            <ExtensionsMarketplaceClient cards={renderedCards} />
          </Suspense>
        </InstallPanelScopeProvider>
      </PageContent>
    </Main>
  );
}
