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
  useLayoutEffect,
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
import { buildTruncationIntent, buildRemovedRunIntent } from "./truncation-intent";
import { createTurnStreamRegistry } from "./turn-stream-registry";
import { startScrollSettlePin, type ScrollSettlePass } from "./scroll-settle";
import {
  COMPOSER_RESERVED_SPACE_FLOOR_PX,
  composerReservedSpacePx,
} from "./composer-reserved-space";
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

  // -------------------------------------------------------------------------
  // THE ROOM THE COMPOSER STANDS IN (cinatra#3044).
  // -------------------------------------------------------------------------
  // The composer is drawn over the bottom of this stream, opaque, so the stream
  // has to reserve the height it actually occupies — see
  // `./composer-reserved-space`. Measured from the composer's own box, on
  // layout, and again whenever that box changes: the notice row that names the
  // bound card appears and disappears, and the prompt wraps.
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerReservedSpace, setComposerReservedSpace] = useState(
    COMPOSER_RESERVED_SPACE_FLOOR_PX,
  );
  const measureComposer = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    const next = composerReservedSpacePx(el.offsetHeight);
    setComposerReservedSpace((prev) => (prev === next ? prev : next));
  }, []);
  useLayoutEffect(() => {
    measureComposer();
  }, [measureComposer, composerNotice, messages, streamingCount]);
  useEffect(() => {
    const el = composerRef.current;
    // A resize observer is the only thing that catches a prompt wrapping under
    // the reader's own typing. Where the environment has none, the layout pass
    // above is the whole measurement and the floor covers the rest.
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureComposer());
    observer.observe(el);
    return () => observer.disconnect();
  }, [measureComposer]);

  // The pin re-fires when the reservation moves: the stream just got taller or
  // shorter beneath the last element, and the bottom it was pinned to moved
  // with it.
  useEffect(() => {
    scrollToBottom();
  }, [
    messages,
    streamingCount,
    pendingExternalHandle,
    typingIndicators,
    scrollToBottom,
    composerReservedSpace,
  ]);

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
        data-conversation-stream
        className="min-h-0 flex-1 overflow-y-auto pt-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        // THE ROOM THE COMPOSER STANDS IN, MEASURED (cinatra#3044). It used to
        // be the constant `pb-24`, and everything the composer grew past that
        // covered the newest content — an arriving card was read through
        // whatever was left above the composer's top edge. See
        // `./composer-reserved-space` for why the old constant is kept as the
        // floor and why the fix is space rather than a z-order.
        style={{ paddingBottom: `${composerReservedSpace}px` }}
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
        <div
          ref={composerRef}
          data-conversation-composer
          className="absolute bottom-0 left-4 right-4 bg-background pb-3 pt-0"
        >
          {composerNotice}
          <PromptField
            ref={promptRef}
            editorTestId="chat-prompt-input"
            // §I INPUT HIERARCHY. The conversation's chat box is the ONE primary
            // input, and every field a card in the stream carries is drawn
            // subordinate to it. Declared HERE, once: `/chat` and the embedded
            // widget mount this same column, so the widget's composer reads as
            // primary by construction rather than by a second opt-in that could
            // drift.
            primary
            conformanceId="chat-composer-primary"
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

/**
 * THE SAVE TOKEN: which assertions one save carried, stated explicitly.
 *
 * The ids alone cannot say it. An id can be asserted TWICE — the save carrying
 * the first assertion may still be open when the turn that follows folds that
 * message back into the list and a later edit removes it again — and those are
 * two different removals, so a confirm that simply subtracted its ids cleared
 * whichever assertion happened to be standing. The fix is a REVISION per
 * assertion, and the token is the snapshot of the revisions the peek handed out.
 *
 * It is DATA, not an identity. The previous round keyed that snapshot on the
 * ids array object itself, held in a `WeakMap` — so any host that copied,
 * rebuilt or serialized the array between the peek and the confirm handed back
 * an array the hook had never seen, whose snapshot was therefore absent, and the
 * confirm silently cleared NOTHING. A confirmed removal that never clears is
 * re-asserted in every later save and, at the cap, evicts newer assertions to
 * make room for itself, forever (codex round 3, finding 3). So the token carries
 * what the confirm needs, in plain pairs that survive anything a host does to
 * them that preserves JSON, and the array object means nothing at all.
 */
