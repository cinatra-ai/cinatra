// ---------------------------------------------------------------------------
// The ONE `/chat` PATH CODEC (cinatra#1878 W3, Epic #1873 — AC#1/#6).
// ---------------------------------------------------------------------------
// A single pure build+parse for every `/chat/…` URL. Before this wave every
// `/chat` seam hardcoded a thread-UUID grammar (`/chat/<uuid>`); this module
// replaces ALL of them with the canonical multi-vendor grammar:
//
//   /chat                                   → redirect to the canonical default
//   /chat/<vendor>/<slug>                   new/empty chat with that assistant
//   /chat/<vendor>/<slug>/<titleSlug>       a thread                (local kinds)
//   /chat/<vendor>/<slug>/<instance>        new chat scoped to a site (remote ONLY)
//   /chat/<vendor>/<slug>/<instance>/<titleSlug>  a thread scoped to that site
//
// The segment AFTER `<slug>` is disambiguated by the assistant's DECLARED
// launch kind (`local` vs `remote`), NEVER by format-sniffing the value
// (cinatra#1873 ruling): a `local` assistant's third segment is always a
// titleSlug; a `remote` assistant's third segment is always an instance id, and
// a remote thread is ALWAYS instance-scoped (`.../<instance>/<titleSlug>`). This
// is why {@link parseChatPath} takes `remoteCapable` — the caller resolves it
// once from the registry (vendor/slug are always segments[0]/[1], so the lookup
// key is available before disambiguation).
//
// Vendor/slug map to the assistant PACKAGE name by the established convention
// (mirrors the A2A agent route `/api/a2a/agents/<vendor>/<slug>`):
// `@<vendor>/<slug>` ⇔ `{ vendor, slug }`. This is the anti-spoofing identity —
// the route NEVER trusts a display handle, only the package-derived vendor/slug.
//
// PURE + ZERO-DEP: no React, no server imports — safe to import from the client
// chat seams AND the host server component AND the AppShell/breadcrumb host code.

/** The `/chat` mount root (the single chat mount; `chat/layout.tsx`). */
export const CHAT_ROOT = "/chat";

// ---------------------------------------------------------------------------
// THE SCOPED MOUNT (cinatra#2809, per-scope surfaces S3).
//
// The same renderer answers under every scope: an organization, a team, a
// project, the workspace, a person's own scope. A launch made from a vantage
// belongs to it, so the address carries it — `/teams/<id>/assistants/<vendor>/
// <slug>` is the scoped twin of `/chat/<vendor>/<slug>`, with the same four
// legal shapes below it.
//
// The scope base is a PREFIX of the MOUNT, never a segment of the grammar: the
// route splits the base off and hands the codec the bare `/chat/…` path it has
// always parsed, which is why every rule below — the slash-free segment
// validation, the kind-driven disambiguation, the legacy single-segment death —
// is untouched.
//
// The scope-base grammar is spelled HERE as a pattern rather than imported from
// the host's `scopeSurfaceBase`: this module is a zero-dependency leaf that the
// client seams, the server component and the shell all import, and it stays
// that way. The agreement with `scopeSurfaceBase` is pinned by a unit test —
// the same arrangement `DEFAULT_ASSISTANT_PACKAGE` above already uses.
// ---------------------------------------------------------------------------

/** The segment the scoped mount answers on, below a scope base. */
export const SCOPED_CHAT_SEGMENT = "assistants";

/** The five scope bases, as the routes spell them. */
const SCOPE_BASE_RE =
  /^\/(?:workspace|personal|(?:organizations|teams|projects)\/[^/\s\\]+)(?=\/|$)/;

function assertScopeBase(base: string): string {
  if (!/^(?:\/[^/\s\\]+)+$/.test(base)) {
    throw new Error(`chat-path-codec: invalid scope base ${JSON.stringify(base)}`);
  }
  return base;
}

/** The mount root for a scope — `/chat` bare, `<scope-base>/assistants` scoped. */
export function chatMountRoot(opts?: { scopeBase?: string | null }): string {
  const base = opts?.scopeBase;
  if (base == null) return CHAT_ROOT;
  return `${assertScopeBase(base)}/${SCOPED_CHAT_SEGMENT}`;
}

