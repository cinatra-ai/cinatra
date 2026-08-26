"use client";

// ---------------------------------------------------------------------------
// ChatPage — orchestration shell for the /chat conversation surface.
// ---------------------------------------------------------------------------
// cinatra#918 split this former ~3.4k-line monolith along its concerns,
// mirroring the #853 approach (pure testable seams first, thin component
// wiring after):
//   - ./ag-ui-chat-client  — the headless AG-UI turn driver + thread
//     CRUD-over-fetch helpers (the unified assistant stream, cinatra#1218)
//   - ./chat-routing       — pure client-side routing decisions
//   - ./conversation-column — THE conversation column (cinatra#2683): the
//     message list, the composer and the scroll behaviour between them, which
//     the site widget mounts too. It owns the next/dynamic boundary for the
//     heavy renderers (marked/katex via markdown-render, the mermaid/shiki
//     wrappers, the extension view dispatch), so they still load in their own
//     chunk and still stay off the initial /chat bundle.
// The bespoke chat-stream-events wire and its `CHAT_STREAM_WIRE` kill-switch
// were deleted by the cinatra#1218 delete stage — the AG-UI stream is the
// ONLY wire; a failed S1 handshake is a fail-closed turn error, never a
// fallback.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { useTheme } from "next-themes";
import type { ThemeName } from "./syntax-highlight";
import { PromptField, type PromptFieldHandle, type Mentionable, type WidgetSubmitHandle } from "@cinatra-ai/sdk-ui";
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
  resolveComposerRouting,
  resolveExtractedGateValues,
} from "./inline-hitl-classify";
// cinatra#2566's composer focus: the store the review cards register with, and
// the pure resolver that says which gate (if any) the composer is bound to.
import {
  createComposerFocusStore,
  resolveComposerTarget,
} from "@cinatra-ai/agents/lifecycle-card-runtime";
// Chat persistence/replay must carry artifact refs alongside text. Adding to
// the Message shape lets the bridge resolve them without the chat path
// importing @/lib directly.
import type { UiMessage as Message, UiThread as Thread, UiThreadSummary as ThreadSummary } from "./types";
import type { ChatViewComponents } from "./chat-messages-view";
import type { ChatPageProps } from "./chat-page-props";
import { editAndResend as runEditAndResend } from "./message-edit-flow";
import { createTurnStreamRegistry, type TurnStreamToken } from "./turn-stream-registry";
import {
  saveChatThreadInOrder,
  fetchThreadList,
  fetchThreadById,
  generateId,
  deriveThreadTitle,
  extractAgentName,
} from "./ag-ui-chat-client";
import {
  EXTERNAL_TAKEOVER_MS,
  countMentions,
  shouldEnterSlackModeOnSend,
  attachRoutingMentionsToMessage,
  collectNewlyTaggedIds,
  resolveDispatchPlan,
} from "./chat-routing";
import { useChatUrlSync } from "./chat-client-url"; // cinatra#1878 W3 /chat URL sync (push/restore/adopt/seed)
// The unified AG-UI wire (cinatra#1218, epic #1216 S2): the headless client
// drives the full turn lifecycle over the S3 reducer behind a small UI port
// (driveAssistantChatTurn); persistence fetch helpers are co-located there
// (formerly ./chat-persistence — see the module's route-graph note). Since
// the #1218 delete stage this is the ONLY wire.
import {
  driveAssistantChatTurn,
  ensureAssistantChatWireNegotiated,
} from "./ag-ui-chat-client";
import { useChatAttachments } from "./use-chat-attachments";
import {
  fetchChatCaptureConfig,
  fetchMentionables,
  patchChatCaptureConfig,
} from "./conversation-services";
import { SkillBadgeCloud } from "./skill-badge-cloud";
import { selectChatBadges, chatEmptyStateCaption, isPinnedBadgePrefill, getGreeting, DEFAULT_GREETING } from "./chat-badges";
import { fingerprintMessages, isRealActivity } from "./thread-activity";
import { publishChatThreadTitle } from "@/lib/chat-shell-bus";
import { DancingRobot } from "./dancing-robot";

