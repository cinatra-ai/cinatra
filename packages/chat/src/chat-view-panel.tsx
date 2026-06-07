"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChatThreadPanel } from "./chat-thread-panel";
import { ensureTeamThread, fetchChatThreads, fetchUserTeams } from "./actions";
import {
  consumePendingChatPanel,
  CHAT_SHOW_PANEL_EVENT,
} from "@/lib/chat-shell-bus";

type ThreadSummary = { id: string; title: string; createdAt: string; updatedAt: string };
type TeamSummary = { id: string; name: string; orgName: string };

/**
 * Overlay panel controlled by custom window events — no props needed.
 * "cinatra:chat:show-panel" { detail: "threads" | "teams" } — open/toggle panel.
 * "cinatra:chat:new" — close panel.
 *
 * Threads are populated by ChatPage via "cinatra:chat:threads-changed" events.
 * Teams are fetched lazily the first time the teams panel opens.
 * No server data is fetched in the layout, so pushState navigations don't cause reloads.
 */
export function ChatViewPanel() {
  const [activePanel, setActivePanel] = useState<"threads" | "teams" | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadsFetched, setThreadsFetched] = useState(false);
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [teamsLoaded, setTeamsLoaded] = useState(false);

  // Consume any panel parked before this component mounted — i.e. the user
  // clicked Chat>Threads from a non-chat route, which dispatched the open
  // event and navigated here; the live listener below missed that event, so
  // open the parked panel on mount. No parked request → no-op.
  useEffect(() => {
    const pending = consumePendingChatPanel();
    if (pending) setActivePanel(pending);
  }, []);

  useEffect(() => {
    function handleShowPanel(e: Event) {
      const panel = (e as CustomEvent<"threads" | "teams">).detail;
      // Clear the parked request now that we are handling it live, so a
      // later remount does not re-open it as a stale pending panel.
      consumePendingChatPanel();
      setActivePanel((prev) => (prev === panel ? null : panel));
    }
    function handleNew() {
      setActivePanel(null);
    }
    window.addEventListener(CHAT_SHOW_PANEL_EVENT, handleShowPanel);
    window.addEventListener("cinatra:chat:new", handleNew);
    return () => {
      window.removeEventListener(CHAT_SHOW_PANEL_EVENT, handleShowPanel);
      window.removeEventListener("cinatra:chat:new", handleNew);
    };
  }, []);

  // Close on click outside the panel.
  useEffect(() => {
    function handleDocMouseDown(e: MouseEvent) {
      if (!activePanel) return;
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setActivePanel(null);
        window.dispatchEvent(new CustomEvent("cinatra:chat:panel-close"));
      }
    }
    document.addEventListener("mousedown", handleDocMouseDown);
    return () => document.removeEventListener("mousedown", handleDocMouseDown);
  }, [activePanel]);

  // Fetch threads the first time the threads panel opens.
  // Mount ChatThreadPanel only after the fetch resolves so initialThreads is populated.
  useEffect(() => {
    if (activePanel === "threads" && !threadsFetched) {
      void fetchChatThreads().then((result) => {
        setThreads(result);
        setThreadsFetched(true);
      });
    }
  }, [activePanel, threadsFetched]);

  useEffect(() => {
    function handleThreadsChanged(e: Event) {
      const detail = (e as CustomEvent<ThreadSummary[]>).detail;
      if (Array.isArray(detail)) setThreads(detail);
    }
    window.addEventListener("cinatra:chat:threads-changed", handleThreadsChanged);
    return () => window.removeEventListener("cinatra:chat:threads-changed", handleThreadsChanged);
  }, []);

  // Fetch teams lazily the first time the teams panel is opened.
  useEffect(() => {
    if (activePanel === "teams" && !teamsLoaded) {
      setTeamsLoaded(true);
      void fetchUserTeams().then(setTeams);
    }
  }, [activePanel, teamsLoaded]);

  if (!activePanel) return null;

  function handleClose() {
    setActivePanel(null);
    window.dispatchEvent(new CustomEvent("cinatra:chat:panel-close"));
  }

  return (
    <div ref={panelRef} className="absolute inset-y-0 left-0 z-20 flex w-80 flex-col border-r border-border bg-card shadow-md">
      {/* Header row with label + close */}
      <div className="flex shrink-0 items-center justify-between px-3 pb-1 pt-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {activePanel === "threads" ? "Threads" : "Teams"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleClose}
          title="Close"
          className="rounded-md p-1 text-muted-foreground transition hover:bg-surface-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {activePanel === "threads" && (
        <div className="min-h-0 flex-1 overflow-hidden">
          {threadsFetched
            ? <ChatThreadPanel initialThreads={threads} embedded />
            : <p className="px-3 py-4 text-xs text-muted-foreground">Loading…</p>
          }
        </div>
      )}

      {activePanel === "teams" && (
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {teams.length === 0 && (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              {teamsLoaded ? "No teams found." : "Loading…"}
            </p>
          )}
          {teams.map((team) => (
            <Button
              key={team.id}
              type="button"
              variant="ghost"
              onClick={async () => {
                const threadId = await ensureTeamThread(team.id, team.name);
                window.dispatchEvent(
                  new CustomEvent("cinatra:chat:select", { detail: { threadId } }),
                );
              }}
              className="flex h-auto w-full flex-col items-start rounded-md px-2 py-1.5 text-left transition hover:bg-surface-muted"
            >
              <span className="truncate text-sm text-foreground">{team.name}</span>
              <span className="truncate text-xs text-muted-foreground">{team.orgName}</span>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
