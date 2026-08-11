// ---------------------------------------------------------------------------
// /chat ROUTE GUARD + resolver (cinatra#1878 W3, AC#3). The server-side glue
// that turns raw `/chat/…` segments into either a redirect, a `not-found`
// (404-hide), or a fully-resolved route — enforcing, in order:
//
//   1. the path GRAMMAR (via the pure codec: bare /chat redirects; a lone
//      legacy /chat/<uuid> and any malformed path are invalid);
//   2. the ASSISTANT audience gate — `<vendor>/<slug>` must resolve to an entry
//      in the ACTOR's audience-filtered registry, else `not-found` (an unknown,
//      uninstalled, or out-of-audience assistant is indistinguishable from a
//      missing one — no existence leak);
//   3. the launch-kind disambiguation of the trailing segments (instance for a
//      remote assistant, titleSlug for a local one);
//   4. per-INSTANCE re-authorization — a remote route's `<instance>` is
//      re-checked against the actor-scoped `listAuthorizedInstances` authority
//      (live org-membership + per-instance connector authority, fail-closed), so
//      actor A can never resolve actor B's instance;
//   5. THREAD resolution — a `<titleSlug>` must name a real thread in that
//      exact container, else `not-found`. cinatra#2562: a thread is
//      addressable before its title-slug mints (the client's `pushChatUrl`
//      pre-slug shape reuses this SAME trailing segment for the thread's
//      stable id), so the segment is tried as a container-scoped ID FIRST,
//      falling back to a title-slug match. ID-first (not slug-first) is
//      deliberate: `slugifyTitle` can — for data written before this fix —
//      have minted a UUID-shaped slug from a thread literally titled as
//      another thread's id; trying the id first means the id owner always
//      wins that segment rather than an accidental/legacy same-shaped slug
//      (the allocator, assistant-thread-store.ts, additionally EXCLUDES a
//      UUID-shaped candidate at mint time going forward, so this is a
//      belt-and-braces pair, not a single point of correctness). Trying the
//      id first costs nothing for the overwhelmingly common non-UUID-shaped
//      slug — the id lookup rejects a non-UUID string before ever touching
//      the database — see chat-route-resolver.test.ts's "id-precedence
//      closes the slug/id namespace collision" case.
//
//      cinatra#2642 — the UNBOUND thread. `assistant_package IS NULL` is the
//      documented "unbound (implicit-@cinatra)" state, and the CLIENT already
//      addresses such a thread at `thread.assistantPackage ??
//      DEFAULT_ASSISTANT_PACKAGE`. The two container-scoped lookups above,
//      however, resolve ONLY the exact package, so an unbound row was
//      out-of-container for its own URL and 404'd. Two LAST-RESORT lookups
//      close that read-side gap, and BOTH are gated on the route being the
//      IMPLICIT-DEFAULT one (canonical package == DEFAULT_ASSISTANT_PACKAGE,
//      no instance) and on the actor OWNING the row. The resulting order is:
//
//        exact-container id → unbound id → exact-container slug → unbound slug
//
//      Unbound-id sits BEFORE the slug lookup so #2589's id-precedence rule is
//      preserved for unbound rows too; unbound-slug sits LAST so an EXPLICIT
//      binding always beats the implicit alias. The unbound deps take NO
//      package/instance parameter at all — a thread can never be resolved into
//      a container the caller merely names — and the guard, not just the
//      production dep, enforces the implicit-default gate. The production dep
//      additionally performs a BEST-EFFORT, idempotent repair that makes the
//      implicit binding explicit; resolution NEVER depends on that write
//      succeeding (see assistant-thread-store.ts's implicit-default section).
//
// The guard LOGIC is dependency-injected (registry read / instance auth / thread
// lookup are the DATA sources), so the whole decision is unit-testable without a
// session, a DB, or the network. The DEFAULT deps lazily import the heavy host
// modules so this file stays a light leaf for the test path.

