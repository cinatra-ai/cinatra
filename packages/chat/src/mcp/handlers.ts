import "server-only";

import { runChatTurn } from "@/app/api/chat/runner";
import { resolveUserContextForUserId } from "@/lib/auth-session";
import { readChatThreadsFromDatabase, readChatThreadsForSealedRoom, upsertChatThreadInDatabase } from "@/lib/database";
// Sealed-room read filter gate.
// 404-hides when the actor has no read+ grant on the supplied projectId;
// the SQL `WHERE project_id = $projectId` clause is enforced inside
// `readChatThreadsForSealedRoom` over the typed project column, not a
// JSON payload parse.
import { assertProjectReadAccess } from "@/lib/sealed-room";
// Chat-thread project-move helpers.
import { assertProjectWritable } from "@/lib/project-writable";
import { runResourceProjectMove } from "@/lib/resource-project-move";
import { deliverMentionWebhook } from "@/lib/assistant-webhook";
import { callCodexCliAssistant } from "@/lib/codex-bridge";
import { callGeminiCliAssistant } from "@/lib/gemini-cli-bridge";
// Operator authz + strict pre-spawn audit + prompt-byte bound for the
// in-process @chatgpt / @gemini host-CLI bridge (engineering#339). Mirrors the
// /api/chat/chatgpt route gate so the chat-mention path cannot be reached by an
// ordinary authenticated org member (chat_thread_send is object.create, not
// operator-only).
import { authorizeChatBridgeMention } from "@/app/api/chat/chatgpt/gate";
import { isAppDevelopmentMode } from "@/lib/runtime-mode";
import { decodeCursor, buildListPage } from "@/lib/mcp-pagination";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveActorFromRequest } from "./actor-context";
import { parseMentions, resolveMentions, resolveMentionsWithDefault, resolveAssistantsByIds } from "../mentions";
import type { ChatMessage, ChatThread, Mention } from "../types";

// Built-in CLI assistant handles bypass webhook delivery and respond
// synchronously in-process. chatgpt/gemini are dev-only CLI tools.
// Legacy chat handles are not accepted here; /chat/copilot is not a route.
const BUILT_IN_HANDLES: ReadonlySet<string> = isAppDevelopmentMode()
  ? new Set(["chatgpt", "gemini"])
  : new Set<string>();

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
// chat_thread_list
// ---------------------------------------------------------------------------

const listChatThreadsInputSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  // Sealed-room read filter input. See packages/chat/src/mcp/registry.ts
  // for the canonical schema; this mirror is the handler-side parse contract.
  projectId: z.string().nullish(),
});

async function handleChatThreadList(request: PrimitiveRequest): Promise<unknown> {
  const parsed = listChatThreadsInputSchema.parse(request.input ?? {});
  const { cursor, limit: rawLimit } = parsed;
  const limit = rawLimit ?? 50;
  const offset = decodeCursor(cursor);
  // Normalize projectId; non-empty strings only.
  const projectId =
    typeof parsed.projectId === "string" && parsed.projectId.trim().length > 0
      ? parsed.projectId.trim()
      : null;

  const actor = await resolveActorFromRequest(request);

  // 404-hide if the caller supplied a projectId they have no read+ grant on.
  // The chat MCP registry does not route projectGrants onto the actor for
  // non-A2A callers. The actor passed to assertProjectReadAccess here is the
  // request.actor; for non-A2A in-process callers this will lack projectGrants
  // and the gate fails closed. That is the intended sealed-room contract: only
  // callers whose ActorContext carries a resolved projectGrants axis, such as
  // real session-derived users via A2A / lineage, see project-scoped lists.
  if (projectId !== null) {
    const actorForGate = request.actor as unknown as Parameters<
      typeof assertProjectReadAccess
    >[0];
    assertProjectReadAccess(actorForGate, projectId);
  }

  // Sealed-room data path. When projectId is set, the SQL filters by
  // `chat_threads.project_id = $projectId` over the typed project column;
  // payload-parse filtering is unindexable and cannot enforce the sealed-room
  // boundary. Subject to CINATRA_SEALED_ROOM_CHAT_THREADS; when off, the SQL
  // falls through to the legacy ambient reader.
  const threads = (
    projectId !== null
      ? readChatThreadsForSealedRoom({ projectId })
      : readChatThreadsFromDatabase()
  ) as unknown as ChatThread[];

  const filtered = threads.filter((t) => {
    // Threads with no ownerUserId are legacy — return them for all callers
    if (!t.ownerUserId) return true;
    // If the caller has no userId, return all (legacy behavior)
    if (!actor.userId) return true;
    // Return threads owned by or tagged with this user
    return t.ownerUserId === actor.userId || (t.taggedAssistantUserIds ?? []).includes(actor.userId);
  });

  const allThreads = filtered
    .map((t) => ({
      id: t.id,
      title: t.title,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }))
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));

  const total = allThreads.length;
  const items = allThreads.slice(offset, offset + limit);
  return buildListPage(items, total, offset, limit);
}

