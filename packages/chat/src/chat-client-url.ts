// ---------------------------------------------------------------------------
// Client-side /chat URL helpers (cinatra#1878 W3, AC#1/#6). The thin client
// bridge over the pure path codec: build a thread's canonical URL from its
// binding + title-slug, build an assistant's base (new-chat) URL, and match a
// browser pathname back to a known thread (kind-agnostic — a thread's own
// binding decides its URL shape, so no per-URL launch-kind lookup is needed in
// the client). The path builders below are pure (no React/DOM); the
// `useChatUrlSync` hook at the foot wires them to the client page's live
// thread-list + assistant-binding refs (kept here, out of the page hub).
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

/**
 * The canonical `/chat` path for a thread, or null when it cannot be addressed
 * yet (no minted title-slug, or an unresolvable package). An unbound thread
 * falls back to the builtin Cinatra assistant's container.
 */
export function chatPathForThread(thread: ThreadUrlFields): string | null {
  if (!thread.titleSlug) return null;
  const vs = packageNameToVendorSlug(thread.assistantPackage ?? DEFAULT_ASSISTANT_PACKAGE);
  if (!vs) return null;
  return buildChatPath({
    vendor: vs.vendor,
    slug: vs.slug,
    instance: thread.instanceId ?? undefined,
    titleSlug: thread.titleSlug,
  });
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
  return buildChatPath({ vendor: vs.vendor, slug: vs.slug, instance: instanceId ?? undefined });
}

/**
 * Match a browser pathname to a known thread id by comparing each thread's
 * canonical path — the kind-agnostic replacement for the old
 * `pathname.match(/^\/chat\/([a-f0-9-]{36})$/)` reads (popstate restore, the
 * thread-panel active-row). Returns null when no known thread matches (a
 * new/empty chat path, or a not-yet-loaded deep link the server already seeded).
 */
export function activeThreadIdForPathname<T extends ThreadUrlFields & { id: string }>(
  pathname: string,
  threads: readonly T[],
): string | null {
  for (const t of threads) {
    const p = chatPathForThread(t);
    if (p && p === pathname) return t.id;
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
} {
  // Live refs so the []-deps window-event handlers never read a stale closure.
  const threadsRef = useRef<readonly T[]>([]);
  const bindingRef = useRef<{ assistantPackage: string | null; instanceId: string | null }>({
    assistantPackage: initialAssistantPackage ?? null,
    instanceId: initialInstanceId ?? null,
  });
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  const pushChatUrl = useCallback((threadId: string | null) => {
    const thread = threadId ? threadsRef.current.find((t) => t.id === threadId) : null;
    const url =
      (thread ? chatPathForThread(thread) : null) ??
      chatBasePathForAssistant(bindingRef.current.assistantPackage, bindingRef.current.instanceId);
    window.history.pushState(null, "", url);
  }, []);

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

  return { pushChatUrl, pushNewChatUrl, restoreActiveThread, adoptThreadBinding, newThreadSummary };
}
