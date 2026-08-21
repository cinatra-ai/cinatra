import { Suspense } from "react";
import Link from "next/link";
import { requireAdminSession, buildCanDoOptsFromSession, isPlatformAdmin } from "@/lib/auth-session";
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
// cinatra#2698 (S4): the marketplace's install state is derived from the
// package's EFFECTIVE canonical row, not from a package-name template map that
// cannot tell a superseded organization row from the workspace row in force.
import { readInstalledExtensionsByPackageNames } from "../canonical-store";
import type { InstalledExtension } from "../canonical-types";
import { isInstallAccessTargetKind } from "../install-access-target";
import type { InstallAccessTargetKind } from "../install-access-target";
import { readExtensionAccessPolicies } from "../permissions-store";
import {
  findLiveWorkspaceRow,
  type WorkspaceReachAudience,
} from "../lifecycle-target-resolver";
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

/**
 * Overlay the EFFECTIVE-ROW install state onto the template-derived map
 * (cinatra#2698, change 3).
 *
 * For every catalog package that carries a LIVE workspace-anchored canonical
 * row, the entry becomes "installed at that row's version, not archived, with
 * the reach it was installed at". The reach comes from the row's persisted
 * audience token — the same token the install target wrote
 * (`accessTargetToInstallPolicy`): `admin` → "Workspace: Admins only",
 * anything else → "Workspace: All", which is also the fail-open-to-the-wider-
 * LABEL default for a legacy row with no policy (the label states reach; it
 * grants none).
 *
 * Kept module-local rather than split into a sibling helper: the marketplace
 * route graph is ratcheted flat, and this is one read the screen already has the
 * context for.
 */
async function applyWorkspaceInstallState(
  installedVersionByName: Map<
    string,
    { version: string; isArchived: boolean; workspaceReach?: WorkspaceReachAudience }
  >,
  cards: MarketplaceCardData[],
): Promise<void> {
  const names = [...new Set(cards.map((c) => c.packageName).filter(Boolean))];
  if (names.length === 0) return;
  let rowsByName: Map<string, InstalledExtension[]>;
  try {
    rowsByName = await readInstalledExtensionsByPackageNames(names);
  } catch {
    // The canonical read is a REFINEMENT of a map that already rendered before
    // this slice. A store failure leaves the template-derived state exactly as
    // it was rather than blanking the grid.
    return;
  }
  const liveWorkspaceRows: InstalledExtension[] = [];
  for (const rows of rowsByName.values()) {
    const row = findLiveWorkspaceRow(rows);
    if (row) liveWorkspaceRows.push(row);
  }
  if (liveWorkspaceRows.length === 0) return;

  // One policy read per KIND (the access rows are keyed {resource_kind,
  // resource_id}), so the whole grid costs at most one query per kind. Only the
  // install-access-target kinds are read: they are the ONLY kinds whose access
  // row is keyed by the canonical `installed_extension.id`, and the only kinds
  // whose install offers a workspace target at all (`accessTargetToRowOwnership`
  // — an agent/skill install can never produce a workspace anchor). A row of any
  // other kind keeps the wider label rather than being looked up under the wrong
  // resource key.
  const idsByKind = new Map<InstallAccessTargetKind, string[]>();
  for (const row of liveWorkspaceRows) {
    if (!isInstallAccessTargetKind(row.kind)) continue;
    const ids = idsByKind.get(row.kind) ?? [];
    ids.push(row.id);
    idsByKind.set(row.kind, ids);
  }
  const policyByRowId = new Map<string, { runListVisibility?: readonly string[] }>();
  for (const [kind, ids] of idsByKind) {
    try {
      const policies = await readExtensionAccessPolicies(kind, ids);
      for (const [id, policy] of policies) policyByRowId.set(id, policy);
    } catch {
      /* no policy read → the wider label, below */
    }
  }

  for (const row of liveWorkspaceRows) {
    const tokens = policyByRowId.get(row.id)?.runListVisibility ?? [];
    const reach: WorkspaceReachAudience = tokens.includes("admin") ? "admin" : "workspace";
    installedVersionByName.set(row.packageName, {
      // The row's own derived `version` column — the canonical installed
      // version for EVERY source type (a bundled row carries one too, so
      // reading it off a verdaccio source alone would leave a bundled
      // workspace install version-less and make its card read "Update now"
      // against any catalog version at all).
      version: row.version ?? "",
      isArchived: false,
      workspaceReach: reach,
    });
  }
}

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
  const installedVersionByName = new Map<
    string,
    { version: string; isArchived: boolean; workspaceReach?: WorkspaceReachAudience }
  >();
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
  // cinatra#2698 (S4, change 3) — THE EFFECTIVE ROW OVERRIDES THE MAP, and the
  // override is LAST so it wins over both loops above.
  //
  // The template-derived map is package-name-keyed and org-blind: it cannot tell
  // an organization's archived row from the app-wide workspace row that
  // superseded it, and its "archived wins" defense would show an organization
  // admin a RESTORE action for a package that is live for their whole workspace.
  // The canonical rows answer that question exactly: while a live workspace row
  // exists it IS the package's install state for every organization, and the
  // card states the reach it was installed at ("Installed (Workspace: All)" /
  // "Installed (Workspace: Admins only)") with no install action.
  await applyWorkspaceInstallState(installedVersionByName, cards);

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
    // cinatra#2698 (S4, change 3): only a platform admin can act on the app-wide
    // workspace row, so only they keep the ordinary CTA states for a
    // workspace-installed package. Every other administrator reads the reach off
    // the disabled pill and is offered nothing — which is exactly what the
    // server install boundary would refuse.
    viewerIsPlatformAdmin: isPlatformAdmin(session),
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