import {
  DEFAULT_ASSISTANT_PACKAGE,
  disambiguateRest,
  splitChatSegments,
  vendorSlugToPackageName,
  type ChatRoute,
} from "@cinatra-ai/chat/chat-path-codec";
import type { AssistantRegistryEntry } from "@/lib/assistant-registry-reader";
import {
  remoteConnectorKindForProvider,
  type RemoteConnectorKind,
} from "@/lib/assistant-remote-target";

/** The resolved assistant a `/chat` route addresses. */
export type ChatRouteAssistant = {
  packageName: string;
  entry: AssistantRegistryEntry;
  /** launch.kind === "remote" — the codec disambiguated the third segment as an
   *  instance, and remote destinations/flyout apply. */
  remoteCapable: boolean;
  targetProvider: string | null;
};

/** The discriminated outcome of resolving a `/chat` route. */
export type ChatRouteResolution =
  | { kind: "redirect"; to: string }
  | { kind: "not-found" }
  | {
      kind: "resolved";
      route: ChatRoute;
      assistant: ChatRouteAssistant;
      /** The durable thread id (a titleSlug route), or null for a new/empty chat. */
      threadId: string | null;
    };

/** The injectable data sources the guard consults. */
export type ChatRouteResolverDeps = {
  /** The ACTOR's audience-filtered registry entries (the one audience truth). */
  readVisibleRegistry(): Promise<AssistantRegistryEntry[]>;
  /** True when the CURRENT actor is authorized to `use` this instance of the
   *  connector kind (the actor-scoped listAuthorizedInstances authority). */
  authorizeInstance(kind: RemoteConnectorKind, instanceId: string): Promise<boolean>;
  /** The durable thread id for a container-scoped title-slug, or null. Tried
   *  only after {@link resolveThreadIdById} misses (id takes precedence —
   *  see the module header). */
  resolveThreadIdBySlug(
    packageName: string,
    instanceId: string | null,
    titleSlug: string,
  ): Promise<string | null>;
  /** The durable thread id for a container-scoped thread id — cinatra#2562's
   *  pre-slug fallback, tried FIRST (before the slug lookup): the trailing
   *  segment may be a thread's stable id, addressed before its title-slug
   *  minted. Returns null for a non-UUID-shaped / non-matching / out-of-container
   *  value — cheaply, without a slug/id namespace collision (a thread titled
   *  literally as another thread's id can never shadow it). */
  resolveThreadIdById(
    packageName: string,
    instanceId: string | null,
    threadId: string,
  ): Promise<string | null>;
  /** The durable thread id for an UNBOUND thread the CURRENT ACTOR OWNS,
   *  addressed by its stable id in the IMPLICIT-DEFAULT container
   *  (cinatra#2642). Consulted ONLY on the implicit-default route (the guard
   *  checks that before calling — see step 5), and takes NO package/instance
   *  parameter BY DESIGN: no caller can name the container a thread resolves
   *  into. Returns null for a non-UUID-shaped value, an absent row, a BOUND
   *  row, a team row, an ownerless row, another actor's row, or an org
   *  mismatch.
   *
   *  OPTIONAL: omitting it disables ONLY this last-resort lookup, which fails
   *  MORE closed (exactly the pre-#2642 behaviour) — never more open. That
   *  keeps every existing injected-dep caller (and the #2589 suite) valid
   *  unchanged; the PRODUCTION deps always supply it, pinned by a test. */
  resolveUnboundThreadIdById?(threadId: string): Promise<string | null>;
  /** The title-slug twin of {@link resolveUnboundThreadIdById} — tried LAST, so
   *  an EXPLICITLY bound thread owning the same slug in the default container
   *  always wins the segment (cinatra#2642). Optional on the same terms. */
  resolveUnboundThreadIdBySlug?(titleSlug: string): Promise<string | null>;
};

const NOT_FOUND: ChatRouteResolution = { kind: "not-found" };

/**
 * Resolve `/chat` segments against the actor's audience + instance authority.
 * Pure given `deps`. See the module header for the ordered guard.
 */
