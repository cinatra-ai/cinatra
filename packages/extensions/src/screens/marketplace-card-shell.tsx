"use client";

// ---------------------------------------------------------------------------
// MarketplaceCardInstallShell (cinatra#2539) — the install-capable browse card.
//
// WHAT CHANGED AND WHY. The §I.1 in-card install panel (cinatra#2373) is a
// SECOND face of the card: the same header band with the picker in the body.
// Exactly one face is ever mounted, and the install face is mounted only after
// the viewer clicks Install now — so on a normal render nobody sees it.
//
// It was nevertheless composed on the SERVER and handed to the client switcher
// as a prop, which means React Server Components serialized the whole thing
// into the page payload for EVERY install-capable card, every render. Measured
// on an 88-card catalog: 218.6 KiB of a 742.7 KiB grid payload — 29% of the
// page spent on a face nobody had asked for yet.
//
// This shell moves that composition to the client. The server still renders the
// visible idle face (unchanged) and now sends the card's DATA alongside it; the
// install face is composed here, from the same components with the same props,
// at the moment the switcher opens it. The rendered DOM is identical — the
// drawing (design specs/app-extensions.html §I.1) is untouched.
//
// The card-invariant half of the panel's inputs (picker rows, entity names,
// active org, availability, the unbound install action) arrives through
// InstallPanelScopeProvider, mounted ONCE for the grid, instead of being
// repeated per card.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";

import type { ExtensionAccent } from "@/components/extension-card";

import { CardFaceSwitcher, InstallPanelCloseButton } from "./card-face-switcher";
import { ExtensionInstallScopePanel } from "./extension-install-scope-panel";
import type { MarketplaceCardData } from "./marketplace-card-model";
import { MarketplaceListingCardInstallFace } from "./marketplace-listing-card";

export type MarketplaceCardInstallShellProps = {
  /** The server-rendered idle face — the card the viewer actually sees. */
  idleFace: ReactNode;
  /** Card data the install face re-uses for its (identical) header band. */
  card: MarketplaceCardData;
  accentColor: ExtensionAccent;
};

export function MarketplaceCardInstallShell({
  idleFace,
  card,
  accentColor,
}: MarketplaceCardInstallShellProps) {
  return (
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
          />
        </MarketplaceListingCardInstallFace>
      }
    />
  );
}
