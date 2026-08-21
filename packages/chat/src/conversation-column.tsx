"use client";

// ---------------------------------------------------------------------------
// THE conversation column (cinatra#2683, epic #2564 S8f).
// ---------------------------------------------------------------------------
// The owner's architecture bar for this slice, in one sentence: ONE
// conversation-column component, built once, consumed by `/chat` AND by
// `/embed/assistant`. Not "the widget reaches parity with /chat" — parity is a
// thing you can measure and then lose. One component is a thing you cannot lose:
// a future `/chat` conversation change IS a widget change, because there is
// nowhere else for it to land.
//
// WHAT THE COLUMN IS. Everything between the frame's edges: the scrolling
// message list (`ChatMessagesView` — history, the user's own echo, sender
// identity rows, user Copy/Edit, the response action row, turn controls, the
// pending tool-confirmation cards, the undo chip, the friendly error card, and
// the whole rich-rendering stack: shiki highlighting, mermaid, chart views and
// extension-provided chat widgets) and the composer under it (`PromptField` —
// multi-line, attachments, the prompt-options flyout, @-mentions, the circular
// send control that becomes Stop while a turn runs). Plus the scroll behaviour
// that ties the two together.
//
// This file is a MOVE, not a rewrite: the JSX below came out of `chat-page.tsx`
// unchanged — same elements, same class names, same handlers, same effect
// dependency lists. `/chat` renders byte-identical DOM before and after, which a
// DOM-shape assertion pins (`conversation-column-chat-dom-shape.test.tsx`).
//
// WHAT THE COLUMN IS NOT. The frame: `/chat`'s app shell, thread drawer,
// empty-state start screen and URL sync; the widget's iframe, bridge handshake,
// broker negotiation and sandbox. Those stay in the routes, and they are the
// only things that stay in the routes.
//
// HOST ADAPTERS — the short, closed list of things that genuinely differ:
//
//   · CREDENTIAL TRANSPORT. `/chat` is a first-party cookie session and declares
//     nothing. The widget declares a broker transport, and its requests carry
//     headers built at call time from closure-held tokens with
//     `credentials: "omit"` — load-bearing, because the embed is SAME-ORIGIN to
//     the Cinatra app and an ambient cookie would answer as whoever else uses
//     that browser. Threaded to the ONE turn driver (`driveAssistantChatTurn`),
//     so retry, resume, abort-silence and error surfacing are the same code on
//     both surfaces rather than two implementations that drift.
//
//   · LINK POLICY. An in-app route link navigates in place on `/chat`; inside a
//     sandboxed widget frame on somebody else's site the same navigation would
//     replace the assistant with the app (or be refused outright). Adapted
//     through the EXISTING host-adaptation seam — the lifecycle-card host
//     declaration — not through a second per-surface flag (`./app-route-link`).
//
//   · THE HOST DECLARATION ITSELF (`lifecycleSurface`), and the widget's
//     apply-intent uplink + a11y/bridge wiring, which the embed already owns.
//
// §3.D IS UNTOUCHED. Nothing here decides, schedules or mutates anything: the
// column renders a transcript and posts a turn. Every decision affordance it
// draws resolves and decides through its own authoritative, credential-checked
// server path exactly as it did on `/chat`.
// ---------------------------------------------------------------------------

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  PromptField,
  type PromptFieldAutosave,
  type PromptFieldHandle,
  type Mentionable,
} from "@cinatra-ai/sdk-ui/prompt-field";
import type {
  WidgetDefinition,
  WidgetManifest,
  WidgetSubmitHandle,
} from "@cinatra-ai/sdk-ui/widget";
import type { ChatGateDescriptor } from "@cinatra-ai/agents/client-entry";
import {
  LifecycleComposerFocusProvider,
  type ComposerFocusStore,
} from "@cinatra-ai/agents/lifecycle-card-runtime";
import type { ThemeName } from "./syntax-highlight";
import {
  createChatWidgetRuntime,
  EMPTY_WIDGETS,
  EMPTY_WIDGET_MANIFESTS,
  type ChatWidgetRuntime,
} from "./widget-runtime";
import {
  driveAssistantChatTurn,
  generateId,
  type AssistantTurnRequestMessage,
} from "./ag-ui-chat-client";
import { buildTruncationIntent } from "./truncation-intent";
import { startScrollSettlePin, type ScrollSettlePass } from "./scroll-settle";
import dynamic from "next/dynamic";
import type { UiMessage } from "./types";
import type { ApplyIntentRef } from "./renderable-views";
import type { ChatViewComponents, LifecycleSurfaceDeclaration } from "./chat-messages-view";

