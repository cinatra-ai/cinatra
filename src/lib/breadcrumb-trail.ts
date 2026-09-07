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

// THE CONNECTOR ROUTE'S NAMED LEVELS (cinatra#3215).
//
// The ratified components drawing: "A crumb that stands for an entity id shows
// that entity's display name — at every position, not only the last", and the
// eight-characters-plus-ellipsis fallback it names is written for an ENTITY ID
// — "never a title-cased raw id". A vendor slug and a connector slug are
// neither ids nor the reader's own words, and `humanizePathSegment` turned them
// into text the product shows nowhere else: "Cinatra Ai", "Google Appointment
// Schedules Connector" — drawn beside a page header writing the connector's
// real display name, "Google Appointment Schedules".
//
// The owning route publishes both display names as crumb contributions from its
// server render, after its access checks, and that is what these crumbs
// normally read. THIS is the floor under that — the reading with no
// contribution published (a soft navigation before the island fires, a reader
// with no access, any future route that forgets): the crumb shows the segment
// VERBATIM, spelled the way the url spells it, and never a title-cased slug. So
// the composer carries the guarantee, not one page.
//
// Verbatim, and not the id placeholder: the placeholder is the drawing's rule
// for an id, and cutting "google-appointment-schedules-connector" to eight
// characters would hide a word the reader can already read in the address bar.
// Verbatim, and not dropped: the vendor and the connector are real levels of
// the hierarchy the trail is required to reflect.
//
// Read at the VENDOR and CONNECTOR positions of the dispatch route only — a
// path that carries both a vendor and a connector segment. The static connector
// pages (`/connectors/email`, `drupal`, `resend`, `wordpress`) carry no such
// pair and are untouched.
export function connectorNameCrumbFallbackLabel(
  segments: string[],
  i: number,
): string | null {
  if (segments[0] !== "connectors") return null;
  if (segments.length < 3) return null;
  if (i !== 1 && i !== 2) return null;
  return safelyDecodePathSegment(segments[i]);
}

