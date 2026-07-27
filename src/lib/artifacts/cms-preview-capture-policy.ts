/**
 * The PURE capture-target policy for the pinned fetched-render pipeline
 * (cinatra#2044 S6, sub-lane L-B).
 *
 * This leaf is the SSRF boundary. The capture step fetches an adapter-supplied
 * authenticated preview page server-side, so the one question that decides
 * whether the pipeline is safe is: *where may that fetch go?* The answer
 * enforced here is deliberately narrow and has no escape hatch:
 *
 *   1. The ORIGIN is never taken from connector-supplied input. It is one of the
 *      org's CONNECT-REGISTERED site origins (`connect_sites.widget_origin`,
 *      established by the operator-driven connect handshake). Connector input
 *      can only SELECT among origins the org already registered — it can never
 *      introduce one.
 *   2. The connector's `sourceUrl` is used ONLY as a selector: its origin must
 *      match a registered origin EXACTLY (scheme + host + port, host compared
 *      case-insensitively and trailing-dot-normalized). It contributes NOTHING
 *      to the URL that is fetched — no path, no query, no fragment, no
 *      userinfo.
 *   3. The PATH is a compile-time constant (the plugin's preview route) with a
 *      single interpolated segment: a post id validated as a positive decimal
 *      integer inside the signed 32-bit range. Nothing else can be appended:
 *      a non-numeric id is rejected, so no traversal, no query smuggling.
 *   4. Every failure FAILS CLOSED with a named reason. There is no "best guess"
 *      arm — an unparsable/absent source url does NOT fall back to "the org's
 *      only registered site", because a connector that could omit the selector
 *      would then choose the target by omission.
 *
 * The network-layer defences (scheme/credential/IP-range/DNS-rebind) are the
 * shared `@cinatra-ai/webhooks` egress guard, applied by the caller to the URL
 * this leaf returns; this module is the ADDRESSING policy that runs first.
 *
 * PURE: no I/O, no server-only imports — the whole allow/deny matrix is
 * unit-provable.
 */

/** The WordPress plugin's authenticated preview route (wordpress-plugin#94).
 * Constant — never assembled from adapter input. */
export const CMS_PREVIEW_PATH_PREFIX = "/wp-json/cinatra/v1/preview/";

/** The Drupal module's authenticated preview route (drupal-module, cinatra#2046).
 * Constant — never assembled from adapter input. */
export const CMS_PREVIEW_PATH_PREFIX_DRUPAL = "/cinatra/preview/";

/**
 * The per-CMS preview ADAPTERS, keyed by the connect client kind.
 *
 * A site whose client kind is not a key here is refused with a named reason
 * rather than probed — the map IS the closed set of "platforms that ship an
 * authenticated preview". Each entry contributes exactly ONE thing to the
 * fetched URL: a COMPILE-TIME path prefix. Nothing adapter-supplied reaches it.
 *
 * The two adapters deliberately share the `preview.<id>` canonical signed
 * content, because both recompute it from the id in the REQUESTED PATH with the
 * same Standard-Webhooks primitive; keeping one signing convention means the
 * host has a single signer for every CMS instead of a per-CMS special case.
 */
const PREVIEW_ADAPTERS: ReadonlyMap<
  string,
  { readonly pathPrefix: string; readonly maxResourceId: number }
> = new Map([
  // WordPress ids are bounded here exactly as the merged L-B policy bounded
  // them — unchanged, so no already-capturable post becomes uncapturable.
  ["wordpress", { pathPrefix: CMS_PREVIEW_PATH_PREFIX, maxResourceId: 2147483647 }],
  // Drupal's `nid` base field is an UNSIGNED integer on its MySQL/MariaDB
  // schema, so a live site can legitimately carry a node id above 2^31-1; a
  // signed-32-bit bound would refuse to capture it. (Raised by a convergence
  // round.) The value is still a hard, closed bound on the ONE interpolated
  // path segment.
  ["drupal", { pathPrefix: CMS_PREVIEW_PATH_PREFIX_DRUPAL, maxResourceId: 4294967295 }],
]);