// ---------------------------------------------------------------------------
// chat_thread_get
// ---------------------------------------------------------------------------

async function handleChatThreadGet(
  request: PrimitiveRequest<{ threadId?: string }>,
): Promise<unknown> {
  const { threadId } = request.input;
  if (!threadId || typeof threadId !== "string") return { error: "threadId is required." };

  const threads = readChatThreadsFromDatabase() as unknown as ChatThread[];
  const thread = threads.find((t) => t.id === threadId);
  if (!thread) return { error: `Thread not found: ${threadId}` };
  return thread;
}

// ---------------------------------------------------------------------------
// chat_thread_send
// ---------------------------------------------------------------------------

async function handleChatThreadSend(
  request: PrimitiveRequest<{ threadId?: string; message?: string; newThread?: boolean; assistantClientId?: string }>,
): Promise<unknown> {
  const { threadId, message, newThread } = request.input;
  if (!message || typeof message !== "string") return { error: "message is required." };

  // Identity must be resolved BEFORE any thread/message persistence so
  // ownerUserId/authorUserId are always populated for the caller (and not
  // left undefined, which chat_thread_list treats as legacy and returns to
  // all callers — a cross-user visibility risk).
  //
  // The MCP transport in packages/mcp-server/src/index.tsx verifies the
  // Bearer JWT (and/or the session cookie) upstream and stamps the resolved
  // userId / orgId / platformRole onto the actor envelope via the chat
  // registry. We trust those values here and do NOT re-parse the raw
  // Authorization header (which would otherwise allow a local caller to
  // impersonate any user by sending an unsigned JWT with a chosen `sub`).
  const inboundActor = await resolveActorFromRequest(request);
  const transportOrgId =
    typeof (request.actor as Record<string, unknown>)?.orgId === "string"
      ? ((request.actor as Record<string, unknown>).orgId as string)
      : undefined;
  const transportPlatformRole =
    (request.actor as Record<string, unknown>)?.platformRole === "platform_admin" ||
    (request.actor as Record<string, unknown>)?.platformRole === "member"
      ? ((request.actor as Record<string, unknown>).platformRole as "platform_admin" | "member")
      : undefined;
  const actor: { userId?: string; userType?: "human" | "assistant"; clientId?: string; actorType: string; source: string } = {
    ...inboundActor,
  };
  if (!actor.userId) {
    return {
      error: "chat_thread_send requires an authenticated caller (the MCP transport did not propagate a verified userId).",
    };
  }

  // Resolve or create the thread
  let thread: ChatThread;
  if (newThread || !threadId) {
    thread = {
      id: randomUUID(),
      title: message.slice(0, 60),
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerUserId: actor.userId,
    };
  } else {
    const threads = readChatThreadsFromDatabase() as unknown as ChatThread[];
    const found = threads.find((t) => t.id === threadId);
    if (!found) return { error: `Thread not found: ${threadId}` };
    thread = found;
  }

  // ---------------------------------------------------------------------------
  // Branch: assistant reply path
  // ---------------------------------------------------------------------------
  if (actor.userType === "assistant" && actor.userId) {
    // The assistant is replying — persist directly, no LLM call
    const replyMsg: ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      content: message,
      createdAt: new Date().toISOString(),
      authorUserId: actor.userId,
    };

    // Flip pending mention state on the most recent user message mentioning this assistant
    const messages = [...(thread.messages ?? [])];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user" && msg.mentionState?.[actor.userId] === "pending") {
        messages[i] = {
          ...msg,
          mentionState: { ...msg.mentionState, [actor.userId]: "handled" },
        };
        break;
      }
    }

    messages.push(replyMsg);

    const updatedThread: ChatThread = {
      ...thread,
      messages,
      updatedAt: new Date().toISOString(),
      taggedAssistantUserIds: [
        ...new Set([...(thread.taggedAssistantUserIds ?? []), actor.userId]),
      ],
    };
    upsertChatThreadInDatabase(updatedThread as unknown as { id: string } & Record<string, unknown>);

    return {
      threadId: thread.id,
      assistantMessage: message,
    };
  }

  // ---------------------------------------------------------------------------
  // Human caller path — resolve routing, persist user message, optionally call LLM
  // ---------------------------------------------------------------------------

  // Step 1: Determine which assistant(s) should respond and update the thread's
  //         active-assistant handle so subsequent messages without @mentions
  //         continue routing to the same assistant.
  const rawMentions = parseMentions(message);
  const hasExplicitMentions = rawMentions.length > 0;

  let resolved: Mention[] = [];
  let newActiveHandle: string = thread.activeAssistantHandle ?? "cinatra";

  const paused = thread.pausedParticipants ?? [];
  let shouldCallLlm: boolean = false;

  // `let` so the empty-resolve fall-through below can promote to the
  // no-mention branch when needed (honor paused / tagged when the parser
  // caught a false-positive @-mention).
  let treatAsNoMention = !hasExplicitMentions;

  if (hasExplicitMentions) {
    resolved = await resolveMentions(rawMentions);
    if (resolved.length > 0) {
      // Last mentioned external (non-@cinatra) handle becomes the new active assistant.
      const lastExternal = [...resolved].reverse().find((m) => m.handle !== "cinatra");
      newActiveHandle = lastExternal ? lastExternal.handle : "cinatra";
      // Explicit @mentions always bypass pause.
      shouldCallLlm = resolved.some((m) => m.handle === "cinatra");
    } else {
      // Parser found `@…` but NONE resolved (false-positive package refs
      // like `@cinatra-ai/<slug>`, human-only mentions, or unknown handles).
      // Treat as no-mention so the broadcast branch handles
      // `pausedParticipants` and `taggedAssistantUserIds` correctly.
      // Returning empty here causes a silent-reply pattern.
      treatAsNoMention = true;
    }
  }

  if (treatAsNoMention) {
    // No explicit mention (or all-empty-resolve) — broadcast to all
    // non-paused tagged participants, otherwise fall back to Cinatra.
    const tagged = thread.taggedAssistantUserIds ?? [];
    if (tagged.length > 0) {
      const activeIds = tagged.filter((id) => !paused.includes(id));
      resolved = await resolveAssistantsByIds(activeIds);
      shouldCallLlm = !paused.includes("cinatra");
      newActiveHandle = thread.activeAssistantHandle ?? "cinatra";
    } else {
      // No tagged participants yet — fall back to Cinatra only.
      if (!paused.includes("cinatra")) {
        resolved = await resolveMentionsWithDefault(message);
      } else {
        resolved = [];
      }
      shouldCallLlm = !paused.includes("cinatra");
      newActiveHandle = "cinatra";
    }
  }

  // Step 2: Build mention state and user message record.
  const mentionState: Record<string, "pending" | "handled"> = {};
  for (const m of resolved) {
    if (m.handle !== "cinatra") mentionState[m.assistantUserId] = "pending";
  }

  const userMsgId = randomUUID();
  const userMsg: ChatMessage = {
    id: userMsgId,
    role: "user",
    content: message,
    createdAt: new Date().toISOString(),
    authorUserId: actor.userId,
    mentions: resolved.filter((m) => m.handle !== "cinatra"),
    mentionState,
  };

  const updatedMessages: ChatMessage[] = [...(thread.messages ?? []), userMsg];

  // Update tagged assistant list (external only).
  const allTagged = [
    ...new Set([
      ...(thread.taggedAssistantUserIds ?? []),
      ...resolved.filter((m) => m.handle !== "cinatra").map((m) => m.assistantUserId),
    ]),
  ];

  // Persist user message (and updated routing state) immediately.
  upsertChatThreadInDatabase({
    ...thread,
    messages: updatedMessages,
    taggedAssistantUserIds: allTagged,
    activeAssistantHandle: newActiveHandle,
    updatedAt: new Date().toISOString(),
  } as unknown as { id: string } & Record<string, unknown>);

  // Fire webhook deliveries for external assistants (fire and forget; @cinatra and built-ins have no webhook URL).
  for (const mention of resolved) {
    if (mention.handle === "cinatra") continue;
    if (BUILT_IN_HANDLES.has(mention.handle)) continue;
    void deliverMentionWebhook(mention.assistantUserId, {
      threadId: thread.id,
      messageId: userMsgId,
      content: message,
      createdAt: userMsg.createdAt,
    });
  }

  // engineering#339: the in-process @chatgpt / @gemini bridge spawns the host
  // Codex / Gemini CLI on the host's provider credentials — the SAME operator
  // power the /api/chat/chatgpt route gates. Resolve the caller's full
  // ActorContext ONCE (only when a built-in CLI mention is actually present, to
  // avoid an unnecessary DB lookup) so each bridge call below can run the
  // identical operator-authz + strict pre-spawn audit + prompt-byte bound
  // BEFORE spawning. A denial persists a denial reply instead of spawning.
  const hasBuiltInCliMention = resolved.some(
    (m) => m.handle === "chatgpt" || m.handle === "gemini",
  );
  let bridgeActorContext: import("@/lib/authz/actor-context").ActorContext | undefined;
  // Prompt material the bound is measured against. Both bridges feed the last
  // 10 thread messages PLUS the new message to the spawned child, so bound that
  // combined text — not just `message` — so the byte cap is equivalent to the
  // route's raw-body cap (the route caps the whole body the prompt is built
  // from). This still cannot let a member bypass operator authz; it just makes
  // the byte ceiling match what actually reaches the child.
  let bridgePromptMaterial = message;
  if (hasBuiltInCliMention) {
    const contextText = (thread.messages ?? [])
      .slice(-10)
      .map((m) => m.content ?? "")
      .join("\n");
    bridgePromptMaterial = contextText ? `${contextText}\n${message}` : message;
    try {
      const resolvedCtx = await resolveUserContextForUserId(actor.userId, {
        activeOrganizationId: transportOrgId,
        platformRole: transportPlatformRole,
      });
      bridgeActorContext = resolvedCtx.actorContext;
    } catch {
      // Fail closed: an unresolvable actor context denies the bridge below
      // (bridgeActorContext stays undefined -> authorizeChatBridgeMention 401).
      bridgeActorContext = undefined;
    }
  }

  // Handle built-in @chatgpt mention synchronously in-process.
  const chatgptMention = resolved.find((m) => m.handle === "chatgpt");
  if (chatgptMention) {
    let codexReply: string;
    const gate = await authorizeChatBridgeMention({
      bridge: "chatgpt",
      actor: bridgeActorContext,
      prompt: bridgePromptMaterial,
    });
    if (gate.kind === "deny") {
      codexReply = gate.reason;
    } else {
      try {
        codexReply = await callCodexCliAssistant(thread, message);
      } catch (err) {
        codexReply = `@chatgpt failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Re-read the thread state (user message was already persisted above)
    const threads = readChatThreadsFromDatabase() as unknown as import("../types").ChatThread[];
    const latestThread = threads.find((t) => t.id === thread.id) ?? {
      ...thread,
      messages: [...(thread.messages ?? []), userMsg],
    };

    // Mark the @chatgpt mention as handled in the user message
    const messagesWithHandled = (latestThread.messages ?? []).map((msg) => {
      if (msg.id === userMsgId && msg.mentionState?.[chatgptMention.assistantUserId] === "pending") {
        return {
          ...msg,
          mentionState: {
            ...msg.mentionState,
            [chatgptMention.assistantUserId]: "handled" as const,
          },
        };
      }
      return msg;
    });

    // Persist the assistant reply
    const codexMsg: import("../types").ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      content: codexReply,
      createdAt: new Date().toISOString(),
      authorUserId: chatgptMention.assistantUserId,
    };
    messagesWithHandled.push(codexMsg);

    upsertChatThreadInDatabase({
      ...latestThread,
      messages: messagesWithHandled,
      updatedAt: new Date().toISOString(),
    } as unknown as { id: string } & Record<string, unknown>);
  }

  // Handle built-in @gemini mention synchronously in-process.
  const geminiMention = resolved.find((m) => m.handle === "gemini");
  if (geminiMention) {
    let geminiReply: string;
    const gate = await authorizeChatBridgeMention({
      bridge: "gemini",
      actor: bridgeActorContext,
      prompt: bridgePromptMaterial,
    });
    if (gate.kind === "deny") {
      geminiReply = gate.reason;
    } else {
      try {
        geminiReply = await callGeminiCliAssistant(thread, message);
      } catch (err) {
        geminiReply = `@gemini failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Re-read the thread state (user message was already persisted above)
    const threads = readChatThreadsFromDatabase() as unknown as import("../types").ChatThread[];
    const latestThread = threads.find((t) => t.id === thread.id) ?? {
      ...thread,
      messages: [...(thread.messages ?? []), userMsg],
    };

    // Mark the @gemini mention as handled in the user message
    const messagesWithHandled = (latestThread.messages ?? []).map((msg) => {
      if (msg.id === userMsgId && msg.mentionState?.[geminiMention.assistantUserId] === "pending") {
        return {
          ...msg,
          mentionState: {
            ...msg.mentionState,
            [geminiMention.assistantUserId]: "handled" as const,
          },
        };
      }
      return msg;
    });

    // Persist the assistant reply
    const geminiMsg: import("../types").ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      content: geminiReply,
      createdAt: new Date().toISOString(),
      authorUserId: geminiMention.assistantUserId,
    };
    messagesWithHandled.push(geminiMsg);

    upsertChatThreadInDatabase({
      ...latestThread,
      messages: messagesWithHandled,
      updatedAt: new Date().toISOString(),
    } as unknown as { id: string } & Record<string, unknown>);
  }

  // Step 4: If only external assistants are tagged, return early — they will
  //         reply via chat_mentions_poll / chat_thread_send.
  if (!shouldCallLlm) {
    return {
      threadId: thread.id,
      assistantMessage: "",
      pendingAssistants: resolved.map((m) => m.handle),
    };
  }

  // Step 5: Drive the Cinatra LLM via runChatTurn (in-process).
  //
  // Invoke runChatTurn directly instead of routing through /api/chat. Browser
  // sessions can authenticate there via cookie, but MCP callers authenticate
  // with an OAuth Bearer JWT; /api/chat is cookie-only, so a Bearer-only call
  // redirects to /sign-in and can produce a silent empty reply. Direct
  // invocation uses the same orchestration code with actor context resolved up
  // front.
  let assistantText = "";
  let chatErrorMessage: string | null = null;
  const toolResults: Array<{ name: string; resultLabel: string }> = [];

  try {
    // Use the transport-supplied org / role when present (they were resolved
    // from the SAME verified session that produced actor.userId). Fall back
    // to a DB lookup for callers without transport context.
    const resolved = await resolveUserContextForUserId(actor.userId, {
      activeOrganizationId: transportOrgId,
      platformRole: transportPlatformRole,
    });
    const { actorContext, platformRole, sessionOrgId } = resolved;
    await runChatTurn({
      messages: updatedMessages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
      actorContext,
      userId: actor.userId,
      platformRole,
      sessionOrgId,
      send: (event, data) => {
        const d = (data ?? {}) as Record<string, unknown>;
        if (event === "text") {
          if (typeof d.content === "string" && d.content) assistantText += d.content;
        } else if (event === "tool_result") {
          toolResults.push({
            name: String(d.name ?? ""),
            resultLabel: String(d.resultLabel ?? ""),
          });
        } else if (event === "error") {
          if (typeof d.message === "string" && d.message) chatErrorMessage = d.message;
        }
      },
    });

    // If the LLM produced no text (e.g. ran out of tool rounds), build a
    // summary from the tool calls that were observed so the caller isn't left
    // with an empty response.
    if (!assistantText && toolResults.length > 0) {
      assistantText =
        "The assistant completed the following actions:\n" +
        toolResults.map((r) => `- ${r.name}: ${r.resultLabel}`).join("\n");
    }
  } catch (err) {
    return { error: `Chat request failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (chatErrorMessage && !assistantText) {
    return {
      threadId: thread.id,
      assistantMessage: "",
      error: `Chat orchestration error: ${chatErrorMessage}`,
    };
  }

  // Mark @cinatra mention as handled (the LLM replied on its behalf).
  const finalMessages: ChatMessage[] = updatedMessages.map((msg) => {
    if (msg.id === userMsgId && msg.mentionState) {
      const updatedMentionState: Record<string, "pending" | "handled"> = { ...msg.mentionState };
      for (const [uid, state] of Object.entries(updatedMentionState)) {
        if (state === "pending") {
          // Auto-handle @cinatra only — external assistants mark themselves via chat_mentions_poll
          const mention = (msg.mentions ?? []).find((m) => m.assistantUserId === uid);
          if (mention?.handle === "cinatra") {
            updatedMentionState[uid] = "handled";
          }
        }
      }
      return { ...msg, mentionState: updatedMentionState };
    }
    return msg;
  });

  finalMessages.push({
    id: randomUUID(),
    role: "assistant",
    content: assistantText,
    createdAt: new Date().toISOString(),
  });

  const updatedThread: ChatThread = {
    ...thread,
    messages: finalMessages,
    taggedAssistantUserIds: allTagged,
    activeAssistantHandle: newActiveHandle,
    updatedAt: new Date().toISOString(),
  };
  upsertChatThreadInDatabase(updatedThread as unknown as { id: string } & Record<string, unknown>);

  return {
    threadId: thread.id,
    assistantMessage: assistantText,
  };
}

// ---------------------------------------------------------------------------
// chat_mentions_poll
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

  const threads = readChatThreadsFromDatabase() as unknown as ChatThread[];
  const items: Array<{
    threadId: string;
    threadTitle: string;
    messageId: string;
    content: string;
    createdAt: string;
    mentions: Mention[];
  }> = [];

  for (const thread of threads) {
    for (const msg of thread.messages ?? []) {
      if (msg.role !== "user") continue;
      // Legacy messages with no mentionState are treated as handled — skip them
      if (!msg.mentionState) continue;
      if (msg.mentionState[actor.userId] !== "pending") continue;
      // Filter by since if provided
      if (since && msg.createdAt && msg.createdAt <= since) continue;

      items.push({
        threadId: thread.id,
        threadTitle: thread.title,
        messageId: msg.id,
        content: msg.content,
        createdAt: msg.createdAt,
        mentions: msg.mentions ?? [],
      });

      if (items.length >= limit) break;
    }
    if (items.length >= limit) break;
  }

  // MCP list pagination standard
  return { items, total: items.length, hasMore: false };
}

// ---------------------------------------------------------------------------
// chat_thread_pause_assistant / chat_thread_resume_assistant
// ---------------------------------------------------------------------------

const pauseResumeInputSchema = z.object({
  threadId: z.string(),
  assistantId: z.string(), // assistantUserId or "cinatra"
});

async function handleChatThreadPauseAssistant(request: PrimitiveRequest): Promise<unknown> {
  const { threadId, assistantId } = pauseResumeInputSchema.parse(request.input ?? {});
  const threads = readChatThreadsFromDatabase() as unknown as ChatThread[];
  const thread = threads.find((t) => t.id === threadId);
  if (!thread) return { error: `Thread not found: ${threadId}` };

  const current = new Set(thread.pausedParticipants ?? []);
  current.add(assistantId);
  // Pausing a participant is not conversational activity — preserve the
  // existing updatedAt (spread from `thread`) so it does NOT bump the thread to
  // the top of the activity-sorted sidebar (#283).
  upsertChatThreadInDatabase({
    ...thread,
    pausedParticipants: Array.from(current),
  } as unknown as { id: string } & Record<string, unknown>);
  return { ok: true, pausedParticipants: Array.from(current) };
}

async function handleChatThreadResumeAssistant(request: PrimitiveRequest): Promise<unknown> {
  const { threadId, assistantId } = pauseResumeInputSchema.parse(request.input ?? {});
  const threads = readChatThreadsFromDatabase() as unknown as ChatThread[];
  const thread = threads.find((t) => t.id === threadId);
  if (!thread) return { error: `Thread not found: ${threadId}` };

  const current = new Set(thread.pausedParticipants ?? []);
  current.delete(assistantId);
  // Resuming a participant is not conversational activity — preserve the
  // existing updatedAt (spread from `thread`) so it does NOT bump the thread to
  // the top of the activity-sorted sidebar (#283).
  upsertChatThreadInDatabase({
    ...thread,
    pausedParticipants: Array.from(current),
  } as unknown as { id: string } & Record<string, unknown>);
  return { ok: true, pausedParticipants: Array.from(current) };
}

// ---------------------------------------------------------------------------
// chat_thread_update — project move semantics
// ---------------------------------------------------------------------------
//
// The only currently-mutable field is `projectId`. Other thread fields
// (title, messages, paused participants) flow through chat_thread_send /
// chat_thread_pause_assistant. Future widening (title rename, etc.) lives
// in its own focused change.
//
// Authz contract:
//   - source: caller must be the thread owner (`ownerUserId`) OR a
//     `taggedAssistantUserIds` member OR platform_admin. This mirrors
//     the existing chat_thread_list visibility rule.
//   - target: assertProjectWritable(actor, newProjectId, "write") — the
//     actor must hold write+ on the target project AND the target must
//     not be archived. Skipped when moving OUT of a project
//     (newProjectId === null).
//
// Active-state protection: chat threads have
// no equivalent "active" state — they are append-only conversation
// records. The move is safe at any time; the payload lockstep contract
// ensures the typed column and the JSON payload stay in sync on the next
// write either way. The move also updates the payload's `projectId` field
// so any code that reads the payload sees the new project tag immediately.
// ---------------------------------------------------------------------------

const chatThreadUpdateSchema = z.object({
  threadId: z.string().min(1),
  // null = move out of a project (back to ambient).
  projectId: z.string().nullable().optional(),
  reason: z.string().min(1).max(500).optional(),
});

async function handleChatThreadUpdate(
  request: PrimitiveRequest<{ threadId?: string; projectId?: string | null; reason?: string }>,
): Promise<unknown> {
  const parsed = chatThreadUpdateSchema.parse(request.input ?? {});

  // No-op if no mutable field is supplied.
  if (parsed.projectId === undefined) {
    return { ok: true as const, noop: true as const };
  }

  // Resolve the thread row. The chat_thread table is keyed by a globally
  // unique id (no org boundary at the row level); access is gated by
  // payload fields (ownerUserId / taggedAssistantUserIds).
  const threads = readChatThreadsFromDatabase() as unknown as ChatThread[];
  const thread = threads.find((t) => t.id === parsed.threadId);
  if (!thread) return { error: `Thread not found: ${parsed.threadId}` };

  // Source-side authz. Owner / tagged-assistant / platform_admin only.
  const actor = await resolveActorFromRequest(request);
  const isPlatformAdmin =
    (request.actor as Record<string, unknown>)?.platformRole === "platform_admin";
  const isOwner = !!actor.userId && thread.ownerUserId === actor.userId;
  const isTagged =
    !!actor.userId && (thread.taggedAssistantUserIds ?? []).includes(actor.userId);
  if (!isOwner && !isTagged && !isPlatformAdmin) {
    return { error: `Thread not found: ${parsed.threadId}` };
  }

  // Same-value no-op (don't write an audit row for a no-op).
  const currentProjectId =
    typeof (thread as unknown as { projectId?: unknown }).projectId === "string"
      ? ((thread as unknown as { projectId: string }).projectId)
      : null;
  if ((currentProjectId ?? null) === (parsed.projectId ?? null)) {
    return { ok: true as const, noop: true as const };
  }

  // Target-side authz.
  if (parsed.projectId !== null && parsed.projectId !== undefined) {
    await assertProjectWritable(
      request.actor as Parameters<typeof assertProjectWritable>[0],
      parsed.projectId,
      "write",
    );
  }

  // Run the transactional move (typed column UPDATE + audit row).
  const actorId = actor.userId ?? "system";
  runResourceProjectMove({
    table: "chat_threads",
    resourceId: thread.id,
    resourceKind: "chat_thread",
    oldProjectId: currentProjectId,
    newProjectId: parsed.projectId ?? null,
    actorId,
    sourceThreadId: thread.id,
    reason: parsed.reason ?? null,
  });

  // Mirror the new projectId into the payload JSON so payload readers
  // see the new tag immediately (lockstep doctrine — column + payload
  // never diverge). `upsertChatThreadInDatabase`'s builder re-derives
  // project_id/created_at/updated_at from payload on every write, so
  // this upsert preserves the lockstep contract.
  upsertChatThreadInDatabase({
    ...thread,
    projectId: parsed.projectId ?? null,
    updatedAt: new Date().toISOString(),
  } as unknown as { id: string } & Record<string, unknown>);

  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function createChatPrimitiveHandlers(): Record<
  string,
  (request: unknown) => Promise<unknown>
> {
  return {
    chat_thread_list: (req) => handleChatThreadList(req as PrimitiveRequest),
    chat_thread_get: (req) =>
      handleChatThreadGet(req as PrimitiveRequest<{ threadId?: string }>),
    chat_thread_send: (req) =>
      handleChatThreadSend(
        req as PrimitiveRequest<{ threadId?: string; message?: string; newThread?: boolean; assistantClientId?: string }>,
      ),
    // Project-move primitive on chat threads.
    chat_thread_update: (req) =>
      handleChatThreadUpdate(
        req as PrimitiveRequest<{ threadId?: string; projectId?: string | null; reason?: string }>,
      ),
    chat_mentions_poll: (req) =>
      handleChatMentionsPoll(req as PrimitiveRequest<{ since?: string; limit?: number }>),
    chat_thread_pause_assistant: (req) =>
      handleChatThreadPauseAssistant(req as PrimitiveRequest),
    chat_thread_resume_assistant: (req) =>
      handleChatThreadResumeAssistant(req as PrimitiveRequest),
  };
}
