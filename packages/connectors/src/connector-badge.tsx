"use client";

import { PlugZap, Unplug } from "lucide-react";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Shared connection-status badge (#682 card grid + the connector setup-page header)
// ---------------------------------------------------------------------------
//
// The SINGLE source of truth for the connector connection-status badge. Both
// the `/connectors` card grid (`connectors-client.tsx`) and the host-injected
// setup-page header badge (the dispatch route `page.tsx`) render THIS
// component, so the card badge and the setup-page badge stay byte-identical
// (visual parity is structural, not copy-paste).
//
// Connection state is shown as a state-coloured BACKGROUND badge (#682), built
// from the design-system `Badge` (variant tokens, contrast-checked: the
// `bg-success/10 text-success` / `bg-destructive/10 text-destructive` treatment
// is the same one used across the app), wrapping the #605 plug icon:
//   connected    → green-background badge: "connected plug" (PlugZap) in the
//                  design success / sea-green token, keeping the connector's
//                  `connectedLabel` count alongside it when one is provided.
//   disconnected → red-background badge: "unplug" (Unplug) in the failed / red
//                  token.
export function ConnectorBadge({ connected, label }: { connected: boolean; label?: string }) {
  if (connected) {
    return (
      <Badge
        variant="success"
        className="font-semibold"
        aria-label={label ? `Connected (${label})` : "Connected"}
      >
        <PlugZap data-icon="inline-start" aria-hidden="true" />
        {label ? <span aria-hidden="true">{label}</span> : null}
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" aria-label="Not connected">
      <Unplug data-icon="inline-start" aria-hidden="true" />
    </Badge>
  );
}
