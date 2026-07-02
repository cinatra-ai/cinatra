// Pure pathname → breadcrumb-trail logic, extracted from <AppShell> so it is
// directly unit-testable: the component only maps the returned crumbs onto
// <BreadcrumbLink>/<BreadcrumbPage>. (Mirrors the pure-helper extraction used
// for the connector cm-error classifier — keep render-affecting logic out of
// the client component so it can be asserted without a full DOM render.)

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
  return false;
}

// Build the breadcrumb trail for `pathname`. Pure: all live-title inputs are
// passed in. The leaf crumb prefers the broadcast page title when it matches
// the current path; chat threads and agent instances collapse to a readable
// two/three-crumb trail; otherwise the full ancestor trail is emitted (capped
// at 4 crumbs with a middle ellipsis).
export function buildBreadcrumbTrail(
  pathname: string,
  opts: {
    pageTitle?: { title: string; pathname: string } | null;
    chatThreadTitle?: string | null;
    agentInstanceName?: string | null;
  } = {},
): BreadcrumbCrumb[] {
  const {
    pageTitle = null,
    chatThreadTitle = null,
    agentInstanceName = null,
  } = opts;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return [{ label: "Personal", href: "/personal" }];

  // Chat thread: collapse to "Chat > <thread title>".
  if (
    segments[0] === "chat" &&
    segments.length >= 2 &&
    /^[a-f0-9-]{36}$/.test(segments[1])
  ) {
    return [
      { label: "Chat", href: "/chat" },
      { label: chatThreadTitle ?? "Thread", href: pathname },
    ];
  }

  // Agent instance: collapse the opaque vendor/package/instance path to
  // "Agents > <instance name> [> <sub-route>]" so the trail stays readable.
  if (segments[0] === "agents" && segments.length >= 4) {
    const crumbs: BreadcrumbCrumb[] = [
      { label: "Agents", href: "/agents" },
      {
        label: agentInstanceName ?? humanizePathSegment(segments[3]),
        href: "/" + segments.slice(0, 4).join("/"),
      },
    ];
    if (segments.length >= 5) {
      crumbs.push({ label: humanizePathSegment(segments[4]), href: pathname });
    }
    return crumbs;
  }

  // General: full trail; the leaf crumb prefers the live page title (the exact
  // <PageHeader> title, e.g. "Upload Extension") over the humanized path
  // segment ("Upload").
  const crumbs: BreadcrumbCrumb[] = segments.map((seg, i) => {
    const isLast = i === segments.length - 1;
    const label =
      isLast && pageTitle && pageTitle.pathname === pathname
        ? pageTitle.title
        : humanizePathSegment(seg);
    // The connector ([slug]) level has no index page, but it links to its
    // canonical subroute (already present in the path); see
    // connectorCanonicalCrumbHref (#422). Other pageless containers (e.g.
    // /connectors/[vendor]) render as a plain label.
    const defaultHref = "/" + segments.slice(0, i + 1).join("/");
    const canonicalConnectorHref = connectorCanonicalCrumbHref(segments, i);
    return {
      label,
      href: canonicalConnectorHref ?? defaultHref,
      // Intermediate segments whose path is a pageless routing container would
      // 404 if linked — render as a label, UNLESS this is the connector crumb
      // we just linked to its canonical subroute.
      nonNavigable:
        !isLast &&
        isPagelessContainerCrumb(segments, i) &&
        !canonicalConnectorHref,
    };
  });

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