/**
 * Split a pathname into its scope base and the BARE `/chat/…` path the codec
 * parses. A pathname that is not a chat mount at all comes back unchanged with
 * an empty base, so a caller can feed it in blind.
 */
export function splitChatScopeBase(pathname: string): {
  scopeBase: string;
  chatPathname: string;
} {
  if (pathname === CHAT_ROOT || pathname.startsWith(`${CHAT_ROOT}/`)) {
    return { scopeBase: "", chatPathname: pathname };
  }
  const m = SCOPE_BASE_RE.exec(pathname);
  if (m) {
    const base = m[0];
    const rest = pathname.slice(base.length);
    // The scope's Assistants TAB (`<base>/assistants`) is a listing page, not a
    // mount: only a path BELOW it addresses a conversation.
    if (rest.startsWith(`/${SCOPED_CHAT_SEGMENT}/`)) {
      return {
        scopeBase: base,
        chatPathname: `${CHAT_ROOT}${rest.slice(SCOPED_CHAT_SEGMENT.length + 1)}`,
      };
    }
  }
  return { scopeBase: "", chatPathname: pathname };
}

/** The canonical default assistant package — the builtin Cinatra assistant.
 *  Pinned in agreement with `BUILTIN_ASSISTANT_ALIAS.packageName`
 *  (src/lib/assistant-registry-schema.ts) by a unit test; kept LOCAL so this
 *  zero-dep leaf never imports the host schema module. */
export const DEFAULT_ASSISTANT_PACKAGE = "@cinatra-ai/cinatra-assistant";

/** The canonical default chat route (`/chat` redirects here). */
export const DEFAULT_CHAT_ROUTE: ChatRoute = Object.freeze({
  vendor: "cinatra-ai",
  slug: "cinatra-assistant",
});

/** The canonical default chat PATH (`/chat` → this). */
export const DEFAULT_CHAT_PATH = buildChatPath(DEFAULT_CHAT_ROUTE);

/**
 * A resolved chat route. `instance` is present ONLY for a remote-capable
 * assistant (a chat scoped to one connected site); `titleSlug` is present ONLY
 * for a thread (an existing conversation). The four legal shapes:
 *   { vendor, slug }                            — new/empty chat
 *   { vendor, slug, titleSlug }                 — a local thread
 *   { vendor, slug, instance }                  — a new remote chat (site-scoped)
 *   { vendor, slug, instance, titleSlug }       — a remote thread (site-scoped)
 */
export type ChatRoute = {
  vendor: string;
  slug: string;
  /** The connected-site instance id — remote-capable assistants only. */
  instance?: string;
  /** The thread title-slug — present iff the route names an existing thread. */
  titleSlug?: string;
};

/** The discriminated result of parsing a `/chat` path. */
export type ParseChatPathResult =
  /** `/chat` (no segments) → redirect the browser to `to`. */
  | { kind: "redirect"; to: string }
  /** An un-routable path (a single legacy `/chat/<uuid>` segment — intentionally
   *  dead, AC#6 — or a structurally malformed path). Callers `notFound()`. */
  | { kind: "invalid" }
  /** A well-formed route. `remoteCapable` mismatches (e.g. a 4-segment path for a
   *  local assistant) resolve to `invalid`, not here. */
  | { kind: "route"; route: ChatRoute };

/** The structural (kind-agnostic) split: vendor + slug + the trailing segments,
 *  or a redirect/invalid verdict that needs no kind. */
export type ChatSegmentsSplit =
  | { kind: "redirect"; to: string }
  | { kind: "invalid" }
  | { kind: "base"; vendor: string; slug: string; rest: string[] };

// ---------------------------------------------------------------------------
// Package ⇔ vendor/slug (the anti-spoofing identity).
// ---------------------------------------------------------------------------

/** A single path segment is valid when non-empty and slash/whitespace-free
 *  (Next.js catch-all already URL-decodes segments). */
function isValidSegment(seg: unknown): seg is string {
  return typeof seg === "string" && seg.length > 0 && !/[\s/]/.test(seg);
}

/**
 * Parse an assistant PACKAGE name (`@<vendor>/<slug>`) into `{ vendor, slug }`.
 * Returns null for a non-scoped or malformed name — the route grammar only ever
 * addresses scoped assistant packages. Mirrors the A2A route's `@${vendor}/${slug}`
 * assembly.
 */
