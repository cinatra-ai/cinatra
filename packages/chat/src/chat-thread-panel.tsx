"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Edit, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { deleteChatThread, renameChatThread } from "./actions";

type ThreadSummary = { id: string; title: string; createdAt: string; updatedAt: string };

function formatRelativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ChatThreadPanel({ initialThreads = [], embedded = false }: { initialThreads?: ThreadSummary[]; embedded?: boolean }) {
  const pathname = usePathname();
  const [threads, setThreads] = useState<ThreadSummary[]>(initialThreads);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [sortMode, setSortMode] = useState<"recent" | "newest">("recent");
  const inputRef = useRef<HTMLInputElement>(null);
  const threadRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Initialize from URL (SSR / direct load), then stay in sync via events from ChatPage.
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    pathname.match(/^\/chat\/([a-f0-9-]{36})$/)?.[1] ?? null,
  );

  useEffect(() => {
    function handleThreadsChanged(e: Event) {
      const detail = (e as CustomEvent<ThreadSummary[]>).detail;
      if (Array.isArray(detail)) setThreads(detail);
    }
    function handleActiveChanged(e: Event) {
      const { threadId } = (e as CustomEvent<{ threadId: string | null }>).detail;
      setActiveThreadId(threadId ?? null);
    }

    window.addEventListener("cinatra:chat:threads-changed", handleThreadsChanged);
    window.addEventListener("cinatra:chat:active-changed", handleActiveChanged);
    return () => {
      window.removeEventListener("cinatra:chat:threads-changed", handleThreadsChanged);
      window.removeEventListener("cinatra:chat:active-changed", handleActiveChanged);
    };
  }, []);

  useEffect(() => {
    if (editingId) inputRef.current?.focus();
  }, [editingId]);

  // Scroll the active thread into view when selection changes or the list loads.
  // block:"nearest" only scrolls if the element is off-screen — avoids jumps.
  useEffect(() => {
    if (!activeThreadId) return;
    const el = threadRefs.current.get(activeThreadId);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeThreadId, threads]);

  function handleNewChat() {
    window.dispatchEvent(new CustomEvent("cinatra:chat:new"));
  }

  function startEdit(thread: ThreadSummary) {
    setEditDraft(thread.title);
    setEditingId(thread.id);
  }

  function navigateToThread(threadId: string) {
    window.dispatchEvent(new CustomEvent("cinatra:chat:select", { detail: { threadId } }));
  }

  async function commitEdit(threadId: string) {
    const trimmed = editDraft.trim();
    if (trimmed && trimmed !== threads.find((t) => t.id === threadId)?.title) {
      await renameChatThread(threadId, trimmed);
      setThreads((prev) =>
        prev.map((t) => (t.id === threadId ? { ...t, title: trimmed } : t)),
      );
    }
    setEditingId(null);
  }

  const sortedThreads = [...threads].sort((a, b) => {
    if (sortMode === "recent") return b.updatedAt.localeCompare(a.updatedAt);
    return b.createdAt.localeCompare(a.createdAt); // newest created first
  });

  if (embedded) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setSortMode("recent")}
            className={cn("h-7 px-2 text-xs", sortMode === "recent" ? "text-foreground" : "text-muted-foreground")}
          >
            Activity
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setSortMode("newest")}
            className={cn("h-7 px-2 text-xs", sortMode === "newest" ? "text-foreground" : "text-muted-foreground")}
          >
            Newest
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {sortedThreads.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">No conversations yet</p>
          ) : (
            sortedThreads.map((thread) => (
              <Fragment key={thread.id}>
                <div
                  role={editingId === thread.id ? undefined : "button"}
                  tabIndex={editingId === thread.id ? undefined : 0}
                  onClick={editingId === thread.id ? undefined : () => navigateToThread(thread.id)}
                  onKeyDown={editingId === thread.id ? undefined : (e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigateToThread(thread.id); }
                  }}
                  ref={(el) => { if (el) threadRefs.current.set(thread.id, el); else threadRefs.current.delete(thread.id); }}
                  className={cn(
                    "group rounded-md px-2 py-2",
                    editingId !== thread.id && "cursor-pointer",
                    "hover:bg-accent hover:text-accent-foreground",
                    activeThreadId === thread.id && "bg-muted",
                  )}
                >
                  {editingId === thread.id ? (
                    <Input
                      ref={inputRef}
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void commitEdit(thread.id); if (e.key === "Escape") setEditingId(null); }}
                      onBlur={() => void commitEdit(thread.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="h-auto w-full rounded border border-border bg-background px-1 py-0.5 text-sm font-medium text-foreground outline-none focus:ring-1 focus:ring-ring"
                    />
                  ) : (
                    <div className="w-full text-start text-sm">
                      <span className={cn("block break-words font-medium text-muted-foreground transition-colors group-hover:text-accent-foreground", activeThreadId === thread.id && "text-foreground")}>
                        {thread.title}
                      </span>
                    </div>
                  )}
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">{formatRelativeTime(thread.updatedAt)}</span>
                    <div className="flex items-center gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={(e) => { e.stopPropagation(); void deleteChatThread(thread.id); setThreads((prev) => prev.filter((t) => t.id !== thread.id)); if (activeThreadId === thread.id) window.dispatchEvent(new CustomEvent("cinatra:chat:new")); }}
                        className="size-[18px] text-muted-foreground hover:text-foreground"
                        aria-label="Delete conversation"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={(e) => { e.stopPropagation(); startEdit(thread); }}
                        className="size-[18px] text-muted-foreground hover:text-foreground"
                        aria-label="Rename conversation"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
                <Separator className="my-1" />
              </Fragment>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2 sm:w-56 lg:w-72 2xl:w-80">
      <div className="sticky top-0 z-10 bg-background pb-3 sm:static sm:z-auto sm:p-0">
        <div className="flex items-center justify-between py-2">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">Chat</h1>
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={handleNewChat}
            className="rounded-lg"
            title="New chat"
          >
            <Edit size={24} className="stroke-muted-foreground" />
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-1 px-1 pb-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setSortMode("recent")}
          className={cn(
            "h-7 px-2 text-xs",
            sortMode === "recent" ? "text-foreground" : "text-muted-foreground",
          )}
        >
          Activity
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setSortMode("newest")}
          className={cn(
            "h-7 px-2 text-xs",
            sortMode === "newest" ? "text-foreground" : "text-muted-foreground",
          )}
        >
          Newest
        </Button>
      </div>

      <ScrollArea className="-mx-3 h-full p-3">
        {sortedThreads.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">No conversations yet</p>
        ) : (
          sortedThreads.map((thread) => (
            <Fragment key={thread.id}>
              <div
                role={editingId === thread.id ? undefined : "button"}
                tabIndex={editingId === thread.id ? undefined : 0}
                onClick={editingId === thread.id ? undefined : () => navigateToThread(thread.id)}
                onKeyDown={
                  editingId === thread.id
                    ? undefined
                    : (e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          navigateToThread(thread.id);
                        }
                      }
                }
                ref={(el) => {
                  if (el) threadRefs.current.set(thread.id, el);
                  else threadRefs.current.delete(thread.id);
                }}
                className={cn(
                  "group rounded-md px-2 py-2",
                  editingId !== thread.id && "cursor-pointer",
                  "hover:bg-accent hover:text-accent-foreground",
                  activeThreadId === thread.id && "bg-muted",
                )}
              >
                {/* Title — text or inline input */}
                {editingId === thread.id ? (
                  <Input
                    ref={inputRef}
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitEdit(thread.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    onBlur={() => void commitEdit(thread.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="h-auto w-full rounded border border-border bg-background px-1 py-0.5 text-sm font-medium text-foreground outline-none focus:ring-1 focus:ring-ring"
                  />
                ) : (
                  <div className="w-full text-start text-sm">
                    <span
                      className={cn(
                        "block break-words font-medium text-muted-foreground transition-colors group-hover:text-accent-foreground",
                        activeThreadId === thread.id && "text-foreground",
                      )}
                    >
                      {thread.title}
                    </span>
                  </div>
                )}

                {/* Bottom row: timestamp + action icons */}
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(thread.updatedAt)}
                  </span>
                  <div className="flex items-center gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteChatThread(thread.id);
                        setThreads((prev) => prev.filter((t) => t.id !== thread.id));
                        if (activeThreadId === thread.id) {
                          window.dispatchEvent(new CustomEvent("cinatra:chat:new"));
                        }
                      }}
                      className="h-auto w-auto rounded p-0.5 text-muted-foreground transition hover:text-foreground"
                      aria-label="Delete conversation"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        startEdit(thread);
                      }}
                      className="h-auto w-auto rounded p-0.5 text-muted-foreground transition hover:text-foreground"
                      aria-label="Rename conversation"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
              <Separator className="my-1" />
            </Fragment>
          ))
        )}
        <div className="h-8" />
      </ScrollArea>
    </div>
  );
}