export async function resolveChatRoute(
  segments: readonly (string | undefined)[] | undefined,
  deps: ChatRouteResolverDeps,
): Promise<ChatRouteResolution> {
  // 1. Grammar (redirect / invalid / base).
  const split = splitChatSegments(segments);
  if (split.kind === "redirect") return { kind: "redirect", to: split.to };
  if (split.kind !== "base") return NOT_FOUND;
  const { vendor, slug, rest } = split;

  // 2. Assistant audience gate. Package-derived identity (anti-spoofing): match
  //    the registry entry by its full package name, never a display handle.
  let packageName: string;
  try {
    packageName = vendorSlugToPackageName(vendor, slug);
  } catch {
    return NOT_FOUND; // an un-encodable vendor/slug can never be a package
  }
  const entries = await deps.readVisibleRegistry();
  const target = packageName.toLowerCase();
  const entry = entries.find((e) => e.packageName.toLowerCase() === target);
  if (!entry) return NOT_FOUND; // unknown / uninstalled / out-of-audience → 404-hide

  // Canonical package identity: adopt the REGISTRY entry's own packageName, not
  // the URL-cased route-derived one. The audience match above is CASE-INSENSITIVE,
  // so `/chat/Cinatra-AI/Foo` and `/chat/cinatra-ai/foo` resolve to the same entry;
  // the thread BINDING + slug-container key must therefore key off ONE canonical
  // identity, or a thread minted under one URL casing would be unresolvable under
  // another (a split container). This is the single identity carried downstream.
  const canonicalPackageName = entry.packageName;
  const remoteCapable = entry.launch.kind === "remote";
  const targetProvider = entry.launch.targetProvider;
  const assistant: ChatRouteAssistant = {
    packageName: canonicalPackageName,
    entry,
    remoteCapable,
    targetProvider,
  };

  // 3. Launch-kind disambiguation of the trailing segments.
  const parsed = disambiguateRest({ vendor, slug }, rest, { remoteCapable });
  if (parsed.kind !== "route") return NOT_FOUND;
  const { route } = parsed;

  // 4. Per-instance re-authorization (remote routes only).
  if (route.instance != null) {
    const kind = remoteConnectorKindForProvider(targetProvider);
    // A remote assistant with no first-party provider resolver cannot scope to a
    // site — treat the instance segment as unroutable (fail-closed).
    if (!kind) return NOT_FOUND;
    const authorized = await deps.authorizeInstance(kind, route.instance);
    if (!authorized) return NOT_FOUND; // not the actor's instance → 404-hide
  }

  // 5. Thread resolution (titleSlug routes only). ID FIRST (cinatra#2562):
  // closes a slug/id namespace collision — a thread titled literally as
  // another thread's id (slugifyTitle permits a UUID-shaped slug) must never
  // shadow that thread's pre-slug URL. Free for the common non-UUID-shaped
  // segment: the id lookup rejects the format before touching the database.
  let threadId: string | null = null;
  if (route.titleSlug != null) {
    // The IMPLICIT-DEFAULT container (cinatra#2642): the ONE container an
    // UNBOUND thread already lives in for the client's own URL builder
    // (`thread.assistantPackage ?? DEFAULT_ASSISTANT_PACKAGE`). Gated HERE, in
    // the pure guard — not only inside the production dep — so no injected
    // dep set can bypass the rule.
    const implicitDefaultRoute =
      route.instance == null &&
      canonicalPackageName.toLowerCase() === DEFAULT_ASSISTANT_PACKAGE.toLowerCase();

    threadId = await deps.resolveThreadIdById(
      canonicalPackageName,
      route.instance ?? null,
      route.titleSlug,
    );
    if (!threadId && implicitDefaultRoute) {
      // An UNBOUND thread the actor OWNS, addressed by its id. BEFORE the slug
      // lookup so #2589's id-precedence rule survives intact: a (legacy)
      // UUID-shaped title_slug in this container must never shadow the thread
      // whose actual id that segment is.
      threadId = (await deps.resolveUnboundThreadIdById?.(route.titleSlug)) ?? null;
    }
    if (!threadId) {
      // No thread owns this segment as its id — fall back to a title-slug match.
      threadId = await deps.resolveThreadIdBySlug(
        canonicalPackageName,
        route.instance ?? null,
        route.titleSlug,
      );
    }
    if (!threadId && implicitDefaultRoute) {
      // LAST: an UNBOUND thread the actor OWNS, addressed by its title_slug.
      // Last by design — an EXPLICIT binding always beats the implicit alias.
      threadId = (await deps.resolveUnboundThreadIdBySlug?.(route.titleSlug)) ?? null;
    }
    if (!threadId) return NOT_FOUND; // no such thread in this container → 404-hide
  }

  return { kind: "resolved", route, assistant, threadId };
}