// THE conversation renderer, and the column's LAZY BOUNDARY for the heavy
// renderers behind it (marked/katex via ./markdown-render, the mermaid wrapper,
// the shiki wrapper, the extension renderable-view dispatch). It lives HERE
// rather than being handed in as a prop (codex round 1, finding 2): a component
// prop is an injection point, and a column whose message list can be swapped per
// host is not "one column, built once" — it is one wrapper around whatever each
// host decided to render. Owning the import means both surfaces get the same
// list AND the same bundle split, with nothing to pass and nothing to get wrong.
//
// `ssr: false` is deliberate and inherited from `/chat`: a default-SSR dynamic()
// here tripped a latent Turbopack async-module-cycle in unrelated SSR chunks and
// broke `next build`, and the view SSR'd an empty container anyway (messages are
// fetched client-side), so client-only rendering of the list is visually
// equivalent.
const ChatMessagesView = dynamic(
  () => import("./chat-messages-view").then((m) => m.ChatMessagesView),
  { ssr: false, loading: () => null },
);

// Re-exported so a HOST can type its adapters against ONE subpath instead of
// reaching into five internal modules. Types only — no runtime edge.
export type { ChatViewComponents, LifecycleSurfaceDeclaration } from "./chat-messages-view";
export type { ApplyIntentRef } from "./renderable-views";
export type { UiMessage } from "./types";
export type { ChatWidgetRuntime } from "./widget-runtime";
export type { Mentionable } from "@cinatra-ai/sdk-ui/prompt-field";
export type {
  WidgetDefinition,
  WidgetManifest,
  WidgetSubmitHandle,
} from "@cinatra-ai/sdk-ui/widget";
export type { ThemeName } from "./syntax-highlight";

/**
 * The adapters a host supplies for the things that genuinely differ between a
 * first-party route and a brokered widget frame. Everything NOT in this type is
 * the same code on both surfaces, by construction.
 */
export type ConversationHostAdapter = {
  /**
   * The lifecycle-card host declaration this column's cards render under, and
   * — because it is what distinguishes a cookie session from a brokered one —
   * the seam the link policy and the cookie-bound affordances key off.
   *
   * REQUIRED, with no default (codex round 1, finding 1). A default would mean
   * a mount that forgot its adapter inherits `chat_thread`, and `chat_thread` is
   * a COOKIE host: inside the widget frame, which is same-origin to the app,
   * that silently re-enables ambient-cookie reads and decisions as whoever else
   * is signed in on that browser. Every mount says who it is.
   */
  lifecycleSurface: LifecycleSurfaceDeclaration;
  /**
   * §6e apply-intent gesture. A host that owns an apply flow (the widget, which
   * uplinks the gesture to its parent page over the bridge) wires it; a host
   * that does not (`/chat`) passes none and the proposal card stays
   * display-only. The seam ADDS a gesture — it never changes which card renders.
   */
  onApplyIntent?: (ref: ApplyIntentRef) => void;
  /**
   * COMPOSER FOCUS (cinatra#2566). The store that binds this column's composer
   * to ONE review card, so a typed message can become a comment on the review
   * the reader chose. A host that supplies one gets the focus affordance on its
   * review cards; a host that supplies none has cards that register nothing and
   * draw no affordance, and its composer behaves exactly as it did before.
   *
   * `/chat` supplies one. The WIDGET deliberately does not: a widget reviewer
   * must meet a fresh confirmation before any decision (S8b), and a composer
   * that quietly turned typing into a decision-module call would route straight
   * past it. Enabling it there is that slice's, not this one's.
   */
  composerFocus?: ComposerFocusStore;
};

/**
 * `/chat`'s host adapter: the first-party cookie surface, declaring no
 * credential (which is what a cookie host must do) and owning no apply flow.
 * Exported so the page states it EXPLICITLY rather than relying on a default.
 */
export const CHAT_THREAD_HOST: ConversationHostAdapter = {
  lifecycleSurface: { host: "chat_thread" },
};

