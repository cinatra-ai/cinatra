"use client";

// Model-A single-connection status card (design/specs/app-connectors.html §II,
// "One connection", right column). The presentational `ConnectionStatusCard`
// from `@cinatra-ai/sdk-ui` renders the chrome (surface panel, hairline, the
// "Connection status" heading over a divider, the status badge, and a full-width
// Check beneath it); this thin client wrapper owns the ONE piece of state the
// card cannot: the live probe transition.
//
// Seeding: the initial badge state comes from the host's
// `resolveConnectorBadgeState` — the SAME readiness signal the /connectors card
// grid reads — so the card opens on the connector's real connected/disconnected
// state, never a blank "unknown".
//
// Check flow (spec §II "connection status · Check flow"): pressing Check swaps
// the badge to the transient indigo "Checking…" (its icon spinning) while the
// declared status-probe action runs through the host action endpoint
// (`/api/extensions/{installId}/actions/{actionId}`), then resolves to
// Connected (probe ok) or Disconnected (probe threw / returned not-ok). The
// probe id is the connector's OWN declared `status-probe.actionId`
// ("connectionStatus" for the key-based connectors) — the host never invents it.
//
// This wrapper builds only the status card + Check. The canonical indigo-plug
// Connect / red-unplug Disconnect pair (design §II items 7/8/15/16, owner-ruled
// on for key-based connectors — epic #1101, 2026-07-10) lives in the LEFT-column
// form, rendered from the connector's own `role`-tagged named actions; this
// right-column card owns the connected/disconnected badge + Check only.

import { useCallback, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { ConnectionStatusCard } from "@cinatra-ai/sdk-ui/connection-status-card";
import type { ConnectionStatus } from "@cinatra-ai/sdk-ui/connection-status-badge";
import { Button } from "@/components/ui/button";

export type ConnectorStatusProbeCardProps = {
  /** Addressable install id for the host action endpoint. */
  installId: string;
  /**
   * The connector's declared `status-probe` action id (e.g. "connectionStatus").
   * When absent, the connector declares no probe, so the card shows the seeded
   * status with no Check control.
   */
  actionId?: string;
  /** Seeded connected state from `resolveConnectorBadgeState` (host readiness). */
  initialConnected: boolean;
  /** Optional richer label for the connected badge (e.g. a count) from the seed. */
  connectedLabel?: string;
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
}: ConnectorStatusProbeCardProps) {
  const [status, setStatus] = useState<ConnectionStatus>(
    initialConnected ? "connected" : "disconnected",
  );
  const [pending, setPending] = useState(false);

  const check = useCallback(async () => {
    if (!actionId) return;
    setPending(true);
    setStatus("checking");
    const ok = await invokeProbe(installId, actionId);
    setPending(false);
    setStatus(ok ? "connected" : "disconnected");
  }, [installId, actionId]);

  return (
    <ConnectionStatusCard
      data-testid="connector-status-probe-card"
      status={status}
      // Only the connected badge carries the seed's richer label; the transient
      // and disconnected states use the badge's own canonical labels.
      label={status === "connected" ? connectedLabel : undefined}
      action={
        actionId ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void check()}
            disabled={pending}
          >
            <RefreshCwIcon />
            Check
          </Button>
        ) : undefined
      }
    />
  );
}
