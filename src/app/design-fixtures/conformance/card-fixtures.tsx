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
import { MarketplaceListingCard } from "@cinatra-ai/extensions/screens/marketplace-listing-card";
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
      <MarketplaceInstallForm
        action={lifecycleAction}
        failureCopyByCategory={buildMarketplaceFailureCopy("install", card.displayName)}
        defaultFailureMessage={marketplaceFailureCopy("unrecoverable", "install", card.displayName)}
      >
        <MarketplaceInstallSubmit pendingLabel="Installing…">
          Install now
        </MarketplaceInstallSubmit>
      </MarketplaceInstallForm>
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

  return (
    <div
      // Harness instrumentation (documented in testid-contract.json):
      // data-surface-id keys the suite onto one fixture card;
      // data-installed-version exposes the resolver input so the
      // update → installed-latest outcome is assertable.
      data-surface-id={fixture.surfaceId}
      data-installed-version={installed?.version ?? ""}
      // `h-full` mirrors the live grid's item wrapper, so `auto-rows-fr` on the
      // grid below actually reaches the card's own `h-full` root.
      className="h-full"
    >
      <MarketplaceListingCard
        card={card}
        accentColor={deriveExtensionAccent(card.packageName)}
        ctaControl={ctaControl}
        ctaState={cta.state}
        detailsControl={
          // The §V detail modal is a separate conformance surface
          // (extension-detail-modal — see allowlist.json); the harness renders
          // the underlined trigger as an inert placeholder. It must carry the
          // LIVE trigger's exact classes (marketplace-detail-modal.tsx §IV
          // default) — the geometry suite measures this control, so a
          // placeholder of a different width would prove the wrong layout.
          <Button type="button" variant="link" size="sm" className="px-1 underline">
            More details
          </Button>
        }
      />
    </div>
  );
}

export function ConformanceCardFixtures() {
  return (
    // The grid mirrors the LIVE marketplace grid's column ramp exactly
    // (extensions-marketplace-client.tsx: 1 / sm:2 / lg:3 / xl:4) instead of
    // the wider 1/md:2/xl:3 it used to carry (cinatra#2363). The action-row
    // geometry contract is a function of card WIDTH, and the old ramp handed
    // every card ~a third of the body at xl — strictly roomier than anything
    // the real screen produces, so the tight case the contract is about was
    // never exercised here. Matching the real ramp makes this harness the
    // narrowest-card surface, which is what the geometry suite measures.
    <div className="grid auto-rows-fr grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {CONFORMANCE_CARD_FIXTURES.map((fixture) => (
        <ConformanceCard key={fixture.surfaceId} fixture={fixture} />
      ))}
    </div>
  );
}
