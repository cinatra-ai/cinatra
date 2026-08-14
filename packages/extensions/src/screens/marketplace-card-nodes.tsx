// ---------------------------------------------------------------------------
// buildMarketplaceCardNodes — the per-card node composition of the §IV
// marketplace browse grid.
//
// Extracted verbatim from ExtensionsMarketplaceScreen (cinatra#2539, page-size
// half) so the composition that DOMINATES the route's RSC payload is a pure,
// dependency-injected function: the screen still owns the auth/DB reads and
// the page chrome, and this module owns the shape of what crosses the client
// boundary. Nothing about the rendered card changed in the move — the drawing
// (design specs/app-extensions.html §I/§IV) is untouched.
//
// The extraction exists so the payload weight is MEASURABLE without a booted
// instance: marketplace-payload-weight.test.ts renders this exact function and
// counts the bytes the grid ships.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { deriveExtensionAccent } from "@/lib/extension-accent";
import { deriveExtensionCompatState } from "@/lib/extension-compat-badge";
import type { InstallTarget } from "@cinatra-ai/agents/install-targets";

import { isInstallAccessTargetKind } from "../install-access-target";
import {
  CardFaceSwitcher,
  InstallPanelCloseButton,
  InstallPanelOpenButton,
} from "./card-face-switcher";
import { ExtensionInstallScopePanel } from "./extension-install-scope-panel";
import type { InstallPanelAvailability } from "./install-panel-availability";
import type { MarketplaceCardData } from "./marketplace-card-model";
import { resolveMarketplaceCardCta } from "./marketplace-card-model";
import { MarketplaceDetailModal } from "./marketplace-detail-modal";
import type { InstallTargetLevel } from "./install-picker-target";
import {
  buildMarketplaceFailureCopy,
  marketplaceFailureCopy,
} from "./marketplace-failure-copy";
import type { MarketplaceInstallActionResult } from "./marketplace-failure-copy";
import { MarketplaceInstallForm, MarketplaceInstallSubmit } from "./marketplace-install-form";
import {
  MarketplaceListingCard,
  MarketplaceListingCardInstallFace,
} from "./marketplace-listing-card";

/** Lightweight filter metadata the client grid keys its tab/search on. */
export type MarketplaceCardMeta = {
  packageName: string;
  title: string;
  description: string | null;
  kind: MarketplaceCardData["kindSlug"];
};

export type MarketplaceCardNode = { meta: MarketplaceCardMeta; node: ReactNode };

export type BuildMarketplaceCardNodesArgs = {
  cards: MarketplaceCardData[];
  /** packageName → installed version + archived flag (the install-state read model). */
  installedVersionByName: Map<string, { version: string; isArchived: boolean }>;
  registryConnected: boolean;
  /** SERVER-COMPUTED picker rows — card-invariant, shared by every panel. */
  installTargets: InstallTarget[];
  ownerEntityNames: Record<string, string>;
  activeOrgId: string;
  installPanelAvailability: InstallPanelAvailability;
  /** The three marketplace form actions (injected so this module stays pure). */
  installAction: (input: {
    packageName: string;
    packageVersion: string;
    accessTarget?: { level: InstallTargetLevel; id: string };
  }) => Promise<MarketplaceInstallActionResult | void>;
  updateAction: (input: {
    packageName: string;
    packageVersion: string;
  }) => Promise<MarketplaceInstallActionResult | void>;
  restoreAction: (input: {
    packageName: string;
  }) => Promise<MarketplaceInstallActionResult | void>;
};

