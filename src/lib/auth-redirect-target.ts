/**
 * Shared helpers for preserving the caller's intended destination across an
 * auth redirect (cinatra#2359).
 *
 * Before this fix, every gated surface (`requireAuthSession()`, the
 * `/artifacts` and agent-review pages, the extension action guard, the
 * dashboard screens) bounced an unauthenticated/expired visitor to a bare
 * `/sign-in` with no memory of where they were headed, and the sign-in page
 * itself hard-redirected to `/` on success. The fix threads a `next` query
 * param through both ends:
 *
 *   1. `src/proxy.ts` / `guardAppRoute` (the app-wide route guard) appends
 *      `?next=<path>` when it 307s a cookie-less request to `/sign-in`, and
 *      forwards the current path to Server Components via
 *      `CURRENT_PATH_HEADER` for the belt-and-suspenders case where the
 *      cookie is present but the session itself has expired/is invalid.
 *   2. `requireAuthSession()` (and the ad hoc gates listed above) read that
 *      forwarded header and build the same `?next=` redirect.
 *   3. `PermissionsAuthPage` (packages/permissions/src/pages.tsx) reads
 *      `next` from its own search params and honors it post-auth instead of
 *      the hardcoded `/`.
 *
 * SECURITY (non-negotiable): `next` must be validated as a same-origin
 * RELATIVE path before it is ever echoed back into a redirect Location or a
 * `redirectTo` prop — otherwise it is a classic open-redirect. Rejected:
 *   - absolute URLs with a scheme (`https://evil.com`, `javascript:...`)
 *   - protocol-relative paths (`//evil.com` — browsers resolve a leading
 *     `//` as "same scheme, different host")
 *   - the backslash trick (`/\evil.com`, `\\evil.com`) — browsers normalize
 *     a leading backslash to a forward slash, so `/\evil.com` is treated
 *     identically to `//evil.com` by the address bar / fetch resolution.
 * Anything that fails validation falls back to `/` — never left un-sanitized,
 * never dropped as a thrown error (a hostile `next` must degrade safely, not
 * crash the auth gate).
 */

const SIGN_IN_PATH = "/sign-in";
const SIGN_UP_PATH = "/sign-up";
// cinatra#2386 — the first-account bootstrap step. The zero-user /sign-in ->
// /sign-up hop (below) now inverts to land here instead: while no Better Auth
// user exists, the bootstrap form is only ever rendered inside the setup
// wizard, never at the bare /sign-up URL (which continues to serve later
// accounts, unchanged, once at least one user exists).
const SETUP_SIGN_UP_PATH = "/setup/account";
const NEXT_PARAM = "next";

/**
 * The request header `guardAppRoute` (src/lib/auth-route-guard.ts) forwards
 * to Server Components carrying the current request's path + query, so
 * `requireAuthSession()` and other in-render gates can recover "where was
 * the caller headed" even though Server Components have no direct access to
 * the incoming request's URL.
 */
export const CURRENT_PATH_HEADER = "x-cinatra-current-path";

/**
 * True when `value` contains a C0 control character (codepoints 0x00-0x1f,
 * including CR/LF). Written as a codepoint scan rather than a regex literal
 * to keep the raw control bytes out of source text entirely.
 */
function containsControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) <= 0x1f) return true;
  }
  return false;
}

/**
 * True when `candidate` is safe to redirect to after auth: a single-leading-
 * slash, same-origin, relative path — no scheme, no protocol-relative `//`,
 * no backslash tricks, no control characters.
 */
export function isSafeNextPath(candidate: string | null | undefined): candidate is string {
  if (!candidate) return false;
  if (candidate.length === 0) return false;
  if (!candidate.startsWith("/")) return false; // must be relative, not absolute/scheme-qualified
  if (candidate.startsWith("//")) return false; // protocol-relative ("//evil.com")
  if (candidate.includes("\\")) return false; // backslash trick — browsers treat \ like /
  if (containsControlChar(candidate)) return false; // header/response-splitting guard

  // A colon in the first path segment signals an embedded URI scheme
  // (RFC 3986 relative-ref grammar forbids a bare ":" there for exactly this
  // reason — it disambiguates a relative path from an absolute-URI).
  const firstSlash = candidate.indexOf("/", 1);
  const firstSegment = firstSlash === -1 ? candidate : candidate.slice(0, firstSlash);
  if (firstSegment.includes(":")) return false;

  return true;
}

/** Returns `candidate` unchanged when it passes {@link isSafeNextPath}, else `undefined`. */
export function sanitizeNextPath(candidate: string | null | undefined): string | undefined {
  return isSafeNextPath(candidate) ? candidate : undefined;
}

function appendNextParam(basePath: string, nextPath?: string | null): string {
  const safeNext = sanitizeNextPath(nextPath);
  if (!safeNext) return basePath;
  return `${basePath}?${NEXT_PARAM}=${encodeURIComponent(safeNext)}`;
}

/** Builds `/sign-in`, or `/sign-in?next=<encoded path>` when `nextPath` is a safe relative path. */
export function buildSignInPath(nextPath?: string | null): string {
  return appendNextParam(SIGN_IN_PATH, nextPath);
}

/** Builds `/sign-up`, or `/sign-up?next=<encoded path>` when `nextPath` is a safe relative path. */
export function buildSignUpPath(nextPath?: string | null): string {
  return appendNextParam(SIGN_UP_PATH, nextPath);
}

/**
 * Builds `/setup/account`, or `/setup/account?next=<encoded path>` when
 * `nextPath` is a safe relative path (cinatra#2386). This is the bootstrap
 * destination for the zero-user `/sign-in` (and direct `/sign-up`) hop —
 * `buildSignUpPath` above stays reserved for the later-account URL itself.
 */
export function buildSetupSignUpPath(nextPath?: string | null): string {
  return appendNextParam(SETUP_SIGN_UP_PATH, nextPath);
}

/** Resolves the post-auth destination: the sanitized `next` value, or `/` when absent/unsafe. */
export function resolvePostAuthDestination(nextPath?: string | null): string {
  return sanitizeNextPath(nextPath) ?? "/";
}

// ---------------------------------------------------------------------------
// /configuration href predicates (cinatra#2701). The render-time half of the
// admin-only rule for the /configuration segment: a member-facing producer
// keeps a /configuration href only for an admin viewer. Pure, client-safe;
// lives here with the other path predicates so the locked route graphs do not
// grow by a module.
// ---------------------------------------------------------------------------

/** True when `href` addresses the admin-only `/configuration` segment. */
export function isConfigurationHref(href: string | null | undefined): boolean {
  if (typeof href !== "string") return false;
  // Only same-origin, root-relative paths can reach the segment; an absolute
  // URL or a `/configurations…` sibling is not it.
  return href === "/configuration" || href.startsWith("/configuration/") ||
    href.startsWith("/configuration?") || href.startsWith("/configuration#");
}

/**
 * The href this viewer should be offered: the original for a platform admin,
 * `undefined` for everyone else when it points into `/configuration`.
 *
 * Returning `undefined` (rather than a substitute destination) is deliberate:
 * every consumer already has a no-href rendering — the notifications feed's
 * href-less card species, the approvals actions menu without its Details link,
 * the MCP row without the field. A substitute would invent a destination the
 * epic never decided on.
 */
export function configurationHrefForViewer(
  href: string | null | undefined,
  viewerIsAdmin: boolean,
): string | undefined {
  if (typeof href !== "string" || href.length === 0) return undefined;
  if (viewerIsAdmin) return href;
  return isConfigurationHref(href) ? undefined : href;
}
