// Pure pathname → breadcrumb-trail logic, extracted from <AppShell> so it is
// directly unit-testable: the component only maps the returned crumbs onto
// <BreadcrumbLink>/<BreadcrumbPage>. (Mirrors the pure-helper extraction used
// for the connector cm-error classifier — keep render-affecting logic out of
// the client component so it can be asserted without a full DOM render.)

import type { CrumbContribution } from "./breadcrumb-contributions";
import { LEGACY_NANOID_RE } from "./id-policy";

export type BreadcrumbCrumb = {
  label: string;
  href: string;
  ellipsis?: boolean;
  nonNavigable?: boolean;
};

export function humanizePathSegment(segment: string): string {
  return decodeURIComponent(segment)
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// An id-like path segment (cinatra#1737): a UUID, a long bare-hex token, or a
// 32-char legacy better-auth id (cinatra#1907 — see src/lib/id-policy.ts).
// These must NEVER pass through `humanizePathSegment` — stripping the hyphens
// and Title-Casing the hex produces text that reads like a mangled name
// ("9c0dfce6 B2cb 4dab …"). Without a resolved contribution they render as an
// obvious short-id placeholder instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i;

// Malformed percent-encoding ("%", truncated UTF-8 escapes) makes
// decodeURIComponent THROW — and these helpers run while rendering the shell,
// so a crafted URL would crash AppShell instead of reaching the page/404.
// Fall back to the raw segment.
function safelyDecodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function isIdLikeSegment(segment: string): boolean {
  const decoded = safelyDecodePathSegment(segment);
  return (
    UUID_RE.test(decoded) ||
    LONG_HEX_RE.test(decoded) ||
    LEGACY_NANOID_RE.test(decoded)
  );
}

/** The obvious short-id placeholder for an unresolved id crumb — never
 *  title-cased hex (cinatra#1737 floor rule). */
export function idSegmentPlaceholder(segment: string): string {
  return `${safelyDecodePathSegment(segment).slice(0, 8)}…`;
}

// Configuration grouping segments that exist only as routing containers — no
// `page.tsx` at `/configuration/<seg>`, so a breadcrumb link there 404s.
export const PAGELESS_CONFIG_GROUPS = new Set([
  "agents",
  "a2a",
  "instance",
  "network",
  "operations",
]);

// The connector dispatch route resolves ONLY at
// `/connectors/[vendor]/[slug]/[subroute]` where `subroute` equals the
// connector descriptor's `setupSubroute` — uniformly `"setup"` today
// (`@cinatra-ai/connectors-catalog`: "always 'setup'; reserved for future
// use"); any other subroute `notFound()`s. We gate the connector-crumb link on
// this literal so the crumb only becomes navigable on a genuinely-valid
// connector page: on an invalid-subroute 404 (where <AppShell> — and therefore
// this breadcrumb — still renders inside the root layout) `segments[3]` is not
// "setup", so the crumb stays a plain label instead of linking to the 404. If
// per-connector subroutes ever diverge, feed the validated subroute in from the
// server rather than widening this guard.
export const CANONICAL_CONNECTOR_SUBROUTE = "setup";

// The navigable canonical href for the connector "[slug]" crumb
// (`/connectors/[vendor]/[slug]`), or null when crumb `i` is not that crumb or
// the current path is not a valid connector page. The connector level has no
// index page, but it resolves at its canonical subroute — which, being the page
// that actually rendered, is already present in the path at index 3. So we can
// link to it without importing the server-only connector registry. (#422,
// follow-up to #421.)
export function connectorCanonicalCrumbHref(
  segments: string[],
  i: number,
): string | null {
  if (
    segments[0] === "connectors" &&
    i === 2 &&
    segments[3] === CANONICAL_CONNECTOR_SUBROUTE
  ) {
    return "/" + segments.slice(0, 4).join("/");
  }
  return null;
}

// Whether the breadcrumb crumb for `segments[i]` points at a pageless routing
// container that would 404 if linked — in which case it must render as a plain
// label, not a link. The auto-breadcrumb otherwise turns every ancestor segment
// into `/seg0/.../segi`, but App-Router container segments (dynamic params with
// no own page, grouping folders) have no page to land on.
//
// Keep this in sync with the route tree — a segment belongs here when its
// directory under `src/app` has no `page.tsx`. Known cases:
//   • /connectors/[vendor] and /connectors/[vendor]/[slug] — connectors resolve
//     only at /connectors/[vendor]/[slug]/[subroute]; the vendor and connector
//     levels have no index page. The connector ([slug]) level is nonetheless
//     rendered as a real link to its canonical subroute (see
//     `connectorCanonicalCrumbHref`, #422); the vendor level stays a label.
//   • /configuration/<group> for the grouping segments above.
//   • /configuration/marketplace/[scope] — the marketplace detail route
//     resolves only at /configuration/marketplace/[scope]/[name]; the [scope]
//     (vendor) level is a routing container with no page.tsx, so its crumb
//     404s if linked (#797). The static depth-3 siblings that DO have pages
//     (`submissions`, `vendor-applications`) are deny-listed so they stay
//     navigable.
export const MARKETPLACE_STATIC_ROUTES = new Set([
  "submissions",
  "vendor-applications",
]);

export function isPagelessContainerCrumb(segments: string[], i: number): boolean {
  const depth = i + 1; // number of path segments up to and including this crumb
  if (segments[0] === "connectors" && (depth === 2 || depth === 3)) return true;
  if (
    segments[0] === "configuration" &&
    depth === 2 &&
    PAGELESS_CONFIG_GROUPS.has(segments[1])
  ) {
    return true;
  }
  if (
    segments[0] === "configuration" &&
    segments[1] === "marketplace" &&
    depth === 3 &&
    !MARKETPLACE_STATIC_ROUTES.has(segments[2])
  ) {
    return true;
  }
  return false;
}

// Build the breadcrumb trail for `pathname`. Pure: all live inputs are passed
// in. Crumb CONTRIBUTIONS (cinatra#1737 — server-authorized, route-published)
// are consulted for EVERY crumb, leaf and intermediate; the leaf additionally
// falls back to the broadcast page title; chat threads and agent instances
// collapse to a readable two/three-crumb trail (documented shape rules);
// otherwise the full ancestor trail is emitted (capped at 4 crumbs with a
// middle ellipsis — contributions, including insertions, apply BEFORE the
// truncation).
//
// Per-crumb label precedence (general branch):
//   1. a contribution whose prefix equals the crumb's path (replaces
//      label/href/nonNavigable in place — the route itself said so);
//   2. leaf only: the broadcast page title (kept as an override for pages
//      whose header genuinely differs from the entity name, e.g. "Upload
//      Extension" — a leaf contribution beats it, being the newer deliberate
//      contract);
//   3. id-like segments: an obvious short-id placeholder — NEVER title-cased
//      hex;
//   4. `humanizePathSegment` for genuinely wordy segments.
export function buildBreadcrumbTrail(
  pathname: string,
  opts: {
    pageTitle?: { title: string; pathname: string } | null;
    chatThreadTitle?: string | null;
    contributions?: readonly CrumbContribution[];
  } = {},
): BreadcrumbCrumb[] {
  const { pageTitle = null, chatThreadTitle = null, contributions = [] } = opts;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return [{ label: "Personal", href: "/personal" }];

  const replacementFor = (crumbPath: string): CrumbContribution | undefined => {
    // Last matching replacement wins (publish already dedupes; this guards
    // callers passing raw arrays).
    for (let j = contributions.length - 1; j >= 0; j--) {
      const c = contributions[j];
      if (!c.insertBefore && c.prefix === crumbPath) return c;
    }
    return undefined;
  };

  // Chat: collapse to "Chat" (a new/empty chat or the bare mount) or
  // "Chat > <thread title>" (a thread) — a documented shape rule (ratified on
  // cinatra#1737). The URL now carries `/chat/<vendor>/<slug>[/<instance>]/
  // <titleSlug>` (cinatra#1878 W3), so the retired `/chat/<uuid>` regex is gone;
  // a thread is signalled by the PERSISTED title arriving over the chat bus
  // (present only while a thread is active — never for a new/empty chat), never
  // re-derived from the path.
  if (segments[0] === "chat") {
    const crumbs: BreadcrumbCrumb[] = [{ label: "Chat", href: "/chat" }];
    if (chatThreadTitle) {
      crumbs.push({ label: chatThreadTitle, href: pathname });
    }
    return crumbs;
  }

  // Agent instance: collapse the opaque vendor/package/instance path to
  // "Agents > <instance name> [> <sub-route>]" — a documented shape rule
  // (ratified): the name is the page header's identity (run title →
  // "<template name> (N) — <startedAt>" → placeholder), supplied via the ONE
  // contribution channel by the gated instance page / rename flow.
  if (segments[0] === "agents" && segments.length >= 4) {
    const instancePath = "/" + segments.slice(0, 4).join("/");
    const contributed = replacementFor(instancePath);
    const crumbs: BreadcrumbCrumb[] = [
      { label: "Agents", href: "/agents" },
      {
        label:
          contributed?.label ??
          (isIdLikeSegment(segments[3])
            ? idSegmentPlaceholder(segments[3])
            : humanizePathSegment(segments[3])),
        href: instancePath,
      },
    ];
    if (segments.length >= 5) {
      crumbs.push({ label: humanizePathSegment(segments[4]), href: pathname });
    }
    return crumbs;
  }

  // General: full trail with the per-crumb precedence documented above.
  // `crumbPaths[i]` records crumb i's own path for insertion targeting —
  // hrefs can be overridden (canonical connector link, contribution href), so
  // they are not a stable match key.
  const crumbPaths: string[] = segments.map(
    (_seg, i) => "/" + segments.slice(0, i + 1).join("/"),
  );
  const crumbs: BreadcrumbCrumb[] = segments.map((seg, i) => {
    const isLast = i === segments.length - 1;
    const crumbPath = "/" + segments.slice(0, i + 1).join("/");
    const contributed = replacementFor(crumbPath);
    const label =
      contributed?.label ??
      (isLast && pageTitle && pageTitle.pathname === pathname
        ? pageTitle.title
        : isIdLikeSegment(seg)
          ? idSegmentPlaceholder(seg)
          : humanizePathSegment(seg));
    // The connector ([slug]) level has no index page, but it links to its
    // canonical subroute (already present in the path); see
    // connectorCanonicalCrumbHref (#422). Other pageless containers (e.g.
    // /connectors/[vendor]) render as a plain label.
    const defaultHref = "/" + segments.slice(0, i + 1).join("/");
    const canonicalConnectorHref = connectorCanonicalCrumbHref(segments, i);
    return {
      label,
      href: contributed?.href ?? canonicalConnectorHref ?? defaultHref,
      // Intermediate segments whose path is a pageless routing container would
      // 404 if linked — render as a label, UNLESS this is the connector crumb
      // we just linked to its canonical subroute. A contribution may also
      // declare its crumb non-navigable explicitly.
      nonNavigable:
        contributed?.nonNavigable ??
        (!isLast &&
          isPagelessContainerCrumb(segments, i) &&
          !canonicalConnectorHref),
    };
  });

  // Ancestry insertions (cinatra#1738 consumes this): a contribution with
  // `insertBefore` inserts a NEW crumb before the crumb whose path equals
  // that prefix, in publisher declaration order; an absent target skips the
  // insertion. Applied BEFORE truncation.
  for (const c of contributions) {
    if (!c.insertBefore) continue;
    const at = crumbPaths.indexOf(c.insertBefore);
    if (at === -1) continue;
    crumbPaths.splice(at, 0, c.prefix);
    crumbs.splice(at, 0, {
      label: c.label,
      href: c.href ?? c.prefix,
      ...(c.nonNavigable !== undefined ? { nonNavigable: c.nonNavigable } : {}),
    });
  }

  // Breadcrumb: 3-4 crumbs max; truncate the middle with an ellipsis.
  if (crumbs.length <= 4) return crumbs;
  return [
    crumbs[0],
    { label: "…", href: crumbs[1].href, ellipsis: true },
    crumbs[crumbs.length - 2],
    crumbs[crumbs.length - 1],
  ];
}

// Stable React key for a crumb at position `i`. Keying by `href` alone collides
// (#499): two distinct crumbs can legitimately share an href — on a valid
// connector page the [slug] crumb canonical-links to its subroute (#422), which
// is the very page the leaf crumb represents, so e.g.
// `/connectors/cinatra-ai/openai-connector/setup` yields crumbs[2] and crumbs[3]
// with the same href. The crumbs are still semantically distinct ("Openai
// Connector" vs "Setup"), so the right fix is a positionally-unique key, not
// dropping a crumb. Index-prefixing also keeps siblings unique for any future
// same-href case (ellipsis already keyed by index).
export function breadcrumbCrumbKey(crumb: BreadcrumbCrumb, i: number): string {
  return crumb.ellipsis ? `ellipsis-${i}` : `${i}-${crumb.href}`;
}
