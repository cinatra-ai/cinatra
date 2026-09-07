"use client";

// The single-connection status card (design §II, "One connection", right
// column). The presentational `ConnectionStatusCard` from `@cinatra-ai/sdk-ui`
// renders the chrome (surface panel, hairline, the "Connection status" heading
// over a divider, the status badge, and a full-width Check beneath it); this
// thin client wrapper owns the ONE piece of state the card cannot: the live
// probe transition.
//
// Seeding: the initial badge state comes from the host's
// `resolveConnectorBadgeState` — the SAME readiness signal the /connectors card
// grid reads — so the card opens on the connector's real connected/disconnected
// state, never a blank "unknown".
//
// Check flow (spec §II "connection status · Check flow"): pressing Check swaps
// the badge to the transient indigo "Checking…" (its icon spinning) while the
// check runs, then resolves to Connected or Disconnected. There are two roads,
// and the card NEVER invents one:
//   1. the connector's OWN declared `status-probe.actionId` ("connectionStatus"
//      for the key-based connectors), POSTed to the host action endpoint
//      (`/api/extensions/{installId}/actions/{actionId}`);
//   2. for a connector that declares no probe (cinatra#3214), the HOST's own
//      shipped readiness road — the `recheck` callback the page binds to the
//      same `resolveConnectorBadgeState` signal that seeded this card and that
//      paints the connector's /connectors card badge.
// With neither road the Check control still renders — the drawing carries it on
// every setup page — but in the drawing's disabled treatment (greyed,
// non-interactive, `aria-disabled`), the same vocabulary §II uses for a
// Disconnect with nothing to disconnect. A control that cannot answer says so;
// it never pretends to run a probe that does not exist.
//
// This wrapper builds only the status card + Check. The canonical indigo-plug
// Connect / red-unplug Disconnect pair (design §II items 7/8/15/16) lives in the
// LEFT-column form, rendered from the connector's own `role`-tagged named
// actions; this right-column card owns the connected/disconnected badge + Check
// only.

import { useCallback, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { ConnectionStatusCard } from "@cinatra-ai/sdk-ui/connection-status-card";
import type { ConnectionStatus } from "@cinatra-ai/sdk-ui/connection-status-badge";
import { Button } from "@/components/ui/button";

/** The host readiness answer — the shape `resolveConnectorBadgeState` returns. */
export type ConnectorReadinessReading = {
  connected: boolean;
  connectedLabel?: string;
};

export type ConnectorStatusProbeCardProps = {
  /** Addressable install id for the host action endpoint. */
  installId: string;
  /**
   * The connector's declared `status-probe` action id (e.g. "connectionStatus").
   * When absent, the connector declares no probe of its own and Check falls back
   * to the host `recheck` road below.
   */
  actionId?: string;
  /** Seeded connected state from `resolveConnectorBadgeState` (host readiness). */
  initialConnected: boolean;
  /** Optional richer label for the connected badge (e.g. a count) from the seed. */
  connectedLabel?: string;
  /**
   * The HOST's shipped readiness road, bound to this connector by the page (a
   * server action over `resolveConnectorBadgeState`). Used by Check only when
   * the connector declares no `status-probe` of its own. Absent → Check renders
   * disabled rather than dead.
   */
  recheck?: () => Promise<ConnectorReadinessReading>;
};

async function invokeProbe(installId: string, actionId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `/api/extensions/${encodeURIComponent(installId)}/actions/${encodeURIComponent(actionId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export function ConnectorStatusProbeCard({
  installId,
  actionId,
  initialConnected,
  connectedLabel,
  recheck,
}: ConnectorStatusProbeCardProps) {
  const [status, setStatus] = useState<ConnectionStatus>(
    initialConnected ? "connected" : "disconnected",
  );
  // The connected badge's richer label (e.g. a count) follows the reading: a
  // host re-check that returns a new count must not leave the seeded one behind.
  const [label, setLabel] = useState<string | undefined>(connectedLabel);
  const [pending, setPending] = useState(false);

  // No road at all -> the control renders in the drawing's disabled treatment.
  // This state IS reachable from the product: the setup page threads `recheck`
  // only for a connector the host actually registers a readiness probe for
  // (cinatra#3214 convergence), so a connector with neither a declared
  // `status-probe` nor a registered host probe gets the disabled Check rather
  // than one that could only ever repeat the registry's generic default.
  const checkable = Boolean(actionId) || Boolean(recheck);

  const check = useCallback(async () => {
    if (!checkable) return;
    setPending(true);
    setStatus("checking");
    if (actionId) {
      const ok = await invokeProbe(installId, actionId);
      setPending(false);
      setStatus(ok ? "connected" : "disconnected");
      return;
    }
    // Host readiness road. Fail-soft, exactly like the seed:
    // a throwing/absent readiness read resolves "not connected", never an error.
    try {
      const reading = await recheck!();
      setStatus(reading.connected ? "connected" : "disconnected");
      setLabel(reading.connectedLabel);
    } catch {
      setStatus("disconnected");
    } finally {
      setPending(false);
    }
  }, [checkable, installId, actionId, recheck]);

  return (
    <ConnectionStatusCard
      data-testid="connector-status-probe-card"
      status={status}
      // Only the connected badge carries the seed's richer label; the transient
      // and disconnected states use the badge's own canonical labels.
      label={status === "connected" ? label : undefined}
      action={
        <Button
          type="button"
          variant="outline"
          onClick={() => void check()}
          disabled={pending || !checkable}
          aria-disabled={pending || !checkable}
        >
          <RefreshCwIcon />
          Check
        </Button>
      }
    />
  );
}
