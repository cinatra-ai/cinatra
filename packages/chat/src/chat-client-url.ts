// ---------------------------------------------------------------------------
// Client-side /chat URL helpers (cinatra#1878 W3 AC#1/#6; cinatra#2562's
// pre-slug addressability fix). The thin client bridge over the pure path
// codec: build a thread's canonical URL from its binding + title-slug (falling
// back to its stable id before the slug mints), build an assistant's base
// (new-chat) URL, and match a browser pathname back to a known thread
// (kind-agnostic — a thread's own binding decides its URL shape, so no
// per-URL launch-kind lookup is needed in the client). The path builders below
// are pure (no React/DOM); `resolveChatPushUrl` / `resolveChatSlugUpgradeUrl`
// are the pure decision cores for the `useChatUrlSync` hook's effectful seams
// (push on selection, replace on slug-mint) at the foot — kept here, out of
// the page hub, and unit-testable without mounting a component.
import { useCallback, useEffect, useRef } from "react";
import {
  DEFAULT_ASSISTANT_PACKAGE,
  DEFAULT_CHAT_PATH,
  buildChatPath,
  packageNameToVendorSlug,
} from "./chat-path-codec";
import type { UiThreadSummary } from "./types";

/** The URL-relevant fields carried on a thread summary/record (all optional —
 *  an unbound legacy thread carries none and falls back to the default). */
export type ThreadUrlFields = {
  assistantPackage?: string | null;
  instanceId?: string | null;
  titleSlug?: string | null;
};

/** The live assistant/instance a not-yet-listed thread is seeded into — the
 *  container `pushChatUrl`'s pre-slug fallback below builds against. */
type ChatBinding = { assistantPackage: string | null; instanceId: string | null };

/** Shared builder: `/chat/<vendor>/<slug>[/<instance>]/<segment>`, or null for
 *  an unresolvable package. `segment` is either a minted title-slug or (before
 *  one exists) the thread's own stable id — the route resolver
 *  (`chat-route-resolver.ts`) tries a container-scoped ID lookup FIRST, then a
 *  title-slug lookup, so either segment addresses the thread (cinatra#2562;
 *  id-first closes a slug/id namespace collision — see that file's header). */
function chatThreadPath(
  thread: Pick<ThreadUrlFields, "assistantPackage" | "instanceId">,
  segment: string,
): string | null {
  const vs = packageNameToVendorSlug(thread.assistantPackage ?? DEFAULT_ASSISTANT_PACKAGE);
  if (!vs) return null;
  return buildChatPath({
    vendor: vs.vendor,
    slug: vs.slug,
    // An ABSENT package drops the instance too (cinatra#2650). The container is
    // the PAIR: a row with an instance and no package is in no container at
    // all, and pinning its stale instance onto the DEFAULT assistant's path
    // builds a URL that assistant has no instance scope to resolve. The same
    // normalization is applied by `resolveChatTurnContainer` below, so the URL
    // this builds and the container the server binds cannot disagree.
    instance: containerInstanceOf(thread),
    titleSlug: segment,
  });
}

/** The instance segment a binding contributes: only when a package is present.
 *  See {@link chatThreadPath}. Pure. */
function containerInstanceOf(
  binding: Pick<ThreadUrlFields, "assistantPackage" | "instanceId">,
): string | undefined {
  return binding.assistantPackage ? (binding.instanceId ?? undefined) : undefined;
}

/**
 * The canonical `/chat` path for a thread: its minted title-slug when present,
 * else its stable id (cinatra#2562 — a thread is ALWAYS addressable; the id
 * fallback keeps it in the URL until the server-minted slug arrives). Null
 * only for an unresolvable package, or a thread carrying neither a slug nor an
 * id. An unbound thread falls back to the builtin Cinatra assistant's
 * container.
 */
export function chatPathForThread(thread: ThreadUrlFields & { id?: string }): string | null {
  if (thread.titleSlug) return chatThreadPath(thread, thread.titleSlug);
  return thread.id ? chatThreadPath(thread, thread.id) : null;
}

/**
 * A thread's id-addressed path — its pre-slug URL shape, regardless of
 * whether a titleSlug has since minted. Used to recognize "the browser is
 * CURRENTLY on this thread's pre-slug URL" (cinatra#2562's slug-arrival
 * upgrade below, and `activeThreadIdForPathname`'s match).
 */
export function chatIdPathForThread(thread: ThreadUrlFields & { id: string }): string | null {
  return chatThreadPath(thread, thread.id);
}

/**
 * The base (new/empty chat) path for an assistant binding — `/chat/<vendor>/<slug>`
 * for a local assistant, `/chat/<vendor>/<slug>/<instance>` when instance-scoped.
 * Falls back to the canonical default path for an unbound/unresolvable binding.
 */