// THE SELECTED TAB IS NOT A LEVEL OF THE HIERARCHY (cinatra#3215).
//
// The drawing fixes the trail as the navigation hierarchy — "the route the page
// sits on, not the thing the page happens to be about" — and closes its
// Breadcrumb section with "Never combine with tabs". The connector dispatch
// route resolves ONLY at its canonical subroute, so that last segment is the
// same fixed word on every connector page, never a distinguishing one; and the
// surface underneath draws that word again as the first trigger of its own
// Setup / Help tab strip. A crumb that names the tab the reader is already
// looking at — and points at the very href the crumb above it points at — is
// not a place above the page.
//
// So the subroute contributes NO crumb and the connector itself is the trail's
// leaf: "Connectors > the vendor > the connector". Decided on the route SHAPE,
// not on whether the surface happens to render a tab strip: a connector that
// declares no extra tabs draws none, and the segment is no more a level of the
// hierarchy there than it is beside one. Answers the crumb path to drop, or
// null.
export function connectorTabCrumbPathToDrop(segments: string[]): string | null {
  if (segments[0] !== "connectors") return null;
  if (segments.length !== 4) return null;
  if (segments[3] !== CANONICAL_CONNECTOR_SUBROUTE) return null;
  return "/" + segments.slice(0, 4).join("/");
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

// THE SCOPE BASE (cinatra#2809, per-scope surfaces S3).
//
// Every surface now answers under a vantage as well as at the root: the
// workspace, a person's own scope, an organization, a team, a project. The
// trail has to know where the scope ends and the surface begins, because the
// two collapse branches below are written against the SURFACE ("Agents >
// <instance>") and a scoped path carries the vantage in front of it.
//
// Spelled here as a recognizer over the path rather than imported from
// `scopeSurfaceBase`: this module is a pure leaf the shell renders through, and
// the agreement with that function is pinned by a unit test.
const SCOPE_BASE_CONTAINERS = new Set(["organizations", "teams", "projects"]);
const SCOPE_BASE_SINGLETONS = new Set(["workspace", "personal"]);

/** The scope base a path is under, or `null` for a root-level path. */
export function scopeBaseFromSegments(segments: string[]): string | null {
  if (segments.length === 0) return null;
  if (SCOPE_BASE_SINGLETONS.has(segments[0])) return `/${segments[0]}`;
  if (SCOPE_BASE_CONTAINERS.has(segments[0]) && segments.length >= 2 && segments[1]) {
    return `/${segments[0]}/${segments[1]}`;
  }
  return null;
}

/** How many segments the scope base occupies. */
function scopeBaseDepth(scopeBase: string | null): number {
  return scopeBase ? scopeBase.split("/").filter(Boolean).length : 0;
}

export function isPagelessContainerCrumb(segments: string[], i: number): boolean {
  const depth = i + 1; // number of path segments up to and including this crumb
  // /analytics has no page.tsx and no redirect — the section root is a pure
  // routing container (cinatra#1910), so its crumb must not link.
  if (segments[0] === "analytics" && depth === 1) return true;
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
  // `/{organizations,teams}/<id>/dashboards` became a pure routing container
  // when cinatra#2474 PR2 folded the scope-collection page onto the entity
  // landing and DELETED the route (no redirect, no shim). Only the
  // `[dashboardId]` canonical-home child lives under it now, so the
  // intermediate "Dashboards" crumb on a nested dashboard URL (#1738) would
  // link to a 404. It renders as a plain label instead — deliberately NOT
  // relinked at the entity landing, which is already the immediately preceding
  // crumb (two adjacent crumbs pointing at one href is worse than one label).
  if (
    (segments[0] === "organizations" || segments[0] === "teams") &&
    depth === 3 &&
    segments[2] === "dashboards"
  ) {
    return true;
  }
  // The agent VENDOR level (cinatra#2809). `…/agents/<vendor>` is a routing
  // container: the route resolves at `…/agents/<vendor>/<package>` and below,
  // so a link at the vendor level 404s. True at the root and under every scope
  // base, because the same route tree is mounted at both.
  const agentsAt = scopeBaseDepth(scopeBaseFromSegments(segments));
  if (
    segments[agentsAt] === "agents" &&
    i === agentsAt + 1 &&
    segments.length >= agentsAt + 3
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
// THE AGENT INSTANCE'S STEP SUB-ROUTES (cinatra#3004; corrected by cinatra#3223).
//
// A sub-route crumb is normally the path segment made readable, and that is
// right wherever the path word is the reader's word. It is not right where the
// path segment is a STEP OF THE RUN rather than a level of the hierarchy: the
// run's schedule step answers at the run's `/trigger` sub-route, and a step
// is a reading inside the run's own route, not a route of its own.
//
// The ratified drawing, components reference, the Breadcrumb section: "A
// breadcrumb always reflects the navigation hierarchy — the route the page sits
// on, not the thing the page happens to be about", and "'Agents › Agent run ›
// Review' is not a possible breadcrumb — the review is read on its run's own
// route, under that run's trail", closing on "a hierarchy the routes do not
// have". This map used to give the schedule step the word "Schedule" at the
// sub-route position, which drew that third crumb; the drawing's conclusion is
// that such a thing is not a crumb at all, so the segment is ELIDED and the
// trail the schedule step composes is byte-identical to the trail every other
// step of the same run composes.
//
// THE PATH IS deliberately UNCHANGED. A bookmark still opens the same surface;
// only the trail the reader sees stops naming a level the routes do not have.
// (That the schedule step has a route of its own at all is a separate
// departure, tracked under epic #3248 — this is the trail's half of it.)
//
// It is read at the SUB-ROUTE position and nowhere else, so an instance whose
// own id happens to be one of these words keeps its own name, and every OTHER
// sub-route under an instance — a genuine page of its own — is named exactly as
// it was.
const AGENT_INSTANCE_STEP_SUBROUTES: ReadonlySet<string> = new Set(["trigger"]);

/**
 * POSITION APPENDS (cinatra#3068 fix leg 2): a contribution with `appendAfter`
 * puts a NEW crumb immediately after the crumb whose path equals that prefix,
 * in publisher declaration order; an absent target skips the append. The mirror
 * of the ancestry insertion below it, and applied on both branches so a
 * publisher's crumb can never be silently dropped by the trail it was published
 * for. Mutates both arrays in step, so a later append targets the trail as it
 * now stands.
 */
function applyCrumbAppends(
  crumbs: BreadcrumbCrumb[],
  crumbPaths: string[],
  contributions: readonly CrumbContribution[],
): void {
  // PUBLISHER ORDER, NOT ITS REVERSE (cinatra#3068 fix leg 2 convergence). The
  // insertion below walks the same way and stays ordered for free -- each
  // insert at `at` pushes the TARGET right, so the next one lands after it.
  // An append lands at `at + 1`, which is the SAME slot every time: a second
  // append for one target would push the first one down and read backwards. So
  // each target counts the crumbs already appended to it and the next append
  // takes the slot after them. The target's own index is re-read every pass, so
  // an append for a different target inserted earlier cannot stale it.
  const appendedPerTarget = new Map<string, number>();
  for (const c of contributions) {
    if (!c.appendAfter) continue;
    const target = crumbPaths.indexOf(c.appendAfter);
    if (target === -1) continue;
    const already = appendedPerTarget.get(c.appendAfter) ?? 0;
    const at = target + already;
    appendedPerTarget.set(c.appendAfter, already + 1);
    crumbPaths.splice(at + 1, 0, c.prefix);
    crumbs.splice(at + 1, 0, {
      label: c.label,
      href: c.href ?? c.prefix,
      ...(c.nonNavigable !== undefined ? { nonNavigable: c.nonNavigable } : {}),
    });
  }
}

export function buildBreadcrumbTrail(
  pathname: string,
  opts: {
    pageTitle?: { title: string; pathname: string } | null;
    chatThreadTitle?: string | null;
    contributions?: readonly CrumbContribution[];
    /**
     * A PERSISTED instance's home scope (cinatra#2809): the vantage its launch
     * was anchored to, supplied by the page's server render. The scope crumb
     * names THIS, never the path the reader wandered in through — an instance
     * belongs where it was launched, and a trail that named the visited path
     * would offer a way back to a scope the instance is not in.
     */
    homeScopeBase?: string | null;
  } = {},
): BreadcrumbCrumb[] {
  const {
    pageTitle = null,
    chatThreadTitle = null,
    contributions = [],
    homeScopeBase = null,
  } = opts;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return [{ label: "Personal", href: "/personal" }];

  const replacementFor = (crumbPath: string): CrumbContribution | undefined => {
    // Last matching replacement wins (publish already dedupes; this guards
    // callers passing raw arrays).
    for (let j = contributions.length - 1; j >= 0; j--) {
      const c = contributions[j];
      // A POSITION-TARGETED entry is never a replacement (cinatra#3068 fix leg
      // 2 convergence). `insertBefore` was already excluded; `appendAfter` is
      // its mirror and must be excluded with it, or an append whose prefix
      // happens to equal a real crumb path would BOTH relabel that crumb and be
      // appended beside it -- one contribution drawn twice.
      if (!c.insertBefore && !c.appendAfter && c.prefix === crumbPath) return c;
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
  const pathScopeBase = scopeBaseFromSegments(segments);
  const baseDepth = scopeBaseDepth(pathScopeBase);
  const surface = segments.slice(baseDepth);

  /**
   * The scope's own crumb: its resolved NAME, linking to the scope landing.
   * The name arrives through the ONE contribution channel (the owning page's
   * server render, after its access checks); with none published it falls back
   * to the id's first eight characters plus an ellipsis, never a title-cased
   * raw id.
   */
  const scopeCrumb = (base: string): BreadcrumbCrumb => {
    const contributed = replacementFor(base);
    const last = base.split("/").filter(Boolean).at(-1) ?? "";
    return {
      label:
        contributed?.label ??
        (isIdLikeSegment(last) ? idSegmentPlaceholder(last) : humanizePathSegment(last)),
      href: contributed?.href ?? base,
    };
  };

  /** The head of a collapsed scoped trail: the instance's HOME scope where the
   *  page named one, otherwise the scope the path is under. */
  const collapsedHead = (): BreadcrumbCrumb[] => {
    const base = homeScopeBase ?? pathScopeBase;
    return base ? [scopeCrumb(base)] : [];
  };

  // Chat: collapses to "Chat" / "Chat > <thread title>" at the root, and to
  // "<scope> > Assistants [> <thread title>]" under a scope base, where the
  // same renderer answers at `<base>/assistants/<vendor>/<slug>…`. The scope's
  // own Assistants TAB (`<base>/assistants`, no vendor/slug below it) is a
  // listing page, not a conversation, and stays on the ordinary trail.
  const isScopedChat = pathScopeBase !== null && surface[0] === "assistants" && surface.length >= 3;
  if (segments[0] === "chat" || isScopedChat) {
    // THE HOME SCOPE WINS OVER THE PATH HERE TOO (convergence finding on this
    // lane). The agent-instance branch already preferred it; the chat branch
    // did not, so a persisted thread read at the BARE /chat address — the
    // address a reader arrives at before the canonical-home redirect, and the
    // one a stale bookmark holds -- collapsed to a scopeless Chat head and
    // offered no way back to the scope the conversation actually belongs to.
    const chatBase = isScopedChat ? (homeScopeBase ?? pathScopeBase) : homeScopeBase;
    const crumbs: BreadcrumbCrumb[] = chatBase
      ? [...collapsedHead(), { label: "Assistants", href: `${chatBase}/assistants` }]
      : [{ label: "Chat", href: "/chat" }];
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
  if (surface[0] === "agents" && surface.length >= 4) {
    const agentsRoot = `${pathScopeBase ?? ""}/agents`;
    const instancePath = "/" + segments.slice(0, baseDepth + 4).join("/");
    const contributed = replacementFor(instancePath);
    const instanceSegment = segments[baseDepth + 3];
    const crumbs: BreadcrumbCrumb[] = [
      ...collapsedHead(),
      { label: "Agents", href: agentsRoot },
      {
        label:
          contributed?.label ??
          (isIdLikeSegment(instanceSegment)
            ? idSegmentPlaceholder(instanceSegment)
            : humanizePathSegment(instanceSegment)),
        href: instancePath,
      },
    ];
    // BOTH DRAWINGS (forward leg 2). The scope base makes every index below
    // relative to the surface, not to the raw path, so a scoped instance page
    // keeps its scope head; and a STEP OF THE RUN CONTRIBUTES NO CRUMB
    // (cinatra#3223) at that same sub-route position, on a scoped base exactly
    // as at the root. The superseded "trigger -> Schedule" label map is gone
    // with the level it named.
    const agentCrumbPaths = crumbs.map((_c, i) =>
      i === crumbs.length - 1
        ? instancePath
        : i === crumbs.length - 2
          ? agentsRoot
          : (homeScopeBase ?? pathScopeBase ?? ""),
    );
    if (surface.length >= 5) {
      const subRoute = safelyDecodePathSegment(segments[baseDepth + 4]);
      if (!AGENT_INSTANCE_STEP_SUBROUTES.has(subRoute)) {
        crumbs.push({
          label: humanizePathSegment(segments[baseDepth + 4]),
          href: pathname,
        });
        agentCrumbPaths.push(pathname);
      }
    }
    // AND THE STEP THE RUN DETAIL IS SHOWING, where the page named one. The
    // run's first step answers on the run's own path and has no segment above
    // to be named by, so it arrives as an append after the run's own crumb.
    applyCrumbAppends(crumbs, agentCrumbPaths, contributions);
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
          : (connectorNameCrumbFallbackLabel(segments, i) ??
            humanizePathSegment(seg)));
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

  applyCrumbAppends(crumbs, crumbPaths, contributions);

  // The connector page's selected tab is not a crumb (cinatra#3215 — see
  // `connectorTabCrumbPathToDrop`). Dropped by PATH, and after the insertions
  // and appends, so a crumb some publisher put at that position is the one that
  // stays and the tab's own crumb is the one that goes.
  const tabCrumbPath = connectorTabCrumbPathToDrop(segments);
  if (tabCrumbPath !== null) {
    const at = crumbPaths.indexOf(tabCrumbPath);
    if (at !== -1) {
      crumbPaths.splice(at, 1);
      crumbs.splice(at, 1);
    }
  }

  // Breadcrumb: 3-4 crumbs max; truncate the middle with an ellipsis.
  //
  // THE SCOPE CRUMB SURVIVES (cinatra#2809). The head used to be crumb 0, which
  // on a scoped route is the CONTAINER listing ("Organizations") — so a deep
  // scoped path was truncated down to a trail that never named the scope the
  // reader was in. The head is the scope's own crumb where the path has one,
  // and crumb 0 everywhere else.
  if (crumbs.length <= 4) return crumbs;
  const truncationScopeBase = scopeBaseFromSegments(segments);
  const scopeAt = truncationScopeBase ? crumbPaths.indexOf(truncationScopeBase) : -1;
  const headAt = scopeAt > 0 ? scopeAt : 0;
  const cutAt = Math.min(headAt + 1, crumbs.length - 3);
  return [
    crumbs[headAt],
    { label: "…", href: crumbs[cutAt].href, ellipsis: true },
    crumbs[crumbs.length - 2],
    crumbs[crumbs.length - 1],
  ];
}

// Stable React key for a crumb at position `i`. Keying by `href` alone collides
// (#499): two distinct crumbs can legitimately share an href, and a duplicate
// key is a React warning and a mis-reconciled row. The case that first raised it
// was the connector setup path, where the [slug] crumb canonical-links to its
// subroute (#422) — the very page the trail's last crumb then stood for. That
// particular pair is gone: the connector page's selected tab is no longer a
// crumb at all (cinatra#3215), so the [slug] crumb IS the leaf and there is
// nothing beside it to collide with. The positional key stays: it is the right
// fix for the general case, and cheaper than proving no two crumbs can ever
// share an href again (ellipsis already keyed by index).
export function breadcrumbCrumbKey(crumb: BreadcrumbCrumb, i: number): string {
  return crumb.ellipsis ? `ellipsis-${i}` : `${i}-${crumb.href}`;
}

// THE TAB TITLE MIRRORS THE RESOLVED TRAIL (cinatra#2809, per-scope surfaces
// S3). The ratified drawing, Components/Breadcrumb: "The browser-tab title
// mirrors the resolved trail under the same rules: an id-bearing route never
// shows a raw id in the tab."
//
// The rule is the TRAIL's rule, so it reads the trail itself and lives beside
// it. Two things were wrong before:
//
//   * the shell recognised an agent instance by `segments[0] === "agents"`,
//     which is the BARE tree alone. S3 mounts the same surface under five scope
//     bases, and on those addresses the recogniser missed — the route fell
//     through to the id-bearing branch, where the shell deliberately writes
//     nothing and the route's own metadata stayed in the tab while the trail
//     beside it read the resolved names.
//   * it read ONE crumb contribution rather than the trail, so the tab
//     disagreed with the trail in exactly the windows where the trail resolves
//     its leaf some other way — the broadcast page title, or the id
//     abbreviation. The launch redirect is one of those windows.
//
// Returns the trail's LEAF label on an agent-instance address under any base,
// or `null` where the address is not one. Null is not a fallback to a humanized
// path segment: a caller that gets null leaves the tab title alone, so an
// id-bearing route can never show a raw id in the tab. The trail's own leaf
// rules do the rest — an unresolvable name is the id's first eight characters
// and an ellipsis there, and therefore in the tab too.
export function agentInstanceTabLabel(
  pathname: string,
  crumbs: readonly BreadcrumbCrumb[],
): string | null {
  const segments = pathname.split("/").filter(Boolean);
  const at = scopeBaseDepth(scopeBaseFromSegments(segments));
  // `<scope-base>/agents/<vendor>/<package>/<instance>` — the instance level,
  // and any step sub-route below it, which the trail collapses to this crumb.
  if (segments[at] !== "agents" || segments.length < at + 4) return null;
  const leaf = crumbs[crumbs.length - 1];
  if (!leaf || leaf.ellipsis) return null;
  return leaf.label || null;
}