export type RemovedMessageIdsSaveToken = {
  /** `[id, revision]` for every assertion standing when the peek was taken. */
  readonly revisions: ReadonlyArray<readonly [string, number]>;
  /** The same, for the RUN half of the intent — `[runId, revision]`. Kept apart
   *  from the ids because the two are different names for the same removal and a
   *  confirm has to clear exactly what its save carried of each. */
  readonly runRevisions: ReadonlyArray<readonly [string, number]>;
  /** THE TRANSCRIPT THE SAVE CARRIED, by message id. A save that LANDS is what
   *  proves the server has a MIRROR ROW for every turn in it — the row the
   *  ordinary key is read out of — so the column releases the registry's run
   *  ledger for exactly those turns on the confirm, and for no others
   *  (`./turn-stream-registry`, `noteSavedTranscript`). Recorded at peek time
   *  rather than read at confirm time: a turn that revealed while the save was
   *  open is NOT in the save that landed, and releasing it would drop the one
   *  identity an edit could still have asserted about it. */
  readonly savedMessageIds: readonly string[];
};

/** What `peekRemovedMessageIds` hands a host: the ids to put on the wire, and
 *  the token to hand back to `confirmRemovedMessageIds` once they land. */
export type PeekedRemovedMessageIds = {
  ids: string[];
  /** THE STREAMING HALF of the same intent (cinatra#2823 S9j): the RUN IDS of
   *  the removed turns the server has no mirror row for. A widget save is
   *  best-effort and silent, so a turn whose save never landed left no row for
   *  the bubble id to reach — the run id is the only identity both sides hold
   *  for it. Empty is the ordinary case and means the ids alone say everything.
   */
  runIds: string[];
  saveToken: RemovedMessageIdsSaveToken;
};

/**
 * Record ONE assertion into a pending map, under the cap. Used for both halves
 * of the intent — the removed message ids and the removed run ids — so the two
 * cannot drift in revision discipline or in what a bound costs them.
 */
function assertRemoval(
  pending: Map<string, number>,
  key: string,
  revisionRef: { current: number },
): void {
  // Re-asserting a key makes it the NEWEST assertion, in revision and in order,
  // so a confirm for the previous one can no longer clear it and an eviction
  // reaches it last.
  pending.delete(key);
  if (pending.size >= MAX_PENDING_REMOVED_MESSAGE_IDS) {
    // THE EVICTION, AND WHAT IT COSTS — stated here, at the line that drops a
    // nameable removal, rather than left to the constant.
    //
    // The OLDEST assertion goes. Its removal becomes re-assertable NEVER: no
    // later save carries it, so that turn's run-bound row can fold back in above
    // the edited prompt on the next reload — the permanent undo this intent
    // exists to prevent, for that one message or that one run. The bound is
    // taken anyway because the alternative has no ceiling at all: a widget save
    // is best-effort and silent, so a host whose saves keep failing accumulates
    // every removal it ever asserted, for the life of the panel, and posts all
    // of them on every save that does get through.
    const oldest = pending.keys().next().value;
    if (typeof oldest === "string") pending.delete(oldest);
  }
  revisionRef.current += 1;
  pending.set(key, revisionRef.current);
}

const NO_PAUSED: string[] = [];
const NO_TAGGED_IDS: string[] = [];
const EMPTY_HANDLE_MAP = new Map<string, string>();
const EMPTY_TYPING = new Map<string, string>();

// ---------------------------------------------------------------------------
// THE REPAIR A LATER SERVER READING CARRIES (cinatra#3051, fix leg 9).
//
// IT LIVES HERE, beside its one caller, rather than in a module of its own:
// `/chat`'s reachable first-party graph is a locked budget (the route-graph
// ratchet), a ceiling may only ever shrink, and a file of eighty lines with a
// single consumer is not worth a module of the route's budget.
// ---------------------------------------------------------------------------

