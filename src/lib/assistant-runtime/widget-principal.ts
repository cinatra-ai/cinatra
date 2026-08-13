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
// forgeable body field. `platformRole` is now PRESENT and SERVER-RESOLVED
// (cinatra#2674, epic #2564 S8e): the floor to `member` existed because the
// embedding site possessed the widget bearer, and S8e ends that possession. Like
// every other field here it is read server-side after the full dual-token
// sequence — the browser and the CMS have no channel to it.
// ---------------------------------------------------------------------------

export type WidgetPrincipal = {
  /** Discriminator — always this literal for the public-site widget path. */
  kind: "public_site_widget";
  /** The authenticated end user (cwu_ claim). */
  userId: string;
  /** The end user's org (cwu_ claim — never session-derived). */
  orgId: string;
  /**
   * THE `cwu_` ROW THIS TURN AUTHENTICATED AGAINST — its `jti` (cinatra#2687).
   *
   * It travels on the principal because the OBO token needs it: the token is
   * minted deep inside the runtime, from this object and nothing else, and it
   * seals this value as `pjti` so the MCP authorization layer can ask whether
   * that row's Better Auth sign-in is still there (#2684's shared predicate).
   * The chat resume token seals the same value at the route.
   *
   * It is a NAME, not a credential: it recovers nothing on its own and the
   * widget token itself never travels here. #2685 kept it off the principal
   * precisely because the principal travels into the OBO token and the carrier
   * run — which is now the reason it belongs on it.
   */
  parentTokenJti: string;
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
  /**
   * Did the `cwu_` this principal was built from carry the `lifecycle.read`
   * grant (cinatra#2577, epic #2564 S8d)? Read off the SAME consume that built
   * the rest of this principal — never a second, later observation of the token,
   * so the grant cannot disagree with the identity it travels with.
   *
   * REQUIRED, deliberately: an omitted flag would default to "no grant", which
   * is the safe direction but a SILENT one. Making it explicit means a new
   * construction site has to answer the question rather than inherit an answer.
   * It rides the widget OBO token's `lcr` claim to the MCP boundary, where the
   * read-only lifecycle primitives read it as their grant.
   */
  lifecycleRead: boolean;
  /**
   * The end user's REAL platform tier, resolved server-side from the user record
   * (cinatra#2674, epic #2564 S8e). It used to be deliberately ABSENT — floored
   * to "member" at mint — because the embedding site possessed the widget
   * bearer; S8e ends that possession, so the real tier travels. `member` for
   * almost everyone and for every uncertain case — an unreadable role resolves
   * narrow, never elevated. REQUIRED for the same reason `lifecycleRead` is: a
   * new construction site must answer the question rather than inherit it.
   */
  platformRole: "platform_admin" | "member";
};