/** The widest resource id ANY adapter may address. `parsePostId` enforces this
 * ceiling; `resolveCaptureTarget` then applies the matched adapter's own
 * (possibly narrower) bound. */
const MAX_POST_ID = 4294967295;

/** One connect-registered site an org may be captured against. */
export interface RegisteredCaptureSite {
  /** The opaque connect site id (audit/correlation). */
  readonly siteId: string;
  /** The connect client kind (`wordpress` / `drupal`). */
  readonly client: string;
  /** The registered origin (`connect_sites.widget_origin`). */
  readonly origin: string;
}

/** Why a capture target was refused. Every arm is a CLOSED, named denial the
 * caller records as the gate's degraded reason — never a silent skip. */
export type CaptureTargetDenial =
  /** The org has no active connect-registered site at all. */
  | "no-registered-site"
  /** The staged write's source url is absent or not a parsable http(s) url. */
  | "unusable-source-url"
  /** The source url's origin matches no registered site for this org. */
  | "origin-not-registered"
  /** The connector's external id is not a positive in-range decimal post id. */
  | "invalid-post-id"
  /** More than one ACTIVE registered site shares the selected origin, so the
   * platform (and therefore the preview route and credential) is ambiguous. */
  | "ambiguous-origin-registration"
  /** The matched site's client kind has no preview adapter. */
  | "client-has-no-preview-adapter";

export type CaptureTargetResolution =
  | {
      readonly ok: true;
      readonly siteId: string;
      /** The matched site's connect client kind (`wordpress` / `drupal`). The
       * caller resolves the PREVIEW CREDENTIAL per client: each CMS is
       * provisioned under its own connector's webhook binding at connect time,
       * so the secret cannot be looked up without knowing which one this is. */
      readonly client: string;
      /** The REGISTERED origin the fetch is pinned to. */
      readonly origin: string;
      readonly postId: number;
      /** The exact absolute url to fetch — origin + constant path + post id. */
      readonly url: string;
      /** The canonical content the host signs (the plugin recomputes it). */
      readonly signedContent: string;
    }
  | { readonly ok: false; readonly reason: CaptureTargetDenial };

/**
 * Normalize an origin for EXACT comparison: lowercase scheme + host, explicit
 * port preserved only when non-default, trailing dot on the host removed.
 * Returns null for anything that is not a well-formed http(s) origin, or that
 * carries userinfo (a userinfo prefix can smuggle a different authority past
 * a naive prefix compare).
 */
export function normalizeOrigin(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") return null;
  const isDefaultPort =
    parsed.port === "" ||
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443");
  return `${parsed.protocol}//${host}${isDefaultPort ? "" : `:${parsed.port}`}`;
}

/**
 * Validate the adapter's external id as an addressable post id.
 *
 * TWO accepted forms, both closed and strictly decimal (no sign, no whitespace,
 * no exponent, no leading `+`), 1..2^32-1 (the matched adapter then applies its
 * own, possibly narrower, ceiling):
 *
 *   `<id>`                 — a bare post id.
 *   `<instanceId>:<id>`    — the connector's SITE-SCOPED composition
 *                            (`cmsExternalId(instanceId, cmsResourceId)`), which
 *                            is what a real staged CMS write actually carries on
 *                            its pointer. Only the segment after the LAST colon
 *                            is read, and it must satisfy the same strict decimal
 *                            grammar; the instance segment contributes nothing to
 *                            the fetched URL.
 *
 * ANYTHING else is refused (`null`) — including an empty instance segment, a
 * trailing colon, or a non-decimal tail. There is no lenient extraction: the
 * whole string must match one of the two grammars.
 *
 * THE INSTANCE SEGMENT IS NOT AN ADDRESSING INPUT, and is deliberately NOT
 * cross-checked against the selected origin: this leaf is handed registered
 * ORIGINS, not the org's connector-instance→site mapping, so it has nothing
 * truthful to compare it with, and inventing a comparison would be a guess. The
 * addressing authority is unchanged and complete without it — the ORIGIN comes
 * from `sourceUrl` matching a connect-registered origin exactly, and the URL is
 * built from the REGISTERED origin. A pointer whose instance segment named a
 * different site than its url therefore resolves by its url, exactly as a bare
 * id would; the connector builds both halves of the pointer from one instance,
 * so the two cannot disagree at the source. (Raised by a codex convergence round;
 * recorded as an accepted, non-SSRF residual rather than papered over.)
 */
