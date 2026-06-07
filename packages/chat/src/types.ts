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