export function chatBasePathForAssistant(
  assistantPackage: string | null | undefined,
  instanceId?: string | null,
): string {
  const vs = packageNameToVendorSlug(assistantPackage ?? DEFAULT_ASSISTANT_PACKAGE);
  if (!vs) return DEFAULT_CHAT_PATH;
  return buildChatPath({
    vendor: vs.vendor,
    slug: vs.slug,
    // Same pairing rule as chatThreadPath (cinatra#2650).
    instance: containerInstanceOf({ assistantPackage, instanceId }),
  });
}

/**
 * Match a browser pathname to a known thread id by comparing each thread's
 * canonical path (slug, or id before one mints) AND its id-addressed path — the
 * kind-agnostic replacement for the old `pathname.match(/^\/chat\/([a-f0-9-]
 * {36})$/)` reads (popstate restore, the thread-panel active-row). The
 * id-path check keeps a thread re-highlighted from a lingering pre-slug URL
 * even after its slug later mints (cinatra#2562). Returns null when no known
 * thread matches (a new/empty chat path, or a not-yet-loaded deep link the
 * server already seeded).
 */
export function activeThreadIdForPathname<T extends ThreadUrlFields & { id: string }>(
  pathname: string,
  threads: readonly T[],
): string | null {
  for (const t of threads) {
    if (chatPathForThread(t) === pathname || chatIdPathForThread(t) === pathname) return t.id;
  }
  return null;
}

/**
 * Pure decision core for `pushChatUrl` (cinatra#2562): the URL a thread
 * selection should navigate to.
 *   1. A thread already in the live list → its canonical path (slug, or id
 *      fallback when no slug has minted yet).
 *   2. A thread not yet reflected in the list — e.g. selected synchronously
 *      right after being seeded, before the next render picks up the new
 *      `threads` value — is still addressable by id under the CURRENTLY bound
 *      assistant/instance, exactly the container a just-created thread is
 *      seeded into.
 *   3. No threadId (explicit clear) → the bound assistant's base path.
 */
export function resolveChatPushUrl<T extends ThreadUrlFields & { id: string }>(
  threadId: string | null,
  threads: readonly T[],
  binding: ChatBinding,
): string {
  const known = threadId ? threads.find((t) => t.id === threadId) : null;
  const thread = known ?? (threadId ? { id: threadId, ...binding } : null);
  return (
    (thread ? chatPathForThread(thread) : null) ??
    chatBasePathForAssistant(binding.assistantPackage, binding.instanceId)
  );
}

/** The /chat CONTAINER a turn is dispatched in (cinatra#2650) — what the server
 *  re-resolves and binds the thread to. Always fully-resolved: an unbound thread
 *  reports the DEFAULT package, never `null`. */
export type ChatTurnContainer = { assistantPackage: string; instanceId: string | null };

/**
 * Pure decision core for the container a turn asserts (cinatra#2650) — the
 * LIVE, LOGICAL container of the thread this turn is FOR, resolved at dispatch
 * time. It is deliberately the exact twin of {@link resolveChatPushUrl}'s
 * source selection, so the URL the client pushes and the container the server
 * binds can never disagree:
 *
 *   1. a thread already in the live list → ITS OWN logical container;
 *   2. a thread not yet in the list (just seeded, this render) → the mount's
 *      current binding, which is the container it is being created in.
 *
 * TWO NORMALIZATIONS, both load-bearing:
 *
 *  - AN UNBOUND THREAD REPORTS THE DEFAULT PACKAGE. `assistantPackage == null`
 *    is the documented "unbound (implicit-@cinatra)" state and is exactly how
 *    `chatPathForThread` already addresses such a thread, so the default is its
 *    real logical home — not "whatever container this tab happens to be in".
 *  - AN ABSENT PACKAGE DROPS THE INSTANCE. The container key is the PAIR; an
 *    instance scope with no package is in no container at all, and the server
 *    refuses that shape outright. Carrying a stale instance from the mount onto
 *    an unbound thread would fabricate a scope nobody authorized.
 *
 * Together these close the SPA transition the naive read gets wrong: mounted at
 * a NON-DEFAULT assistant, selecting an OLD UNBOUND thread from the sidebar
 * leaves `adoptThreadBinding`'s ref on the non-default package (it treats an
 * explicit `null` as "keep the current binding", by design, so the New-chat
 * button stays in this container) — sending on that thread must still bind the
 * DEFAULT, because the default is where that thread's URL resolves.
 */
export function resolveChatTurnContainer<T extends ThreadUrlFields & { id: string }>(
  threadId: string | null,
  threads: readonly T[],
  binding: ChatBinding,
): ChatTurnContainer {
  const known = threadId ? threads.find((t) => t.id === threadId) : null;
  const source: ThreadUrlFields = known ?? binding;
  return {
    assistantPackage: source.assistantPackage ?? DEFAULT_ASSISTANT_PACKAGE,
    instanceId: containerInstanceOf(source) ?? null,
  };
}

/**
 * Pure decision core for the slug-arrival URL upgrade (cinatra#2562): null
 * when no upgrade is due, else the canonical URL to `replaceState` to. Fires
 * only when the browser's CURRENT pathname is exactly some thread's id-shaped
 * URL and that thread now carries a titleSlug — so an unrelated thread minting
 * a slug elsewhere in the list never touches the address bar.
 */