export function parsePostId(externalId: string | null | undefined): number | null {
  if (typeof externalId !== "string") return null;
  const match = /^(?:[^:\s]+:)?([0-9]{1,10})$/.exec(externalId);
  if (!match) return null;
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_POST_ID) return null;
  return id;
}

/**
 * Resolve the ONE url the capture step may fetch, or a named denial.
 *
 * @param registeredSites The org's ACTIVE connect-registered sites (host-read,
 *   never connector-supplied).
 * @param sourceUrl The staged write's correlation url — a SELECTOR only.
 * @param externalId The connector's external id for the staged post.
 */
export function resolveCaptureTarget(input: {
  readonly registeredSites: readonly RegisteredCaptureSite[];
  readonly sourceUrl: string | null | undefined;
  readonly externalId: string | null | undefined;
}): CaptureTargetResolution {
  const sites = input.registeredSites.filter((s) => normalizeOrigin(s.origin) !== null);
  if (sites.length === 0) return { ok: false, reason: "no-registered-site" };

  const selector =
    typeof input.sourceUrl === "string" ? normalizeOrigin(input.sourceUrl) : null;
  if (selector === null) return { ok: false, reason: "unusable-source-url" };

  // EXACTLY ONE match, or refuse. The connect-site uniqueness index is
  // (org, client, origin), so ONE origin may be registered under TWO client
  // kinds; picking the first match would let a Drupal pointer resolve a
  // WordPress row and be fetched with a WordPress route and a WordPress
  // credential. There is nothing truthful to disambiguate with at this leaf
  // (it is handed origins, not the org's connector-instance mapping), so the
  // ambiguity is a NAMED denial rather than a guess. (Raised by a convergence
  // round.)
  const matches = sites.filter((s) => normalizeOrigin(s.origin) === selector);
  if (matches.length === 0) return { ok: false, reason: "origin-not-registered" };
  const distinctClients = new Set(matches.map((s) => s.client));
  if (distinctClients.size > 1) {
    return { ok: false, reason: "ambiguous-origin-registration" };
  }
  const match = matches[0]!;
  const adapter = PREVIEW_ADAPTERS.get(match.client);
  if (!adapter) {
    return { ok: false, reason: "client-has-no-preview-adapter" };
  }

  const postId = parsePostId(input.externalId);
  if (postId === null || postId > adapter.maxResourceId) {
    return { ok: false, reason: "invalid-post-id" };
  }

  // The registered origin — NOT the selector string — is what the url is built
  // from, so nothing of the adapter's url survives into the request. The path
  // is the matched CLIENT's compile-time constant, so a WordPress route can
  // never be requested from a Drupal origin (or the reverse).
  const origin = normalizeOrigin(match.origin) as string;
  return {
    ok: true,
    siteId: match.siteId,
    client: match.client,
    origin,
    postId,
    url: `${origin}${adapter.pathPrefix}${postId}`,
    signedContent: `preview.${postId}`,
  };
}

/** Human-readable copy for a denial — surfaced as the gate's degraded reason so
 * the reviewer is told what is missing rather than shown a silent gap. */
export function captureDenialCopy(reason: CaptureTargetDenial): string {
  switch (reason) {
    case "no-registered-site":
      return "no connected site is registered for this organization";
    case "unusable-source-url":
      return "the staged write carried no usable source URL to identify the site";
    case "origin-not-registered":
      return "the staged write's site is not a connect-registered site for this organization";
    case "invalid-post-id":
      return "the staged write carried no addressable post id";
    case "client-has-no-preview-adapter":
      return "the connected site's platform does not supply an authenticated preview";
    case "ambiguous-origin-registration":
      return "more than one connected site is registered at that address, so the platform to capture from is ambiguous";
  }
}
