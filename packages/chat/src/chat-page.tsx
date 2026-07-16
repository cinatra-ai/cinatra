"use client";

// ---------------------------------------------------------------------------
// ChatPage — orchestration shell for the /chat conversation surface.
// ---------------------------------------------------------------------------
// cinatra#918 split this former ~3.4k-line monolith along its concerns,
// mirroring the #853 approach (pure testable seams first, thin component
// wiring after):
//   - ./chat-persistence   — thread CRUD-over-fetch + thread-model helpers
//   - ./chat-stream-events — pure SSE parsing + per-event message transforms
//   - ./chat-routing       — pure client-side routing decisions
//   - ./chat-messages-view — the conversation renderer, mounted via
//     next/dynamic so the heavy renderers (marked/katex via markdown-render,
//     recharts via chart-embed, the mermaid/shiki wrappers) load in their own
//     chunk and stop riding the initial /chat bundle.
// This component keeps the state machine, effects, and dispatch orchestration
// unchanged — every extracted seam is a mechanical move.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { authClient } from "@/lib/auth-client";
import { useTheme } from "next-themes";
import type { ThemeName } from "./syntax-highlight";
import { PromptField, type PromptFieldHandle, type Mentionable, type WidgetDefinition, type WidgetManifest, type WidgetSubmitHandle } from "@cinatra-ai/sdk-ui";
// The widget set is NOT imported from extension packages here. It arrives as
// props from the server chat mount, which resolves it from the generated
// extension manifest + extension lifecycle (src/lib/chat-widget-catalog.server.ts);
// this file derives all detection/wizard/refresh behavior via the pure
// widget-runtime factory. Adding/removing a widget-bearing extension requires
// no edit to this file (#34 / IOC-39, IOC-41).
import {
  createChatWidgetRuntime,
  EMPTY_WIDGETS,
  EMPTY_WIDGET_MANIFESTS,
} from "./widget-runtime";
import {
  resolveMessageRouting,
  setAssistantPauseState,
  extractHitlGateValuesAction,
} from "./actions";
// Chat prompt-window HITL drive.
import {
  classifyPromptForGate,
  createChatGateRegistry,
  resolveExtractedGateValues,
} from "./inline-hitl-classify";
// Chat persistence/replay must carry artifact refs alongside text. Adding to
// the Message shape lets the bridge resolve them without the chat path
// importing @/lib directly.
import type { LlmAttachmentRef } from "@cinatra-ai/llm";
import type { UiMessage as Message, UiThread as Thread, UiThreadSummary as ThreadSummary } from "./types";
import {
  saveChatThreadViaFetch,
  fetchThreadList,
  fetchThreadById,
  generateId,
  deriveThreadTitle,
  extractAgentName,
} from "./ag-ui-chat-client";
import {
  parseSseEventBlock,
  extractAgentRunId,
  normalizeCitations,
  createSlackBuffers,
  appendSlackTextDelta,
  applySlackThinkingStart,
  applySlackThinkingEnd,
  applySlackToolCall,
  applySlackToolResult,
  applySlackCitations,
  applyTextDeltaToMessages,
  applyThinkingStartToMessages,
  applyThinkingEndToMessages,
  applyToolCallToMessages,
  applyToolResultToMessages,
  applyCitationsToMessages,
  applyErrorToMessages,
  extractErrorMessage,
} from "./chat-stream-events";
import {
  EXTERNAL_TAKEOVER_MS,
  countMentions,
  shouldEnterSlackModeOnSend,
  applyExternalMentionsToMessages,
  applyBuiltInMentionToMessages,
  collectNewlyTaggedIds,
  resolveDispatchPlan,
} from "./chat-routing";
// The unified AG-UI wire (cinatra#1218, epic #1216 S2): the headless client
// drives the full turn lifecycle over the S3 reducer behind a small UI port
// (driveAssistantChatTurn); persistence fetch helpers are co-located there
// (formerly ./chat-persistence — see the module's route-graph note). The
// bespoke wire below stays behind the `streamWire` flag until the
// parity-gated deletes land.
import {
  driveAssistantChatTurn,
  ensureAssistantChatWireNegotiated,
  uploadChatAttachments,
} from "./ag-ui-chat-client";
import { SkillBadgeCloud } from "./skill-badge-cloud";
import { selectChatBadges, chatEmptyStateCaption, isPinnedBadgePrefill, getGreeting, DEFAULT_GREETING } from "./chat-badges";
import { fingerprintMessages, isRealActivity } from "./thread-activity";
import { publishChatThreadTitle } from "@/lib/chat-shell-bus";
import { DancingRobot } from "./dancing-robot";

// The conversation renderer is the LAZY BOUNDARY for the chat route's heavy
// renderers (marked/katex/recharts/mermaid/shiki all sit behind it). ssr:false
// is deliberate: a default-SSR dynamic() here tripped a latent Turbopack
// async-module-cycle in unrelated SSR chunks and broke `next build`; the view
// SSR'd an empty container anyway (messages are fetched client-side), so
// client-only rendering of the list is visually equivalent.
const ChatMessagesView = dynamic(
  () => import("./chat-messages-view").then((m) => m.ChatMessagesView),
  { ssr: false, loading: () => null },
);

// Empty-state badge + caption selection live in ./chat-badges (pure +
// unit-tested). The component imports `selectChatBadges` +
// `chatEmptyStateCaption` and feeds the result into the badge cloud / h1.

// The greeting/quote selection lives in ./chat-badges (pure, alongside the
// other empty-state copy selection) — moved there by cinatra#1218 to keep
// this tracked bottleneck file inside its file-size ceiling.

// ---------------------------------------------------------------------------
// Main chat page
// ---------------------------------------------------------------------------

type ChatPageMode = "create-agent" | "create-workflow";

type ChatPageProps = {
  initialThreadId?: string;
  userId?: string;
  initialMention?: string;
  initialMode?: ChatPageMode;
  /** Pre-fills the prompt field on mount (e.g. a `?wf=&task=` workflow-task
   *  handoff). Ignored if `initialMention` is set. */
  initialPrompt?: string;
  /** Live chat-widget catalog, resolved server-side by the chat mount from the
   *  generated extension manifest + extension lifecycle
   *  (src/lib/chat-widget-catalog.server.ts). Component values are RSC client
   *  references. Defaults to empty — widget embeds then simply don't render
   *  (a legitimate state when no widget-bearing extension is live). */
  widgets?: WidgetDefinition[];
  widgetManifests?: WidgetManifest[];
  /** Which stream wire drives default Cinatra turns (cinatra#1218, #1216 S2).
   *  `"ag-ui"` = the unified assistant stream (headless client + S3 reducer);
   *  `"legacy"` = the bespoke chat-stream-events wire (the retained
   *  kill-switch until the parity-gated deletes land). Defaults to legacy so
   *  non-/chat mounts are unaffected; the /chat page mount resolves the env
   *  flag server-side and passes it here. */
  streamWire?: "ag-ui" | "legacy";
};

