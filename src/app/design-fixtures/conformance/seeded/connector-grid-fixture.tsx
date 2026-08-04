// ---------------------------------------------------------------------------
// connector-grid / connector-connection-filter / connector-install-cta /
// connector-empty-panel conformance fixture (cinatra#986; extended by
// cinatra#2355 for the 0.7.0 spec's empty-state matrix and install CTA).
//
// SERVER component mirroring the real /connectors composition: card data is
// resolved server-side — readiness through the REAL resolveReadinessFailSoft
// containment (cinatra#110) — and handed to the REAL ConnectorsClient. The
// seeded `probeThrows` card exercises the surface's documented error
// treatment: its probe THROWS and the fail-soft degrades that ONE card to
// "not connected" (never a 500), which the suite asserts as the
// connector-grid `error` state variant.
//
// The card `name` binds connector.displayName from the seed kit — the same
// manifest-displayName-over-slug precedence pages.tsx applies — with
// anti-lookalike seeds (displayName shares no token with the slug).
//
// EMPTY-STATE MATRIX (cinatra#2355, adopting design@3d33cc800
// specs/app-connectors.html version 0.7.0 §I). Both product panels key off the
// SERVER-resolved `cards`, so each matrix cell needs its own mount with its
// own card set — no client-side interaction can manufacture them:
//
//   data-variant="populated"           all 8 seeded cards, marketplace within
//                                      reach — the default All view, the
//                                      filter round-trip, and the closing CTA.
//   data-variant="empty-all"           zero cards, marketplace within reach →
//                                      the "No connectors to show" panel
//                                      carrying the SINGLE install CTA (the
//                                      bottom button suppressed beneath it).
//   data-variant="empty-all-no-access" zero cards, NO marketplace access →
//                                      the same panel with the buttonless copy
//                                      and no "+ Connector" in the toolbar.
//   data-variant="empty-connected"     disconnected-only cards → under
//                                      Connected the #1092 panel stands AND
//                                      the bottom CTA still renders (its
//                                      action is a different one).
//   data-variant="empty-disconnected"  connected-only cards → under
//                                      Disconnected there is no panel at all:
//                                      a bare list, the CTA remaining.
//
// The only substitutions are the seeded card source and the resolved
// marketplace-access fact; everything rendered is the REAL ConnectorsClient.
// ---------------------------------------------------------------------------

import {
  ConnectorsClient,
  type ConnectorCardData,
} from "@cinatra-ai/connectors/connectors-client";
import {
  resolveReadinessFailSoft,
  type ReadinessSnapshot,
} from "@cinatra-ai/connectors/readiness-fail-soft";

import { SEEDED_CONNECTOR_CARDS, type SeededConnectorCard } from "../seed-data";

/**
 * Resolve seeded card descriptors into `ConnectorCardData` through the REAL
 * fail-soft readiness containment (a `probeThrows` seed degrades to "not
 * connected" rather than throwing).
 */
async function resolveCards(seeds: SeededConnectorCard[]): Promise<ConnectorCardData[]> {
  return Promise.all(
    seeds.map(async (seed) => {
      const probe = (): ReadinessSnapshot => {
        if (seed.probeThrows) {
          throw new Error("design-conformance seeded probe failure (forced error state)");
        }
        return { connected: seed.connected, connectedLabel: seed.connectedLabel };
      };
      const readiness = await resolveReadinessFailSoft(
        seed.slug,
        probe,
        // Silence the containment log in the harness — the throw is seeded.
        () => {},
      );
      return {
        slug: seed.slug,
        name: seed.displayName,
        logo: null,
        connected: readiness.connected,
        connectedLabel: readiness.connectedLabel,
        href: `/design-fixtures/conformance/seeded#${seed.slug}`,
      };
    }),
  );
}

async function ConnectorGridMount({
  variant,
  seeds,
  canReachMarketplace,
}: {
  variant: string;
  seeds: SeededConnectorCard[];
  canReachMarketplace: boolean;
}) {
  const cards: ConnectorCardData[] = await resolveCards(seeds);
  return (
    <div data-surface-id="connector-grid" data-variant={variant}>
      <ConnectorsClient
        cards={cards}
        scopeValue={["workspace"]}
        scopes={{ orgs: [], projects: [], canGrantWorkspace: true }}
        canReachMarketplace={canReachMarketplace}
      />
    </div>
  );
}

export async function ConnectorGridFixture() {
  return (
    <div className="flex flex-col gap-10">
      {/* The populated default view: all 8 seeded cards under All, the actor
          standing in for one WITH marketplace access (so the toolbar's
          "+ Connector" and the closing "Install more connectors" CTA both
          render). This mount owns connector-grid `present`/`name`/`error`, the
          connector-connection-filter inventory + round-trip, and the
          connector-install-cta surface. */}
      <ConnectorGridMount
        variant="populated"
        seeds={SEEDED_CONNECTOR_CARDS}
        canReachMarketplace
      />

      {/* All + 0 · marketplace within reach. Zero cards is a REAL state for a
          real actor: cards are actor- AND scope-filtered server-side, so a
          workspace with connectors installed can still show none. This mount
          owns the connector-empty-panel surface (state:empty + its
          install-more action). */}
      <ConnectorGridMount variant="empty-all" seeds={[]} canReachMarketplace />

      {/* All + 0 · NO marketplace access. The same panel, its copy ending on
          "ask an administrator" instead of the install clause, no button in
          the panel, and no "+ Connector" in the toolbar — the paired gating of
          spec §I ("A control that leads nowhere is never shown."). */}
      <ConnectorGridMount
        variant="empty-all-no-access"
        seeds={[]}
        canReachMarketplace={false}
      />

      {/* Connected + 0. Disconnected-only cards, so the Connected segment has
          nothing to show while the grid itself is NOT empty — the case that
          separates the two panels. The bottom CTA is NOT suppressed here. */}
      <ConnectorGridMount
        variant="empty-connected"
        seeds={SEEDED_CONNECTOR_CARDS.filter((c) => !c.connected)}
        canReachMarketplace
      />

      {/* Disconnected + 0. Connected-only cards: under Disconnected there is
          no panel at all — the grid area is simply bare and the CTA remains. */}
      <ConnectorGridMount
        variant="empty-disconnected"
        seeds={SEEDED_CONNECTOR_CARDS.filter((c) => c.connected)}
        canReachMarketplace
      />
    </div>
  );
}
