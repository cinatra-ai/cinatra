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
// §II modal-footer dry-run (cinatra#1041) — screens-only server action.
import { planExtensionUpdateFormAction } from "./update-plan-action";
import {
  ExtensionsMarketplaceClient,
  MarketplaceGridLoadingFallback,
} from "./extensions-marketplace-client";
import { ExtensionInstallScopeDialog } from "./extension-install-scope-dialog";
import { isInstallAccessTargetKind } from "../install-access-target";
import { MarketplaceInstallForm, MarketplaceInstallSubmit } from "./marketplace-install-form";
import { MarketplaceDetailModal } from "./marketplace-detail-modal";
import {
  buildMarketplaceFailureCopy,
  marketplaceFailureCopy,
} from "./marketplace-failure-copy";
import type { MarketplaceCardData } from "./marketplace-card-model";
import { resolveMarketplaceCardCta } from "./marketplace-card-model";
import { MarketplaceListingCard } from "./marketplace-listing-card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { deriveExtensionAccent } from "@/lib/extension-accent";
import { deriveExtensionCompatState } from "@/lib/extension-compat-badge";
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
  // the connector/artifact/workflow Install CTA opens a dialog over these
  // rows. Default selection is the ORG row when installable — parity with the
  // per-kind default (workspace access) so the flow stays one-click.
  // -------------------------------------------------------------------------
  const { orgRole } = await buildCanDoOptsFromSession(session);
  const activeOrgId = session.session?.activeOrganizationId ?? "";
  const { installTargets, ownerEntityNames, defaultValue: pickerFallbackValue } =
    await buildInstallTargetPickerContext({ session, orgRole });
  const orgRow = installTargets.find(
    (t) => t.level === "organization" && !t.disabled,
  );
  const installScopeDefaultValue = orgRow ? orgRow.value : pickerFallbackValue;

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

  const renderedCards = cards.map((card) => {
    const installedInfo = installedVersionByName.get(card.packageName);
    // Six-state CTA resolved by the pure helper (semver-correct update
    // detection; Install/Update disabled when the registry is down; a
    // not-installed listing whose declared ABI this host cannot satisfy
    // resolves to the greyed "incompatible" state — never softer than the
    // install gate).
    const compatState = deriveExtensionCompatState(card.sdkAbiRange);
    const cta = resolveMarketplaceCardCta(card, installedInfo, registryConnected, compatState);

    // Per-row .bind() — install identifiers come straight from the catalog entry
    // ({packageName, packageVersion}); install resolves the typeId + tarball from
    // Verdaccio independent of the browse source (so Install Now actually installs).
    const installAction = installExtensionPackageFormAction.bind(null, {
      packageName: card.packageName,
      packageVersion: card.packageVersion,
    });
    const updateAction = updateExtensionPackageFormAction.bind(null, {
      packageName: card.packageName,
      packageVersion: card.packageVersion,
    });
    const restoreAction = restoreExtensionPackageFormAction.bind(null, {
      packageName: card.packageName,
    });
    // §II modal-footer dry-run (cinatra#1041): the footer's "Update now" plans
    // first (against THIS card's catalog version) and the admin confirms the
    // rendered Update plan before `updateAction` applies through the batch.
    const planUpdateAction = planExtensionUpdateFormAction.bind(null, {
      packageName: card.packageName,
      targetVersion: card.packageVersion,
    });

    const ctaControl =
      cta.state === "restore" ? (
        // Restore re-activates an already-installed (archived) template — DB-only.
        // A failure (DB/auth/state race) is surfaced as a toast, not a page crash (#356).
        // The category→copy map keeps the toast actionable + non-technical (#685);
        // restore rarely yields a marketplace category, so it usually lands on
        // the non-technical "unrecoverable"/default "try again" copy.
        <MarketplaceInstallForm
          action={restoreAction}
          failureCopyByCategory={buildMarketplaceFailureCopy("restore", card.displayName)}
          defaultFailureMessage={marketplaceFailureCopy("unrecoverable", "restore", card.displayName)}
        >
          <MarketplaceInstallSubmit variant="outline" pendingLabel="Restoring…">
            Restore
          </MarketplaceInstallSubmit>
        </MarketplaceInstallForm>
      ) : cta.state === "incompatible" ? (
        // The greyed six-state "Incompatible" CTA (spec §IV): the declared ABI
        // range of the CATALOG version is unsatisfiable on this host, so the
        // install/update gate would refuse it — grey the action out (opacity
        // .4, not-allowed cursor, spec title) instead of offering an action
        // that cannot succeed. The label names the blocked action (Install
        // now for a not-installed listing, Update now for an installed-older
        // one whose newer catalog version is incompatible). The
        // pointer-events override keeps the native title tooltip reachable on
        // a disabled button. The red-triangle Incompatible verdict renders as
        // the plain footer-meta row (CompatMeta in marketplace-listing-card.tsx —
        // spec §IV L631 is not a badge).
        <Button
          size="sm"
          disabled
          className="cursor-not-allowed disabled:pointer-events-auto disabled:opacity-40"
          title="Requires a newer Cinatra version"
        >
          {cta.blockedAction === "update" ? "Update now" : "Install now"}
        </Button>
      ) : cta.state === "install" ? (
        // Install fetches the tarball from the registry — a live CTA only
        // when the registry is connected; otherwise a disabled button so
        // we never present an Install that cannot actually install.
        cta.disabled ? (
          <Button size="sm" disabled title="Connect the package registry to install">
            Install now
          </Button>
        ) : isInstallAccessTargetKind(card.kindSlug) ? (
          // connector / artifact / workflow: pre-install access selector
          // (cinatra#805) — dialog over the shared server-computed
          // org/team/project rows; the chosen target is authorized
          // server-side and persisted via setExtensionInstallAccess.
          // Failure copy contract matches MarketplaceInstallForm (#685).
          <ExtensionInstallScopeDialog
            packageName={card.packageName}
            packageVersion={card.packageVersion}
            displayName={card.displayName}
            installTargets={installTargets}
            ownerEntityNames={ownerEntityNames}
            activeOrgId={activeOrgId}
            defaultValue={installScopeDefaultValue}
            failureCopyByCategory={buildMarketplaceFailureCopy("install", card.displayName)}
            defaultFailureMessage={marketplaceFailureCopy("unrecoverable", "install", card.displayName)}
            installAction={installExtensionPackageFormAction}
          />
        ) : (
          // A failed install toasts instead of crashing the route (#356). The
          // message is now classified per the merged install-failure taxonomy
          // (marketplace#152) into actionable, NON-technical end-user copy —
          // no "registry"/HTTP jargon, no asserting a usually-wrong cause (#685).
          <MarketplaceInstallForm
            action={installAction}
            failureCopyByCategory={buildMarketplaceFailureCopy("install", card.displayName)}
            defaultFailureMessage={marketplaceFailureCopy("unrecoverable", "install", card.displayName)}
          >
            <MarketplaceInstallSubmit pendingLabel="Installing…">
              Install now
            </MarketplaceInstallSubmit>
          </MarketplaceInstallForm>
        )
      ) : cta.state === "update" ? (
        cta.disabled ? (
          <Button size="sm" disabled title="Connect the package registry to update">
            Update now
          </Button>
        ) : (
          <MarketplaceInstallForm
            action={updateAction}
            failureCopyByCategory={buildMarketplaceFailureCopy("update", card.displayName)}
            defaultFailureMessage={marketplaceFailureCopy("unrecoverable", "update", card.displayName)}
          >
            <MarketplaceInstallSubmit pendingLabel="Updating…">
              Update now
            </MarketplaceInstallSubmit>
          </MarketplaceInstallForm>
        )
      ) : (
        // Installed — the disabled secondary pill at spec opacity .9.
        <Button size="sm" variant="secondary" disabled className="disabled:opacity-90">
          Installed
        </Button>
      );

    const node = (
      <MarketplaceListingCard
        card={card}
        accentColor={deriveExtensionAccent(card.packageName)}
        ctaControl={ctaControl}
        // Conformance contract (cinatra#985): expose the resolved six-state
        // CTA identity on the card's CTA slot (data-cta-state).
        ctaState={cta.state}
        detailsControl={
          // More details opens the in-app extension-detail modal (embedding
          // the marketplace listing detail) instead of navigating to the
          // full-page route; the trigger renders as the centred underlined
          // link button of spec §IV. The modal footer carries the same
          // six-state install CTA.
          <MarketplaceDetailModal
            card={card}
            cta={cta}
            installAction={installAction}
            updateAction={updateAction}
            restoreAction={restoreAction}
            planUpdateAction={planUpdateAction}
            // cinatra#1541: the modal footer's "Install now" for a connector /
            // artifact / workflow opens the SAME pre-install access-scope dialog
            // the card opens (cinatra#805), layered above the modal — plumbed
            // from the SAME server-computed, already-authorized picker context
            // (no broader lookup; AC2/AC3). Passed only for the access-target
            // kinds, mirroring the card's own isInstallAccessTargetKind branch.
            installScope={
              isInstallAccessTargetKind(card.kindSlug)
                ? {
                    installTargets,
                    ownerEntityNames,
                    activeOrgId,
                    defaultValue: installScopeDefaultValue,
                    failureCopyByCategory: buildMarketplaceFailureCopy("install", card.displayName),
                    defaultFailureMessage: marketplaceFailureCopy(
                      "unrecoverable",
                      "install",
                      card.displayName,
                    ),
                    installAction: installExtensionPackageFormAction,
                  }
                : undefined
            }
          />
        }
      />
    );

    return {
      meta: {
        packageName: card.packageName,
        title: card.displayName,
        description: card.description,
        kind: card.kindSlug,
      },
      node,
    };
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
        <Suspense fallback={<MarketplaceGridLoadingFallback />}>
          <ExtensionsMarketplaceClient cards={renderedCards} />
        </Suspense>
      </PageContent>
    </Main>
  );
}
