"use client";

import { useEffect, useRef, useState } from "react";
import { MessagesSquare, SquarePen, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChatThreadPanel } from "./chat-thread-panel";
import { ensureTeamThread } from "./actions";

type ThreadSummary = { id: string; title: string; createdAt: string; updatedAt: string };
type TeamSummary = { id: string; name: string; orgName: string };

/**
 * Left chrome of the chat card:
 *  - A narrow vertical icon strip (always visible, full-height border)
 *  - A collapsible thread list panel (toggled by the threads icon)
 *  - A collapsible team panel (toggled by the users icon)
 *
 * On lg+ the panel is a static flex column — no overlay.
 * On smaller screens it floats over the chat content; clicking outside closes it
 * without blocking the content area (no backdrop div).
 */
export function ChatPanel({
  initialThreads = [],
  initialTeams = [],
}: {
  initialThreads?: ThreadSummary[];
  initialTeams?: TeamSummary[];
}) {
  // Always initialize false (matches server render), then correct on client after mount.
  // Using window.innerWidth in the initializer causes a hydration mismatch on wide screens.
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [teamsOpen, setTeamsOpen] = useState(false);

  useEffect(() => {
    if (window.innerWidth >= 1536) setThreadsOpen(true);
  }, []);
  const containerRef = useRef<HTMLDivElement>(null);

  // Click-outside to close — overlay mode only (< lg breakpoint).
  // Uses document mousedown so the content area stays fully interactive (no backdrop).
  useEffect(() => {
    function handleDocClick(e: MouseEvent) {
      if (window.innerWidth >= 1536) return; // wide enough — don't auto-close on outside click
      if (!threadsOpen && !teamsOpen) return;
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setThreadsOpen(false);
        setTeamsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleDocClick);
    return () => document.removeEventListener("mousedown", handleDocClick);
  }, [threadsOpen, teamsOpen]);

  // Close on thread selection in overlay mode.
  useEffect(() => {
    function handleSelect() {
      if (window.innerWidth < 1536) {
        setThreadsOpen(false);
        setTeamsOpen(false);
      }
    }
    window.addEventListener("cinatra:chat:select", handleSelect);
    return () => window.removeEventListener("cinatra:chat:select", handleSelect);
  }, []);

  function handleNewChat() {
    window.dispatchEvent(new CustomEvent("cinatra:chat:new"));
  }

  function toggleThreads() {
    setThreadsOpen((prev) => !prev);
    setTeamsOpen(false);
  }

  function toggleTeams() {
    setTeamsOpen((prev) => !prev);
    setThreadsOpen(false);
  }

  return (
    <div ref={containerRef} className="relative flex shrink-0">
      {/* Narrow icon strip — always visible, full-height border */}
      <div className="flex h-full shrink-0 flex-col items-center gap-1 border-r border-border px-1 py-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleNewChat}
          title="New chat"
          className="rounded-md p-2 text-muted-foreground transition hover:bg-surface-muted hover:text-foreground"
        >
          <SquarePen className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={toggleThreads}
          title={threadsOpen ? "Collapse threads" : "Show threads"}
          className={cn(
            "rounded-md p-2 transition hover:bg-surface-muted hover:text-foreground",
            threadsOpen ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <MessagesSquare className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={toggleTeams}
          title={teamsOpen ? "Collapse teams" : "Show teams"}
          className={cn(
            "rounded-md p-2 transition hover:bg-surface-muted hover:text-foreground",
            teamsOpen ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <Users className="h-4 w-4" />
        </Button>
      </div>

      {/* Thread list panel */}
      {threadsOpen && (
        <div className="absolute inset-y-0 left-full z-20 flex w-72 flex-col border-r border-border bg-background shadow-md">
          {/* Close button — always visible */}
          <div className="flex justify-end px-1.5 pt-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setThreadsOpen(false)}
              title="Close"
              className="h-auto w-auto rounded-md p-1 text-muted-foreground transition hover:bg-surface-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="min-h-0 flex-1">
            <ChatThreadPanel initialThreads={initialThreads} embedded />
          </div>
        </div>
      )}

      {/* Team list panel */}
      {teamsOpen && (
        <div className="absolute inset-y-0 left-full z-20 flex w-72 flex-col border-r border-border bg-background shadow-md">
          <div className="flex items-center justify-between px-3 pt-3 pb-1">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Teams</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setTeamsOpen(false)}
              title="Close"
              className="h-auto w-auto rounded-md p-1 text-muted-foreground transition hover:bg-surface-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {initialTeams.length === 0 && (
              <p className="px-2 py-4 text-xs text-muted-foreground">No teams found.</p>
            )}
            {initialTeams.map((team) => (
              <Button
                key={team.id}
                type="button"
                variant="ghost"
                onClick={async () => {
                  const threadId = await ensureTeamThread(team.id, team.name);
                  window.dispatchEvent(new CustomEvent("cinatra:chat:select", { detail: { threadId } }));
                  if (window.innerWidth < 1536) setTeamsOpen(false);
                }}
                className="flex h-auto w-full flex-col items-start gap-0 rounded-md px-2 py-1.5 text-left transition hover:bg-surface-muted"
              >
                <span className="truncate text-sm text-foreground">{team.name}</span>
                <span className="truncate text-xs text-muted-foreground">{team.orgName}</span>
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