/**
 * WHAT A LATER SERVER READING ADDS TO A TURN THE COLUMN ALREADY HAS
 * (cinatra#3051, the ninth proof round's live-update finding).
 *
 * THE MEASUREMENT. With the run `completed` and its review gate `pending`, two
 * third-party pages that had been open since before the dispatch drew no review
 * slot, no placeholder and no review card for ten minutes (243 samples); a page
 * loaded afterwards drew the card from the persisted turn in about 36 seconds.
 * The same round measured the same silence one moment earlier: at the run's
 * schedule moment the widget drew zero schedule cards.
 *
 * WHY A NEW-MESSAGE SEAM COULD NOT SEE IT. A lifecycle card is not delivered as
 * a message. `src/lib/lifecycle/lifecycle-run-outbox.ts` writes it INTO the turn
 * that dispatched the run, and the thread read hands that turn back under the id
 * the page already knows — "a turn the spine ALREADY CARRIES is repaired, never
 * duplicated" (`assembleThreadPayloadFromParts`). So the whole delivery, on an
 * open page, is a repair to a message already on screen, and a seam that only
 * appended new messages was structurally unable to carry it. A reload read the
 * same turn and drew the card, which is exactly the asymmetry measured.
 *
 * THIS MODULE IS THE REPAIR, AND NOTHING ELSE. It is the client-side twin of the
 * server's own fold-in rule and is bounded the same way: it adds LIFECYCLE RENDER
 * STATE — a renderable view, or the run pinned on a producing call — to a message
 * the column already holds, and it can do nothing else. Every other field of the
 * reader's own copy is returned untouched by construction, because the result is
 * built FROM that copy and only ever grows.
 *
 * THE FOUR RULES, each one a way of losing somebody's work if it is left out:
 *
 *   • IT ONLY EVER ADDS. Content, role, order, thought groups, citations and
 *     attachments are the reader's own; a server reading never replaces one. The
 *     open page is the page somebody has been reading and writing into.
 *
 *   • A CARD IS ADDED ONCE, wherever it already sits. Identity is the card's own
 *     `viewType|ref` — the same key the server's outbox dedupes on
 *     (`turnAlreadyCarriesCard`) — read across BOTH places a turn can hold a
 *     card, so a card slotted on a step is never added again at turn level (or
 *     the other way round) by the next look.
 *
 *   • A VIEW GOES BACK ON ITS PRODUCING STEP, or at turn level if that step is
 *     not in the reader's trace. That is the same resolution the durable
 *     projection makes for an unplaceable stamp, and it is what keeps a card
 *     that cannot be placed from being dropped.
 *
 *   • A RUN IS PINNED ONLY WHERE NOTHING IS PINNED. A call already naming a run
 *     is the client's own record of its own dispatch; a server reading never
 *     moves it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it never adds a `tool_call` the reader's
 * trace does not have. A step arriving late would land at the end of a trace
 * that has already been read in order, and the turn would read as a sequence
 * nobody saw. Its cards are not lost — they fold in at turn level, which is
 * where a card with no producing step belongs.
 */


type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A card's identity, or null for a payload that is not a renderable view. The
 *  same `viewType|ref` pair the server's own one-card rule keys on. */
function viewIdentity(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const viewType = raw.viewType;
  const ref = raw.ref;
  if (typeof viewType !== "string" || viewType.length === 0) return null;
  if (typeof ref !== "string" || ref.length === 0) return null;
  return `${viewType}|${ref}`;
}

function partsOf(message: UiMessage | undefined): Rec[] {
  const parts = (message as unknown as { parts?: unknown }).parts;
  return Array.isArray(parts) ? parts.filter(isRecord) : [];
}

/**
 * THE SECOND CARRIAGE OF A SLOT (cinatra#2825's Slack projection). A pinned
 * layout that omits the ordered `parts` still may not omit the anchor a
 * lifecycle card mounts at, so it carries the slots — and only the slots — on
 * `lifecycleParts`, and the view reads `parts ?? lifecycleParts`. A card
 * already carried THERE is already on screen, so the repair below must read it
 * too or it would add a second copy of the same card.
 */
function lifecyclePartsOf(message: UiMessage | undefined): Rec[] {
  const parts = (message as unknown as { lifecycleParts?: unknown }).lifecycleParts;
  return Array.isArray(parts) ? parts.filter(isRecord) : [];
}

function turnLevelViewsOf(message: UiMessage | undefined): unknown[] {
  const dataParts = (message as unknown as { dataParts?: unknown }).dataParts;
  return Array.isArray(dataParts) ? dataParts : [];
}

function slottedViewsOf(part: Rec): unknown[] {
  return Array.isArray(part.views) ? (part.views as unknown[]) : [];
}