// ---------------------------------------------------------------------------
// The CONTAINER a turn creates its thread in (cinatra#2650).
//
// A /chat turn must record WHICH assistant's container the new thread belongs
// to, and nothing on the wire may be trusted to say so. The browser knows the
// container only because THIS module told it: the /chat page resolves the route
// here and hands the client `initialAssistantPackage` / `initialInstanceId`.
// The turn POST carries that value back as an ASSERTION, and the server
// RE-RESOLVES it through the SAME two authorities the page used — the actor's
// audience-filtered registry, and the per-instance `authorizeInstance`
// authority. The bound value is the REGISTRY ENTRY'S OWN `packageName`, never
// the caller's string, so a forged, uninstalled, out-of-audience, or
// wrong-cased assertion can never become a binding.
//
// The trust model is deliberately the SAME one the sibling producer selector
// already uses (`body.assistant`: the client names a handle, the server
// resolves it to a principal and audience-gates it, 404-hiding a forged one) —
// one model on one request body, not two.
//
// REFUSAL IS HARD, NEVER A SILENT DEFAULT (codex round-0/1): an assertion that
// does not resolve is a 404 at the caller, exactly like the producer selector's
// refusal. Only an ABSENT assertion falls back to the implicit default — that
// is the compatibility path for a caller that has no container (an old client,
// the MCP surface), not an error being swallowed.
// ---------------------------------------------------------------------------

/** What the client asserts about the /chat container its turn is running in. */
export type ChatContainerAssertion = {
  assistantPackage: string;
  instanceId?: string | null;
};

/** The SERVER-RESOLVED container a thread is bound into. `assistantPackage` is
 *  the registry entry's own canonical spelling. */
export type ResolvedChatContainer = {
  assistantPackage: string;
  instanceId: string | null;
};

export type ResolveChatContainerResult =
  | { ok: true; container: ResolvedChatContainer }
  | { ok: false; code: "unknown-assistant" | "unauthorized-instance" };

/** The two authorities a container resolution consults — the SAME members of
 *  {@link ChatRouteResolverDeps} the route guard's steps 2 and 4 use. */
export type ChatContainerResolverDeps = Pick<
  ChatRouteResolverDeps,
  "readVisibleRegistry" | "authorizeInstance"
>;

/**
 * Re-resolve a client-asserted /chat container against the ACTOR's own
 * authority. Pure given `deps`.
 *
 * - an ABSENT assertion resolves to the IMPLICIT DEFAULT container (the builtin
 *   assistant, no instance) WITHOUT consulting either authority: no claim was
 *   made, so there is nothing to authorize, and the default is the container an
 *   unbound row already lives in for the client's URL builder and for #2649's
 *   alias. This is the compatibility path for a caller that has no container;
 *   the default container's own decision lives HERE, in the module that owns
 *   the /chat container concept, rather than being restated at each call site;
 * - the package matches the audience-filtered registry CASE-INSENSITIVELY (the
 *   route guard's rule), and the resolved container carries the ENTRY's
 *   canonical `packageName`;
 * - an instance is honored ONLY on a `remote`-launch assistant with a
 *   first-party connector kind, and ONLY after `authorizeInstance` passes — so
 *   actor A can never home a thread in actor B's instance, and an instance can
 *   never be pinned onto a local assistant that has no such scope;
 * - anything else refuses. The caller 404-hides, never falls back.
 */
