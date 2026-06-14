import "server-only";

// Host-side resolution of the `dev-tunnel-status` capability (the
// lazy/guarded host-access cutover: the development/tunnel page no longer
// value-imports `@cinatra-ai/tailscale-connector` — the connector registers
// its local status reads as a capability provider at activation and the page
// resolves them at request time).
//
// Degraded mode: provider absent (connector not installed/active) or a read
// throwing → `{ connected: false, funnelUrlPreview: null }`, which the page
// already renders as its "connect Tailscale" state.

import type { DevTunnelStatusProvider } from "@cinatra-ai/sdk-extensions";
import { DEV_TUNNEL_STATUS_CAPABILITY } from "@cinatra-ai/sdk-extensions/internal";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

export type DevTunnelStatus = {
  connected: boolean;
  funnelUrlPreview: string | null;
};

// Structural guard: a capability impl is `unknown` by contract.
function isDevTunnelStatusProvider(impl: unknown): impl is DevTunnelStatusProvider {
  if (typeof impl !== "object" || impl === null) return false;
  const candidate = impl as { getConnectionStatus?: unknown; getFunnelUrlPreview?: unknown };
  return (
    typeof candidate.getConnectionStatus === "function" &&
    typeof candidate.getFunnelUrlPreview === "function"
  );
}

/** The dev-tunnel status for the development/tunnel surface (degrades, never throws). */
export function getDevTunnelStatus(): DevTunnelStatus {
  const match = resolveCapabilityProviders(DEV_TUNNEL_STATUS_CAPABILITY).find((p) =>
    isDevTunnelStatusProvider(p.impl),
  );
  if (!match) return { connected: false, funnelUrlPreview: null };
  const impl = match.impl as DevTunnelStatusProvider;
  try {
    return {
      connected: impl.getConnectionStatus().connected === true,
      funnelUrlPreview: impl.getFunnelUrlPreview(),
    };
  } catch (err) {
    console.warn(
      `[dev-tunnel-status] ${match.packageName} status read failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return { connected: false, funnelUrlPreview: null };
  }
}
