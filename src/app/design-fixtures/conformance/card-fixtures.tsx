"use client";

// ---------------------------------------------------------------------------
// Functional-acceptance harness for the extension-listing-card-* conformance
// surfaces (cinatra#985, design-conformance L2b).
//
// Renders the REAL MarketplaceListingCard through the REAL six-state CTA
// machinery — resolveMarketplaceCardCta (state resolver),
// deriveExtensionCompatState (ABI verdict), MarketplaceInstallForm /
// MarketplaceInstallSubmit (pending-aware form) — against deterministic
// fixture catalog entries (fixture-data.ts). No storefront round-trip, no
// registry, no DB: the ONLY substitution is the bound server action, replaced
// by a harness action that mutates the installed-state input and lets the
// real resolver re-derive the CTA. So "click Install → the card reaches the
// Installed state" exercises the same state machine + presentation the live
// /configuration/extensions screen renders; the server-side install effect is
// owned by the seeded-fixture gate (cinatra#986).
//
// Kept OFF the pixel-diffed /design-fixtures index page (same convention as
// the §V detail-modal fixture route): coverage here is assertion-based —
// tests/e2e/design/conformance/functional-acceptance.spec.ts.
// ---------------------------------------------------------------------------

// Deep module imports ON PURPOSE (established by the §V modal fixture): the
// screens barrel re-exports the registry-catalog SERVER screen
// (pacote/child_process reach), which a client component must never pull into
// the browser graph. These four modules are client-safe (pure model helpers +
// "use client" components).
import {
  MarketplaceListingCard,
  MarketplaceListingCardInstallFace,
} from "@cinatra-ai/extensions/screens/marketplace-listing-card";
import {
  CardFaceSwitcher,
  InstallPanelCloseButton,
  InstallPanelOpenButton,
} from "@cinatra-ai/extensions/screens/card-face-switcher";
import { ExtensionInstallScopePanel } from "@cinatra-ai/extensions/screens/extension-install-scope-panel";
import { resolveInstallPanelAvailability } from "@cinatra-ai/extensions/screens/install-panel-availability";
import { isInstallAccessTargetKind } from "@cinatra-ai/extensions/install-access-target";
import {
  MarketplaceInstallForm,
  MarketplaceInstallSubmit,
} from "@cinatra-ai/extensions/screens/marketplace-install-form";
import {
  resolveMarketplaceCardCta,
  type MarketplaceCardData,
} from "@cinatra-ai/extensions/screens/marketplace-card-model";
import {
  buildMarketplaceFailureCopy,
  marketplaceFailureCopy,
} from "@cinatra-ai/extensions/screens/marketplace-failure-copy";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { deriveExtensionCompatState } from "@/lib/extension-compat-badge";
import { deriveExtensionAccent } from "@/lib/extension-accent";
import {
  CONFORMANCE_CARD_FIXTURES,
  CONFORMANCE_INSTALL_PANEL_ACTIVE_ORG_ID,
  CONFORMANCE_INSTALL_PANEL_ENTITY_NAMES,
  CONFORMANCE_INSTALL_PANEL_FIXTURE,
  CONFORMANCE_INSTALL_PANEL_TARGETS,
  type ConformanceCardFixture,
} from "./fixture-data";

function toCardData(
  fixture: ConformanceCardFixture,
): MarketplaceCardData {
  return {
    packageName: fixture.packageName,
    packageVersion: fixture.packageVersion,
    displayName: fixture.displayName,
    description: fixture.description,
    kindSlug: fixture.kindSlug,
    kindLabel: fixture.kindLabel,
    badge: { text: "Free", variant: "free" },
    freshnessAt: null,
    rating: null,
    detailHref: `/configuration/marketplace/fixtures/${fixture.packageName.split("/")[1]}`,
    installCount: null,
    manifestLogoUrl: null,
    iconSlug: null,
    iconUrl: null,
    vendorLogoUrl: null,
    sdkAbiRange: fixture.sdkAbiRange,
    vendor: { name: "Cinatra Fixtures", storeUrl: null },
  };
}

