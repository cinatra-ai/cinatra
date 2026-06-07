"use client";

import { MessagesSquare, SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Horizontal tab nav attached to the top of the thread list column inside the chat card.
 *
 * Tabs (left → right):
 *  - Threads  → no-op (just a visual label for the list below)
 *  - New chat → dispatches cinatra:chat:new
 */
export function ChatSideBar() {
  function handleNewChat() {
    window.dispatchEvent(new CustomEvent("cinatra:chat:new"));
  }

  return (
    <div className="flex items-center gap-0.5 border-b border-border px-2 py-1.5">
      <div className="rounded-md p-1.5 text-muted-foreground" title="Threads">
        <MessagesSquare className="h-4 w-4" />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleNewChat}
        className="h-auto w-auto rounded-md p-1.5 text-muted-foreground transition hover:bg-surface-muted hover:text-foreground"
        title="New chat"
      >
        <SquarePen className="h-4 w-4" />
      </Button>
    </div>
  );
}
