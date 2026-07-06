// ---------------------------------------------------------------------------
// connector-grid / connector-connection-filter conformance fixture
// (cinatra#986).
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
// ---------------------------------------------------------------------------

import {
  ConnectorsClient,
  type ConnectorCardData,
} from "@cinatra-ai/connectors/connectors-client";
import {
  resolveReadinessFailSoft,
  type ReadinessSnapshot,
} from "@cinatra-ai/connectors/readiness-fail-soft";

import { SEEDED_CONNECTOR_CARDS } from "../seed-data";

export async function ConnectorGridFixture() {
  const cards: ConnectorCardData[] = await Promise.all(
    SEEDED_CONNECTOR_CARDS.map(async (seed) => {
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

  return (
    <div data-surface-id="connector-grid">
      <ConnectorsClient
        cards={cards}
        scopeValue="workspace"
        scopes={{ orgs: [], projects: [], canGrantWorkspace: true }}
      />
    </div>
  );
}