function ConformanceCard({ fixture }: { fixture: ConformanceCardFixture }) {
  const card = toCardData(fixture);
  // The REAL installed-state input shape the live screen reads from
  // agent_templates — here harness state, mutated by the CTA action so the
  // REAL resolver re-derives the post-action state.
  const [installed, setInstalled] = useState(fixture.installed);
  const compatState = deriveExtensionCompatState(card.sdkAbiRange);
  const cta = resolveMarketplaceCardCta(card, installed ?? undefined, true, compatState);

  // Harness lifecycle action: the specified outcome of install/update/restore
  // is "the extension is installed (at the catalog version)" — mutate the
  // resolver input accordingly after the fixture latency. Success returns
  // undefined (no redirect in the harness), so the real form simply settles.
  const lifecycleAction = async () => {
    await new Promise((r) => setTimeout(r, fixture.ctaDelayMs));
    setInstalled({ version: card.packageVersion, isArchived: false });
  };

  // Mirror of the live screen's `usesInstallPanel` predicate — same three
  // inputs, same order (cinatra#2373).
  const usesInstallPanel =
    cta.state === "install" && !cta.disabled && isInstallAccessTargetKind(card.kindSlug);

  // The REAL availability resolver over SERVER-COMPUTED-shaped rows. The
  // platform-admin fixture resolves to `ready` with the `Workspace: All` row
  // as the default selection.
  const availability = resolveInstallPanelAvailability({
    activeOrgId: CONFORMANCE_INSTALL_PANEL_ACTIVE_ORG_ID,
    installTargets: CONFORMANCE_INSTALL_PANEL_TARGETS,
    fallbackDefaultValue: null,
  });

  // Harness scoped install action — the SAME argument shape the real unbound
  // action takes. It mutates the resolver input, so the REAL resolver
  // re-derives the post-install CTA and the face switcher's install face stops
  // being rendered exactly as the live redirect-and-re-render does.
  const scopedInstallAction = async () => {
    await new Promise((r) => setTimeout(r, fixture.ctaDelayMs));
    setInstalled({ version: card.packageVersion, isArchived: false });
  };

  // Mirror of the live screen's six-state ctaControl branches
  // (extensions-marketplace-screen.tsx), composed from the SAME primitives.
  const ctaControl =
    cta.state === "restore" ? (
      <MarketplaceInstallForm
        action={lifecycleAction}
        failureCopyByCategory={buildMarketplaceFailureCopy("restore", card.displayName)}
        defaultFailureMessage={marketplaceFailureCopy("unrecoverable", "restore", card.displayName)}
      >
        <MarketplaceInstallSubmit variant="outline" pendingLabel="Restoring…">
          Restore
        </MarketplaceInstallSubmit>
      </MarketplaceInstallForm>
    ) : cta.state === "incompatible" ? (
      <Button
        size="sm"
        disabled
        className="cursor-not-allowed disabled:pointer-events-auto disabled:opacity-40"
        title="Requires a newer Cinatra version"
      >
        {cta.blockedAction === "update" ? "Update now" : "Install now"}
      </Button>
    ) : cta.state === "install" ? (
      usesInstallPanel ? (
        // Mirrors the live screen's in-card panel branch (cinatra#2373): an
        // access-target kind's Install now swaps the card body, it does not
        // submit and it does not open a dialog.
        <InstallPanelOpenButton>Install now</InstallPanelOpenButton>
      ) : (
        <MarketplaceInstallForm
          action={lifecycleAction}
          failureCopyByCategory={buildMarketplaceFailureCopy("install", card.displayName)}
          defaultFailureMessage={marketplaceFailureCopy("unrecoverable", "install", card.displayName)}
        >
          <MarketplaceInstallSubmit pendingLabel="Installing…">
            Install now
          </MarketplaceInstallSubmit>
        </MarketplaceInstallForm>
      )
    ) : cta.state === "update" ? (
      <MarketplaceInstallForm
        action={lifecycleAction}
        failureCopyByCategory={buildMarketplaceFailureCopy("update", card.displayName)}
        defaultFailureMessage={marketplaceFailureCopy("unrecoverable", "update", card.displayName)}
      >
        <MarketplaceInstallSubmit pendingLabel="Updating…">
          Update now
        </MarketplaceInstallSubmit>
      </MarketplaceInstallForm>
    ) : (
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
      ctaState={cta.state}
      detailsControl={
        // The §V detail modal is a separate conformance surface
        // (extension-detail-modal — see allowlist.json); the harness renders
        // the underlined trigger as an inert placeholder.
        <Button type="button" variant="link" size="sm">
          More details
        </Button>
      }
    />
  );

  return (
    <div
      // Harness instrumentation (documented in testid-contract.json):
      // data-surface-id keys the suite onto one fixture card;
      // data-installed-version exposes the resolver input so the
      // update → installed-latest outcome is assertable.
      data-surface-id={fixture.surfaceId}
      data-installed-version={installed?.version ?? ""}
      className="h-full"
    >
      {usesInstallPanel ? (
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
                installTargets={CONFORMANCE_INSTALL_PANEL_TARGETS}
                ownerEntityNames={CONFORMANCE_INSTALL_PANEL_ENTITY_NAMES}
                activeOrgId={CONFORMANCE_INSTALL_PANEL_ACTIVE_ORG_ID}
                availability={availability}
                failureCopyByCategory={buildMarketplaceFailureCopy("install", card.displayName)}
                defaultFailureMessage={marketplaceFailureCopy(
                  "unrecoverable",
                  "install",
                  card.displayName,
                )}
                installAction={scopedInstallAction}
              />
            </MarketplaceListingCardInstallFace>
          }
        />
      ) : (
        idleFace
      )}
    </div>
  );
}

/**
 * The `extension-install-panel` conformance mount (cinatra#2373). One card in
 * its own surface root so the panel's four annotated actions are driven in
 * isolation from the six-state card grid above.
 */
export function ConformanceInstallPanelFixture() {
  return (
    <div className="max-w-[300px]">
      <ConformanceCard fixture={CONFORMANCE_INSTALL_PANEL_FIXTURE} />
    </div>
  );
}

export function ConformanceCardFixtures() {
  // 4-column tail (cinatra#2363 geometry proof): the prior md:2/xl:3 grid never
  // exercised the CARD-BODY-tight case the one-line CTA/details row contract
  // depends on (md ~172px, lg/xl ~207-208px with the expanded sidebar) — a
  // 3-up xl column is wide enough to always fit the pair, silently hiding a
  // wrap regression. lg:3/xl:4 keeps md 2-up (already tight) and tightens the
  // wider breakpoints too, so every state's CTA+details row is proven at the
  // real minimum width, not just the roomiest one.
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {CONFORMANCE_CARD_FIXTURES.map((fixture) => (
        <ConformanceCard key={fixture.surfaceId} fixture={fixture} />
      ))}
    </div>
  );
}