// Extension-provided chat renderable-view components (viewType → component),
// resolved server-side from the generated `cinatra.views` map and passed in as
// a prop (RSC client references). Empty default: the `chart` viewType then
// renders the never-blank fallback, a legitimate state when no view-bearing
// extension is live/built. Kept inline (a runtime value); the props TYPE lives
// in ./chat-page-props.
const EMPTY_CHAT_VIEWS: ChatViewComponents = {};

// The CONVERSATION COLUMN (cinatra#2683, epic #2564 S8f) — the message list, the
// composer and the scroll behaviour that ties them together, lifted OUT of this
// file so the site widget mounts the same component instead of an impoverished
// copy of it. `/chat` is unchanged by the move: the JSX, the class names, the
// handlers and the effect dependency lists went across verbatim, and a DOM-shape
// assertion pins that. Everything still in this file is FRAME — the app shell,
// the thread drawer, the empty-state start screen, thread CRUD and URL sync.
//
// The `next/dynamic` wrapper that used to sit here for the message list moved
// INTO the column, which now owns that boundary for every host: the heavy
// renderers still load in their own chunk, and there is no list component to
// hand in — so no way for a second surface to hand in a different one.
import { ConversationColumn, CHAT_THREAD_HOST } from "./conversation-column";

// Empty-state badge + caption selection live in ./chat-badges (pure +
// unit-tested). The component imports `selectChatBadges` +
// `chatEmptyStateCaption` and feeds the result into the badge cloud / h1.

// The greeting/quote selection lives in ./chat-badges (pure, alongside the
// other empty-state copy selection) — moved there by cinatra#1218 to keep
// this tracked bottleneck file inside its file-size ceiling.

// ---------------------------------------------------------------------------
// Main chat page — its props contract (ChatPageProps/ChatPageMode) lives in the
// type-only ./chat-page-props module (extracted to keep this bottleneck file
// within its file-size ceiling); the EMPTY_CHAT_VIEWS runtime default is inline
// above.
// ---------------------------------------------------------------------------

