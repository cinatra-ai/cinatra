"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  CHAT_THREAD_RENAMED_EVENT,
  chatThreadCrumbLabel,
  chatThreadNameFromTitle,
  publishChatThreadTitle,
  type ChatThreadName,
} from "@/lib/chat-shell-bus";

// ---------------------------------------------------------------------------
// THE ACTIVE THREAD'S NAME IN THE BREADCRUMB (cinatra#4453).
//
// The components drawing, Breadcrumb section: a crumb that stands for an entity
// shows that entity's name; "While a name is genuinely unavailable, the crumb
// shows the id's first eight characters plus an ellipsis"; a refused or missing
// entity shows no part of the id. The chat trail draws "Chat › <thread>".
//
// WHERE THE NAME COMES FROM, freshest first:
//   1. The page's own reads of the active thread: the load when the thread
//      opens and the poll every few seconds. They are the read route's answer
//      for this reader, so they hold a rename by another writer and a deletion,
//      also for a thread the list never holds (a team thread, another user's
//      thread read by a platform admin, a legacy ownerless thread).
//   2. The page's thread list, for a thread no read has answered yet.
//   3. The server render's answer for the route's own thread, only until a read
//      or the list first holds that thread, so a direct load does not wait on a
//      fetch and a name the server read never outlives a fresher answer.
//
// A rename made on this page arrives as `CHAT_THREAD_RENAMED_EVENT` and wins at
// once. A read that was already on its way when the rename landed is dropped,
// so it cannot bring the old name back.
// ---------------------------------------------------------------------------

type ThreadSummaryLike = { id: string; title: string };

/** What a read of one thread answered: its title, or `null` for no thread. */
export type ThreadNameRead = { threadId: string; title: string | null };

const UNAVAILABLE: ChatThreadName = { state: "unavailable" };

/** The answer the crumb draws for the active thread, by the order above. */
export function crumbThreadName(input: {
  activeThreadId: string | null;
  read: ThreadNameRead | null;
  threads: readonly ThreadSummaryLike[];
  initialThreadId?: string;
  initialThreadName?: ChatThreadName;
  serverNameSpent: boolean;
}): ChatThreadName {
  const { activeThreadId, read, threads } = input;
  if (!activeThreadId) return UNAVAILABLE;
  if (read && read.threadId === activeThreadId) return chatThreadNameFromTitle(read.title);
  const listed = threads.find((t) => t.id === activeThreadId);
  if (listed) return chatThreadNameFromTitle(listed.title ?? "");
  if (activeThreadId === input.initialThreadId && !input.serverNameSpent && input.initialThreadName) {
    return input.initialThreadName;
  }
  return UNAVAILABLE;
}

/**
 * Publishes the active thread's crumb and returns `startThreadNameRead`: call it
 * when a read of a thread starts, and hand its answer (the thread, or `null`)
 * to the function it returns.
 */
export function useThreadCrumbName<T extends ThreadSummaryLike>(input: {
  activeThreadId: string | null;
  threads: T[];
  setThreads: Dispatch<SetStateAction<T[]>>;
  initialThreadId?: string;
  initialThreadName?: ChatThreadName;
}): (threadId: string) => (thread: { title?: string | null } | null) => void {
  const { activeThreadId, threads, setThreads, initialThreadId, initialThreadName } = input;
  const [read, setRead] = useState<ThreadNameRead | null>(null);
  const renameEpochRef = useRef(0);
  const serverNameSpentRef = useRef(false);

  const startThreadNameRead = useCallback((threadId: string) => {
    const epoch = renameEpochRef.current;
    return (thread: { title?: string | null } | null) => {
      if (epoch !== renameEpochRef.current) return;
      setRead({ threadId, title: thread ? (thread.title ?? "") : null });
    };
  }, []);

  useEffect(() => {
    function handleRenamed(e: Event) {
      const detail = (e as CustomEvent<{ threadId?: unknown; title?: unknown }>).detail;
      const threadId = detail?.threadId;
      const title = detail?.title;
      if (typeof threadId !== "string" || typeof title !== "string") return;
      renameEpochRef.current += 1;
      setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, title } : t)));
      setRead((prev) => (prev?.threadId === threadId ? { threadId, title } : prev));
    }
    window.addEventListener(CHAT_THREAD_RENAMED_EVENT, handleRenamed);
    return () => window.removeEventListener(CHAT_THREAD_RENAMED_EVENT, handleRenamed);
  }, [setThreads]);

  useEffect(() => {
    if (
      initialThreadId &&
      (read?.threadId === initialThreadId || threads.some((t) => t.id === initialThreadId))
    ) {
      serverNameSpentRef.current = true;
    }
    const name = crumbThreadName({
      activeThreadId,
      read,
      threads,
      initialThreadId,
      initialThreadName,
      serverNameSpent: serverNameSpentRef.current,
    });
    publishChatThreadTitle(activeThreadId ? chatThreadCrumbLabel(name, activeThreadId) : null);
  }, [activeThreadId, read, threads, initialThreadId, initialThreadName]);

  return startThreadNameRead;
}