export function resolveChatSlugUpgradeUrl<T extends ThreadUrlFields & { id: string }>(
  currentPathname: string,
  threads: readonly T[],
): string | null {
  for (const t of threads) {
    if (!t.titleSlug) continue;
    if (chatIdPathForThread(t) !== currentPathname) continue;
    const canonical = chatPathForThread(t);
    return canonical && canonical !== currentPathname ? canonical : null;
  }
  return null;
}

/**
 * cinatra#1878 W3: the client page's /chat URL sync — owns the live thread-list
 * + assistant-binding refs and the codec-backed helpers its window-event
 * handlers call (push a thread's URL, the new-chat base path, restore the active
 * thread from the pathname on back/forward, adopt a loaded thread's binding).
 * Kept here so the codec wiring stays out of the page hub.
 */
export function useChatUrlSync<T extends ThreadUrlFields & { id: string }>(
  threads: readonly T[],
  initialAssistantPackage: string | null | undefined,
  initialInstanceId: string | null | undefined,
): {
  pushChatUrl: (threadId: string | null) => void;
  pushNewChatUrl: () => void;
  restoreActiveThread: () => string | null;
  adoptThreadBinding: (thread: ThreadUrlFields) => void;
  newThreadSummary: (id: string, title: string, now: string) => UiThreadSummary;
  /** The container to assert on a turn for `threadId` (cinatra#2650). Reads the
   *  LIVE refs, so it is correct at DISPATCH time — after a sidebar selection, a
   *  New-chat, or a retry — not a stale render snapshot. */
  chatTurnContainer: (threadId: string | null) => ChatTurnContainer;
} {
  // Live refs so the []-deps window-event handlers never read a stale closure.
  const threadsRef = useRef<readonly T[]>([]);
  const bindingRef = useRef<ChatBinding>({
    assistantPackage: initialAssistantPackage ?? null,
    instanceId: initialInstanceId ?? null,
  });
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  const pushChatUrl = useCallback((threadId: string | null) => {
    const url = resolveChatPushUrl(threadId, threadsRef.current, bindingRef.current);
    window.history.pushState(null, "", url);
  }, []);

  // cinatra#2562: a thread's title-slug mints server-side on the first titled
  // persist and arrives on the NEXT threads refetch (`newThreadSummary` below
  // seeds a titleless summary) — upgrade the browser's id-addressed URL to the
  // canonical slug path IN PLACE the moment the mint is observed.
  // `replaceState`, never `pushState`: minting a slug is not a new
  // back-button stop, and the stale id URL is retired from history so a later
  // back/forward never lands on an address the thread has since outgrown.
  // This fires from a BACKGROUND poll (not an explicit user navigation like
  // pushChatUrl/pushNewChatUrl), so it must not silently drop a live
  // `?wf=<id>&task=<key>` deep-link query or hash still in the address bar —
  // carry the current search/hash across the pathname swap.
  useEffect(() => {
    const upgrade = resolveChatSlugUpgradeUrl(window.location.pathname, threads);
    if (upgrade) {
      window.history.replaceState(null, "", upgrade + window.location.search + window.location.hash);
    }
  }, [threads]);

  // New chat → the bound assistant's base path (guard avoids a no-op history entry).
  const pushNewChatUrl = useCallback(() => {
    const base = chatBasePathForAssistant(bindingRef.current.assistantPackage, bindingRef.current.instanceId);
    if (window.location.pathname !== base) window.history.pushState(null, "", base);
  }, []);

  const restoreActiveThread = useCallback(
    () => activeThreadIdForPathname(window.location.pathname, threadsRef.current),
    [],
  );

  const adoptThreadBinding = useCallback((thread: ThreadUrlFields) => {
    if (thread.assistantPackage !== undefined || thread.instanceId !== undefined) {
      bindingRef.current = {
        assistantPackage: thread.assistantPackage ?? bindingRef.current.assistantPackage,
        instanceId: thread.instanceId ?? bindingRef.current.instanceId,
      };
    }
  }, []);

  // Seed a just-created thread's summary with this mount's binding; the title-slug
  // is minted server-side on the first titled persist and arrives on the next refetch.
  const newThreadSummary = useCallback(
    (id: string, title: string, now: string): UiThreadSummary => ({
      id,
      title,
      createdAt: now,
      updatedAt: now,
      assistantPackage: bindingRef.current.assistantPackage,
      instanceId: bindingRef.current.instanceId,
    }),
    [],
  );

  const chatTurnContainer = useCallback(
    (threadId: string | null): ChatTurnContainer =>
      resolveChatTurnContainer(threadId, threadsRef.current, bindingRef.current),
    [],
  );

  return { pushChatUrl, pushNewChatUrl, restoreActiveThread, adoptThreadBinding, newThreadSummary, chatTurnContainer };
}
