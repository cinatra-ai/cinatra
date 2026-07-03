// ---------------------------------------------------------------------------
// Mention types
// ---------------------------------------------------------------------------

export type Mention = {
  handle: string;
  assistantUserId: string;
  offset: number;
  length: number;
};

// ---------------------------------------------------------------------------
// Chat message + thread types
// ---------------------------------------------------------------------------

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  toolCalls?: ChatToolCall[];
  thinking?: string;
  // Optional — newly added fields; absent in legacy rows
  authorUserId?: string;
  mentions?: Mention[];
  mentionState?: Record<string, "pending" | "handled">; // key = assistantUserId
};

export type ChatToolCall = {
  id: string;
  name: string;
  label: string;
  status: "running" | "completed" | "failed";
  result?: string;
};

export type ChatThread = {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  // Optional — newly added fields; absent in legacy rows
  ownerUserId?: string;
  taggedAssistantUserIds?: string[];
  // The @handle of the last-tagged assistant. "cinatra" or unset = Cinatra LLM.
  // Any other value = that external assistant owns subsequent messages until re-tagged.
  activeAssistantHandle?: string;
  // Participants (assistantUserId or "cinatra") temporarily excluded from broadcast dispatch.
  pausedParticipants?: string[];
  // References public.team.id — when set, thread is a shared team channel.
  teamId?: string;
};

// ---------------------------------------------------------------------------
// Client/streaming UI shapes (cinatra#918)
// ---------------------------------------------------------------------------
// The shapes below are the CLIENT-side thread model used by ChatPage and the
// modules split out of it (chat-persistence / chat-stream-events /
// chat-routing / chat-messages-view). They extend the persisted ChatMessage /
// ChatThread rows above with streaming-only state (thoughtGroups, parts,
// liveStatus, errors) that is populated while a turn streams and persisted
// verbatim in the thread JSON. Moved here unchanged from chat-page.tsx so the
// split modules share one definition.

import type { LlmAttachmentRef } from "@cinatra-ai/llm";
import type { AssistantMessagePart } from "./assistant-parts";

export type UiToolCall = {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  resultLabel?: string;
  serverLabel?: string;
};

export type UiThoughtGroup = {
  id: string;
  thinkingSeconds?: number;
  toolCalls: UiToolCall[];
};

export type UiCitation = {
  index: number;
  title: string;
  url: string;
};

export type UiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  // Optional artifact refs attached to THIS turn. Persisted verbatim in the
  // thread JSON; forwarded to /api/chat so the runner can resolve them via the
  // bridge ports. Older messages without this field replay byte-identically.
  attachments?: LlmAttachmentRef[];
  thoughtGroups?: UiThoughtGroup[];
  // Chronological render trace — populated alongside `content` and
  // `thoughtGroups` during streaming. Renderer prefers this when present.
  // Older persisted messages without `parts` fall back to the flat layout.
  parts?: AssistantMessagePart[];
  citations?: UiCitation[];
  error?: string;
  errorRaw?: string;
  liveStatus?: string;
  // Mention tracking — set on user messages directed at external assistants
  mentions?: Array<{ handle: string; assistantUserId: string; offset: number; length: number }>;
  mentionState?: Record<string, "pending" | "handled">;
  // Set on assistant messages from external assistants (not Cinatra's own LLM)
  authorUserId?: string;
};

export type UiThread = {
  id: string;
  title: string;
  messages: UiMessage[];
  createdAt: string;
  updatedAt: string;
  activeAssistantHandle?: string;
  taggedAssistantUserIds?: string[];
  slackMode?: boolean;
  ownerUserId?: string;
};

export type UiThreadSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};