/** The conversation state + turn callbacks the host orchestrator owns. */
export type ConversationColumnProps = {
  /** REQUIRED — see `ConversationHostAdapter.lifecycleSurface`. */
  host: ConversationHostAdapter;

  // ----- the list -----
  messages: UiMessage[];
  isSlackMode: boolean;
  animating: boolean;
  theme: ThemeName;
  userId?: string;
  sessionUser?: { name?: string | null; image?: string | null } | null;
  activeThreadId: string | null;
  activeAssistantHandle?: string;
  assistantHandleMap: Map<string, string>;
  taggedAssistantUserIds: string[];
  mentionables: Mentionable[];
  pausedParticipants: string[];
  onTogglePause: (participantId: string, next: boolean) => void;
  requestEditMessageId: string | null;
  onRequestEditMessage: (messageId: string) => void;
  onEditStarted: () => void;
  /**
   * How many turns are streaming right now. `hasActiveStream` is derived from
   * it, and the auto-scroll effect keys on the COUNT (not the boolean) exactly
   * as `/chat` did: in Slack mode a second concurrent stream must re-scroll.
   */
  streamingCount: number;
  isStreaming: (messageId: string) => boolean;
  onEditAndResend: (messageId: string, newContent: string) => void;
  onActivateResource: (resourceType: string, resourceId: string) => void;
  widgetRuntime: ChatWidgetRuntime;
  widgetSubmitRef: RefObject<WidgetSubmitHandle | null>;
  widgetRefreshKey: number;
  onActiveGateChange: (runId: string, gate: ChatGateDescriptor | null, instanceId: string) => void;
  pendingExternalHandle: string | null;
  typingIndicators: Map<string, string>;
  chatViews: ChatViewComponents;

  // ----- the composer -----
  /**
   * The composer handle. Held by the HOST because a host may mount a second
   * `PromptField` outside the column that shares it (`/chat`'s empty-state
   * start screen does, and its focus/prefill effects address whichever one is
   * mounted).
   */
  promptRef: RefObject<PromptFieldHandle | null>;
  placeholder: string;
  promptStorageKey: string;
  canSubmitEmpty?: boolean;
  onSubmit: (value: string) => void;
  submitAriaLabel: string;
  onStop: () => void;
  onAttachmentsSelected?: (files: File[]) => void;
  autosave?: PromptFieldAutosave;
  remoteChat?: { label: string; href: string };
  /** Rendered directly above the composer (the attachment-refusal notice). */
  composerNotice?: ReactNode;
};

