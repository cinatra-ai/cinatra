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
  /**
   * Why the preview is missing, as a connector-reported code (cinatra#2534).
   * `null` when a preview exists, or when the provider does not report one.
   *
   * A null preview has several distinct causes (unresolved tailnet, no
   * sanctioned dev identity, conflicting identity signals) and only the first
   * is fixed by reconnecting the connector — so the surface must not guess.
   * The `dev-tunnel-status` capability contract exposes no getter for the code,
   * and rather than widen that contract this reads an OPTIONAL getter off the
   * same provider: a capability impl is `unknown` by contract and already
   * structurally probed, so an impl that grows the getter is picked up with no
   * host change, and one that never does degrades to `null` (which the surface
   * renders as an explicitly cause-agnostic notice).
   *
   * The tailscale connector reports it since its #65 (pinned here from
   * 9061f2c3): `getFunnelUrlPreviewReason` returns the identity code it had
   * previously only logged. It still returns `null` for the unresolved-tailnet
   * cause, which has no minted code — that one keeps the cause-agnostic copy.
   */
  funnelUrlPreviewReason: string | null;
};

/** The optional reason getter — see `funnelUrlPreviewReason` above. */
type DevTunnelReasonReader = {
  getFunnelUrlPreviewReason?: () => unknown;
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

/**
 * Read the optional reason getter. Absent, non-callable, throwing, or
 * returning anything but a non-empty string → `null` (no reason reported).
 * A reason is advisory copy selection; it must never break the status read.
 */
function readPreviewReason(impl: DevTunnelStatusProvider): string | null {
  try {
    // The property READ is inside the try too: an impl may expose the reason
    // through a getter (or a Proxy trap) that throws, and that must not escape
    // into the caller's catch — which would turn a healthy connected status
    // into "not connected" over a purely advisory read.
    const reader = (impl as DevTunnelStatusProvider & DevTunnelReasonReader)
      .getFunnelUrlPreviewReason;
    if (typeof reader !== "function") return null;
    const value = reader.call(impl);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** The dev-tunnel status for the development/tunnel surface (degrades, never throws). */
export function getDevTunnelStatus(): DevTunnelStatus {
  const match = resolveCapabilityProviders(DEV_TUNNEL_STATUS_CAPABILITY).find((p) =>
    isDevTunnelStatusProvider(p.impl),
  );
  if (!match) {
    return { connected: false, funnelUrlPreview: null, funnelUrlPreviewReason: null };
  }
  const impl = match.impl;
  try {
    const funnelUrlPreview = impl.getFunnelUrlPreview();
    return {
      connected: impl.getConnectionStatus().connected === true,
      funnelUrlPreview,
      funnelUrlPreviewReason: funnelUrlPreview ? null : readPreviewReason(impl),
    };
  } catch (err) {
    console.warn(
      `[dev-tunnel-status] ${match.packageName} status read failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return { connected: false, funnelUrlPreview: null, funnelUrlPreviewReason: null };
  }
}
