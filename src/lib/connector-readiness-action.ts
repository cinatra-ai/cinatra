"use server";

// The HOST's shipped readiness road, re-runnable from the connector setup
// page's Connection status card (design §II — "the Check action beneath it",
// cinatra#3214).
//
// A connector that declares its OWN `status-probe` action is checked by the
// card through the generic host action endpoint, with the connector's own
// declared action id — the host invents no probe id. A connector that declares
// none still HAS a readiness road when the host registers one:
// `resolveConnectorBadgeState`, the same registered probe that seeds this card
// and paints the connector's /connectors grid badge. Check re-runs THAT road
// here. Nothing is fabricated: the answer is the connector's own registered
// probe. A connector with NO registered probe is never handed this road at all
// (the page passes no `recheck`), so the card renders Check in the drawing's
// disabled treatment rather than running the registry's generic default.
//
// AUTHORIZATION: a server action is directly addressable by any authenticated
// caller with any packageId — binding it in the page does NOT make it
// package-bound. It therefore re-runs the dispatch route's own read gate for
// the requested connector before reading anything: the catalog policy gate for
// a catalog connector, and the trusted-runtime install record (which is itself
// proof of trust AND of actor authorization) for a runtime-only one. Any miss,
// and no actor at all, fail closed to "not connected" — never a disclosure of a
// connector this caller cannot view.

import { getActorContext } from "@/lib/auth-session";
import { enforceConnectorPolicy } from "@/lib/connector-policy";
import { resolveRuntimeConnectorCardRecord } from "@/lib/extension-install-resolution";
import {
  getConnectorRegistryEntryByPackageId,
  resolveConnectorBadgeState,
  type ConnectorReadiness,
} from "@/lib/connectors-registry.server";
// Side effect: registers the built-in readiness probes, so a re-check resolves
// the SAME probe the page render resolved.
import "@/lib/connector-readiness.server";

const NOT_CONNECTED: ConnectorReadiness = { connected: false };

export async function recheckConnectorReadiness(
  packageId: string,
): Promise<ConnectorReadiness> {
  const actor = await getActorContext();
  if (!actor) return NOT_CONNECTED;

  if (getConnectorRegistryEntryByPackageId(packageId)) {
    if (!enforceConnectorPolicy(packageId, actor, "read").allowed) {
      return NOT_CONNECTED;
    }
  } else {
    const record = await resolveRuntimeConnectorCardRecord(packageId, actor);
    if (!record) return NOT_CONNECTED;
  }

  const userId =
    actor.principalType === "HumanUser" ? actor.principalId : null;
  return resolveConnectorBadgeState(packageId, { userId });
}