export async function resolveChatContainer(
  assertion: ChatContainerAssertion | null | undefined,
  deps: ChatContainerResolverDeps,
): Promise<ResolveChatContainerResult> {
  if (!assertion) {
    return {
      ok: true,
      container: { assistantPackage: DEFAULT_ASSISTANT_PACKAGE, instanceId: null },
    };
  }
  const asserted = assertion.assistantPackage.trim().toLowerCase();
  if (!asserted) return { ok: false, code: "unknown-assistant" };
  const entries = await deps.readVisibleRegistry();
  const entry = entries.find((e) => e.packageName.toLowerCase() === asserted);
  if (!entry) return { ok: false, code: "unknown-assistant" };

  const instanceId = assertion.instanceId?.trim() ? assertion.instanceId.trim() : null;
  if (!instanceId) return { ok: true, container: { assistantPackage: entry.packageName, instanceId: null } };

  // An instance scope only exists for a remote-launch assistant, and only for
  // the instances THIS actor is authorized to use (fail-closed on both).
  if (entry.launch.kind !== "remote") return { ok: false, code: "unauthorized-instance" };
  const kind = remoteConnectorKindForProvider(entry.launch.targetProvider);
  if (!kind) return { ok: false, code: "unauthorized-instance" };
  if (!(await deps.authorizeInstance(kind, instanceId))) {
    return { ok: false, code: "unauthorized-instance" };
  }
  return { ok: true, container: { assistantPackage: entry.packageName, instanceId } };
}

// ---------------------------------------------------------------------------
// Default (production) deps — lazily import the heavy host graph so this module
// stays a light leaf on the unit-test path.
// ---------------------------------------------------------------------------

/** Read the current actor's audience-visible registry (builtin-only when there
 *  is no session — fail-toward-less-visibility, matching server-audience-resolver). */
async function readVisibleRegistryForCurrentActor(): Promise<AssistantRegistryEntry[]> {
  const { getAuthSession, isPlatformAdmin } = await import("@/lib/auth-session");
  const { resolveAssistantAudienceContext, readAssistantRegistryForActor } = await import(
    "@/lib/assistant-registry-reader"
  );
  const session = await getAuthSession();
  if (!session) {
    const entries = await readAssistantRegistryForActor({
      userId: "",
      isPlatformAdmin: false,
      orgIds: new Set(),
      teamIds: new Set(),
      projectIds: new Set(),
    });
    return entries.filter((e) => e.isBuiltin);
  }
  const activeOrgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)?.activeOrganizationId ??
    null;
  const ctx = await resolveAssistantAudienceContext({
    userId: session.user.id,
    activeOrgId,
    isPlatformAdmin: isPlatformAdmin(session),
  });
  return readAssistantRegistryForActor(ctx);
}

/** Actor-scoped instance authorization via the connector list authority. */
async function authorizeInstanceForCurrentActor(
  kind: RemoteConnectorKind,
  instanceId: string,
): Promise<boolean> {
  const { createInstanceListAuthority } = await import("@/lib/connector-instance-write-authority");
  const filter = createInstanceListAuthority(kind);
  const allowed = await filter([{ id: instanceId }]);
  return allowed.length > 0;
}

/** Container-scoped title-slug → thread id. */
async function resolveThreadIdBySlugForContainer(
  packageName: string,
  instanceId: string | null,
  titleSlug: string,
): Promise<string | null> {
  const { getAssistantThreadBySlug } = await import("@/lib/assistant-thread-store");
  return getAssistantThreadBySlug(packageName, instanceId, titleSlug)?.id ?? null;
}

/** Container-scoped thread id → thread id (cinatra#2562's pre-slug fallback). */
async function resolveThreadIdByIdForContainer(
  packageName: string,
  instanceId: string | null,
  threadId: string,
): Promise<string | null> {
  const { getAssistantThreadByIdInContainer } = await import("@/lib/assistant-thread-store");
  return getAssistantThreadByIdInContainer(packageName, instanceId, threadId)?.id ?? null;
}