/** Every card identity this message already carries, from every place one can sit. */
function cardsAlreadyCarried(message: UiMessage): Set<string> {
  const carried = new Set<string>();
  for (const raw of turnLevelViewsOf(message)) {
    const id = viewIdentity(raw);
    if (id !== null) carried.add(id);
  }
  for (const part of [...partsOf(message), ...lifecyclePartsOf(message)]) {
    for (const raw of slottedViewsOf(part)) {
      const id = viewIdentity(raw);
      if (id !== null) carried.add(id);
    }
  }
  return carried;
}

/**
 * The reader's copy of a turn, plus whatever lifecycle render state the server's
 * reading of the SAME turn has that it does not. `null` when there is nothing to
 * add — which is the ordinary answer, and the one that lets the column keep the
 * identity of its list and render nothing.
 */
function lifecycleRepairFor(local: UiMessage, server: UiMessage): UiMessage | null {
  if (local.role !== "assistant") return null;

  const carried = cardsAlreadyCarried(local);
  const localParts = partsOf(local);
  const serverParts = partsOf(server);
  const localCallIds = new Set(
    localParts
      .filter((p) => p.kind === "tool_call" && typeof p.id === "string")
      .map((p) => p.id as string),
  );

  // The views the server holds and this copy does not, kept in the server's own
  // order and tagged with the call they were produced by (null = turn level).
  const owed: Array<{ slot: string | null; view: unknown }> = [];
  const claim = (slot: string | null, raw: unknown) => {
    const id = viewIdentity(raw);
    if (id === null || carried.has(id)) return;
    carried.add(id);
    // A view whose producing step is not in the reader's trace folds in at turn
    // level — the same resolution the durable projection makes for a slot that
    // names a call the trace does not have.
    owed.push({ slot: slot !== null && localCallIds.has(slot) ? slot : null, view: raw });
  };
  for (const part of serverParts) {
    const slot = typeof part.id === "string" ? part.id : null;
    for (const raw of slottedViewsOf(part)) claim(slot, raw);
  }
  for (const raw of turnLevelViewsOf(server)) claim(null, raw);

  // The runs the server pinned on calls this copy has unpinned.
  const owedRuns = new Map<string, string>();
  for (const part of serverParts) {
    if (part.kind !== "tool_call") continue;
    const id = typeof part.id === "string" ? part.id : null;
    const runId = typeof part.runId === "string" && part.runId.length > 0 ? part.runId : null;
    if (id === null || runId === null || !localCallIds.has(id)) continue;
    const localPart = localParts.find((p) => p.kind === "tool_call" && p.id === id);
    if (localPart === undefined) continue;
    if (typeof localPart.runId === "string" && localPart.runId.length > 0) continue;
    owedRuns.set(id, runId);
  }

  const slotted = owed.filter((o) => o.slot !== null);
  const atTurnLevel = owed.filter((o) => o.slot === null).map((o) => o.view);
  if (slotted.length === 0 && atTurnLevel.length === 0 && owedRuns.size === 0) return null;

  const nextParts =
    slotted.length === 0 && owedRuns.size === 0
      ? localParts
      : localParts.map((part) => {
          if (part.kind !== "tool_call") return part;
          const id = typeof part.id === "string" ? part.id : null;
          if (id === null) return part;
          const mine = slotted.filter((o) => o.slot === id).map((o) => o.view);
          const run = owedRuns.get(id);
          if (mine.length === 0 && run === undefined) return part;
          const next: Rec = { ...part };
          if (mine.length > 0) next.views = [...slottedViewsOf(part), ...mine];
          if (run !== undefined) next.runId = run;
          return next;
        });

  return {
    ...local,
    // Field-presence discipline: a key is written only when this repair has
    // something to put in it, so a turn that owed only a pinned run serializes
    // exactly as it did before.
    ...(nextParts === localParts ? {} : { parts: nextParts }),
    ...(atTurnLevel.length > 0
      ? { dataParts: [...turnLevelViewsOf(local), ...atTurnLevel] }
      : {}),
  } as UiMessage;
}

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
  // THE TURN REGISTRY `/chat` keeps, and it is the SAME MODULE (cinatra#2823
  // S9j). It was a bare `Map<assistantId, AbortController>` here — `isStreaming`
  // read it, the stop control aborted it, its size was `streamingCount` — and a
  // bare map has no room for the one thing the truncation below needs: the
  // SERVER'S own name for each turn.
  //
  // A bubble id is minted HERE. The server's link from such an id to the
  // run-bound row that survives a truncation runs through the turn's MIRROR ROW,
  // and a whole-transcript save is what writes that row. A widget save is
  // best-effort and SILENT, so a turn whose save never landed has no row at all:
  // its bubble id asserts a name the server has never seen, the reconcile DELETE
  // cannot reach the run-bound row, and the removed turn folds back in above the
  // edited prompt on the next reload. The RUN ID is the identity both sides
  // hold, `driveAssistantChatTurn` reports it on every mode, and this column
  // simply never took it.
  //
  // Reusing the registry rather than growing a second mechanism is the point:
  // the ledger, the instance token, the anchor filter, the cap and the
  // two-halves release rule are ONE implementation, so a `/chat` fix to any of
  // them is a widget fix (`./turn-stream-registry`).
  const turnStreams = useMemo(() => createTurnStreamRegistry(), []);
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
  // finding 4). WHICH revisions a save carried is stated by the SAVE TOKEN the
  // peek hands out (`RemovedMessageIdsSaveToken`), never inferred from the ids
  // array's object identity. Insertion order is the assertion order, which is
  // what makes "evict the oldest" meaningful at the cap below.
  const removedMessageIdsRef = useRef<Map<string, number>>(new Map());
  /** THE REMOVALS THAT ARE SETTLED (cinatra#3051 convergence). An assertion
   *  leaves the pending map the moment a save that carried it lands — but the
   *  server read that was already in flight when that save landed still has the
   *  turn in it, and it answers AFTER the assertion is gone. Adopting that
   *  answer would put a removal the reader already saved straight back, which is
   *  the same permanent undo the pending map exists to prevent, one beat later.
   *  So a confirmed removal is remembered here for the life of the mount: ids
   *  only, never messages, and only ever consulted by the adoption below. */
  const settledRemovalIdsRef = useRef<Set<string>>(new Set());
  /** THE RUN HALF of the same outstanding intent, held on exactly the same terms
   *  — one revision per assertion, the same counter, the same cap, released by
   *  the same confirm. Separate map because the two are different names for one
   *  removal and the wire carries them in different fields. */
  const removedRunIdsRef = useRef<Map<string, number>>(new Map());
  const removalRevisionRef = useRef(0);
  // Remount key for mounted extension widgets — bumped when a turn ran a tool a
  // manifest declares as widget-refreshing, exactly as `/chat` bumps it.
  const [widgetRefreshKey, setWidgetRefreshKey] = useState(0);
  const promptRef = useRef<PromptFieldHandle | null>(null);
  const widgetSubmitRef = useRef<WidgetSubmitHandle | null>(null);

  const hasActiveStream = streamingCount > 0;
  const isStreaming = useCallback(
    (messageId: string) => turnStreams.has(messageId),
    [turnStreams],
  );

  // A COMMITTED transcript releases the BUBBLE-ID half of every ended turn it
  // carries — the same effect `/chat` runs, for the same reason: from here the
  // edit's own snapshot names the turn, so the ledger has nothing to add. The
  // RUN half waits for a save that LANDED, which is what `confirmRemovedMessageIds`
  // reports on this surface (`./turn-stream-registry`).
  useEffect(() => {
    turnStreams.noteCommittedTranscript(messages);
  }, [messages, turnStreams]);

  // THE LEDGER'S THREAD BOUNDARY. Its entries belong to the thread they streamed
  // in, and no other thread's transcript or save would ever release them, so a
  // panel re-pointed at a different thread must drop them rather than let an
  // edit over there assert removals about turns that ran somewhere else. The
  // registry decides that on the THREAD; the first observation of an empty
  // registry is an adoption, so a mount (and React's double-invoked mount
  // effect) resets nothing.
  //
  // The streaming COUNT needs no correction here, unlike `/chat`'s: every write
  // of it in this column reads `turnStreams.size()` rather than adjusting a
  // number, and each aborted drive's own `finally` runs one. A reset empties the
  // map, so the next `finally` reports zero.
  useEffect(() => {
    turnStreams.resetForThread(threadId);
  }, [threadId, turnStreams]);

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
      // THIS instance's token. The `finally` closes over the token, never over
      // the id: an assistant id is reusable, and an `end` looked up by one
      // reaches whatever turn is wearing it now. `anchorMessageId` is the PROMPT
      // this turn was dispatched to answer — the last message of the history it
      // was given — which is how the intent tells a turn below an edit point
      // from one above it.
      const token = turnStreams.begin(
        assistantId,
        abort,
        history[history.length - 1]?.id ?? null,
      );
      setStreamingCount(turnStreams.size());
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
            // THE SERVER'S OWN NAME FOR THIS TURN, taken exactly as `/chat`
            // takes it and gated on the same instance token — a superseded drive
            // must never stamp its run onto the turn wearing its id now. The
            // port is idempotent; the driver reports on every fold.
            noteRunId: (runId) => {
              turnStreams.noteRunId(token, runId);
            },
            isWidgetRefreshTool: widgetRuntime.isWidgetRefreshTool,
            onWidgetRefresh: () => setWidgetRefreshKey((k) => k + 1),
          },
        });
      } finally {
        // The turn stays NAMEABLE by the truncation intent after this: `end`
        // moves it to the ledger, which releases the bubble id on the reveal's
        // commit and the run on a save that landed.
        turnStreams.end(token);
        setStreamingCount(turnStreams.size());
        onTurnStatusChange?.(failed ? "error" : abort.signal.aborted ? "idle" : "finished");
      }
    },
    [onTurnStatusChange, threadId, transport, turnStreams, widgetRuntime.isWidgetRefreshTool, writeMessages],
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
      const removed = buildTruncationIntent(current, idx + 1, turnStreams.removableTurnIds());
      // ...and the SERVER'S name for the removed turns it has no mirror row for.
      //
      // THE SET ASKED ABOUT IS THE TRANSCRIPT SLICE, NOT `removed`. A run id
      // names the run-bound row outright, so under-naming is the fail-closed
      // direction here and the query must be exact: `removed` unions in whatever
      // the registry could name, which is deliberately generous for BUBBLE ids
      // (the server intersects those with the rows the payload dropped) and
      // would be a claim this column cannot support if it reached a run.
      //
      // AND IT INCLUDES THE REWRITTEN MESSAGE. This column edits in place,
      // keeping the id — so `messageId` is not REMOVED and is rightly absent
      // from the assertion on the wire — but every turn anchored to it answered
      // a prompt that no longer says what it said, and is just as superseded as
      // the turns below it. `/chat` mints a fresh id and gets this for free; here
      // it is stated (`removableRunIds`, `./turn-stream-registry`).
      const invalidatedPrompts = new Set<string>();
      for (const message of current.slice(idx)) {
        if (typeof message.id === "string" && message.id.length > 0)
          invalidatedPrompts.add(message.id);
      }
      const removedRuns = buildRemovedRunIntent(turnStreams.removableRunIds(invalidatedPrompts));
      for (const id of removed) assertRemoval(removedMessageIdsRef.current, id, removalRevisionRef);
      for (const runId of removedRuns)
        assertRemoval(removedRunIdsRef.current, runId, removalRevisionRef);
      writeMessages(history);
      void runTurn(history);
    },
    [hasActiveStream, runTurn, turnStreams, writeMessages],
  );

  /** The removals this column has truncated and not yet had saved: the `ids` to
   *  put on the write, and the SAVE TOKEN naming the assertions those ids stand
   *  for. They stay here until the host confirms they landed, so a save that
   *  silently failed does not lose the assertion. Peeking does not consume, and
   *  the host may do anything JSON-preserving to either half — nothing here is
   *  keyed on an object's identity (`RemovedMessageIdsSaveToken`). */
  const peekRemovedMessageIds = useCallback(
    (savedMessages?: UiMessage[]): PeekedRemovedMessageIds => {
      const pending = removedMessageIdsRef.current;
      const pendingRuns = removedRunIdsRef.current;
      // `savedMessages` is the transcript the save is about to carry. The host
      // passes what it posts, so the confirm can release the run ledger for
      // exactly the turns that save gave a mirror row and for no others; a caller
      // that passes nothing gets this column's current list, which is the same
      // thing for every host that peeks at save time.
      const carried = savedMessages ?? listRef.current;
      return {
        ids: [...pending.keys()],
        runIds: [...pendingRuns.keys()],
        saveToken: {
          revisions: [...pending],
          runRevisions: [...pendingRuns],
          savedMessageIds: carried
            .map((m) => m.id)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        },
      };
    },
    [],
  );
  /** The save that carried this token came back OK — drop the assertions it
   *  actually carried, and only those. An id re-asserted since (the message came
   *  back and a later edit removed it again) has a newer revision standing than
   *  the token records, and survives: its removal has not been saved by anyone
   *  yet. A token from no peek of this column names no standing revision and so
   *  clears nothing — keeping an assertion costs an id in one payload, dropping
   *  one loses a removal for good, and this module takes the first every time. */
  const confirmRemovedMessageIds = useCallback(
    (saveToken: RemovedMessageIdsSaveToken) => {
      const pending = removedMessageIdsRef.current;
      for (const [id, carried] of saveToken?.revisions ?? []) {
        if (pending.get(id) === carried) {
          pending.delete(id);
          // SETTLED, not forgotten — a read still in flight from before this
          // save will answer with the turn still in it.
          settledRemovalIdsRef.current.add(id);
        }
      }
      const pendingRuns = removedRunIdsRef.current;
      for (const [runId, carried] of saveToken?.runRevisions ?? []) {
        if (pendingRuns.get(runId) === carried) pendingRuns.delete(runId);
      }
      // THE SAVE LANDED, so every turn it carried now has a MIRROR ROW and the
      // ordinary key takes over for it: the registry releases those turns
      // entirely, which is what keeps the run ledger from holding every turn this
      // panel ever streamed. Only the transcript the save actually carried is
      // released — a turn that revealed while the save was open is not in it, and
      // releasing that one would drop the only identity a later edit could
      // assert about it (`./turn-stream-registry`).
      const saved = saveToken?.savedMessageIds ?? [];
      if (saved.length > 0) turnStreams.noteSavedTranscript(saved.map((id) => ({ id })));
    },
    [turnStreams],
  );

  const onStop = useCallback(() => {
    // NOT a reset: stopping does not leave the thread, so each aborted turn is
    // ended by its own drive into the ledger and stays nameable — which is the
    // whole point of stopping one.
    turnStreams.abortAll();
  }, [turnStreams]);

  // Abort every in-flight turn when the column goes away (codex round 2). The
  // embed used to hold its own controller and abort it when the bridge tore
  // down; the registry lives here now, so the cleanup has to live here too. A
  // widget panel closed mid-answer would otherwise leave the stream reading —
  // and its `updateMessages` writing — into an unmounted tree. `reset` rather
  // than `abortAll`: the ledger's ids belong to a panel that is gone, and there
  // is no later transcript or save here to release them. The registry identity
  // is stable for the mount, so this runs once and never re-subscribes.
  useEffect(() => {
    return () => {
      turnStreams.reset();
    };
  }, [turnStreams]);

  /**
   * THE ONE WAY A LATER SERVER READING MAY ENTER AN ALREADY-MOUNTED COLUMN
   * (cinatra#3051).
   *
   * Until this existed, a column's list was seeded ONCE — at mount, from
   * `initialMessages` — and nothing could ever add to it but a turn taken in
   * this browser. On a third-party page that is the whole defect: a panel opened
   * at ten past cannot learn that a run was released at twenty past, however
   * long the person leaves it open, because the only reading it ever took was
   * the one it took before the run existed.
   *
   * IT IS THE WEAKEST THING THAT CLOSES THAT, and each of the three rules below
   * is a different way of losing somebody's work if it is left out:
   *
   *   • IT ONLY EVER ADDS. A server reading never replaces, re-orders or edits a
   *     message already on screen. The list a reader is looking at is the one
   *     they have been reading and writing into; a wholesale swap for a snapshot
   *     taken somewhere else is how an unsaved edit disappears.
   *
   *   • IT ADOPTS NOTHING WHILE A TURN IS LIVE. A streaming turn is folding into
   *     this list token by token, and a server reading taken mid-stream is a
   *     picture of a conversation that is still moving. The look that answered
   *     during a turn is simply dropped; the next one, after the turn settled,
   *     carries the same news.
   *
   *   • IT NEVER FOLDS BACK A TURN AN OPEN EDIT REMOVED. An edit truncates the
   *     transcript and holds a standing removal assertion until a save that
   *     carried it lands. The server still has those turns until then, so
   *     adopting blind would put the reader's edit straight back — the permanent
   *     undo the truncation intent exists to prevent, arrived at from a new
   *     direction.
   *
   *   • IT TAKES THE TAIL AND NOTHING BUT THE TAIL. Additions are appended, so
   *     the part of a server reading this seam may take is the part after the
   *     last message the column already knows. A message the server holds
   *     BEFORE that point would arrive at the end of the list and read as a
   *     conversation nobody had in that order.
   *
   *   • IT NEVER FOLDS BACK A REMOVAL THAT WAS ALREADY SAVED. A read that set
   *     off before the save that carried a removal answers after it, with the
   *     removed turn still in it. The assertion has gone by then, so the
   *     settled-removal ids are what refuse it.
   *
   * Returns HOW MANY it took, so a caller can tell "nothing new" from "nothing
   * happened"; when it took none, the list keeps its identity and no render
   * follows.
   */
  const adoptServerMessages = useCallback(
    (serverMessages: readonly UiMessage[] | null | undefined): number => {
      if (!Array.isArray(serverMessages) || serverMessages.length === 0) return 0;
      // A live turn owns the list. Say nothing and let the next look carry it.
      if (turnStreams.size() > 0) return 0;
      const current = listRef.current;
      const known = new Set(
        current
          .map((m) => m.id)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      );
      // THE TAIL, AND ONLY THE TAIL. Everything this column takes is appended,
      // so the only part of the server's reading it may take is the part that
      // comes AFTER the last message it already knows: taking one from the
      // middle would append a turn that belongs earlier and leave the reader
      // looking at a conversation in an order nobody spoke it in. An unknown
      // message the server has BEFORE that point is not lost — it is simply not
      // this seam's to place, and a reload puts the whole reading in order.
      let tailStart = 0;
      for (let i = 0; i < serverMessages.length; i += 1) {
        const id = serverMessages[i]?.id;
        if (typeof id === "string" && known.has(id)) tailStart = i + 1;
      }
      const removed = removedMessageIdsRef.current;
      const settled = settledRemovalIdsRef.current;
      const additions: UiMessage[] = [];
      for (let i = tailStart; i < serverMessages.length; i += 1) {
        const message = serverMessages[i];
        const id = message?.id;
        if (typeof id !== "string" || id.length === 0) continue;
        if (known.has(id)) continue;
        // A standing removal assertion is a reader's edit that has not been
        // saved yet. The server has not heard about it; this column has.
        if (removed.has(id)) continue;
        // A SETTLED removal is a reader's edit that HAS been saved. A read that
        // set off before that save still carries the turn; the column does not
        // take it back.
        if (settled.has(id)) continue;
        known.add(id);
        additions.push(message);
      }
      // THE REPAIR — AND WHY AN ADDITION ALONE WAS NEVER GOING TO CARRY THE
      // CARD (cinatra#3051, the ninth proof round's live-update finding).
      //
      // A lifecycle card is not delivered as a message. The outbox writes it
      // INTO the turn that dispatched the run, and the thread read hands that
      // turn back under the id this column already knows — "a turn the spine
      // ALREADY CARRIES is repaired, never duplicated". So on a page that
      // stayed open the whole delivery is a repair to a message already on
      // screen, and the tail rule above, correct as it is, can never see one:
      // the id is known, so every look skipped it. The round measured exactly
      // that — no review slot, no placeholder, no card for ten minutes on the
      // open pages, and the card in about thirty-six seconds on a page loaded
      // afterwards, from the same turn.
      //
      // The repair adds LIFECYCLE RENDER STATE and can do nothing else
      // (`lifecycleRepairFor` below): it never replaces content, never
      // re-orders, never removes, and adds each card once however many times
      // the look repeats. Everything the addition rules above protect is
      // protected here by construction, because a repaired message is built
      // from the reader's own copy and only ever grows.
      const serverById = new Map<string, UiMessage>();
      for (const message of serverMessages) {
        const id = message?.id;
        if (typeof id !== "string" || id.length === 0) continue;
        if (!serverById.has(id)) serverById.set(id, message);
      }
      let repairs = 0;
      const repaired = current.map((message) => {
        const id = message?.id;
        if (typeof id !== "string" || id.length === 0) return message;
        const server = serverById.get(id);
        if (server === undefined) return message;
        const next = lifecycleRepairFor(message, server);
        if (next === null) return message;
        repairs += 1;
        return next;
      });
      if (additions.length === 0 && repairs === 0) return 0;
      writeMessages([...(repairs === 0 ? current : repaired), ...additions]);
      return additions.length + repairs;
    },
    [turnStreams, writeMessages],
  );

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
    adoptServerMessages,
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
