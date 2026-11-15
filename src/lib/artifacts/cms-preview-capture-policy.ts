/**
 * The registered-origin policy of the page capture (cinatra#2044 S6, sub-lane
 * L-B; since cinatra#3862 leg 8 only what the registered-page capture of
 * cinatra#4223 and the page render read).
 *
 *   - `normalizeOrigin` reduces an origin to one exact, comparable form, so a
 *     registered origin is matched EXACTLY (scheme + host + port, host compared
 *     case-insensitively and trailing-dot-normalized) and a userinfo prefix or
 *     a non-http(s) scheme is refused.
 *   - `CaptureTargetDenial` and `captureDenialCopy` name every way a target
 *     was refused. Stored capture records carry these reasons, so every member
 *     keeps its copy.
 *
 * The network-layer defences (scheme/credential/IP-range/DNS-rebind) are the
 * shared `@cinatra-ai/webhooks` egress guard, applied by the caller.
 *
 * PURE: no I/O, no server-only imports.
 */

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
