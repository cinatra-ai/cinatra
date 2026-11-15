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
// WHERE THE NAME COMES FROM, in this order:
//   1. The page's own reads of the active thread: the load when the thread
//      opens and the poll every few seconds. They are the read route's answer
//      for this reader, so they hold a rename by another writer and a deletion,
//      also for a thread the list never holds (a team thread, another user's
//      thread read by a platform admin, a legacy ownerless thread).
//      Reads can overlap. Of the reads asked while the reader stays on the
//      thread, the crumb keeps the answer of the one asked last that has
//      answered: an older answer that arrives later is dropped, a title and a
//      not-found alike. A switch to another thread, also away and back, drops
//      the kept answer and every read asked before it.
//   2. The page's thread list, for a thread no read of this visit has answered.
//   3. The server render's answer for the route's own thread, until it is
//      spent, so a direct load does not wait on a fetch. The answer is spent
//      when a read or the list holds that thread, or when the reader switches
//      to another thread (also away and back). A spent answer stays spent for the rest
//      of the document, also after a remount with the same cached server props:
//      a server answer the page has already replaced, or left, never comes back,
//      for a renamed or a deleted thread alike. A server render that answers
//      differently (a new name, a new state) is a new answer.
//
// A rename made on this page arrives as `CHAT_THREAD_RENAMED_EVENT` and wins at
// once. A read of the renamed thread that was already on its way when the
// rename landed is dropped, so it cannot bring the old name back. A rename of
// another thread leaves the reads of the active thread alone.
//
// While a reply streams, the page polls neither the thread nor the list
// (chat-page.tsx), so a rename or a deletion by another writer reaches the
// crumb with the first poll after the stream ends.
// ---------------------------------------------------------------------------

type ThreadSummaryLike = { id: string; title: string };

/** What a read of one thread answered: its title, or `null` for no thread. */
export type ThreadNameRead = { threadId: string; title: string | null };

const UNAVAILABLE: ChatThreadName = { state: "unavailable" };

// The server answers spent in this document, by thread and answer. A remount
// that receives the same cached answer again does not draw it (source 3 above).
const spentServerAnswers = new Set<string>();

function serverAnswerKey(threadId: string, answer: ChatThreadName): string {
  return `${threadId}\u0000${JSON.stringify(answer)}`;
}

/** For tests: forget the server answers spent in this document. */
export function forgetSpentServerThreadNames(): void {
  spentServerAnswers.clear();
}

/** The reads of one visit to a thread: the newest answer by the order asked. */
type ThreadVisit = { threadId: string | null; visit: number; read: ThreadNameRead | null; readSeq: number };

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
  const [visit, setVisit] = useState<ThreadVisit>({ threadId: activeThreadId, visit: 0, read: null, readSeq: 0 });
  if (visit.threadId !== activeThreadId) {
    // Another thread, or this one again after another: a new visit keeps no read.
    setVisit((v) => ({ threadId: activeThreadId, visit: v.visit + 1, read: null, readSeq: 0 }));
  }
  const read = visit.read;
  const currentVisit = visit.visit;
  // Per thread: how many renames this page made of it. A read that started
  // before a rename of its own thread answers too late to count.
  const renameEpochsRef = useRef<Map<string, number>>(new Map());
  const readSeqRef = useRef(0);

  const startThreadNameRead = useCallback(
    (threadId: string) => {
      const epoch = renameEpochsRef.current.get(threadId) ?? 0;
      const seq = ++readSeqRef.current;
      return (thread: { title?: string | null } | null) => {
        if (epoch !== (renameEpochsRef.current.get(threadId) ?? 0)) return;
        setVisit((v) =>
          v.visit !== currentVisit || v.threadId !== threadId || seq <= v.readSeq
            ? v
            : { ...v, read: { threadId, title: thread ? (thread.title ?? "") : null }, readSeq: seq },
        );
      };
    },
    [currentVisit],
  );

  useEffect(() => {
    function handleRenamed(e: Event) {
      const detail = (e as CustomEvent<{ threadId?: unknown; title?: unknown }>).detail;
      const threadId = detail?.threadId;
      const title = detail?.title;
      if (typeof threadId !== "string" || typeof title !== "string") return;
      renameEpochsRef.current.set(threadId, (renameEpochsRef.current.get(threadId) ?? 0) + 1);
      setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, title } : t)));
      setVisit((v) => (v.read?.threadId === threadId ? { ...v, read: { threadId, title } } : v));
    }
    window.addEventListener(CHAT_THREAD_RENAMED_EVENT, handleRenamed);
    return () => window.removeEventListener(CHAT_THREAD_RENAMED_EVENT, handleRenamed);
  }, [setThreads]);

  useEffect(() => {
    const serverKey =
      initialThreadId && initialThreadName ? serverAnswerKey(initialThreadId, initialThreadName) : null;
    if (
      serverKey &&
      (currentVisit > 0 || read?.threadId === initialThreadId || threads.some((t) => t.id === initialThreadId))
    ) {
      spentServerAnswers.add(serverKey);
    }
    const name = crumbThreadName({
      activeThreadId,
      read,
      threads,
      initialThreadId,
      initialThreadName,
      serverNameSpent: serverKey === null || spentServerAnswers.has(serverKey),
    });
    publishChatThreadTitle(activeThreadId ? chatThreadCrumbLabel(name, activeThreadId) : null);
  }, [activeThreadId, currentVisit, read, threads, initialThreadId, initialThreadName]);

  return startThreadNameRead;
}
