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
//      exact container, else `not-found`.
//
// The guard LOGIC is dependency-injected (registry read / instance auth / thread
// lookup are the DATA sources), so the whole decision is unit-testable without a
// session, a DB, or the network. The DEFAULT deps lazily import the heavy host
// modules so this file stays a light leaf for the test path.

import {
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
  /** The durable thread id for a container-scoped title-slug, or null. */
  resolveThreadIdBySlug(
    packageName: string,
    instanceId: string | null,
    titleSlug: string,
  ): Promise<string | null>;
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

  // 5. Thread resolution (titleSlug routes only).
  let threadId: string | null = null;
  if (route.titleSlug != null) {
    threadId = await deps.resolveThreadIdBySlug(
      canonicalPackageName,
      route.instance ?? null,
      route.titleSlug,
    );
    if (!threadId) return NOT_FOUND; // no such thread in this container → 404-hide
  }

  return { kind: "resolved", route, assistant, threadId };
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

/** The production deps (used by the /chat server component). */
export const DEFAULT_CHAT_ROUTE_RESOLVER_DEPS: ChatRouteResolverDeps = {
  readVisibleRegistry: readVisibleRegistryForCurrentActor,
  authorizeInstance: authorizeInstanceForCurrentActor,
  resolveThreadIdBySlug: resolveThreadIdBySlugForContainer,
};

/** Resolve using the production deps — the entry the /chat route calls. */
export function resolveChatRouteForCurrentActor(
  segments: readonly (string | undefined)[] | undefined,
): Promise<ChatRouteResolution> {
  return resolveChatRoute(segments, DEFAULT_CHAT_ROUTE_RESOLVER_DEPS);
}
