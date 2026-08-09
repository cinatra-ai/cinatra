// cinatra#2593 — the whole-response action row (Copy response / Try again).
//
// Previously this markup was inlined ONLY inside the ChatGPT-mode branch of
// `chat-messages-view.tsx`; the Slack-mode (multi-participant) branch never
// mounted it at all, so a user in a multi-participant thread never saw
// response-level actions even though the per-block actions (code/table copy,
// injected by markdown-render.ts) kept showing. Extracted here as one shared
// component so both renderers mount the identical row — response-level
// actions are renderer-independent. Presentation-layer only; no data-model
// change: Copy response is fully shared across both modes; Try again stays
// Slack-suppressed (see the `isSlackMode` doc below) because resolving it
// safely under Slack's concurrent-stream ordering needs a data-model change,
// which is out of scope for this fix.

import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { UiMessage } from "./types";

export function ResponseActionBar({
  message,
  messages,
  hasActiveStream,
  isSlackMode,
  isStreaming,
  onEditAndResend,
}: {
  message: UiMessage;
  messages: UiMessage[];
  hasActiveStream: boolean;
  /**
   * Gates "Try again" only (Copy response is safe in both modes). Slack mode
   * allows CONCURRENT streams (chat-page.tsx `editAndResend`: "In ChatGPT
   * mode, keep the existing single-stream block; in Slack mode concurrent
   * streams are allowed"), so a later user turn can be appended to
   * `messages` before an earlier turn's assistant response finishes
   * streaming and is appended after it — order no longer strictly
   * alternates user/assistant. The nearest-preceding-user lookup below is
   * only a safe way to find "the turn this response replies to" when order
   * DOES strictly alternate (true in ChatGPT/single-stream mode); in Slack
   * mode it can resolve to the WRONG prior turn, and `onEditAndResend` is
   * DESTRUCTIVE — it truncates the whole thread at that message's index and
   * resends from there, in a THREAD OTHER PARTICIPANTS SHARE. So Try again
   * stays suppressed in Slack mode until the data model tracks which turn
   * each assistant response actually replies to (cinatra#2593's fix
   * direction is presentation-layer-only; that association is a data-model
   * change, out of scope here).
   */
  isSlackMode: boolean;
  /** True while `messageId` has an in-flight stream (abort-controller registry). */
  isStreaming: (messageId: string) => boolean;
  onEditAndResend: (messageId: string, newContent: string) => void;
}) {
  if (isStreaming(message.id)) return null;
  const idx = messages.findIndex((m) => m.id === message.id);
  const prevUser = !isSlackMode && idx > 0
    ? messages.slice(0, idx).findLast((m) => m.role === "user")
    : undefined;
  return (
    <div className="mt-1 flex gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => void navigator.clipboard.writeText(message.content)}
        className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-surface-muted hover:text-muted-foreground"
        title="Copy response"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
          <rect x="5.5" y="5.5" width="7" height="7" rx="1" />
          <path d="M3.5 10.5V4a1 1 0 0 1 1-1h6.5" />
        </svg>
      </Button>
      {prevUser && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => onEditAndResend(prevUser.id, prevUser.content)}
          disabled={hasActiveStream}
          className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-surface-muted hover:text-muted-foreground disabled:opacity-50"
          title="Try again"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