export function buildMarketplaceCardNodes({
  cards,
  installedVersionByName,
  registryConnected,
  installTargets,
  ownerEntityNames,
  activeOrgId,
  installPanelAvailability,
  installAction: installFormAction,
  updateAction: updateFormAction,
  restoreAction: restoreFormAction,
}: BuildMarketplaceCardNodesArgs): MarketplaceCardNode[] {
  return cards.map((card) => {
    const installedInfo = installedVersionByName.get(card.packageName);
    // Six-state CTA resolved by the pure helper (semver-correct update
    // detection; Install/Update disabled when the registry is down; a
    // not-installed listing whose declared ABI this host cannot satisfy
    // resolves to the greyed "incompatible" state — never softer than the
    // install gate).
    const compatState = deriveExtensionCompatState(card.sdkAbiRange);
    const cta = resolveMarketplaceCardCta(card, installedInfo, registryConnected, compatState);

    // The in-card install panel (cinatra#2373) mounts for exactly the kinds
    // that HAVE an access target and only in the live "install" CTA state:
    // agents/skills have no audience to choose and keep their direct
    // zero-argument bound form, and update/restore/installed/incompatible are
    // untouched CTA states.
    const usesInstallPanel =
      cta.state === "install" && !cta.disabled && isInstallAccessTargetKind(card.kindSlug);

    // Per-row .bind() — install identifiers come straight from the catalog entry
    // ({packageName, packageVersion}); install resolves the typeId + tarball from
    // Verdaccio independent of the browse source (so Install Now actually installs).
    const installAction = installFormAction.bind(null, {
      packageName: card.packageName,
      packageVersion: card.packageVersion,
    });
    const updateAction = updateFormAction.bind(null, {
      packageName: card.packageName,
      packageVersion: card.packageVersion,
    });
    const restoreAction = restoreFormAction.bind(null, {
      packageName: card.packageName,
    });

    const ctaControl =
      cta.state === "restore" ? (
        // Restore re-activates an already-installed (archived) template. A failure
        // — a DB/auth/state race, or one of the stages that DO reach the registry
        // (kind resolve, runtime activate) — is surfaced as a toast, not a page
        // crash (#356). The category→copy map keeps the toast actionable +
        // non-technical (#685); the restore copy collapses the marketplace-shaped
        // categories to one administrator-escalation message and makes no retry
        // claim in either direction (#2333).
        <MarketplaceInstallForm
          action={restoreAction}
          failureCopyByCategory={buildMarketplaceFailureCopy("restore", card.displayName)}
          defaultFailureMessage={marketplaceFailureCopy(
            "unrecoverable",
            "restore",
            card.displayName,
          )}
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
        ) : usesInstallPanel ? (
          // connector / artifact / workflow: the pre-install access selector
          // (cinatra#805) now lives IN the card (cinatra#2373, spec §I.1) —
          // this CTA swaps the card body to the install face instead of
          // opening a dialog. The chosen AUDIENCE is authorized server-side
          // and persisted via setExtensionInstallAccess exactly as before.
          <InstallPanelOpenButton>Install now</InstallPanelOpenButton>
        ) : (
          // A failed install toasts instead of crashing the route (#356). The
          // message is now classified per the merged install-failure taxonomy
          // (marketplace#152) into actionable, NON-technical end-user copy —
          // no "registry"/HTTP jargon, no asserting a usually-wrong cause (#685).
          <MarketplaceInstallForm
            action={installAction}
            failureCopyByCategory={buildMarketplaceFailureCopy("install", card.displayName)}
            defaultFailureMessage={marketplaceFailureCopy(
              "unrecoverable",
              "install",
              card.displayName,
            )}
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
            defaultFailureMessage={marketplaceFailureCopy(
              "unrecoverable",
              "update",
              card.displayName,
            )}
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

    const accentColor = deriveExtensionAccent(card.packageName);

    const idleFace = (
      <MarketplaceListingCard
        card={card}
        accentColor={accentColor}
        ctaControl={ctaControl}
        // Conformance contract (cinatra#985): expose the resolved six-state
        // CTA identity on the card's CTA slot (data-cta-state).
        ctaState={cta.state}
        detailsControl={
          // More details opens the in-app extension-detail modal (embedding
          // the marketplace listing detail) instead of navigating to the
          // full-page route; the trigger renders as the centred underlined
          // link button of spec §IV. cinatra#2406 (owner ruling): the modal
          // renders no footer — details-only. Install/update/restore stay on
          // the card's own `ctaControl` above.
          <MarketplaceDetailModal card={card} />
        }
      />
    );

    // ONE opaque node per extension, exactly as the filter-only client grid
    // has always received. For an access-target install the node is the client
    // face switcher over TWO server-rendered faces; exactly one of them is
    // mounted at any time, so a hidden face can never retain a stale panel.
    const node = usesInstallPanel ? (
      <CardFaceSwitcher
        idleFace={idleFace}
        installFace={
          <MarketplaceListingCardInstallFace
            card={card}
            accentColor={accentColor}
            closeControl={<InstallPanelCloseButton />}
          >
            <ExtensionInstallScopePanel
              packageName={card.packageName}
              packageVersion={card.packageVersion}
              displayName={card.displayName}
              installTargets={installTargets}
              ownerEntityNames={ownerEntityNames}
              activeOrgId={activeOrgId}
              availability={installPanelAvailability}
              failureCopyByCategory={buildMarketplaceFailureCopy("install", card.displayName)}
              defaultFailureMessage={marketplaceFailureCopy(
                "unrecoverable",
                "install",
                card.displayName,
              )}
              // UNBOUND action — the identifiers travel as arguments, so the
              // one panel component serves every card.
              installAction={installFormAction}
            />
          </MarketplaceListingCardInstallFace>
        }
      />
    ) : (
      idleFace
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
}