export function ChatPage({ initialThreadId, initialAssistantPackage, initialInstanceId, remoteChat, userId, initialMention, initialMode, initialPrompt, widgets = EMPTY_WIDGETS, widgetManifests = EMPTY_WIDGET_MANIFESTS, chatViews = EMPTY_CHAT_VIEWS }: ChatPageProps = {}) {
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
  const { pushChatUrl, pushNewChatUrl, restoreActiveThread, adoptThreadBinding, newThreadSummary, chatTurnContainer } =
    useChatUrlSync(threads, initialAssistantPackage, initialInstanceId);
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
  // The scroll container, the auto-scroll lock and the scroll-to-bottom effects
  // moved WITH the column (cinatra#2683) — they are column behaviour, and the
  // widget needs them too. `promptRef` stays here because BOTH mounts share it:
  // the empty-state start screen below and the column's composer.
  const promptRef = useRef<PromptFieldHandle>(null);
  const [promptValue, setPromptValue] = useState<string>("");
  const [mentionables, setMentionables] = useState<Mentionable[]>([]);
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
  // In-flight turns + ended-but-uncommitted ones (./turn-stream-registry).
  const streams = useMemo(() => createTurnStreamRegistry(), []);
  // Latest-value ref for messages so re-entrant senders never read a stale
  // snapshot when building the next request's context.
  const messagesRef = useRef<Message[]>([]);
  // RunId-keyed registry of OPEN inline HITL gates (cinatra#853 — the
  // chat/run gate concern lives in inline-hitl-classify's pure factory).
  // useState initializer → ONE registry instance for the component lifetime,
  // so both function identities are stable across renders (the handler is
  // threaded to InlineAgentRunCard).
  const [{ handleActiveGateChange, getLatestOpenGate }] = useState(createChatGateRegistry);
  // COMPOSER FOCUS (cinatra#2566): which review card this page's composer is
  // bound to. One store for the page's lifetime, handed DOWN to the column (so
  // the cards register and draw the affordance) and read HERE at send time (so
  // the message is routed by what is true when the reader presses send). The
  // same useState-initializer shape as the gate registry, and for the same
  // reason: one instance, stable identity.
  const [composerFocusStore] = useState(createComposerFocusStore);
  // The host adapter `/chat` declares, plus its composer-focus store. Composed
  // rather than baked into the exported constant because the store is per-mount
  // — the constant stays the explicit statement of WHICH host this is.
  const chatHostAdapter = useMemo(
    () => ({ ...CHAT_THREAD_HOST, composerFocus: composerFocusStore }),
    [composerFocusStore],
  );
  // Latest-value ref for the active thread id so in-flight streamResponse coroutines
  // can detect thread switches after an await and no-op their patches.
  const activeThreadIdRef = useRef<string | null>(null);
  // Paperclip upload + cinatra#1890 visible-refusal surface (see use-chat-attachments).
  const { pendingAttachments, clearPendingAttachments, handleAttachmentsSelected, refusalNotice } =
    useChatAttachments(activeThreadIdRef);
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

    // Both reads go through the SHARED conversation services (cinatra#2683,
    // epic #2564 S8f) — the same functions the widget calls, with no transport
    // argument, so this surface sends exactly the cookie request it always sent.
    // One implementation of each read means the widget cannot be given a
    // different answer than `/chat` by accident.
    void fetchChatCaptureConfig().then((config) => {
      if (!config) return;
      setAutosaveEnabled(config.enabled);
      setAutosaveCanToggle(config.userCanConfigure);
      setAutosaveVisible(config.userCanSeeIndicator || config.userCanConfigure);
    });

    let mentionablesCancelled = false;
    void fetchMentionables().then((list) => {
      if (!mentionablesCancelled) setMentionables(list);
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
      pushNewChatUrl(); // codec base path for the bound assistant (cinatra#1878 W3)
    }

    function handlePopState() {
      promptRef.current?.clear();
      const restored = restoreActiveThread(); // pathname → known thread, else clear (#1878 W3)
      if (restored) {
        setActiveThreadId(restored);
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
      pushChatUrl(threadId);
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

  // Keep messagesRef in sync so re-entrant callers read the latest value — and,
  // on the same commit, release the BUBBLE-ID half of every ended turn this
  // transcript carries, which leaves no window in which a turn is nameable from
  // neither source. The RUN half waits for a save that LANDED (the registry).
  useEffect(() => {
    messagesRef.current = messages;
    streams.noteCommittedTranscript(messages);
  }, [messages, streams]);

  // Keep activeThreadIdRef in sync so streamResponse can detect thread switches.
  // (The auto-scroll lock release that used to sit here moved into
  // ConversationColumn with the lock itself — cinatra#2683.)
  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  // Notify ChatThreadPanel of the active thread so it can highlight without router navigation.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("cinatra:chat:active-changed", { detail: { threadId: activeThreadId } }),
    );
  }, [activeThreadId]);

  // Load thread messages when activeThreadId changes.
  useEffect(() => {
    // Defense in depth: eagerly abort every in-flight stream when the active
    // thread changes, and drop the ended-uncommitted ledger with it — its ids
    // belong to the thread being left and no other thread's transcript would
    // ever release them. The registry decides that on the THREAD, not on the
    // stream count: an ended turn stays nameable until its reveal commits, so
    // the ledger outlives the last stream and a switch made after it still has
    // to drop it (convergence round 2). The stillOnOriginThread guard inside
    // streamResponse short-circuits any late setMessages chunks arriving after
    // this point, so an aborted stream cannot mutate the new thread's list.
    if (streams.resetForThread(activeThreadId)) setStreamingCount(0);
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
        adoptThreadBinding(thread); // keep New chat/URL in this container (#1878 W3)
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
    // A SAVE THAT LANDED releases the ledger's RUN half and adopts the baseline;
    // ISSUING one releases nothing (convergence round 4, finding 1) — a failed one wrote
    // no mirror row. Fenced on its OWN thread, like every resumed await here.
    saveChatThreadInOrder(thread).then(() => { if (activeThreadIdRef.current !== thread.id) return; streams.noteSavedTranscript(messages); loadedFingerprintRef.current = fingerprintMessages(messages); }, () => {});
    // Real activity: advance this thread's updatedAt in-place. The sidebar's
    // default "Activity" mode sorts by updatedAt desc, so this re-positions the
    // thread to the top without an explicit array reorder here.
    setThreads((prev) =>
      prev.map((t) =>
        t.id === thread.id ? { ...t, title: thread.title, updatedAt: thread.updatedAt } : t,
      ),
    );
  }, [messages, hasActiveStream, activeThreadId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Emit active thread title so AppShell can show it in the breadcrumb.
  useEffect(() => {
    const title = threads.find((t) => t.id === activeThreadId)?.title ?? null;
    publishChatThreadTitle(title);
  }, [activeThreadId, threads]);

  // Acquired immediately before streamResponse's try, so the finally is sure.
  // `anchorMessageId` is the PROMPT this turn answers — how the intent tells a turn BELOW an edit point from one above it.
  function beginStream(assistantId: string, controller: AbortController, anchorMessageId: string | null) {
    setStreamingCount((n) => n + 1);
    return streams.begin(assistantId, controller, anchorMessageId); // THIS instance's token
  }

  // Idempotent — the count moves only if this instance really was the live one.
  // The turn stays NAMEABLE by the truncation intent until its reveal commits.
  function endStream(token: TurnStreamToken) {
    if (streams.end(token)) setStreamingCount((n) => Math.max(0, n - 1));
  }

  // AG-UI stream driver (cinatra#1218) — the turn drive lives headlessly in
  // ./ag-ui-chat-client. This wrapper owns registry + guard.
  async function streamAgUiResponse(contextMessages: Message[], threadId: string, handle?: string, authorUserId?: string, endpoint?: string, assistant?: string, anchorMessageId?: string | null, boundCard?: { refs: string[]; focused: string | null }) {
    const assistantId = generateId();
    const abortController = new AbortController();
    // The ORIGIN thread this turn was dispatched FOR (captured BEFORE the handshake
    // await — re-reading the ref would guard the WRONG thread after a mid-await switch).
    const originThreadId = threadId;
    const stillOnOriginThread = () => activeThreadIdRef.current === originThreadId;
    const token = beginStream(assistantId, abortController, anchorMessageId ?? contextMessages[contextMessages.length - 1]?.id ?? null); // the PROMPT, never the id; the tail is it only when the caller did not name one (cinatra#2823)
    try {
      await driveAssistantChatTurn({
        threadId,
        assistantId,
        authorUserId,
        // Host-runtime assistant: explicit producer endpoint + selector; @cinatra/default neither. `chatContainer` is the thread's HOME (cinatra#2650) — resolved from the LIVE list + mount binding at dispatch, never the producer.
        ...(endpoint ? { endpoint } : {}), ...(assistant ? { assistant } : {}), chatContainer: chatTurnContainer(threadId),
        slack: isSlackModeRef.current,
        signal: abortController.signal,
        messages: contextMessages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
        })),
        // cinatra#2932 — the bound-card CLAIM, read at send time by the caller
        // and threaded verbatim. Omitted when the composer has no card on
        // screen, so an ordinary turn's request body is unchanged.
        ...(boundCard ? { boundCard } : {}),
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
          noteRunId: (runId) => { streams.noteRunId(token, runId); }, // the server's own name for THIS instance
          isWidgetRefreshTool: (name) => widgetRuntime.isWidgetRefreshTool(name),
          onWidgetRefresh: () => setWidgetRefreshKey((k) => k + 1),
        },
      });
    } finally {
      endStream(token);
    }
  }

  // The /chat turn dispatcher — AG-UI is the ONLY wire (cinatra#1218 delete
  // stage). The S1 capability handshake stays fail-closed: a failed
  // negotiation surfaces a turn error on a never-blank assistant bubble —
  // there is no legacy fallback to retry over. Externals are webhook-polled
  // and never touch this dispatcher.
  async function streamResponse(contextMessages: Message[], handle?: string, endpoint = "/api/assistants/chat", authorUserId?: string, assistant?: string, anchorMessageId?: string | null, boundCard?: { refs: string[]; focused: string | null }) {
    const threadId = activeThreadIdRef.current;
    if (!threadId) {
      // Unreachable in practice: every caller dispatches inside an active
      // thread (sendMessage creates + pins the thread id before dispatch).
      console.error("[chat] turn dispatched with no active thread — dropped");
      return;
    }
    if (!(await ensureAssistantChatWireNegotiated())) {
      // Fail-closed per S1 CONTRACT.md §5 — surface the failure, never blank.
      const assistantId = generateId();
      setMessages((prev) =>
        activeThreadIdRef.current === threadId
          ? [...prev, {
              id: assistantId,
              role: "assistant" as const,
              content: "",
              ...(authorUserId ? { authorUserId } : {}),
              error: "The assistant stream is unavailable (contract negotiation failed). Reload the page and try again.",
            }]
          : prev,
      );
      return;
    }
    return streamAgUiResponse(contextMessages, threadId, handle, authorUserId, endpoint, assistant, anchorMessageId, boundCard);
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

  // EDIT AND RESEND — the flow lives in ./message-edit-flow (the truncation
  // intent, the intent save it waits for, the origin-thread guards, the routed
  // regeneration); this binding is the page's half (./turn-stream-registry).
  async function editAndResend(messageId: string, newContent: string) {
    await runEditAndResend(
      {
        messages,
        currentMessages: () => messagesRef.current,
        setMessages,
        isSlackMode,
        hasActiveStream,
        removableTurnIds: () => streams.removableTurnIds(),
        removableRunIds: (removed) => streams.removableRunIds(removed),
        condemnedTurnIds: (removed) => streams.condemnedTurnIds(removed),
        settleRemovableRunIds: (removed) => streams.settleRunIdsForRemoval(removed),
        activeThreadId,
        currentThreadId: () => activeThreadIdRef.current,
        loadedThreadCreatedAt: () => loadedThreadCreatedAtRef.current,
        threads,
        activeAssistantHandle,
        setActiveAssistantHandle,
        taggedAssistantUserIds, pausedParticipants, assistantHandleMap, userId, streamResponse,
      },
      messageId,
      newContent,
    );
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
      // Pin the latest-value ref SYNCHRONOUSLY (the sync effect confirms it on
      // the next render): the AG-UI dispatcher reads the ref for the turn's
      // thread binding, and the routing await below is not guaranteed to span
      // a render flush.
      activeThreadIdRef.current = threadId;
      // New thread — reset pause state so stale participants from previous thread don't bleed in.
      setPausedParticipants([]);
      setActiveThreadId(threadId);
      // Seed the new thread with this mount's binding; slug arrives next refetch.
      setThreads((prev) => [newThreadSummary(threadId!, title, now), ...prev]);
      pushChatUrl(threadId);
    }

    // Snapshot + clear pending attachments so this message owns the refs and
    // the next prompt starts empty.
    const attachmentsForThisMessage = pendingAttachments;
    if (attachmentsForThisMessage.length > 0) clearPendingAttachments();
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
      saveChatThreadInOrder({ id: threadId, title, messages: currentMessages, createdAt, updatedAt: now, activeAssistantHandle, taggedAssistantUserIds, slackMode: isSlackMode, ownerUserId: userId } as Record<string, unknown> & { id: string }).catch((err) => console.error("[chat] saveChatThread failed:", err));
    }

    // -----------------------------------------------------------------------
    // ONE ROAD, for everything except a waiting screen's fields (cinatra#2932,
    // lifecycle-b W5a). What you type goes to the assistant; the two arms that
    // used to act on it first — a sentence filed as a bound review's comment,
    // and this page's own several-reviews refusal — are gone, with their
    // replacements in the same change. The FIELD-GATE arm stays until #2934
    // builds the control that would replace it. `inline-hitl-classify.ts` states
    // which arm went where and why one did not.
    //
    // The review binding is read at SEND time — a card can be focused, decided
    // or unmounted while the reader is typing — and carried with the message as
    // a CLAIM the server re-checks under the reader's own access.
    // -----------------------------------------------------------------------
    const composerSnapshot = composerFocusStore.getSnapshot();
    const boundCardClaim =
      composerSnapshot.eligible.length > 0
        ? {
            refs: [...composerSnapshot.eligible],
            focused:
              resolveComposerTarget(composerSnapshot).kind === "target"
                ? composerSnapshot.focused
                : null,
          }
        : null;
    {
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
        saveChatThreadInOrder({
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
      // Read the FIELD GATE at SEND time, not at render time: a gate can open or
      // close while the reader is typing. A bound review is no longer read here
      // at all — it travels with the message as `boundCardClaim` above.
      const composerRouting = resolveComposerRouting({
        latestOpenGate: getLatestOpenGate(),
      });

      const gate = composerRouting.kind === "field-gate" ? composerRouting.gate : undefined;
      if (gate) {
        const verdict = classifyPromptForGate(trimmed, {
          fields: gate.fields,
          fieldName: gate.fieldName,
        });
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
      }
    }

    // Routing: broadcast to all non-paused participants when there is no @mention.
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
    // Optimistically append newly-tagged assistantUserIds BEFORE saveChatThread —
    // triggers the Slack-mode transition the moment the user sends.
    const newlyTaggedIds = collectNewlyTaggedIds(routing.externalMentions);
    if (newlyTaggedIds.length > 0) {
      // First @mention opens directly in Slack mode (mirror the cold-load
      // suppression pattern — no "switching" animation).
      if (baseMessages.length === 0) prevIsSlackModeRef.current = true;
      setTaggedAssistantUserIds((prev) => {
        const merged = new Set([...prev, ...newlyTaggedIds]);
        return Array.from(merged);
      });
    }
    const nextActiveHandle = routing.activeHandle !== undefined ? (routing.activeHandle || undefined) : activeAssistantHandle;
    if (routing.activeHandle !== undefined) setActiveAssistantHandle(nextActiveHandle);

    // Attach the routed mention chips (pending external, or in-band host-runtime).
    setMessages((prev) => attachRoutingMentionsToMessage(prev, userMessage.id, routing));

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
        // abort controller in the same render batch that clears pendingExternalHandle
        // (removes the visible gap before the cinatra thinking indicator).
        void streamResponse(currentMessages, "cinatra", undefined, undefined, undefined, undefined, boundCardClaim ?? undefined);
        setPendingExternalHandle(null);
      }, EXTERNAL_TAKEOVER_MS);
      return;
    }

    // plan.kind === "stream". The producer selector: a declared host-runtime
    // assistant runs AS its own principal (canonical handle drives the endpoint);
    // @cinatra/default carry NO selector (undefined ⇒ byte-identical runChatTurn).
    const streamSelector = routing.hostRuntimeMention?.handle;
    if (isSlackMode) {
      // Slack mode: fire-and-forget so sendMessage returns immediately. streamResponse
      // is non-throwing (internal try/catch writes errors into the assistant message),
      // so void dispatch cannot leak an unhandled rejection.
      const displayHandle = nextActiveHandle ?? activeAssistantHandle ?? "Assistant";
      void streamResponse(currentMessages, displayHandle, plan.endpoint, plan.authorUserId, streamSelector, undefined, boundCardClaim ?? undefined);
    } else {
      // ChatGPT mode: preserve the existing synchronous, blocking behavior.
      await streamResponse(currentMessages, undefined, plan.endpoint, plan.authorUserId, streamSelector, undefined, boundCardClaim ?? undefined);
    }
  }

  // Stable callbacks threaded to the lazily-loaded conversation view.
  const isStreaming = useCallback(
    (messageId: string) => streams.has(messageId),
    [streams],
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
      void patchChatCaptureConfig(enabled);
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
                {refusalNotice}
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
                  remoteChat={remoteChat}
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
      <ConversationColumn
        // `/chat` states its host EXPLICITLY: the first-party cookie surface.
        host={chatHostAdapter}
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
        streamingCount={streamingCount}
        isStreaming={isStreaming}
        onEditAndResend={(id, content) => void editAndResend(id, content)}
        onActivateResource={(resourceType, resourceId) => void activateResource(resourceType, resourceId)}
        widgetRuntime={widgetRuntime}
        widgetSubmitRef={widgetSubmitRef}
        widgetRefreshKey={widgetRefreshKey}
        onActiveGateChange={handleActiveGateChange}
        pendingExternalHandle={pendingExternalHandle}
        typingIndicators={typingIndicators}
        chatViews={chatViews}
        promptRef={promptRef}
        placeholder={hasActiveEmbed ? "Press Enter to save, or type a message..." : "Type a message..."}
        promptStorageKey={`cinatra_thread_prompt_${activeThreadId}`}
        canSubmitEmpty={hasActiveEmbed}
        onSubmit={(value) => void sendMessage(value)}
        submitAriaLabel={hasActiveEmbed ? "Save form" : "Send message"}
        onStop={() => {
          streams.abortAll();
        }}
        onAttachmentsSelected={handleAttachmentsSelected}
        autosave={autosaveProp}
        remoteChat={remoteChat}
        composerNotice={refusalNotice}
      />
    </div>
  );
}