/** The CURRENT actor for an implicit-default unbound lookup (cinatra#2642):
 *  transport-derived only (the session), NEVER route/tool input. Null when
 *  there is no session or no user id — the lookups then refuse outright. */
async function currentUnboundThreadActor(): Promise<{
  userId: string;
  orgId: string | null;
} | null> {
  const { getAuthSession } = await import("@/lib/auth-session");
  const session = await getAuthSession();
  const userId = session?.user?.id ?? "";
  if (!userId) return null;
  return { userId, orgId: session?.session?.activeOrganizationId ?? null };
}

/** Resolve an UNBOUND thread the actor OWNS by id, in the implicit-default
 *  container, and make its implicit binding EXPLICIT (cinatra#2642).
 *
 *  The repair is BEST-EFFORT and NOT load-bearing: the id above already
 *  resolved read-only, so a refused or raced repair changes nothing about this
 *  request. That is what makes it safe on a GET render — a prefetched/retried
 *  render just re-normalizes a row into the container it already logically
 *  belongs to (idempotent, and it never bumps `updated_at`). */
async function resolveUnboundThreadIdByIdForCurrentActor(
  threadId: string,
): Promise<string | null> {
  const actor = await currentUnboundThreadActor();
  if (!actor) return null;
  const { getOwnedUnboundAssistantThreadById, repairImplicitDefaultThreadBinding } = await import(
    "@/lib/assistant-thread-store"
  );
  const thread = getOwnedUnboundAssistantThreadById(threadId, actor);
  if (!thread) return null;
  repairImplicitDefaultThreadBinding(thread.id, actor);
  return thread.id;
}

/** The title-slug twin of {@link resolveUnboundThreadIdByIdForCurrentActor}. */
async function resolveUnboundThreadIdBySlugForCurrentActor(
  titleSlug: string,
): Promise<string | null> {
  const actor = await currentUnboundThreadActor();
  if (!actor) return null;
  const { getOwnedUnboundAssistantThreadBySlug, repairImplicitDefaultThreadBinding } = await import(
    "@/lib/assistant-thread-store"
  );
  const thread = getOwnedUnboundAssistantThreadBySlug(titleSlug, actor);
  if (!thread) return null;
  repairImplicitDefaultThreadBinding(thread.id, actor);
  return thread.id;
}

/** The production deps (used by the /chat server component). */
export const DEFAULT_CHAT_ROUTE_RESOLVER_DEPS: ChatRouteResolverDeps = {
  readVisibleRegistry: readVisibleRegistryForCurrentActor,
  authorizeInstance: authorizeInstanceForCurrentActor,
  resolveThreadIdBySlug: resolveThreadIdBySlugForContainer,
  resolveThreadIdById: resolveThreadIdByIdForContainer,
  resolveUnboundThreadIdById: resolveUnboundThreadIdByIdForCurrentActor,
  resolveUnboundThreadIdBySlug: resolveUnboundThreadIdBySlugForCurrentActor,
};

/** Re-resolve an asserted /chat container with the production authorities — the
 *  entry `POST /api/assistants/chat` calls (cinatra#2650). Reuses the SAME dep
 *  object the route guard runs on, so container resolution and route resolution
 *  can never drift onto two different audience/instance authorities. */
export function resolveChatContainerForCurrentActor(
  assertion: ChatContainerAssertion | null | undefined,
): Promise<ResolveChatContainerResult> {
  return resolveChatContainer(assertion, DEFAULT_CHAT_ROUTE_RESOLVER_DEPS);
}

/** Resolve using the production deps — the entry the /chat route calls. */
export function resolveChatRouteForCurrentActor(
  segments: readonly (string | undefined)[] | undefined,
): Promise<ChatRouteResolution> {
  return resolveChatRoute(segments, DEFAULT_CHAT_ROUTE_RESOLVER_DEPS);
}
