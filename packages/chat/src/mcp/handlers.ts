import "server-only";

// cinatra#1037 P5.6 PR2 CUTOVER — final teardown (owner ruling 2026-07-21).
//
// The broad public chat-thread primitives (chat_thread_list/get/send/update and
// chat_thread_pause/resume) are RETIRED. The in-process @chatgpt/@gemini host-CLI
// bridge that lived inside chat_thread_send is deleted with it: @chatgpt keeps
// working through its own independent route (/api/assistants/chatgpt), and
// @gemini is deliberately retired from /chat — it returns as a connector-API
// extension package under the assistants epic (#1873), not via an interim
// in-process bridge. No backward-compat alias.
//
// Only the TWO narrow external-assistant reply primitives survive, both reading
// the AUTHORITATIVE structured store (never the legacy chat_threads table):
//   - chat_mentions_poll  → scanPendingMentionsForAssistant
//   - chat_mention_reply  → reconstructThreadPayload (+ structured write-through)
import { upsertChatThreadInDatabase } from "@/lib/database";
import {
  reconstructThreadPayload,
  scanPendingMentionsForAssistant,
} from "@/lib/assistant-thread-store";
import { randomUUID } from "node:crypto";
import { resolveActorFromRequest } from "./actor-context";
import type { ChatMessage, ChatThread } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PrimitiveRequest<T = Record<string, unknown>> = {
  primitiveName: string;
  input: T;
  actor: { actorType: string; source: string; [key: string]: unknown };
  mode: string;
};

// ---------------------------------------------------------------------------
// chat_mentions_poll — poll the structured store for pending @mentions
// ---------------------------------------------------------------------------

async function handleChatMentionsPoll(
  request: PrimitiveRequest<{ since?: string; limit?: number }>,
): Promise<unknown> {
  const actor = await resolveActorFromRequest(request);
  if (actor.userType !== "assistant" || !actor.userId) {
    return { error: "chat_mentions_poll requires an assistant user context." };
  }

  const since = request.input?.since;
  const limit = Math.min(Math.max(request.input?.limit ?? 20, 1), 100);

  // Structured-store scan (cinatra#1037 P5.6 PR2 CUTOVER): enumerate durable-
  // content threads and collect user messages whose mentionState is 'pending'
  // for this assistant. Shape-exact replacement for the old
  // readChatThreadsFromDatabase() full-table scan.
  const items = scanPendingMentionsForAssistant(actor.userId, { since, limit });
  return { items, total: items.length, hasMore: false };
}

// ---------------------------------------------------------------------------
// chat_mention_reply — the NARROW mention-reply primitive (cinatra#1037 P5.6
// PR2 CUTOVER).
//
// Reply into the MENTIONED thread ONLY: (threadId, messageId, message) — append
// the assistant's reply to the exact user message that @mentioned it and mark
// that mention handled.
//
// AUTHZ = THE MENTION'S AUDIENCE. Authorization is conferred SOLELY by the
// pending mention: the transport-verified assistant must have a 'pending'
// mentionState entry on EXACTLY this (threadId, messageId) user message. No
// thread-ownership/grant is consulted or granted — a handled/absent/foreign
// mention is rejected. There is NO self-asserted clientId fallback; a human or
// unauthenticated caller is rejected.
//
// The thread is read from the AUTHORITATIVE structured store
// (reconstructThreadPayload) and the reply is persisted THROUGH the structured
// write-through (upsertChatThreadInDatabase mints a reconstruction-visible
// `legacy:` content turn via the mirror). No LLM call — the assistant supplied
// the text.
//
// CONCURRENCY (codex convergence): the pending-mention check + whole-thread
// upsert here are the SAME non-atomic read-modify-write model as the reply path
// this primitive replaced (the retired chat_thread_send assistant branch). It is
// NOT a regression this teardown introduces — the shape is unchanged. Now that
// this stage makes the structured store the SOLE writer, an ATOMIC per-turn
// consume-pending + append (a CAS/locked-transaction store op, no full-payload
// overwrite) is newly UNBLOCKED and is the tracked follow-up hardening; it is a
// deliberate scope boundary of this destructive teardown, not part of it.
// ---------------------------------------------------------------------------

async function handleChatMentionReply(
  request: PrimitiveRequest<{ threadId?: string; messageId?: string; message?: string }>,
): Promise<unknown> {
  const { threadId, messageId, message } = request.input ?? {};
  if (!threadId || typeof threadId !== "string") return { error: "threadId is required." };
  if (!messageId || typeof messageId !== "string") return { error: "messageId is required." };
  if (!message || typeof message !== "string") return { error: "message is required." };

  const actor = await resolveActorFromRequest(request);
  if (actor.userType !== "assistant" || !actor.userId) {
    return {
      error:
        "chat_mention_reply requires an authenticated assistant identity (client_credentials).",
    };
  }

  const thread = reconstructThreadPayload(threadId) as unknown as ChatThread | null;
  if (!thread) return { error: `Thread not found: ${threadId}` };

  // Audience authz: a PENDING mention for THIS assistant on THIS exact message.
  const messages = [...(thread.messages ?? [])];
  const idx = messages.findIndex((m) => m.id === messageId);
  const target = idx >= 0 ? messages[idx] : undefined;
  if (!target || target.role !== "user" || target.mentionState?.[actor.userId] !== "pending") {
    return {
      error: `No pending mention for this assistant on message ${messageId} in thread ${threadId}.`,
    };
  }

  // Mark the exact mention handled (idempotent flip on this one message only).
  messages[idx] = {
    ...target,
    mentionState: { ...target.mentionState, [actor.userId]: "handled" },
  };

  // Append the reply as a reconstruction-visible content turn.
  const replyMsg: ChatMessage = {
    id: randomUUID(),
    role: "assistant",
    content: message,
    createdAt: new Date().toISOString(),
    authorUserId: actor.userId,
  };
  messages.push(replyMsg);

  const updatedThread: ChatThread = {
    ...thread,
    messages,
    updatedAt: new Date().toISOString(),
    taggedAssistantUserIds: [
      ...new Set([...(thread.taggedAssistantUserIds ?? []), actor.userId]),
    ],
  };
  const transportOrgId =
    typeof (request.actor as Record<string, unknown>)?.orgId === "string"
      ? ((request.actor as Record<string, unknown>).orgId as string)
      : undefined;
  upsertChatThreadInDatabase(
    updatedThread as unknown as { id: string } & Record<string, unknown>,
    { assistantMirrorOrgId: transportOrgId ?? null },
  );

  return { threadId, messageId, handled: true, assistantMessage: message };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function createChatPrimitiveHandlers(): Record<
  string,
  (request: unknown) => Promise<unknown>
> {
  return {
    chat_mentions_poll: (req) =>
      handleChatMentionsPoll(req as PrimitiveRequest<{ since?: string; limit?: number }>),
    // Narrow mention-reply primitive (cinatra#1037 PR2 CUTOVER): reply into the
    // mentioned thread ONLY; authz = the pending mention's audience.
    chat_mention_reply: (req) =>
      handleChatMentionReply(
        req as PrimitiveRequest<{ threadId?: string; messageId?: string; message?: string }>,
      ),
  };
}