export function ConversationColumn({
  host,
  messages,
  isSlackMode,
  animating,
  theme,
  userId,
  sessionUser,
  activeThreadId,
  activeAssistantHandle,
  assistantHandleMap,
  taggedAssistantUserIds,
  mentionables,
  pausedParticipants,
  onTogglePause,
  requestEditMessageId,
  onRequestEditMessage,
  onEditStarted,
  streamingCount,
  isStreaming,
  onEditAndResend,
  onActivateResource,
  widgetRuntime,
  widgetSubmitRef,
  widgetRefreshKey,
  onActiveGateChange,
  pendingExternalHandle,
  typingIndicators,
  chatViews,
  promptRef,
  placeholder,
  promptStorageKey,
  canSubmitEmpty = false,
  onSubmit,
  submitAriaLabel,
  onStop,
  onAttachmentsSelected,
  autosave,
  remoteChat,
  composerNotice,
}: ConversationColumnProps) {
  const hasActiveStream = streamingCount > 0;

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // Scroll lock: true when user has scrolled up intentionally. Auto-scroll is suppressed until
  // streaming ends OR user scrolls back to the bottom.
  const userScrolledUpRef = useRef(false);
  // Marks scrolls driven by scrollToBottom() so onScroll ignores them instead of clearing the lock.
  const isProgrammaticScrollRef = useRef(false);

  // Auto-scroll lock release on thread switch (#1702). The lock is
  // CONTAINER-level state reused across threads, so without an
  // activeThreadId-keyed reset "scrolled up in thread A" leaks into thread B and
  // a newly opened thread renders at an arbitrary position instead of its latest
  // message. Declared BEFORE the scroll effect: React runs effects in definition
  // order, so the lock is already clear when scrollToBottom fires for the new
  // thread's messages (a same-render, cached thread switch).
  useEffect(() => {
    userScrolledUpRef.current = false;
  }, [activeThreadId]);

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

  // -------------------------------------------------------------------------
  // The COLD-LOAD settle pass (cinatra#2740).
  // -------------------------------------------------------------------------
  // The effect above is a SINGLE shot on a static reload: the thread's messages
  // are fetched asynchronously, so it fires once, when the list populates — with
  // the message elements mounted but their content not yet laid out. Markdown,
  // highlighted code, run panels and the auto-sized textareas all grow after
  // that, so the height it read was short and the pin landed near the top of a
  // long thread. A streaming turn hides the defect, because its per-chunk
  // re-fire re-measures a taller container each time.
  //
  // So the initial load gets a bounded settle pass on top of that one shot: it
  // re-pins while the container's content height is still moving and ends when
  // the layout goes quiet (see `./scroll-settle`). It is armed ONCE per thread,
  // which is why streaming is untouched — the pass has long ended by the time a
  // turn runs, and the per-chunk effect keeps doing exactly what it did.
  const settleArmedRef = useRef(true);
  const settlePassRef = useRef<ScrollSettlePass | null>(null);

  useEffect(() => {
    // A new thread is a new cold load: end the old pass and re-arm.
    settlePassRef.current?.stop();
    settlePassRef.current = null;
    settleArmedRef.current = true;
  }, [activeThreadId]);

  useEffect(() => {
    if (!settleArmedRef.current) return;
    const container = messagesContainerRef.current;
    // Stay armed until there is a transcript to pin to — on a cold load the
    // messages arrive well after mount, which is the whole point.
    if (!container || messages.length === 0) return;
    settleArmedRef.current = false;
    settlePassRef.current = startScrollSettlePin({
      container,
      pin: scrollToBottom,
      // The lock is read at call time, so a reader who scrolls up mid-settle
      // ends the pass instead of fighting it.
      isLocked: () => userScrolledUpRef.current,
    });
    // No cleanup keyed on these deps: an unrelated re-render must not cut a
    // settle pass short. The pass ends on its own deadline, on the thread
    // switch above, or on the unmount below.
  }, [activeThreadId, messages, scrollToBottom]);

  useEffect(
    () => () => {
      settlePassRef.current?.stop();
      settlePassRef.current = null;
    },
    [],
  );

  // Re-enable auto-scroll when streaming completes so the next response scrolls normally.
  const prevHasActiveStreamRef = useRef(false);
  useEffect(() => {
    if (prevHasActiveStreamRef.current && !hasActiveStream) userScrolledUpRef.current = false;
    prevHasActiveStreamRef.current = hasActiveStream;
  }, [hasActiveStream]);

  // Return focus to the prompt input after streaming completes.
  useEffect(() => {
    if (!hasActiveStream) promptRef.current?.focus();
  }, [hasActiveStream, promptRef]);

  const column = (
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
          sessionUser={sessionUser}
          activeThreadId={activeThreadId}
          activeAssistantHandle={activeAssistantHandle}
          assistantHandleMap={assistantHandleMap}
          taggedAssistantUserIds={taggedAssistantUserIds}
          mentionables={mentionables}
          pausedParticipants={pausedParticipants}
          onTogglePause={onTogglePause}
          requestEditMessageId={requestEditMessageId}
          onRequestEditMessage={onRequestEditMessage}
          onEditStarted={onEditStarted}
          hasActiveStream={hasActiveStream}
          isStreaming={isStreaming}
          onEditAndResend={onEditAndResend}
          onActivateResource={onActivateResource}
          widgetRuntime={widgetRuntime}
          widgetSubmitRef={widgetSubmitRef}
          widgetRefreshKey={widgetRefreshKey}
          onActiveGateChange={onActiveGateChange}
          pendingExternalHandle={pendingExternalHandle}
          typingIndicators={typingIndicators}
          chatViews={chatViews}
          lifecycleSurface={host.lifecycleSurface}
          {...(host.onApplyIntent ? { onApplyIntent: host.onApplyIntent } : {})}
        />
      </div>

      {/* Zero-height relative anchor — constrains input bar to max-w-3xl+px-4 exactly as messages content */}
      <div className="relative mx-auto w-full max-w-3xl px-4">
        <div className="absolute bottom-0 left-4 right-4 bg-background pb-3 pt-0">
          {composerNotice}
          <PromptField
            ref={promptRef}
            editorTestId="chat-prompt-input"
            placeholder={placeholder}
            storageKey={promptStorageKey}
            rows={1}
            canSubmitEmpty={canSubmitEmpty}
            onSubmit={onSubmit}
            submitAriaLabel={submitAriaLabel}
            pending={isSlackMode ? false : (hasActiveStream || !!pendingExternalHandle)}
            onStop={onStop}
            stopAriaLabel="Stop generating"
            showStatusMessage={false}
            mentionables={mentionables}
            {...(onAttachmentsSelected ? { onAttachmentsSelected } : {})}
            {...(autosave ? { autosave } : {})}
            {...(remoteChat ? { remoteChat } : {})}
          />
        </div>
      </div>
    </div>
  );

  // COMPOSER FOCUS (cinatra#2566) wraps the WHOLE column — the review cards in
  // the list and the composer below them — because the binding is a fact about
  // the pair. A host that declares no store gets the column verbatim, so its
  // cards see no provider, register nothing, and draw no focus affordance: the
  // same fail-closed shape as the lifecycle host declaration itself.
  return host.composerFocus ? (
    <LifecycleComposerFocusProvider store={host.composerFocus}>
      {column}
    </LifecycleComposerFocusProvider>
  ) : (
    column
  );
}