export function packageNameToVendorSlug(
  packageName: string,
): { vendor: string; slug: string } | null {
  if (typeof packageName !== "string" || !packageName.startsWith("@")) return null;
  const parts = packageName.slice(1).split("/");
  if (parts.length !== 2) return null;
  const [vendor, slug] = parts;
  if (!isValidSegment(vendor) || !isValidSegment(slug)) return null;
  return { vendor, slug };
}

/** Assemble the assistant PACKAGE name from a `{ vendor, slug }` pair. The exact
 *  reverse of {@link packageNameToVendorSlug}; throws on invalid segments so an
 *  ill-formed route can never mint a bogus package key. */
export function vendorSlugToPackageName(vendor: string, slug: string): string {
  if (!isValidSegment(vendor) || !isValidSegment(slug)) {
    throw new Error(`vendorSlugToPackageName: invalid vendor/slug (${vendor!}/${slug!})`);
  }
  return `@${vendor}/${slug}`;
}

/** The assistant package a route addresses. */
export function routePackageName(route: Pick<ChatRoute, "vendor" | "slug">): string {
  return vendorSlugToPackageName(route.vendor, route.slug);
}

// ---------------------------------------------------------------------------
// Build.
// ---------------------------------------------------------------------------

/**
 * Build the canonical `/chat` path for a route. Structural: `instance` (when
 * present) precedes `titleSlug`, matching the grammar. Throws on an invalid
 * segment so a malformed route never yields a silently-wrong URL. Round-trips
 * with {@link parseChatPath} for the matching `remoteCapable`.
 */
export function buildChatPath(
  route: ChatRoute,
  opts?: { scopeBase?: string | null },
): string {
  const segments: string[] = [route.vendor, route.slug];
  if (route.instance != null) segments.push(route.instance);
  if (route.titleSlug != null) segments.push(route.titleSlug);
  for (const seg of segments) {
    if (!isValidSegment(seg)) {
      throw new Error(`buildChatPath: invalid path segment ${JSON.stringify(seg)}`);
    }
  }
  return `${chatMountRoot(opts)}/${segments.join("/")}`;
}

/**
 * Assert a route is well-formed for a given launch topology. A `local`
 * assistant MUST NOT carry an instance; a `remote` THREAD (titleSlug present)
 * MUST carry an instance. Used by build call-sites + tests to keep illegal
 * shapes from ever reaching a URL. Returns the route for chaining.
 */
export function assertChatRoute(route: ChatRoute, opts: { remoteCapable: boolean }): ChatRoute {
  if (!opts.remoteCapable && route.instance != null) {
    throw new Error("assertChatRoute: a local assistant route must not carry an instance");
  }
  if (opts.remoteCapable && route.titleSlug != null && route.instance == null) {
    throw new Error("assertChatRoute: a remote thread route must be instance-scoped");
  }
  return route;
}

// ---------------------------------------------------------------------------
// Parse.
// ---------------------------------------------------------------------------

/** Normalize a raw catch-all `slug` param (Next.js gives `string[] | undefined`)
 *  to a clean `string[]` (drops empties defensively). */
function normalizeSegments(segments: readonly (string | undefined)[] | undefined): string[] {
  if (!segments) return [];
  return segments.filter((s): s is string => typeof s === "string" && s.length > 0);
}

/**
 * Phase 1 — the KIND-AGNOSTIC split. Establishes the redirect / invalid /
 * base(vendor,slug,rest) verdict WITHOUT needing the assistant's launch kind.
 * The caller resolves `remoteCapable` from `{ vendor, slug }` and then calls
 * {@link disambiguateRest} (or the combined {@link parseChatPath}).
 */
export function splitChatSegments(
  segments: readonly (string | undefined)[] | undefined,
): ChatSegmentsSplit {
  const segs = normalizeSegments(segments);
  // `/chat` — the bare mount redirects to the canonical default assistant.
  if (segs.length === 0) return { kind: "redirect", to: DEFAULT_CHAT_PATH };
  // A single segment can only be a legacy `/chat/<uuid>` — intentionally dead
  // (AC#6; no writer mints it any more). It is NOT a `<vendor>/<slug>` pair.
  if (segs.length === 1) return { kind: "invalid" };
  const [vendor, slug, ...rest] = segs;
  if (!isValidSegment(vendor) || !isValidSegment(slug)) return { kind: "invalid" };
  if (rest.some((s) => !isValidSegment(s))) return { kind: "invalid" };
  return { kind: "base", vendor, slug, rest };
}

