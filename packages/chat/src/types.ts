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
import type { HitlInterruptSlice } from "./renderer/ag-ui-reducer";

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
  // The lifecycle SLOTS of the ordered trace (cinatra#2825, S9l), carried by a
  // layout projection that omits `parts` itself — the Slack layout, whose pinned
  // turn shape is thoughtGroups + flat content. A lifecycle item is not part of
  // that layout: it is an adjunct the reader may have to ACT on, so the slot the
  // card mounts at survives the projection here while the ordered trace stays
  // omitted. Absent on every ChatGPT-mode turn (the full trace is on `parts`)
  // and on any turn that carries no lifecycle slot, so persisted thread JSON is
  // byte-identical to before wherever there is nothing to carry.
  lifecycleParts?: AssistantMessagePart[];
  citations?: UiCitation[];
  // Structured `DATA_PART` payloads the AG-UI reducer carried through (i.e. the
  // ones it did not consume itself — never `agent_run` / `citations`), kept on
  // the projected turn so `/chat` can dispatch them to the renderable-view
  // registry (cinatra#2565). Persisted verbatim in the thread JSON: a lifecycle
  // card's payload is a bounded opaque REF, so a reload re-renders the card from
  // the durable ref and re-resolves the CURRENT state server-side. Older
  // messages without the field replay byte-identically.
  dataParts?: Record<string, unknown>[];
  // The open HITL interrupt slice for this turn, carried through rather than
  // dropped (cinatra#2565). `/chat` does not yet RENDER a typed interrupt — the
  // recommendation hold's typed-interrupt renderer lands with S4 (#2568) — but
  // the projection must stop discarding it, or that slice would have to re-add
  // a parallel wire. The reducer clears it on RESUME and on either terminal, so
  // a persisted turn effectively never carries one.
  interrupt?: HitlInterruptSlice | null;
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
  // Canonical thread binding + URL slug (cinatra#1878 W3). Optional — an unbound
  // legacy thread carries none and falls back to the builtin Cinatra container.
  assistantPackage?: string | null;
  instanceId?: string | null;
  titleSlug?: string | null;
};

export type UiThreadSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  // Canonical binding + URL slug so the client can build `/chat/<vendor>/<slug>
  // [/<instance>]/<titleSlug>` for the sidebar/back-forward without a per-URL
  // registry lookup (cinatra#1878 W3). Optional — unbound threads carry none.
  assistantPackage?: string | null;
  instanceId?: string | null;
  titleSlug?: string | null;
};
