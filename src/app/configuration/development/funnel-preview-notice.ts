// Message selection for the tunnel field's Tailscale flyout when NO Funnel URL
// preview is available (cinatra#2534).
//
// The flyout used to render ONE hardcoded sentence for every null preview:
//
//   "TAILSCALE: tailnet not resolved yet — reconnect the Tailscale connector
//    to refresh."
//
// That sentence is true for exactly one of the reasons a preview can be
// missing. The connector returns `null` for several (see its
// `getTailscaleFunnelUrlPreview`): an unresolved tailnet, an instance with no
// sanctioned dev identity, or conflicting identity signals. On a plain local
// install the real cause is the identity one — and reconnecting the connector
// cannot change it, so the operator was sent down a dead end while an
// externally reachable URL (often a Funnel already running on the host) was
// one paste away.
//
// This module is the pure selection seam: reason code in, rendered copy out.
// It is deliberately separate from the form so every branch is unit-testable
// without a Tailscale install.
//
// ---------------------------------------------------------------------------
// Reason plumbing — what is live today
// ---------------------------------------------------------------------------
// The connector had always COMPUTED the precise reason and only console.warn()d
// it. The `dev-tunnel-status` capability CONTRACT still declares only
// `getConnectionStatus()` / `getFunnelUrlPreview()`; rather than widen it, the
// host reads an OPTIONAL reason getter off the same provider impl (see
// @/lib/dev-tunnel-status). The tailscale connector's registered impl carries
// that getter since its #65, pinned here from 9061f2c3, so the identity
// branches below are LIVE on a real instance (proven end to end in
// evidence/2534-pin).
//
// The "unknown" branch is not dead: the connector reports no code for the
// unresolved-tailnet cause (none is minted), and a provider that never grows
// the getter degrades to `null`. That branch asserts no cause it cannot know
// and recommends no remediation that may not apply.

/** Reason codes the connector defines (its published constants). */
export const FUNNEL_PREVIEW_UNREGISTERED_IDENTITY = "tailscale.unregistered_dev_identity";
export const FUNNEL_PREVIEW_IDENTITY_CONFLICT = "tailscale.conflicting_dev_identity";
/**
 * The no-tailnet case. The connector returns `null` for it without a code
 * today; this is the code it should report, and the ONLY case in which
 * "reconnect the connector" is sound advice.
 */
export const FUNNEL_PREVIEW_NO_TAILNET = "tailscale.no_tailnet";

export type FunnelPreviewNoticeState =
  | "unregistered-identity"
  | "identity-conflict"
  | "no-tailnet"
  | "unknown";

export type FunnelPreviewNotice = {
  /** Stable id — also rendered as a data attribute so a UI test can assert it. */
  state: FunnelPreviewNoticeState;
  /** The sentence shown in the flyout. */
  message: string;
  /**
   * Whether reconnecting the Tailscale connector can actually change the
   * outcome. False for every identity case — the old copy told every operator
   * to reconnect regardless.
   */
  reconnectHelps: boolean;
};

// Shared tail: the field accepts any valid origin, so pasting works TODAY —
// including the URL of a Funnel the operator already runs on this host, which
// the auto-derived picker never offers.
const PASTE_HINT =
  "Paste an externally reachable HTTPS URL below — for example a Funnel you already run on this host.";

/**
 * Pick the flyout copy for a missing Funnel URL preview.
 *
 * Returns `null` when a preview EXISTS — the caller renders the pickable
 * option instead, and this seam has nothing to say.
 */
export function selectFunnelPreviewNotice(input: {
  funnelUrlPreview: string | null;
  /** Connector-reported reason code, or `null` when none was reported. */
  reason: string | null;
}): FunnelPreviewNotice | null {
  if (input.funnelUrlPreview) return null;

  switch (input.reason) {
    case FUNNEL_PREVIEW_NO_TAILNET:
      return {
        state: "no-tailnet",
        reconnectHelps: true,
        message:
          "Tailnet not resolved yet — reconnect the Tailscale connector to refresh.",
      };
    case FUNNEL_PREVIEW_UNREGISTERED_IDENTITY:
      return {
        state: "unregistered-identity",
        reconnectHelps: false,
        message:
          "This instance has no sanctioned Tailscale identity, so no Funnel URL " +
          `is derived for it. Reconnecting the connector will not change that. ${PASTE_HINT} ` +
          "To get an auto-derived URL instead, run this instance as a clone or a worktree.",
      };
    case FUNNEL_PREVIEW_IDENTITY_CONFLICT:
      return {
        state: "identity-conflict",
        reconnectHelps: false,
        message:
          "This instance sets conflicting Tailscale identity signals, so no Funnel " +
          `URL is derived for it. Reconnecting the connector will not change that. ${PASTE_HINT} ` +
          "To get an auto-derived URL instead, declare exactly one of clone, worktree or main.",
      };
    default:
      return {
        state: "unknown",
        reconnectHelps: false,
        message:
          "No Funnel URL is available for this instance. The tailnet may not be " +
          "resolved yet, or this instance may have no sanctioned Tailscale identity — " +
          `reconnecting the connector does not help in the second case. ${PASTE_HINT}`,
      };
  }
}
