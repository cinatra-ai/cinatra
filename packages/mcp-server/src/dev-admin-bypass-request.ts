/**
 * The ONE request-level composition of the development admin bypass.
 *
 * Both consumers — the MCP transport (`/api/mcp`) and the `/api/cli/*` route
 * guard — call `grantDevAdminBypassForRequest` and nothing else. The policy
 * itself is the pure function in `./dev-admin-bypass`; this module is the only
 * place that gathers its inputs, so the two surfaces can never drift into two
 * different trust boundaries.
 *
 * What it gathers, and from where:
 *   - the connecting socket's peer address, from `./local-connection` (the
 *     runtime's connection info — not a header, not the URL authority);
 *   - whether ANY forwarded header was present AT INGRESS, which refuses
 *     outright. Read from the same connection snapshot, NEVER from the route
 *     handler's `Request` headers: the development server synthesises the
 *     forwarded chain on the way in, so a route-level presence check would
 *     refuse every request there is, the local operator's included;
 *   - the per-boot local credential this process minted, from
 *     `./dev-local-token`, and the one the caller presented in the header.
 */

import {
  DEV_LOCAL_TOKEN_HEADER,
  isTrustedDevPeer,
  shouldGrantDevAdminBypass,
  type HeaderReader,
} from "./dev-admin-bypass";
import { expectedDevLocalToken } from "./dev-local-token";
import { getLocalConnectionInfo } from "./local-connection";

/**
 * True when the in-flight request is the local operator on this machine:
 * a loopback socket peer, no forwarded header, and the per-boot credential.
 */
export function isTrustedDevPeerRequest(headers: HeaderReader): boolean {
  // ONE snapshot, taken at ingress. When there is none — the boot hook did not
  // run, or the request did not arrive over a Node HTTP server — both network
  // facts are the fail-closed answer: an unknown peer, and an assumed hop.
  const connection = getLocalConnectionInfo();
  return isTrustedDevPeer({
    nodeEnv: process.env.NODE_ENV,
    envBypassFlag: process.env.CINATRA_MCP_DEV_ADMIN_BYPASS,
    peerAddress: connection?.remoteAddress ?? null,
    forwardedHeaderPresent: connection ? connection.forwardedHeaderPresent : true,
    // The credential is the one thing the caller is MEANT to send, so it — and
    // only it — is read from the request's own headers.
    presentedToken: headers.get(DEV_LOCAL_TOKEN_HEADER),
    expectedToken: expectedDevLocalToken(),
  });
}

/**
 * The bypass decision for a request: grant platform_admin, or not. This is the
 * single entry point every consumer uses.
 */
export function grantDevAdminBypassForRequest(headers: HeaderReader): boolean {
  return shouldGrantDevAdminBypass({
    nodeEnv: process.env.NODE_ENV,
    envBypassFlag: process.env.CINATRA_MCP_DEV_ADMIN_BYPASS,
    isTrustedDevPeer: isTrustedDevPeerRequest(headers),
  });
}

/**
 * One-time operator notice when the opt-in flag is on but this process minted
 * no credential — the bypass is enabled and will refuse every request until the
 * boot hook runs. Silent in production and when the flag is off.
 */
let devBypassReadinessNoticeEmitted = false;
export function emitDevAdminBypassReadinessNoticeOnce(): void {
  if (devBypassReadinessNoticeEmitted) return;
  devBypassReadinessNoticeEmitted = true;
  if (process.env.NODE_ENV === "production") return;
  if (process.env.CINATRA_MCP_DEV_ADMIN_BYPASS !== "true") return;
  if (expectedDevLocalToken()) return;
  console.warn(
    "[mcp-dev-admin-bypass] enabled, but no per-boot local credential was minted in this process — every request will be REFUSED. The credential is minted at boot and written 0600 into the instance data directory (CINATRA_DATA_DIR, else .cinatra/); a local client presents it in the " +
      DEV_LOCAL_TOKEN_HEADER +
      " header.",
  );
}