// ---------------------------------------------------------------------------
// The column's DEFAULT turn engine.
// ---------------------------------------------------------------------------
// A host with no richer orchestrator (the widget) must not hand-roll "append the
// user's message, stream the answer, re-run from an edit, stop the stream" —
// that is the shape the 2026-08-12 inventory found reduced, and a second copy of
// it would drift again. This hook IS that behaviour, and everything it returns
// spreads straight into `<ConversationColumn/>`.
//
// `/chat` does NOT use it: its turn is multi-participant (routing, @mention
// broadcast, Slack mode, external-assistant takeover) and persists the thread,
// which are frame concerns its page orchestrator owns. Both paths converge on
// the SAME wire — `driveAssistantChatTurn` — which is where the turn lifecycle
// itself lives, so neither surface has its own transport, retry or error
// behaviour. Unifying the orchestrator ABOVE that is a follow-on; it is recorded
// as such on the S8f PR rather than pretended away.
// ---------------------------------------------------------------------------

/**
 * How this surface's requests prove who is asking.
 *
 * ABSENT ⇒ the first-party cookie session, byte-identical to `/chat` today.
 * PRESENT ⇒ a broker surface: the headers are built at call time from the host's
 * closure-held tokens (never state, never a prop, never the DOM) and
 * `credentialsMode: "omit"` is load-bearing, not decorative.
 */
export type ConversationTransport = {
  /** Built at call time; applied to the turn POST by the one turn driver. */
  authHeaders: () => Record<string, string>;
  /** Broker surfaces send no cookie. Typed as the literal union so a host
   *  cannot declare a cookie-bearing broker transport by accident. */
  credentialsMode: "omit";
  /** The producer SELECTOR — the canonical handle this turn runs as
   *  (`"wordpress"` / `"drupal"` on the widget). Omitted ⇒ the @cinatra default. */
  assistant?: string;
};

export type ConversationTurnStatus = "idle" | "running" | "finished" | "error";

/**
 * The pending-removals cap: how many asserted-but-unsaved message ids this
 * column keeps at once. One entry is one MESSAGE, not one turn — a single edit
 * asserts the whole truncated tail — so the ceiling is set well above any
 * transcript a widget panel realistically holds, and reaching it means either a
 * truncation of more than 512 messages in one edit or a host whose saves have
 * been failing since the first one. The eviction site states what going over it
 * costs.
 */
export const MAX_PENDING_REMOVED_MESSAGE_IDS = 512;

const NO_PAUSED: string[] = [];
const NO_TAGGED_IDS: string[] = [];
const EMPTY_HANDLE_MAP = new Map<string, string>();
const EMPTY_TYPING = new Map<string, string>();

