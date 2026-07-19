// ---------------------------------------------------------------------------
// The widget principal — the net-new S5 construct threaded through the assistant
// runtime for the public-site (WordPress/Drupal) widget path.
//
// The `/api/assistants/chat` broker-auth branch builds this ONLY after the full
// ported dual-token fail-closed sequence succeeds (cit_ origin consume + cwu_
// user consume + two-token origin agreement + canonical origin re-pin + live
// membership + body-instance agreement + handle↔token binding). It is the
// SINGLE server-verified source of the pinned instance + the connector kind +
// the `public_site_widget` discriminator that ride the widget OBO token
// (`src/lib/widget-mcp-actor-token.ts`) across the MCP boundary so BOTH hops are
// driven by server-verified values, never model/route-forgeable ones.
//
// It is `null` on the cookie-session (non-widget) path — the built-in `@cinatra`
// assistant with the existing chat token is byte-unchanged when this is absent.
//
// AUTH INVARIANT: instance binding is preserved EXACTLY; `instanceId` here is
// the SERVER-DERIVED canonical row (the verified-origin re-pin), never a
// forgeable body field. `platformRole` is DELIBERATELY ABSENT — a widget user
// is floored to `member` at the OBO token mint, never elevated at the boundary.
// ---------------------------------------------------------------------------

export type WidgetPrincipal = {
  /** Discriminator — always this literal for the public-site widget path. */
  kind: "public_site_widget";
  /** The authenticated end user (cwu_ claim). */
  userId: string;
  /** The end user's org (cwu_ claim — never session-derived). */
  orgId: string;
  /** SERVER-DERIVED canonical instance id (the verifiedOrigin re-pin). */
  instanceId: string;
  /** The cit_-derived server-verified origin — authoritative; carried for audit. */
  verifiedOrigin: string;
  /**
   * The assistant handle == the cit_ agent_slug host-mapping == `body.assistant`.
   * Enforced equal at the route (fail-closed) — a wordpress cit_ can't drive
   * `assistant:"drupal"` (G9). Also the connector KIND minted into the OBO
   * token's `knd` claim.
   */
  assistantHandle: "wordpress" | "drupal";
  /** The instances-config key ("wordpress" | "drupal") from the cit_ entry auth. */
  instancesConfigKey: string;
  // NOTE: platformRole is deliberately ABSENT — floored to "member" at mint.
};