/**
 * Phase 2 — disambiguate the trailing segments by the assistant's DECLARED
 * launch kind (never by format-sniffing the value):
 *   rest = []            → new/empty chat
 *   rest = [x]           → local: x is a titleSlug; remote: x is an instance
 *   rest = [i, t]        → remote ONLY: i=instance, t=titleSlug
 *   otherwise            → invalid (a >2 tail, or a 2-tail for a local kind)
 */
export function disambiguateRest(
  base: { vendor: string; slug: string },
  rest: readonly string[],
  opts: { remoteCapable: boolean },
): ParseChatPathResult {
  const { vendor, slug } = base;
  if (rest.length === 0) {
    return { kind: "route", route: { vendor, slug } };
  }
  if (rest.length === 1) {
    return opts.remoteCapable
      ? { kind: "route", route: { vendor, slug, instance: rest[0] } }
      : { kind: "route", route: { vendor, slug, titleSlug: rest[0] } };
  }
  if (rest.length === 2 && opts.remoteCapable) {
    return { kind: "route", route: { vendor, slug, instance: rest[0], titleSlug: rest[1] } };
  }
  // A local kind never has >1 trailing segment; any kind never has >2.
  return { kind: "invalid" };
}

/**
 * The combined parse: split + disambiguate. Use when the launch kind is already
 * known for the addressed `{ vendor, slug }`. For the redirect/invalid verdicts
 * `remoteCapable` is irrelevant (the phase-1 split settles them).
 */
export function parseChatPath(
  segments: readonly (string | undefined)[] | undefined,
  opts: { remoteCapable: boolean },
): ParseChatPathResult {
  const split = splitChatSegments(segments);
  if (split.kind !== "base") return split;
  return disambiguateRest({ vendor: split.vendor, slug: split.slug }, split.rest, opts);
}

// ---------------------------------------------------------------------------
// Client conveniences (used by the chat seams that build URLs / read the active
// thread out of `window.location.pathname`).
// ---------------------------------------------------------------------------

/** True when `route` names an existing thread (carries a titleSlug). */
export function routeIsThread(route: ChatRoute): boolean {
  return route.titleSlug != null;
}

/**
 * The active thread's titleSlug for a `/chat` pathname, given the addressed
 * assistant's launch kind — or null when the path is a new/empty chat, a
 * redirect, or invalid. The kind-aware replacement for the old
 * `pathname.match(/^\/chat\/([a-f0-9-]{36})$/)` reads in the client seams
 * (chat-page popstate, thread-panel active-row, AppShell title, breadcrumb).
 */
export function threadSlugFromPathname(
  pathname: string,
  opts: { remoteCapable: boolean },
): string | null {
  const { chatPathname } = splitChatScopeBase(pathname);
  if (!chatPathname.startsWith(CHAT_ROOT)) return null;
  const segments = chatPathname.slice(CHAT_ROOT.length).split("/");
  const parsed = parseChatPath(segments, opts);
  return parsed.kind === "route" ? parsed.route.titleSlug ?? null : null;
}

/** The raw `/chat` trailing segments of a pathname (`[]` when not under /chat or
 *  the bare mount). Kind-agnostic — feeds {@link splitChatSegments}. */
export function chatSegmentsFromPathname(pathname: string): string[] {
  const { chatPathname } = splitChatScopeBase(pathname);
  if (!chatPathname.startsWith(CHAT_ROOT)) return [];
  return normalizeSegments(chatPathname.slice(CHAT_ROOT.length).split("/"));
}

/** True when a pathname is any `/chat` path (the mount or below). The prefix
 *  checks that "survive as-is" (app-shell:241, app-sidebar) may keep using a
 *  literal `startsWith`; this is the codec-owned equivalent for new callers. */
export function isChatPathname(pathname: string): boolean {
  const { chatPathname } = splitChatScopeBase(pathname);
  return chatPathname === CHAT_ROOT || chatPathname.startsWith(`${CHAT_ROOT}/`);
}
