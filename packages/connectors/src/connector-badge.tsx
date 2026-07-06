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
// Connection state is shown as a SOLID state-coloured chip (cinatra#1014,
// design system §VII "Connectors"), built from the design-system `Badge`
// `success` / `destructive` variants with a SOLID override: `bg-success` /
// `bg-destructive` (replacing the variant's default soft `/10` tint) plus the
// matching white `-foreground` text/icon token — via `className`, so the
// shared `ui/badge.tsx` primitive (vendored verbatim into five extension
// repos — drupal-assistant-connector, tailscale-connector,
// wordpress-mcp-connector, drupal-mcp-connector, wordpress-assistant-connector
// — see scripts/extensions/vendor-extension-primitives.mjs) is untouched.
// `dark:bg-success` / `dark:bg-destructive` explicitly override the variant's
// own `dark:bg-success/20` soft tint (tailwind-merge drops the conflicting
// class; the `--success`/`--destructive` CSS custom properties themselves
// already resolve to the correct light/dark shade, so no other dark:
// override is needed), wrapping the #605 plug icon:
//   connected    → filled green chip: "connected plug" (PlugZap, white) in the
//                  design success token, keeping the connector's
//                  `connectedLabel` count alongside it when one is provided.
//   disconnected → filled red chip: "unplug" (Unplug, white) in the
//                  destructive token.
// (#1014 replaces the prior soft-tint treatment on THIS badge only.)
export function ConnectorBadge({ connected, label }: { connected: boolean; label?: string }) {
  if (connected) {
    return (
      <Badge
        variant="success"
        data-testid="connector-badge"
        data-connected=""
        className="bg-success text-success-foreground dark:bg-success font-semibold"
        aria-label={label ? `Connected (${label})` : "Connected"}
      >
        <PlugZap data-icon="inline-start" aria-hidden="true" />
        {label ? <span aria-hidden="true">{label}</span> : null}
      </Badge>
    );
  }
  return (
    <Badge
      variant="destructive"
      data-testid="connector-badge"
      className="bg-destructive text-destructive-foreground dark:bg-destructive"
      aria-label="Not connected"
    >
      <Unplug data-icon="inline-start" aria-hidden="true" />
    </Badge>
  );
}
