"use client";

import { useEffect, useState } from "react";
import { ChatThreadPanel } from "./chat-thread-panel";

type ThreadSummary = { id: string; title: string; createdAt: string; updatedAt: string };

/**
 * Local overlay panel for conversation history on smaller viewports.
 *
 * Renders absolutely within its nearest `relative` ancestor (the chat card),
 * so it never covers the left navigation sidebar.
 *
 * Controlled by two custom events:
 *  - cinatra:chat:history-toggle  → open/close toggle (from ChatSideBar)
 *  - cinatra:chat:select          → auto-close on thread selection
 */
export function ChatHistoryDrawer({ initialThreads = [] }: { initialThreads?: ThreadSummary[] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handleToggle() { setOpen((prev) => !prev); }
    function handleSelect() { setOpen(false); }
    window.addEventListener("cinatra:chat:history-toggle", handleToggle);
    window.addEventListener("cinatra:chat:select", handleSelect);
    return () => {
      window.removeEventListener("cinatra:chat:history-toggle", handleToggle);
      window.removeEventListener("cinatra:chat:select", handleSelect);
    };
  }, []);

  if (!open) return null;

  return (
    <>
      {/* Backdrop — covers the card only, click to close */}
      <div
        className="absolute inset-0 z-10 bg-background/50"
        onClick={() => setOpen(false)}
      />
      {/* Panel — stays within the card, never reaches the left nav */}
      <div className="absolute inset-y-0 left-0 z-20 flex w-72 flex-col overflow-hidden border-r border-line bg-surface shadow-lg">
        <div className="flex flex-1 flex-col overflow-hidden px-4 pt-4">
          <ChatThreadPanel initialThreads={initialThreads} />
        </div>
      </div>
    </>
  );
}