export function ChatPage({ initialThreadId, userId, initialMention, initialMode, initialPrompt, widgets = EMPTY_WIDGETS, widgetManifests = EMPTY_WIDGET_MANIFESTS, streamWire = "legacy" }: ChatPageProps = {}) {
  const { resolvedTheme } = useTheme();
  const theme: ThemeName = resolvedTheme === "dark" ? "github-dark" : "github-light";
  // Manifest-driven widget runtime — registries/detectors/wizard helpers
  // derived from the props-resolved catalog (see ./widget-runtime).
  const widgetRuntime = useMemo(
    () => createChatWidgetRuntime(widgets, widgetManifests),
    [widgets, widgetManifests],
  );
  const isCreateAgentMode = initialMode === "create-agent";
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(initialThreadId ?? null);
  const [messages, setMessages] = useState<Message[]>([]);
  // Streaming registry: one AbortController per in-flight streamResponse call.
  // Replaces the single boolean flag so N concurrent streams can coexist.
  const [streamingCount, setStreamingCount] = useState(0);
  const hasActiveStream = streamingCount > 0;
  // Map of assistantId → display handle for per-assistant typing indicator bubbles in Slack mode.
  const [typingIndicators, setTypingIndicators] = useState<Map<string, string>>(new Map());
  const [activeAssistantHandle, setActiveAssistantHandle] = useState<string | undefined>();
  const [pendingExternalHandle, setPendingExternalHandle] = useState<string | null>(null);
  const [greeting, setGreeting] = useState(DEFAULT_GREETING);
  const [autosaveEnabled, setAutosaveEnabled] = useState(false);
  const [autosaveVisible, setAutosaveVisible] = useState(false);
  const [autosaveCanToggle, setAutosaveCanToggle] = useState(false);
  const [widgetRefreshKey, setWidgetRefreshKey] = useState(0);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // Scroll lock: true when user has scrolled up intentionally. Auto-scroll is suppressed until
  // streaming ends OR user scrolls back to the bottom.
  const userScrolledUpRef = useRef(false);
  // Marks scrolls driven by scrollToBottom() so onScroll ignores them instead of clearing the lock.
  const isProgrammaticScrollRef = useRef(false);
  const promptRef = useRef<PromptFieldHandle>(null);
  const [promptValue, setPromptValue] = useState<string>("");
  const [mentionables, setMentionables] = useState<Mentionable[]>([]);
  // Pending attachments uploaded via the PromptField paperclip; consumed +
  // cleared by the next sendMessage().
  const [pendingAttachments, setPendingAttachments] = useState<LlmAttachmentRef[]>([]);
  const handleAttachmentsSelected = useCallback(async (files: File[]) => {
    // Upload-over-fetch lives in the client transport module (cinatra#1218).
    const refs = await uploadChatAttachments(files);
    if (refs.length > 0) {
      setPendingAttachments((prev) => [...prev, ...refs]);
    }
  }, []);
  const { data: session } = authClient.useSession();
  const [isSlackMode, setIsSlackMode] = useState(false);
  const isSlackModeRef = useRef(false);
  const [animating, setAnimating] = useState(false);
  const prevIsSlackModeRef = useRef(false);
  const [taggedAssistantUserIds, setTaggedAssistantUserIds] = useState<string[]>([]);
  const [pausedParticipants, setPausedParticipants] = useState<string[]>([]);
  const [requestEditMessageId, setRequestEditMessageId] = useState<string | null>(null);

  // Maps assistantUserId → @handle by scanning mentions in user messages.
  // Used in Slack mode to show the correct sender name/icon per assistant message.
  const assistantHandleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === "user" && msg.mentions) {
        for (const m of msg.mentions) {
          if (m.assistantUserId && m.handle) map.set(m.assistantUserId, m.handle);
        }
      }
    }
    return map;
  }, [messages]);

  // Keep isSlackModeRef in sync so streamResponse always reads the current value
  // even when called from a stale closure (e.g. the 20-second takeover timer).
  useEffect(() => { isSlackModeRef.current = isSlackMode; }, [isSlackMode]);

  useEffect(() => {
    const shouldBeSlack = taggedAssistantUserIds.length >= 2;
    if (shouldBeSlack && !prevIsSlackModeRef.current) {
      // Live transition — play animation once
      setIsSlackMode(true);
      setAnimating(true);
      prevIsSlackModeRef.current = true;
      const t = window.setTimeout(() => setAnimating(false), 700);
      return () => window.clearTimeout(t);
    }
    if (shouldBeSlack) {
      setIsSlackMode(true);
    }
  }, [taggedAssistantUserIds]);

  const skipNextThreadLoadRef = useRef(false);
  // Tracks the thread whose data is currently rendered. Prevents the persist
  // effect from saving stale messages to a new activeThreadId while the async
  // load is still in flight.
  const loadedThreadIdRef = useRef<string | null>(initialThreadId ?? null);
  // Fingerprint of the message list as it was last LOADED for the active
  // thread. The persist effect compares the current fingerprint against this to
  // tell "messages changed because of real activity (user submit / LLM
  // response / edit / external message)" from "messages changed because we just
  // opened/loaded the thread". Only the former advances `updatedAt` and the
  // sidebar position (issue #283). Empty string == nothing loaded yet (a
  // brand-new thread starts empty, so its first user message reads as activity).
  const loadedFingerprintRef = useRef<string>("");
  // The active thread's immutable createdAt as read from the loaded thread
  // data. Used as the createdAt fallback when persisting so the payload's
  // createdAt does not drift to `now`/updatedAt if the local `threads` summary
  // list has not arrived yet (#283 — the typed created_at column is immutable
  // on conflict, but readChatThreadsFromDatabase reads the payload JSON).
  const loadedThreadCreatedAtRef = useRef<string | null>(null);
  // Map of assistantId → AbortController for every in-flight streamResponse call.
  const streamingAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  // Latest-value ref for messages so re-entrant senders never read a stale
  // snapshot when building the next request's context.
  const messagesRef = useRef<Message[]>([]);
  // RunId-keyed registry of OPEN inline HITL gates (cinatra#853 — the
  // chat/run gate concern lives in inline-hitl-classify's pure factory).
  // useState initializer → ONE registry instance for the component lifetime,
  // so both function identities are stable across renders (the handler is
  // threaded to InlineAgentRunCard).
  const [{ handleActiveGateChange, getLatestOpenGate }] = useState(createChatGateRegistry);
  // Latest-value ref for the active thread id so in-flight streamResponse coroutines
  // can detect thread switches after an await and no-op their patches.
  const activeThreadIdRef = useRef<string | null>(null);
  const externalReplyTimerRef = useRef<number | null>(null);
  // Tracks whether the user has manually renamed the active thread — prevents auto-title from overriding.
  const titleUserEditedRef = useRef(false);
  const hasMessages = messages.length > 0;

  // Check if the last assistant message has an embedded widget.
  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant");
  const activeWidgets = lastAssistantMessage ? widgetRuntime.detectWidgets(lastAssistantMessage.content) : [];
  const hasActiveEmbed = activeWidgets.length > 0;
  const widgetSubmitRef = useRef<WidgetSubmitHandle | null>(null);

  // Load thread list and autosave config on mount.
  useEffect(() => {
    void fetchThreadList().then(setThreads);
    setGreeting(getGreeting());

    void fetch("/api/chat/autosave")
      .then((r) => r.json())
      .then((config: { enabled?: boolean; userCanConfigure?: boolean; userCanSeeIndicator?: boolean }) => {
        setAutosaveEnabled(Boolean(config.enabled));
        setAutosaveCanToggle(Boolean(config.userCanConfigure));
        setAutosaveVisible(Boolean(config.userCanSeeIndicator) || Boolean(config.userCanConfigure));
      })
      .catch(() => {});

    let mentionablesCancelled = false;
    void fetch("/api/assistants/list")
      .then((r) => (r.ok ? r.json() : { assistants: [] }))
      .then((data: { assistants?: { id: string; handle: string }[] }) => {
        if (!mentionablesCancelled && Array.isArray(data.assistants)) {
          setMentionables(data.assistants.map((a) => ({ ...a, displayName: a.handle })));
        }
      })
      .catch((err) => {
        console.error("[chat] failed to load assistants for @-mention flyout:", err);
      });

    function resetSlackMode() {
      setIsSlackMode(false);
      setAnimating(false);
      setTaggedAssistantUserIds([]);
      setPausedParticipants([]);
      prevIsSlackModeRef.current = false;
    }

    function handleNewChat() {
      const wasInThread = !!activeThreadIdRef.current || messagesRef.current.length > 0;
      setActiveThreadId(null);
      setMessages([]);
      resetSlackMode();
      promptRef.current?.clear();
      // Only change the greeting when leaving an active thread — avoids visible flicker
      // when clicking "New chat" while already at the empty state.
      if (wasInThread) setGreeting(getGreeting());
      void fetchThreadList().then(setThreads);
      if (window.location.pathname !== "/chat") {
        window.history.pushState(null, "", "/chat");
      }
    }

    function handlePopState() {
      promptRef.current?.clear();
      const match = window.location.pathname.match(/^\/chat\/([a-f0-9-]{36})$/);
      if (match) {
        setActiveThreadId(match[1]);
      } else {
        setActiveThreadId(null);
        setMessages([]);
        resetSlackMode();
        setGreeting(getGreeting());
      }
    }

    function handleSelectThread(e: Event) {
      const { threadId } = (e as CustomEvent<{ threadId: string }>).detail;
      promptRef.current?.clear();
      setActiveThreadId(threadId);
      window.history.pushState(null, "", `/chat/${threadId}`);
    }

    window.addEventListener("cinatra:chat:new", handleNewChat);
    window.addEventListener("cinatra:chat:select", handleSelectThread);
    window.addEventListener("popstate", handlePopState);
    return () => {
      mentionablesCancelled = true;
      window.removeEventListener("cinatra:chat:new", handleNewChat);
      window.removeEventListener("cinatra:chat:select", handleSelectThread);
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  // Keep messagesRef in sync with state so re-entrant callers read the latest value.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Keep activeThreadIdRef in sync so streamResponse can detect thread switches.
  // Also release the auto-scroll lock — it leaked across thread switches (#1702).
  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
    userScrolledUpRef.current = false;
  }, [activeThreadId]);

  // Notify ChatThreadPanel of the active thread so it can highlight without router navigation.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("cinatra:chat:active-changed", { detail: { threadId: activeThreadId } }),
    );
  }, [activeThreadId]);

  // Load thread messages when activeThreadId changes.
  useEffect(() => {
    // Defense in depth: eagerly abort every in-flight stream when the
    // active thread changes. The stillOnOriginThread guard inside
    // streamResponse also short-circuits any late setMessages chunks that arrive
    // after this point, so even if an aborted stream's final reader.read() resolves
    // mid-switch, it cannot mutate the new thread's messages list.
    if (streamingAbortControllersRef.current.size > 0) {
      for (const c of streamingAbortControllersRef.current.values()) c.abort();
      streamingAbortControllersRef.current.clear();
      setStreamingCount(0);
    }
    if (skipNextThreadLoadRef.current) {
      skipNextThreadLoadRef.current = false;
      return;
    }
    if (!activeThreadId) {
      loadedThreadIdRef.current = null;
      loadedFingerprintRef.current = "";
      loadedThreadCreatedAtRef.current = null;
      setMessages([]);
      setIsSlackMode(false);
      setAnimating(false);
      setTaggedAssistantUserIds([]);
      setPausedParticipants([]);
      prevIsSlackModeRef.current = false;
      return;
    }
    void fetchThreadById(activeThreadId).then((thread) => {
      if (thread) {
        // Backfill missing ids — threads stored before the id field was added won't have them,
        // causing key={undefined} in the messages list and React's missing-key warning.
        // Build the loaded array ONCE and reuse it for both setMessages and the
        // activity fingerprint: re-mapping a second time would mint different
        // backfilled ids and make a pure open look like real activity (#283).
        const loadedMessages = thread.messages.map((m) => ({ ...m, id: m.id || generateId() }));
        setMessages(loadedMessages);
        // Restore active assistant handle so subsequent messages route correctly.
        setActiveAssistantHandle(thread.activeAssistantHandle);
        // Synchronise Slack-mode state on cold reload. Set prevIsSlackModeRef.current
        // BEFORE setTaggedAssistantUserIds so the transition-detection useEffect does
        // not detect a false→true transition on mount (no animation on cold load).
        const slackIds = thread.taggedAssistantUserIds ?? [];
        // slackMode flag overrides the taggedAssistantUserIds heuristic — threads
        // that entered Slack mode via a @human-user mention (no assistantUserId) have
        // slackIds=[] but slackMode=true, so the mode is correctly restored on reload.
        const restoredSlack = (thread as unknown as { slackMode?: boolean }).slackMode ?? (slackIds.length > 0);
        prevIsSlackModeRef.current = restoredSlack; // skip animation on cold load
        setTaggedAssistantUserIds(slackIds);
        setIsSlackMode(restoredSlack);
        setPausedParticipants((thread as unknown as { pausedParticipants?: string[] }).pausedParticipants ?? []);
        // Snapshot the loaded messages' fingerprint so the persist effect can
        // tell this load echo apart from real activity and NOT bump updatedAt
        // (and the sidebar position) on a plain open (#283). Uses the SAME
        // loadedMessages array that was handed to setMessages.
        loadedFingerprintRef.current = fingerprintMessages(loadedMessages);
        // Remember the thread's immutable createdAt so a later persist never
        // rewrites it even if the threads-summary list has not loaded yet.
        loadedThreadCreatedAtRef.current =
          (thread as unknown as { createdAt?: string }).createdAt ?? null;
        // Mark this thread's data as fully loaded — unblocks the persist effect.
        loadedThreadIdRef.current = activeThreadId;
      }
    });
  }, [activeThreadId]);

  // Poll the active thread for externally-written messages (e.g. from the
  // chat_thread_send MCP tool). Uses window.setInterval per codebase convention.
  useEffect(() => {
    if (!activeThreadId) return;
    if (hasActiveStream) return;

    const intervalId = window.setInterval(() => {
      void fetchThreadById(activeThreadId).then((thread) => {
        if (!thread) return;
        setMessages((prev) => {
          if (thread.messages.length <= prev.length) return prev;
          // Backfill missing ids — same pattern as the thread-load effect.
          return thread.messages.map((m) => ({ ...m, id: m.id || generateId() }));
        });
        // Sync tagged assistant IDs so externally-added tags (e.g. via MCP) are reflected.
        const serverIds = thread.taggedAssistantUserIds ?? [];
        if (serverIds.length > 0) {
          setTaggedAssistantUserIds((prev) => {
            if (serverIds.length === prev.length && serverIds.every((id, i) => id === prev[i])) return prev;
            return serverIds;
          });
        }
      });
    }, 3000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeThreadId, hasActiveStream]);

  // Clear the pending-external-reply state as soon as an assistant message arrives
  // (either from the external assistant via polling, or from the @cinatra fallback).
  useEffect(() => {
    if (!pendingExternalHandle) return;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === "assistant") {
      setPendingExternalHandle(null);
      if (externalReplyTimerRef.current) {
        clearTimeout(externalReplyTimerRef.current);
        externalReplyTimerRef.current = null;
      }
    }
  }, [messages, pendingExternalHandle]);

  // Poll the thread list so new conversations created externally (e.g. via MCP) appear in the
  // sidebar without a reload. Runs always (not gated on activeThreadId) at a slower cadence.
  useEffect(() => {
    if (hasActiveStream) return;
    const intervalId = window.setInterval(() => {
      void fetchThreadList().then((fresh) => {
        setThreads((prev) => {
          if (fresh.length !== prev.length) return fresh;
          const freshTop = fresh.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.updatedAt;
          const prevTop = prev.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.updatedAt;
          return freshTop !== prevTop ? fresh : prev;
        });
      });
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [hasActiveStream]);

  // Notify the thread panel whenever the thread list changes.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("cinatra:chat:threads-changed", { detail: threads }));
  }, [threads]);

  const scrollToBottom = useCallback(() => {
    if (messagesContainerRef.current && !userScrolledUpRef.current) {
      isProgrammaticScrollRef.current = true;
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
      // Clear the flag after the scroll event fired by this assignment has been processed.
      requestAnimationFrame(() => { isProgrammaticScrollRef.current = false; });
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingCount, pendingExternalHandle, typingIndicators, scrollToBottom]);

  // Re-enable auto-scroll when streaming completes so the next response scrolls normally.
  const prevHasActiveStreamRef = useRef(false);
  useEffect(() => {
    if (prevHasActiveStreamRef.current && !hasActiveStream) userScrolledUpRef.current = false;
    prevHasActiveStreamRef.current = hasActiveStream;
  }, [hasActiveStream]);

  // Return focus to the prompt input after streaming completes.
  useEffect(() => {
    if (!hasActiveStream) promptRef.current?.focus();
  }, [hasActiveStream]);

  // Pre-fill prompt with ?mention=handle when navigating from a profile "Chat now" button.
  useEffect(() => {
    if (!initialMention) return;
    // Wait one tick so the prompt field has mounted and registered its ref.
    const id = setTimeout(() => {
      promptRef.current?.setValue(`@${initialMention} `);
    }, 50);
    return () => clearTimeout(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-fill prompt with a workflow-task handoff (?wf=&task= deep link).
  // Mention wins if both are present (mention is the more specific intent).
  useEffect(() => {
    if (initialMention || !initialPrompt) return;
    const id = setTimeout(() => {
      promptRef.current?.setValue(initialPrompt);
    }, 50);
    return () => clearTimeout(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist thread on real conversational activity (debounced via hasActiveStream).
  useEffect(() => {
    if (!activeThreadId || messages.length === 0) return;
    if (hasActiveStream) return; // Wait until streaming finishes.
    // Bail out if the thread load is still in flight — prevents saving stale
    // messages (from the previous thread) to the newly-selected activeThreadId.
    if (loadedThreadIdRef.current !== activeThreadId) return;
    // Bail out if the messages are identical to what was loaded for this thread
    // — i.e. this effect fired only because opening/selecting the thread set the
    // messages. A passive open must NOT advance updatedAt or reorder the sidebar
    // (#283); only real activity (user submit, LLM response, edit, externally
    // added message) changes the fingerprint and falls through here.
    if (!isRealActivity(loadedFingerprintRef.current, messages)) return;

    const existing = threads.find((t) => t.id === activeThreadId);
    const updatedAt = new Date().toISOString();
    const thread: Thread = {
      id: activeThreadId,
      title: existing?.title
        ?? deriveThreadTitle(messages.find((m) => m.role === "user")?.content ?? ""),
      messages,
      // createdAt is immutable — never derive it from updatedAt (that conflation
      // made the "created" timestamp drift on every save, #283). Prefer the
      // local summary, then the loaded thread's createdAt (covers the case where
      // the summary list has not arrived), and only fall back to updatedAt for a
      // genuinely new thread that has no createdAt anywhere.
      createdAt: existing?.createdAt ?? loadedThreadCreatedAtRef.current ?? updatedAt,
      updatedAt,
      activeAssistantHandle,
      taggedAssistantUserIds,
      slackMode: isSlackMode,
      ownerUserId: userId,
    };
    saveChatThreadViaFetch(thread).catch(() => {});
    // Real activity: advance this thread's updatedAt in-place. The sidebar's
    // default "Activity" mode sorts by updatedAt desc, so this re-positions the
    // thread to the top without an explicit array reorder here.
    setThreads((prev) =>
      prev.map((t) =>
        t.id === thread.id ? { ...t, title: thread.title, updatedAt: thread.updatedAt } : t,
      ),
    );
    // Adopt the persisted message set as the new baseline so an unrelated
    // re-render with the SAME messages does not bump updatedAt a second time.
    loadedFingerprintRef.current = fingerprintMessages(messages);
  }, [messages, hasActiveStream, activeThreadId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Emit active thread title so AppShell can show it in the breadcrumb.
  useEffect(() => {
    const title = threads.find((t) => t.id === activeThreadId)?.title ?? null;
    publishChatThreadTitle(title);
  }, [activeThreadId, threads]);

  function pushChatUrl(threadId: string | null) {
    const url = threadId ? `/chat/${threadId}` : "/chat";
    window.history.pushState(null, "", url);
  }

  // Register a stream in the registry and bump the count. Must only be called
  // from inside streamResponse's try block so cleanup is guaranteed in finally.
  function beginStream(assistantId: string, controller: AbortController) {
    streamingAbortControllersRef.current.set(assistantId, controller);
    setStreamingCount((n) => n + 1);
  }

  // Remove a stream from the registry and decrement the count. Idempotent —
  // safe to call even if the key was already deleted (returns without side effect).
  function endStream(assistantId: string) {
    if (streamingAbortControllersRef.current.delete(assistantId)) {
      setStreamingCount((n) => Math.max(0, n - 1));
    }
  }

  // The AG-UI wire selector (cinatra#1218): "ag-ui" routes default Cinatra
  // turns through the unified stream; a failed fail-closed handshake (S1
  // CONTRACT.md §5) pins this ref to the retained legacy wire.
  const streamWireRef = useRef<"ag-ui" | "legacy">(streamWire);

  // AG-UI stream driver (cinatra#1218) — the unified-wire counterpart of the
  // bespoke streamResponse below, lifecycle-identical; the turn drive lives
  // headlessly in ./ag-ui-chat-client. This wrapper owns registry + guard.
  async function streamAgUiResponse(contextMessages: Message[], threadId: string, handle?: string, authorUserId?: string) {
    const assistantId = generateId();
    const abortController = new AbortController();
    // The ORIGIN thread is the one this turn was dispatched FOR (captured
    // BEFORE the handshake await) — re-reading the ref here would guard
    // against the WRONG thread after a switch during that await.
    const originThreadId = threadId;
    const stillOnOriginThread = () => activeThreadIdRef.current === originThreadId;
    try {
      beginStream(assistantId, abortController);
      await driveAssistantChatTurn({
        threadId,
        assistantId,
        authorUserId,
        slack: isSlackModeRef.current,
        signal: abortController.signal,
        messages: contextMessages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.attachments && m.attachments.length > 0
            ? { attachments: m.attachments }
            : {}),
        })),
        ui: {
          updateMessages: (updater) =>
            setMessages((prev) => (stillOnOriginThread() ? updater(prev) : prev)),
          setTypingIndicator: (on) =>
            setTypingIndicators((prev) => {
              const m = new Map(prev);
              if (on) m.set(assistantId, handle ?? "Assistant");
              else m.delete(assistantId);
              return m;
            }),
          isWidgetRefreshTool: (name) => widgetRuntime.isWidgetRefreshTool(name),
          onWidgetRefresh: () => setWidgetRefreshKey((k) => k + 1),
        },
      });
    } finally {
      endStream(assistantId);
    }
  }

  // Thin SSE driver — connection handling, the read loop, and the
  // thread-switch/abort guards live here; every per-event message transform is
  // a pure, unit-tested applier in ./chat-stream-events.
  async function streamResponse(contextMessages: Message[], handle?: string, endpoint = "/api/chat", authorUserId?: string) {
    // Unified-wire delegation (cinatra#1218): default Cinatra turns ride the
    // AG-UI stream when the cutover flag is on and the fail-closed handshake
    // succeeds (a failure pins the page to the retained legacy wire).
    // Mention/external/bridge dispatches stay on their legacy endpoints in
    // this stage (S5/delete-stage scope). The thread always exists here.
    if (endpoint === "/api/chat" && streamWireRef.current === "ag-ui") {
      const agUiThreadId = activeThreadIdRef.current;
      if (agUiThreadId) {
        if (await ensureAssistantChatWireNegotiated()) {
          return streamAgUiResponse(contextMessages, agUiThreadId, handle, authorUserId);
        }
        streamWireRef.current = "legacy";
      }
    }
    const assistantId = generateId();
    const abortController = new AbortController();
    // Capture the thread that spawned this stream. Every async patch below
    // short-circuits if the active thread has changed since we started.
    const originThreadId = activeThreadIdRef.current;
    // Per-stream paragraph-break tracker. Must be function-local so two
    // concurrent streams cannot corrupt each other's separator state. It is
    // consumed HERE in event-loop scope (never inside a setMessages updater)
    // — see applyTextDeltaToMessages for the React-replay rationale.
    let nextTextNeedsRoundSeparator = false;
    // Read Slack mode from the ref so stale closures (e.g. the 20-second takeover timer)
    // always see the current value rather than the value at the time sendMessage was called.
    const isSlack = isSlackModeRef.current;

    // Helper: returns true iff the thread that spawned this stream is still
    // the active thread. Every setMessages callback inside the SSE loop calls
    // this and returns `prev` unchanged when it fires false — the stream has
    // been orphaned by a thread switch and must not mutate the new thread.
    const stillOnOriginThread = () => activeThreadIdRef.current === originThreadId;

    // Slack-mode accumulation buffers. Declared before try so they are accessible in finally.
    const slackBuffers = createSlackBuffers();
    // Error from catch block — declared before try so finally can read it.
    let caughtError = "";

    try {
      // Register the stream AFTER local declarations and BEFORE any await.
      // If any statement above throws (it can't — they're all synchronous
      // constant/local declarations), no registry leak is possible.
      beginStream(assistantId, abortController);

      if (isSlack) {
        // Slack mode: show a per-assistant typing indicator instead of an empty bubble.
        setTypingIndicators((prev) => {
          const m = new Map(prev);
          m.set(assistantId, handle ?? "Assistant");
          return m;
        });
      } else {
        // ChatGPT mode: append the empty assistant bubble immediately (unchanged behavior).
        setMessages((prev) => {
          if (!stillOnOriginThread()) return prev;
          return [...prev, { id: assistantId, role: "assistant", content: "", thoughtGroups: [], parts: [], liveStatus: "Thinking", ...(authorUserId ? { authorUserId } : {}) }];
        });
      }

      const apiMessages = contextMessages.map((m) => ({
        role: m.role,
        content: m.content,
        // Forward attachments only when present so every text-only message
        // remains byte-identical.
        ...(m.attachments && m.attachments.length > 0
          ? { attachments: m.attachments }
          : {}),
      }));
      const chatBody = JSON.stringify({ messages: apiMessages });

      // Retry once on network errors (TypeError: Failed to fetch). This handles
      // Turbopack's lazy compilation window: the first request to /api/chat after
      // a server restart may fail while the large module graph is being compiled.
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: chatBody,
          signal: abortController.signal,
        });
      } catch (fetchErr) {
        if (abortController.signal.aborted) throw fetchErr;
        // Network error — wait briefly and retry once
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        if (abortController.signal.aborted) throw fetchErr;
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: chatBody,
          signal: abortController.signal,
        });
      }

      // After the initial network await, verify we're still on the origin thread
      // AND not already aborted. If the user switched threads during the POST
      // handshake, exit silently — no state mutation, no error toast.
      if (abortController.signal.aborted || !stillOnOriginThread()) {
        return;
      }

      if (!response.ok) throw new Error("Chat request failed.");

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response stream.");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (abortController.signal.aborted || !stillOnOriginThread()) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const parsed = parseSseEventBlock(block);
          if (!parsed) continue;
          const { evt, data: d } = parsed;

          if (evt === "text") {
            const delta = String(d.content ?? "");
            // Read-and-clear the round-boundary flag HERE (event loop scope) —
            // the SSE handler runs exactly once per event, so the applier stays
            // a pure function of `prev` (see chat-stream-events.ts).
            const consumeRoundSeparator = nextTextNeedsRoundSeparator;
            if (consumeRoundSeparator) {
              nextTextNeedsRoundSeparator = false;
            }
            if (!delta) {
              // Skip — no state change.
            } else if (!isSlack) {
              setMessages((prev) => {
                if (!stillOnOriginThread()) return prev;
                return applyTextDeltaToMessages(prev, assistantId, delta, consumeRoundSeparator);
              });
            } else {
              // Slack mode: accumulate into buffer instead of updating state per-chunk.
              appendSlackTextDelta(slackBuffers, delta, consumeRoundSeparator);
            }
          } else if (evt === "thinking_start") {
            if (!isSlack) {
              setMessages((prev) => {
                if (!stillOnOriginThread()) return prev;
                return applyThinkingStartToMessages(prev, assistantId);
              });
            } else {
              applySlackThinkingStart(slackBuffers);
            }
          } else if (evt === "thinking_end") {
            const seconds = Number(d.seconds) || 0;
            if (!isSlack) {
              setMessages((prev) => {
                if (!stillOnOriginThread()) return prev;
                return applyThinkingEndToMessages(prev, assistantId, seconds);
              });
            } else {
              applySlackThinkingEnd(slackBuffers, seconds);
            }
            nextTextNeedsRoundSeparator = true;
          } else if (evt === "tool_call") {
            const event = {
              id: String(d.id),
              name: String(d.name),
              serverLabel: typeof d.serverLabel === "string" ? d.serverLabel : undefined,
            };
            if (!isSlack) {
              setMessages((prev) => {
                if (!stillOnOriginThread()) return prev;
                return applyToolCallToMessages(prev, assistantId, event);
              });
            } else {
              applySlackToolCall(slackBuffers, event);
            }
          } else if (evt === "tool_result") {
            const toolName = String(d.name ?? "");
            if (widgetRuntime.isWidgetRefreshTool(toolName)) {
              setWidgetRefreshKey((k) => k + 1);
            }
            const event = {
              id: String(d.id),
              resultLabel: String(d.resultLabel ?? ""),
              serverLabel: typeof d.serverLabel === "string" ? d.serverLabel : undefined,
              // agent_run results carry a runId the renderer pins on the
              // tool_call part (mounts <InlineAgentRunCard runId={...} />).
              runId: extractAgentRunId(toolName, d.result),
            };
            if (!isSlack) {
              setMessages((prev) => {
                if (!stillOnOriginThread()) return prev;
                return applyToolResultToMessages(prev, assistantId, event);
              });
            } else {
              applySlackToolResult(slackBuffers, event);
            }
          } else if (evt === "citations") {
            const normalized = normalizeCitations(d.citations);
            if (normalized.length > 0) {
              if (!isSlack) {
                setMessages((prev) => {
                  if (!stillOnOriginThread()) return prev;
                  return applyCitationsToMessages(prev, assistantId, normalized);
                });
              } else {
                applySlackCitations(slackBuffers, normalized);
              }
            }
          } else if (evt === "error") {
            const rawError = String(d.message ?? "");
            if (!isSlack) {
              setMessages((prev) => {
                if (!stillOnOriginThread()) return prev;
                return applyErrorToMessages(prev, assistantId, rawError);
              });
            } else {
              slackBuffers.error = extractErrorMessage(rawError);
              break;
            }
          }
        }
      }

      // Slack mode: reveal the fully buffered message in one atomic setMessages call.
      // Intentionally does NOT populate `parts` — Slack reveals atomically so it
      // doesn't have the visually-divorced-progress problem the chat UI does.
      // The renderer's fallback to `thoughtGroups + content` runs for these
      // messages. If Slack ever moves to streamed reveal, also build a parts
      // trace here (cf. ChatGPT mode's event handlers above).
      if (isSlack && stillOnOriginThread() && (slackBuffers.text.length > 0 || slackBuffers.thoughtGroups.length > 0 || slackBuffers.error.length > 0)) {
        setMessages((prev) => {
          if (!stillOnOriginThread()) return prev;
          return [...prev, {
            id: assistantId,
            role: "assistant" as const,
            content: slackBuffers.text,
            ...(authorUserId ? { authorUserId } : {}),
            ...(slackBuffers.thoughtGroups.length > 0 ? { thoughtGroups: slackBuffers.thoughtGroups } : {}),
            ...(slackBuffers.citations.length > 0 ? { citations: slackBuffers.citations } : {}),
            ...(slackBuffers.error.length > 0 ? { error: slackBuffers.error } : {}),
          }];
        });
      }
    } catch (error) {
      // Internal error boundary — streamResponse MUST NOT rethrow because
      // callers dispatch it as `void streamResponse(...)` and unhandled promise
      // rejections would leak and leave streamingCount stuck.
      if (error instanceof Error && error.name === "AbortError") {
        // User clicked stop or thread switch aborted — clean exit, no toast.
      } else {
        const rawError = error instanceof Error ? error.stack ?? error.message : "Something went wrong.";
        if (!isSlack) {
          setMessages((prev) => {
            if (!stillOnOriginThread()) return prev;
            return prev.map((msg) =>
              msg.id === assistantId
                ? { ...msg, error: error instanceof Error ? error.message : "Something went wrong.", errorRaw: rawError }
                : msg,
            );
          });
        } else {
          caughtError = error instanceof Error ? error.message : "Something went wrong.";
        }
      }
      // Do NOT rethrow. Swallow.
    } finally {
      if (isSlack) {
        // Remove this assistant's typing indicator bubble.
        setTypingIndicators((prev) => {
          const m = new Map(prev);
          m.delete(assistantId);
          return m;
        });
        // If a non-abort error occurred and we didn't already insert a content bubble, insert an error bubble.
        if (caughtError && stillOnOriginThread()) {
          setMessages((prev) => {
            if (!stillOnOriginThread()) return prev;
            const alreadyInserted = prev.some((m) => m.id === assistantId);
            if (alreadyInserted) return prev;
            return [...prev, { id: assistantId, role: "assistant" as const, content: "", error: caughtError }];
          });
        }
      }
      // Sole cleanup — guarantees Map/count stay in sync even on unexpected errors.
      endStream(assistantId);
    }
  }

  async function submitEmbed() {
    const ok = await widgetSubmitRef.current?.submit();
    if (!ok) return;

    // Determine which widget was just saved.
    const currentWidget = activeWidgets[0];
    const currentWidgetId = currentWidget?.widgetId ?? "";
    const resourceId = currentWidget?.resourceId ?? "";
    const label = widgetRuntime.wizardStepLabel(currentWidgetId) ?? "Configuration saved.";
    const nextWidgetId = widgetRuntime.getNextWizardStep(currentWidgetId);

    if (nextWidgetId && resourceId) {
      // Advance to next wizard step — embed the next widget directly, no API call.
      const embedTag = `[widget:${nextWidgetId}:${resourceId}]`;
      const confirmMsg: Message = { id: generateId(), role: "assistant", content: `${label}\n\n${embedTag}` };
      setMessages((prev) => [...prev, confirmMsg]);
    } else if (resourceId && widgetRuntime.isWizardStep(currentWidgetId)) {
      // Last wizard step — show confirmation prompt using manifest config.
      const manifest = widgetRuntime.getWizardManifest(currentWidgetId);
      const confirmType = manifest?.wizard?.confirmation.resourceType ?? "resource";
      const confirmTag = `[confirm-${confirmType}:${resourceId}]`;
      const confirmMsg: Message = { id: generateId(), role: "assistant", content: `${label}\n\n${confirmTag}` };
      setMessages((prev) => [...prev, confirmMsg]);
    } else {
      // Non-wizard widget — confirm and let the model continue.
      const confirmMsg: Message = { id: generateId(), role: "assistant", content: label };
      const updatedMessages = [...messages, confirmMsg];
      setMessages(updatedMessages);
      await streamResponse(updatedMessages);
    }
  }

  async function activateResource(resourceType: string, resourceId: string) {
    const manifest = widgetRuntime.findManifestByConfirmationResourceType(resourceType);
    if (!manifest?.wizard) return;

    const endpoint = manifest.wizard.confirmation.activateEndpoint.replace("{resourceId}", resourceId);
    const response = await fetch(endpoint, { method: "POST" });
    if (!response.ok) {
      const errorMsg: Message = { id: generateId(), role: "assistant", content: "Failed to create. Please try again." };
      setMessages((prev) => [...prev, errorMsg]);
      return;
    }

    const result = await response.json().catch(() => ({})) as { resourceId?: string };
    const realId = result.resourceId ?? resourceId;
    const successMessage = `${manifest.wizard.confirmation.successMessage} The ${resourceType} ID is ${realId}. Continue with the next steps.`;
    const confirmMsg: Message = { id: generateId(), role: "assistant", content: successMessage };
    const updatedMessages = [...messages, confirmMsg];
    setMessages(updatedMessages);
    await streamResponse(updatedMessages);
  }

  async function editAndResend(messageId: string, newContent: string) {
    if (!newContent.trim()) return;
    // In ChatGPT mode, keep the existing single-stream block; in Slack mode concurrent streams are allowed.
    if (!isSlackMode && hasActiveStream) return;

    // Truncate conversation at the edited message and replace it.
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    const prior = messages.slice(0, idx);
    // Preserve attachments from the original turn so editing the text doesn't
    // silently drop the file refs from the persisted thread + the re-dispatched
    // user message.
    const original = messages[idx];
    const editedMessage: Message = {
      id: generateId(),
      role: "user",
      content: newContent.trim(),
      ...(original?.attachments && original.attachments.length > 0
        ? { attachments: original.attachments }
        : {}),
    };
    const truncated = [...prior, editedMessage];
    setMessages(truncated);

    // Resolve threadId — edits always happen in an existing thread.
    const threadId = activeThreadId ?? activeThreadIdRef.current;

    // Persist the truncated history before routing (same as sendMessage).
    if (threadId) {
      const now = new Date().toISOString();
      const title = threads.find((t) => t.id === threadId)?.title ?? deriveThreadTitle(editedMessage.content);
      // createdAt is immutable: prefer the summary, then the loaded thread's
      // createdAt (covers the body loading before the summary list), then now
      // for a genuinely new thread (#283).
      const createdAt = threads.find((t) => t.id === threadId)?.createdAt ?? loadedThreadCreatedAtRef.current ?? now;
      saveChatThreadViaFetch({ id: threadId, title, messages: truncated, createdAt, updatedAt: now, activeAssistantHandle, taggedAssistantUserIds, slackMode: isSlackMode, ownerUserId: userId } as Record<string, unknown> & { id: string })
        .catch((err) => console.error("[chat] saveChatThread failed (edit):", err));
    }

    // ChatGPT (normal) mode — preserve byte-identical behavior.
    if (!isSlackMode) {
      await streamResponse(truncated);
      return;
    }

    // Slack mode — always regenerate. Use routing to pick the right endpoint; fall back to /api/chat.
    let editEndpoint = "/api/chat";
    let editHandle: string | undefined = activeAssistantHandle;
    let editAuthorId: string | undefined;

    try {
      const routing = await resolveMessageRouting(
        editedMessage.content,
        threadId,
        activeAssistantHandle,
        {
          taggedAssistantUserIds,
          pausedParticipants,
          handleMap: Object.fromEntries(assistantHandleMap),
        },
      );
      if (routing.chatEndpoint) editEndpoint = routing.chatEndpoint;
      const nextHandle = routing.activeHandle !== undefined ? (routing.activeHandle || undefined) : activeAssistantHandle;
      if (routing.activeHandle !== undefined) setActiveAssistantHandle(nextHandle);
      editHandle = nextHandle ?? activeAssistantHandle;
      editAuthorId = routing.builtInMention?.assistantUserId;
    } catch {
      // Routing failed — proceed with current assistant context
    }

    // Always fire the stream so the user always gets a regenerated response on edit.
    void streamResponse(truncated, editHandle, editEndpoint, editAuthorId);
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();

    // If empty submit and an embed is active, submit the embedded form instead.
    if (!trimmed && hasActiveEmbed) {
      void submitEmbed();
      return;
    }

    if (!trimmed) return;
    // In Slack mode, re-entry is allowed — users can keep posting while assistants stream.
    // In ChatGPT mode, the existing single-stream block is preserved.
    if (!isSlackMode && hasActiveStream) return;

    // Create thread if needed.
    let threadId = activeThreadId;
    if (!threadId) {
      threadId = generateId();
      const title = extractAgentName(trimmed) ?? deriveThreadTitle(trimmed);
      const now = new Date().toISOString();
      // Don't save the empty thread here — the save with the user message below
      // will create it. Saving empty first then saving with messages creates a
      // race condition where the empty write can arrive at the server second.
      skipNextThreadLoadRef.current = true;
      loadedThreadIdRef.current = threadId;
      // New thread — reset pause state so stale participants from previous thread don't bleed in.
      setPausedParticipants([]);
      setActiveThreadId(threadId);
      setThreads((prev) => [{ id: threadId!, title, createdAt: now, updatedAt: now }, ...prev]);
      pushChatUrl(threadId);
    }

    // Snapshot + clear pending attachments so this message owns the refs and
    // the next prompt starts empty.
    const attachmentsForThisMessage = pendingAttachments;
    if (attachmentsForThisMessage.length > 0) setPendingAttachments([]);
    const userMessage: Message = {
      id: generateId(),
      role: "user",
      content: trimmed,
      ...(attachmentsForThisMessage.length > 0
        ? { attachments: attachmentsForThisMessage }
        : {}),
    };
    // Read from messagesRef to avoid stale-closure races: a previous Slack submit may
    // have appended an assistant bubble after this handler's closure was captured.
    const baseMessages = messagesRef.current;
    const currentMessages = [...baseMessages, userMessage];
    // For any @mention, switch to Slack mode NOW — in the same synchronous batch as
    // setMessages — so the message is never rendered in normal (right-aligned) mode.
    // resolveMessageRouting is async; the cheap regex check in ./chat-routing is
    // sufficient here.
    if (shouldEnterSlackModeOnSend({
      isSlackMode,
      taggedAssistantCount: taggedAssistantUserIds.length,
      mentionCount: countMentions(trimmed),
    })) {
      // Suppress the enter-animation only on the very first message of a new thread.
      if (baseMessages.length === 0) prevIsSlackModeRef.current = true;
      setIsSlackMode(true);
    }
    setMessages(currentMessages);
    promptRef.current?.clear();

    // Auto-update thread title from "The agent's name is: <name>" in existing threads.
    const agentName = extractAgentName(trimmed);
    if (agentName && threadId && !titleUserEditedRef.current) {
      const now = new Date().toISOString();
      setThreads((prev) =>
        prev.map((t) =>
          t.id === threadId ? { ...t, title: agentName, updatedAt: now } : t,
        ),
      );
    }

    // Always persist the user message immediately — before routing, before LLM call.
    // This ensures the message is saved even if routing returns early (external assistant)
    // or if streamResponse fails partway through.
    {
      const now = new Date().toISOString();
      const title = threads.find((t) => t.id === threadId)?.title ?? deriveThreadTitle(trimmed);
      // createdAt is immutable: prefer the summary, then the loaded thread's
      // createdAt, then now for a genuinely new thread (#283).
      const createdAt = threads.find((t) => t.id === threadId)?.createdAt ?? loadedThreadCreatedAtRef.current ?? now;
      saveChatThreadViaFetch({ id: threadId, title, messages: currentMessages, createdAt, updatedAt: now, activeAssistantHandle, taggedAssistantUserIds, slackMode: isSlackMode, ownerUserId: userId } as Record<string, unknown> & { id: string }).catch((err) => console.error("[chat] saveChatThread failed:", err));
    }

    // -----------------------------------------------------------------------
    // Chat prompt-window HITL drive. If an inline HITL gate is
    // open, classify this message: a gate response is submitted via the SAME
    // approval path the embedded form uses (AgenticRunPanel single source of
    // truth) and does NOT trigger an LLM turn; a non-response falls through
    // to normal chat routing below.
    // -----------------------------------------------------------------------
    {
      // Drive the most-recently-registered open gate (typical case: one).
      const gate = getLatestOpenGate();
      if (gate) {
        const verdict = classifyPromptForGate(trimmed, {
          fields: gate.fields,
          fieldName: gate.fieldName,
        });
        // Append an assistant ack AND persist it, mirroring the immediate
        // user-message save above. Without the explicit save the gate path's
        // early returns leave the ack reliant on the generic no-stream
        // persistence effect; persisting here removes the timing inconsistency
        // so the ack survives an immediate reload.
        const persistAck = (content: string): void => {
          const ackMsg: Message = {
            id: generateId(),
            role: "assistant",
            content,
          };
          const messagesWithAck = [...currentMessages, ackMsg];
          setMessages((prev) => [...prev, ackMsg]);
          const now = new Date().toISOString();
          const title =
            threads.find((t) => t.id === threadId)?.title ??
            deriveThreadTitle(trimmed);
          // createdAt is immutable: prefer the summary, then the loaded
          // thread's createdAt, then now for a genuinely new thread (#283).
          const createdAt =
            threads.find((t) => t.id === threadId)?.createdAt ?? loadedThreadCreatedAtRef.current ?? now;
          saveChatThreadViaFetch({
            id: threadId,
            title,
            messages: messagesWithAck,
            createdAt,
            updatedAt: now,
            activeAssistantHandle,
            taggedAssistantUserIds,
            slackMode: isSlackMode,
            ownerUserId: userId,
          } as Record<string, unknown> & { id: string }).catch((err) =>
            console.error("[chat] saveChatThread (gate ack) failed:", err),
          );
        };
        const finishGateSubmit = async (
          value: Record<string, unknown> | string | number | boolean,
        ): Promise<void> => {
          try {
            await gate.submit(value);
            persistAck(
              `Submitted to the agent's \`${gate.xRenderer}\` step.`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : "unknown";
            persistAck(`Could not submit to the agent gate: ${msg}`);
          }
        };
        if (verdict.kind === "submit") {
          await finishGateSubmit(verdict.value);
          return;
        }
        if (verdict.kind === "llm") {
          let extracted: Record<string, unknown> = {};
          try {
            const raw = await extractHitlGateValuesAction(trimmed, gate.fields);
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              extracted = parsed as Record<string, unknown>;
            }
          } catch {
            extracted = {};
          }
          // The required-field policy is pure and unit-tested — see
          // resolveExtractedGateValues in inline-hitl-classify.ts.
          const resolution = resolveExtractedGateValues(extracted, gate.fields);
          if (resolution.kind === "submit") {
            await finishGateSubmit(resolution.value);
            return;
          }
          if (resolution.kind === "partial") {
            // Partial — keep the gate open, tell the user what's missing,
            // do NOT route to the LLM (the message was a gate attempt).
            persistAck(
              `Got ${resolution.presentKeys.join(", ")}. Still need: ${resolution.missing.join(", ")}. Fill the form or reply with the remaining value(s).`,
            );
            return;
          }
          // Nothing extracted → fall through to normal chat routing.
        }
        // verdict.kind === "chat" → fall through to normal chat routing.
      }
    }

    // Check routing: broadcast to all non-paused participants when no @mention.
    const routing = await resolveMessageRouting(
      trimmed,
      threadId,
      activeAssistantHandle,
      {
        taggedAssistantUserIds,
        pausedParticipants,
        handleMap: Object.fromEntries(assistantHandleMap),
      },
    );
    // Optimistically append newly-tagged assistantUserIds to component state BEFORE
    // saveChatThread — this triggers the Slack-mode transition the moment the user sends.
    const newlyTaggedIds = collectNewlyTaggedIds(routing.externalMentions);
    if (newlyTaggedIds.length > 0) {
      // First message with @mention — conversation opens directly in Slack mode,
      // no "switching" animation needed. Mirror the cold-load suppression pattern.
      if (baseMessages.length === 0) prevIsSlackModeRef.current = true;
      setTaggedAssistantUserIds((prev) => {
        const merged = new Set([...prev, ...newlyTaggedIds]);
        return Array.from(merged);
      });
    }
    // Persist the active assistant handle in component state.
    const nextActiveHandle = routing.activeHandle !== undefined ? (routing.activeHandle || undefined) : activeAssistantHandle;
    if (routing.activeHandle !== undefined) setActiveAssistantHandle(nextActiveHandle);

    // Always attach mentionState to the user message so external assistants get polled.
    if (routing.externalMentions && routing.externalMentions.length > 0) {
      const externalMentions = routing.externalMentions;
      setMessages((prev) => applyExternalMentionsToMessages(prev, userMessage.id, externalMentions));
    }

    // Attach mention for built-in assistants so assistantHandleMap resolves their handle → name.
    if (routing.builtInMention) {
      const builtInMention = routing.builtInMention;
      setMessages((prev) => applyBuiltInMentionToMessages(prev, userMessage.id, builtInMention));
    }

    const plan = resolveDispatchPlan(routing, nextActiveHandle);

    if (plan.kind === "none") {
      // Broadcast fired to external assistants but Cinatra is paused — nothing more to do locally.
      return;
    }

    if (plan.kind === "wait-external") {
      // Only external assistants are active — show waiting indicator.
      setPendingExternalHandle(plan.handle);
      if (externalReplyTimerRef.current) clearTimeout(externalReplyTimerRef.current);
      externalReplyTimerRef.current = window.setTimeout(() => {
        externalReplyTimerRef.current = null;
        // Cinatra takeover — launch the stream FIRST so beginStream() registers the
        // abort controller / typing indicator in the same render batch where
        // pendingExternalHandle is cleared. This removes the visible gap between
        // "Waiting for @handle…" and the cinatra thinking indicator.
        void streamResponse(currentMessages, "cinatra");
        setPendingExternalHandle(null);
      }, EXTERNAL_TAKEOVER_MS);
      return;
    }

    // plan.kind === "stream"
    if (isSlackMode) {
      // Slack mode: fire-and-forget so sendMessage returns immediately and the
      // composer unblocks. streamResponse is guaranteed non-throwing by its
      // internal try/catch, which writes errors into the assistant message, so
      // void dispatch cannot leak an unhandled rejection.
      const displayHandle = nextActiveHandle ?? activeAssistantHandle ?? "Assistant";
      void streamResponse(currentMessages, displayHandle, plan.endpoint, plan.authorUserId);
    } else {
      // ChatGPT mode: preserve the existing synchronous, blocking behavior.
      await streamResponse(currentMessages, undefined, plan.endpoint, plan.authorUserId);
    }
  }

  // Stable callbacks threaded to the lazily-loaded conversation view.
  const isStreaming = useCallback(
    (messageId: string) => streamingAbortControllersRef.current.has(messageId),
    [],
  );
  const handleTogglePause = useCallback((participantId: string, next: boolean) => {
    setPausedParticipants((prev) =>
      next ? [...prev, participantId] : prev.filter((id) => id !== participantId),
    );
    // The pause button only renders inside an active thread, so activeThreadId
    // is always set when this fires (same invariant the inline handler relied on).
    if (activeThreadIdRef.current) {
      void setAssistantPauseState(activeThreadIdRef.current, participantId, next);
    }
  }, []);
  const handleEditStarted = useCallback(() => setRequestEditMessageId(null), []);

  // Shared autosave prop for both PromptField mounts (hoisted — cinatra#1218).
  const autosaveProp = autosaveVisible ? {
    enabled: autosaveEnabled,
    canToggle: autosaveCanToggle,
    onToggle: (enabled: boolean) => {
      setAutosaveEnabled(enabled);
      void fetch("/api/chat/autosave", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
    },
  } : undefined;

  // ----- Empty state -----
  // Only show the start screen when no thread is selected. When activeThreadId is
  // set (thread clicked) but messages haven't loaded from the API yet, fall through
  // to the thread view so users don't see a flash of the start screen during load.
  if (!hasMessages && !activeThreadId) {
    return (
      <div className="flex h-full">
          <main className="flex flex-1 flex-col items-center justify-center px-5 pb-[80px]">
            <div className="flex w-full max-w-2xl flex-col items-center gap-8 -mt-[30px]">
              <div className="-translate-y-[30px]"><DancingRobot /></div>
              <div className="flex w-full flex-col items-center gap-8 -mt-[120px]">
              <div className="flex flex-col items-center gap-3">
                <h1 className="text-center font-display italic font-extrabold leading-[1.05] tracking-[-0.018em] text-balance text-[38px] text-foreground">
                  {chatEmptyStateCaption(initialMode, greeting)}
                </h1>
              </div>

              <div className="w-full">
                <PromptField
                  ref={promptRef}
                  editorTestId="chat-prompt-input"
                  placeholder={
                    isCreateAgentMode
                      ? "Describe what it should do"
                      : "Ask anything..."
                  }
                  storageKey="cinatra_chat_prompt"
                  shouldDiscardStoredValue={isPinnedBadgePrefill}
                  rows={1}
                  canSubmitEmpty={false}
                  onSubmit={(value) => void sendMessage(value)}
                  onChange={(value) => setPromptValue(value)}
                  submitAriaLabel="Send message"
                  pending={isSlackMode ? false : (hasActiveStream || !!pendingExternalHandle)}
                  showStatusMessage={false}
                  mentionables={mentionables}
                  onAttachmentsSelected={handleAttachmentsSelected}
                  autosave={autosaveProp}
                />
                <SkillBadgeCloud
                  badges={selectChatBadges(initialMode)}
                  promptValue={promptValue}
                  onSelect={(prefillText) => {
                    promptRef.current?.setValue(prefillText);
                    promptRef.current?.focus?.();
                  }}
                />
              </div>
              </div>
            </div>
          </main>
        </div>
    );
  }

  // ----- Conversation state -----
  return (
    <div className="flex h-full">
      <div className="relative flex min-h-0 flex-1 flex-col">

        <div
          ref={messagesContainerRef}
          className="min-h-0 flex-1 overflow-y-auto pb-24 pt-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onScroll={() => {
            // Ignore scroll events caused by scrollToBottom() itself — only react to user input.
            if (isProgrammaticScrollRef.current) return;
            const el = messagesContainerRef.current;
            if (!el) return;
            const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            // 5px threshold: engage lock on any meaningful upward scroll, release when back at bottom.
            userScrolledUpRef.current = distanceFromBottom > 5;
          }}
        >
          <ChatMessagesView
            messages={messages}
            isSlackMode={isSlackMode}
            animating={animating}
            theme={theme}
            userId={userId}
            sessionUser={session?.user}
            activeThreadId={activeThreadId}
            activeAssistantHandle={activeAssistantHandle}
            assistantHandleMap={assistantHandleMap}
            taggedAssistantUserIds={taggedAssistantUserIds}
            mentionables={mentionables}
            pausedParticipants={pausedParticipants}
            onTogglePause={handleTogglePause}
            requestEditMessageId={requestEditMessageId}
            onRequestEditMessage={setRequestEditMessageId}
            onEditStarted={handleEditStarted}
            hasActiveStream={hasActiveStream}
            isStreaming={isStreaming}
            onEditAndResend={(id, content) => void editAndResend(id, content)}
            onActivateResource={(resourceType, resourceId) => void activateResource(resourceType, resourceId)}
            widgetRuntime={widgetRuntime}
            widgetSubmitRef={widgetSubmitRef}
            widgetRefreshKey={widgetRefreshKey}
            onActiveGateChange={handleActiveGateChange}
            pendingExternalHandle={pendingExternalHandle}
            typingIndicators={typingIndicators}
          />
        </div>

        {/* Zero-height relative anchor — constrains input bar to max-w-3xl+px-4 exactly as messages content */}
        <div className="relative mx-auto w-full max-w-3xl px-4">
          <div className="absolute bottom-0 left-4 right-4 bg-background pb-3 pt-0">
            <PromptField
              ref={promptRef}
              editorTestId="chat-prompt-input"
              placeholder={hasActiveEmbed ? "Press Enter to save, or type a message..." : "Type a message..."}
              storageKey={`cinatra_thread_prompt_${activeThreadId}`}
              rows={1}
              canSubmitEmpty={hasActiveEmbed}
              onSubmit={(value) => void sendMessage(value)}
              submitAriaLabel={hasActiveEmbed ? "Save form" : "Send message"}
              pending={isSlackMode ? false : (hasActiveStream || !!pendingExternalHandle)}
              onStop={() => {
                for (const c of streamingAbortControllersRef.current.values()) c.abort();
              }}
              stopAriaLabel="Stop generating"
              showStatusMessage={false}
              mentionables={mentionables}
              onAttachmentsSelected={handleAttachmentsSelected}
              autosave={autosaveProp}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
