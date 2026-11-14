// Client-only bus bridging the app shell and the chat package across mount
// boundaries. Each value is held in a module variable so a consumer that
// mounts AFTER the producer emitted still reads the last value. This fixes
// two ordering races:
//
//   1. Breadcrumb (AppShell) vs ChatPage title emit on a direct-load of
//      `/chat/<uuid>`: ChatPage (a descendant) runs its title-emit effect
//      BEFORE AppShell (an ancestor) attaches its listener, so the one-shot
//      event is missed and the breadcrumb stays "Thread". AppShell now seeds
//      its initial title from `getCurrentChatThreadTitle()` and stays live
//      via the event.
//
//   2. Chat>Threads sidebar action vs ChatViewPanel mount when fired from a
//      non-chat route: the sidebar dispatches the open event then navigates
//      to /chat, but ChatViewPanel only mounts AFTER navigation, missing the
//      event. The desired panel is parked here and consumed on mount.
//
// All functions are SSR-safe (window-guarded) — the holders are plain module
// state that only the client mutates.

export const CHAT_TITLE_CHANGED_EVENT = "cinatra:chat:title-changed";
export const CHAT_SHOW_PANEL_EVENT = "cinatra:chat:show-panel";
/** A thread renamed on this page: `{ threadId, title }` (cinatra#4453). */
export const CHAT_THREAD_RENAMED_EVENT = "cinatra:chat:thread-renamed";

export type ChatPanel = "threads" | "teams";

// --- Active chat thread title -------------------------------------------

/**
 * WHAT A READ OF A THREAD ANSWERED FOR ITS NAME (cinatra#4453). Three answers,
 * because the components drawing (Breadcrumb section) draws three crumbs:
 *
 *   - `named`: the reader may read the thread, and it has a title. The crumb
 *     shows the title.
 *   - `blank`: the reader may read the thread, and its title is empty. "While a
 *     name is genuinely unavailable, the crumb shows the id's first eight
 *     characters plus an ellipsis".
 *   - `unavailable`: the read refused the reader, found no thread, or failed.
 *     The trail draws no thread crumb, so no part of the id reaches a reader
 *     who may not read the thread.
 */
export type ChatThreadName =
  | { state: "named"; name: string }
  | { state: "blank" }
  | { state: "unavailable" };

/** The answer for a thread a read returned (its title), or `unavailable` for none. */
export function chatThreadNameFromTitle(title: string | null | undefined): ChatThreadName {
  if (title == null) return { state: "unavailable" };
  const name = title.trim();
  return name ? { state: "named", name } : { state: "blank" };
}

/** The thread crumb's label for an answer, or `null` for no thread crumb. */
export function chatThreadCrumbLabel(answer: ChatThreadName, threadId: string): string | null {
  if (answer.state === "named") return answer.name;
  if (answer.state === "blank") return `${threadId.slice(0, 8)}\u2026`;
  return null;
}

let currentChatThreadTitle: string | null = null;

/** Set the active chat thread title (or null) + notify live listeners. */
export function publishChatThreadTitle(title: string | null): void {
  currentChatThreadTitle = title;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(CHAT_TITLE_CHANGED_EVENT, { detail: { title } }),
    );
  }
}

/** Last published chat thread title — used to seed a consumer that mounts
 *  after the producer emitted (direct-load race). */
export function getCurrentChatThreadTitle(): string | null {
  return currentChatThreadTitle;
}

// --- Pending chat-view panel open ---------------------------------------

let pendingChatPanel: ChatPanel | null = null;

/** Request the chat-view panel open to `panel`. Parks the request (for a
 *  ChatViewPanel that has not mounted yet) AND dispatches the live event
 *  (for an already-mounted one). */
export function requestChatPanel(panel: ChatPanel): void {
  pendingChatPanel = panel;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(CHAT_SHOW_PANEL_EVENT, { detail: panel }),
    );
  }
}

/** Read + clear any parked panel request. ChatViewPanel calls this on mount
 *  (cross-route open) and from its live listener (so a request handled while
 *  mounted is not re-consumed as stale on a later remount). */
export function consumePendingChatPanel(): ChatPanel | null {
  const panel = pendingChatPanel;
  pendingChatPanel = null;
  return panel;
}