export function useConversationColumnTurns({
  threadId,
  transport,
  widgets = EMPTY_WIDGETS,
  widgetManifests = EMPTY_WIDGET_MANIFESTS,
  initialMessages,
  onTurnStatusChange,
  takePendingAttachments,
}: {
  threadId: string;
  transport?: ConversationTransport;
  widgets?: WidgetDefinition[];
  widgetManifests?: WidgetManifest[];
  /** Seed the list (a restored thread, or a deterministic fixture). */
  initialMessages?: UiMessage[];
  /** The reduced turn status after every list write, so a host can mirror it
   *  (the embed's `data-turn-status` observability hook). */
  onTurnStatusChange?: (status: ConversationTurnStatus) => void;
  /**
   * The attachments the composer has uploaded and not yet sent (cinatra#2683,
   * epic #2564 S8f). Called ONCE at submit and expected to clear its own buffer,
   * so a file cannot ride two turns. Absent ⇒ a host with no upload row, which
   * is the same as an empty buffer.
   *
   * It is a callback rather than a prop because the buffer changes on every
   * upload and the submit handler must read the LATEST one — the same reason
   * `/chat` reads its own buffer at submit time rather than closing over it.
   */
  takePendingAttachments?: () => UiMessage["attachments"];
}) {
  const [messages, setMessages] = useState<UiMessage[]>(() => initialMessages ?? []);
  // The list MIRROR — `/chat` keeps the same one (`messagesRef`). Two reasons,
  // and the second is a correctness fix from codex round 1 (finding 4):
  //   · a re-entrant caller (the next fold of a stream) must read the latest
  //     list, not the one captured when its closure was created;
  //   · the turn's OUTCOME must be knowable the moment the driver returns.
  //     Deriving it inside a `setState` updater made it depend on when React
  //     chose to run that updater, so an errored turn could still publish
  //     `finished` — and the embed mirrors that status into `data-turn-status`,
  //     which an out-of-process observer fences on. Folding against the mirror
  //     makes every write synchronous and the outcome exact.
  const listRef = useRef<UiMessage[]>(initialMessages ?? []);
  const writeMessages = useCallback((next: UiMessage[]) => {
    listRef.current = next;
    setMessages(next);
  }, []);
  const [requestEditMessageId, setRequestEditMessageId] = useState<string | null>(null);
  // The abort-controller registry `/chat` keeps: `isStreaming(id)` reads it, the
  // stop control aborts every entry, and its size is `streamingCount`.
  const streamingRef = useRef(new Map<string, AbortController>());
  const [streamingCount, setStreamingCount] = useState(0);
  // THE TRUNCATION INTENT THIS COLUMN OWES ITS HOST (cinatra#2823 S9j).
  //
  // `onEditAndResend` below truncates the transcript, and a truncating save is
  // the ONE save the server may act on destructively: its reconcile DELETE drops
  // the removed turns' mirror rows while their run-bound rows — minted when each
  // run started — survive untouched, and the reload folds those back in above
  // the edited prompt unless the save ASSERTED the removal. `/chat` carries that
  // assertion (`message-edit-flow.ts`); this column truncated in silence, so a
  // widget reader's edit came undone on every reload.
  //
  // It is ACCUMULATED rather than passed straight out, because the edit and the
  // save are separate events here: the host saves when a TURN ENDS, which is one
  // or more turns after the edit that truncated. The ids wait here until a save
  // that carried them is known to have landed.
  //
  // Each id is held with the REVISION of its current assertion, and every
  // assertion of an id mints a new one. An id can be asserted twice: the save
  // that carried the first one may still be open when the list regains that
  // message and a later edit removes it AGAIN, and those are two different
  // removals. A confirm that simply subtracted its ids cleared whichever
  // assertion happened to be standing, so the second removal ended up asserted
  // by nothing — the silent truncation this whole leg removes (codex round 2,
  // finding 4). Insertion order is the assertion order, which is what makes
  // "evict the oldest" meaningful at the cap below.
  const removedMessageIdsRef = useRef<Map<string, number>>(new Map());
  const removalRevisionRef = useRef(0);
  // The revisions a `peek` handed out, keyed by the ARRAY it handed them on:
  // that array is the save's identity — the host puts this exact one on the
  // wire and hands it back to `confirm` — and it is weakly held, so a save
  // whose array is gone takes its snapshot with it.
  const removalSnapshotsRef = useRef(new WeakMap<readonly string[], Map<string, number>>());
  // Remount key for mounted extension widgets — bumped when a turn ran a tool a
  // manifest declares as widget-refreshing, exactly as `/chat` bumps it.
  const [widgetRefreshKey, setWidgetRefreshKey] = useState(0);
  const promptRef = useRef<PromptFieldHandle | null>(null);
  const widgetSubmitRef = useRef<WidgetSubmitHandle | null>(null);

  const hasActiveStream = streamingCount > 0;
  const isStreaming = useCallback(
    (messageId: string) => streamingRef.current.has(messageId),
    [],
  );

  // A host that resolves no extension catalog still gets the SAME runtime the
  // catalog-bearing host gets — an empty one from the same factory — rather than
  // a bespoke "no widgets" detector. The detection shape is then identical on
  // every surface, and adding a widget-bearing extension needs no host edit.
  const widgetRuntime = useMemo(
    () => createChatWidgetRuntime(widgets, widgetManifests),
    [widgets, widgetManifests],
  );

  const runTurn = useCallback(
    async (history: UiMessage[]) => {
      const assistantId = generateId();
      const abort = new AbortController();
      streamingRef.current.set(assistantId, abort);
      setStreamingCount(streamingRef.current.size);
      onTurnStatusChange?.("running");
      const wire: AssistantTurnRequestMessage[] = history.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
      }));
      let failed = false;
      try {
        await driveAssistantChatTurn({
          threadId,
          assistantId,
          messages: wire,
          slack: false,
          signal: abort.signal,
          ...(transport?.assistant ? { assistant: transport.assistant } : {}),
          ...(transport ? { authHeaders: transport.authHeaders } : {}),
          ...(transport ? { credentialsMode: transport.credentialsMode } : {}),
          ui: {
            updateMessages: (updater) => {
              const next = updater(listRef.current);
              failed = next.some((m) => m.id === assistantId && !!m.error);
              writeMessages(next);
            },
            setTypingIndicator: () => {},
            isWidgetRefreshTool: widgetRuntime.isWidgetRefreshTool,
            onWidgetRefresh: () => setWidgetRefreshKey((k) => k + 1),
          },
        });
      } finally {
        streamingRef.current.delete(assistantId);
        setStreamingCount(streamingRef.current.size);
        onTurnStatusChange?.(failed ? "error" : abort.signal.aborted ? "idle" : "finished");
      }
    },
    [onTurnStatusChange, threadId, transport, widgetRuntime.isWidgetRefreshTool, writeMessages],
  );

  const onSubmit = useCallback(
    (value: string) => {
      const text = value.trim();
      if (!text || hasActiveStream) return;
      promptRef.current?.clear();
      // The uploaded-but-unsent files belong to THIS turn — taken (and cleared)
      // at submit, exactly as `/chat` takes its own buffer, so the wire carries
      // them and the next turn does not.
      const attachments = takePendingAttachments?.();
      const userMessage: UiMessage = {
        id: generateId(),
        role: "user",
        content: text,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      };
      const history = [...listRef.current, userMessage];
      writeMessages(history);
      void runTurn(history);
    },
    [hasActiveStream, runTurn, takePendingAttachments, writeMessages],
  );

  /**
   * Edit a user message (or "Try again" on the response below it): truncate the
   * thread AT that message, replace it, and re-run from there — the same
   * semantics as `/chat`'s single-stream ChatGPT mode.
   */
  const onEditAndResend = useCallback(
    (messageId: string, newContent: string) => {
      if (hasActiveStream) return;
      const current = listRef.current;
      const idx = current.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      const original = current[idx];
      const edited: UiMessage = {
        ...original,
        content: newContent,
        // Attachments belong to the TURN, not to the text: editing the words
        // must not silently drop the files the turn was asked about.
        ...(original.attachments && original.attachments.length > 0
          ? { attachments: original.attachments }
          : {}),
      };
      const history = [...current.slice(0, idx), edited];
      // Everything from the edit point down is deliberately gone, and the host's
      // next save has to SAY so. `idx + 1` because the edited message keeps its
      // own id here (unlike `/chat`, which mints a fresh one) — it is being
      // rewritten in place, not removed, so asserting its removal would be a
      // lie about a message the payload still carries.
      const removed = buildTruncationIntent(current, idx + 1, streamingRef.current.keys());
      for (const id of removed) {
        const pending = removedMessageIdsRef.current;
        // Re-asserting an id makes it the NEWEST assertion, in revision and in
        // order, so a confirm for the previous one can no longer clear it and
        // an eviction reaches it last.
        pending.delete(id);
        if (pending.size >= MAX_PENDING_REMOVED_MESSAGE_IDS) {
          // THE EVICTION, AND WHAT IT COSTS — stated here, at the line that
          // drops a nameable removal, rather than left to the constant.
          //
          // The OLDEST assertion goes. Its removal becomes re-assertable NEVER:
          // no later save carries it, so that turn's run-bound row can fold back
          // in above the edited prompt on the next reload — the permanent undo
          // this intent exists to prevent, for that one message. The bound is
          // taken anyway because the alternative has no ceiling at all: a widget
          // save is best-effort and silent, so a host whose saves keep failing
          // accumulates every id it ever truncated, for the life of the panel,
          // and posts all of them on every save that does get through.
          const oldest = pending.keys().next().value;
          if (typeof oldest === "string") pending.delete(oldest);
        }
        removalRevisionRef.current += 1;
        pending.set(id, removalRevisionRef.current);
      }
      writeMessages(history);
      void runTurn(history);
    },
    [hasActiveStream, runTurn, writeMessages],
  );

  /** The removals this column has truncated and not yet had saved. The host
   *  puts them on its next write; they stay here until it confirms they
   *  landed, so a save that silently failed does not lose the assertion. The
   *  array handed out is the token `confirm` is matched against — see below. */
  const peekRemovedMessageIds = useCallback(() => {
    const ids = [...removedMessageIdsRef.current.keys()];
    removalSnapshotsRef.current.set(ids, new Map(removedMessageIdsRef.current));
    return ids;
  }, []);
  /** A save carrying exactly these ids came back OK — drop them, and ONLY those
   *  whose assertion is still the one that save carried. An id re-asserted
   *  since (the message came back and a later edit removed it again) has a newer
   *  revision than the snapshot taken when this array was peeked, and survives:
   *  its removal has not been saved by anyone yet. An array this hook did not
   *  hand out carries no snapshot and therefore clears nothing — keeping an
   *  assertion costs an id in one payload, dropping one loses a removal for
   *  good, and this module takes the first every time. */
  const confirmRemovedMessageIds = useCallback((ids: string[]) => {
    const carried = removalSnapshotsRef.current.get(ids);
    for (const id of ids) {
      const standing = removedMessageIdsRef.current.get(id);
      if (standing !== undefined && carried?.get(id) === standing) {
        removedMessageIdsRef.current.delete(id);
      }
    }
  }, []);

  const onStop = useCallback(() => {
    for (const controller of streamingRef.current.values()) controller.abort();
  }, []);

  // Abort every in-flight turn when the column goes away (codex round 2). The
  // embed used to hold its own controller and abort it when the bridge tore
  // down; the registry lives here now, so the cleanup has to live here too. A
  // widget panel closed mid-answer would otherwise leave the stream reading —
  // and its `updateMessages` writing — into an unmounted tree. The registry is
  // read through the ref, so this runs once per mount and never re-subscribes.
  useEffect(() => {
    const registry = streamingRef.current;
    return () => {
      for (const controller of registry.values()) controller.abort();
    };
  }, []);

  const onEditStarted = useCallback(() => setRequestEditMessageId(null), []);
  const onTogglePause = useCallback(() => {}, []);

  return {
    messages,
    isSlackMode: false as const,
    animating: false as const,
    activeThreadId: threadId,
    assistantHandleMap: EMPTY_HANDLE_MAP,
    taggedAssistantUserIds: NO_TAGGED_IDS,
    pausedParticipants: NO_PAUSED,
    onTogglePause,
    requestEditMessageId,
    onRequestEditMessage: setRequestEditMessageId,
    onEditStarted,
    streamingCount,
    isStreaming,
    onEditAndResend,
    peekRemovedMessageIds,
    confirmRemovedMessageIds,
    widgetRuntime,
    widgetSubmitRef,
    widgetRefreshKey,
    pendingExternalHandle: null,
    typingIndicators: EMPTY_TYPING,
    promptRef,
    onSubmit,
    onStop,
  };
}
