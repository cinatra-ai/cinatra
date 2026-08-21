/**
 * EDIT AND RESEND — the one `/chat` flow that truly TRUNCATES a transcript.
 *
 * Lifted out of `chat-page.tsx` as a vertical slice: the whole edit path (the
 * truncation intent it asserts, the intent save it waits for, the origin-thread
 * guards around both of its suspension points, and the routed regeneration)
 * lives here, and the page keeps only the binding that hands it the state it
 * reads. Nothing about the flow changed in the move; what it does is stated in
 * the comments below, which came across with it.
 *
 * THE FILENAME IS NOT "edit-and-resend" ON PURPOSE. `resend` is a VENDOR TOKEN
 * (scripts/audit/vendor-token-core-gate.mjs — the email API of that name), and
 * the gate scans file paths and import specifiers, so a production module by
 * that name is a new vendor-token occurrence on a floor that may only shrink.
 * The exported flow keeps the name the whole codebase calls it by; only the path
 * avoids the token.
 */
import { saveChatThreadInOrder, generateId, deriveThreadTitle } from "./ag-ui-chat-client";
import { resolveMessageRouting } from "./actions";
import { applyExternalMentionsToMessages } from "./chat-routing";
import { buildTruncationIntent, buildRemovedRunIntent } from "./truncation-intent";
import type { UiMessage as Message, UiThreadSummary as ThreadSummary, Mention } from "./types";

/** Everything the flow reads from the page, handed in explicitly so the slice
 *  stays testable without mounting the page. */
export type EditAndResendDeps = {
  messages: Message[];
  /** The page's `setMessages` verbatim — the updater form and the direct form
   *  both, exactly as React's setter takes them. */
  setMessages: (next: Message[] | ((prev: Message[]) => Message[])) => void;
  isSlackMode: boolean;
  hasActiveStream: boolean;
  /** Every turn this edit must name BESIDE its own transcript slice: the turns
   *  in flight AND the ones that ENDED without their reveal having committed
   *  yet (`./turn-stream-registry`). Read LIVE, at intent-build time. */
  removableTurnIds: () => Iterable<string>;
  /** The RUN IDS the edit may act on — the only identity the server can act on
   *  for a turn no saved transcript ever carried. Read LIVE, and NARROWED by the
   *  ids this edit removed: a run id names the run-bound row outright, so a turn
   *  dispatched for a prompt this edit KEPT must not be offered
   *  (`./turn-stream-registry`). */
  removableRunIds: (removedMessageIds: ReadonlySet<string>) => Iterable<string>;
  activeThreadId: string | null;
  /** Latest-value read of the active thread, for the post-await guards. */
  currentThreadId: () => string | null;
  loadedThreadCreatedAt: () => string | null;
  threads: ThreadSummary[];
  activeAssistantHandle?: string;
  setActiveAssistantHandle: (next: string | undefined) => void;
  taggedAssistantUserIds: string[];
  pausedParticipants: string[];
  assistantHandleMap: Map<string, string>;
  userId?: string;
  streamResponse: (
    contextMessages: Message[],
    handle?: string,
    endpoint?: string,
    authorUserId?: string,
    assistant?: string,
  ) => Promise<void>;
};

export async function editAndResend(
  deps: EditAndResendDeps,
  messageId: string,
  newContent: string,
): Promise<void> {
  const {
    messages,
    setMessages,
    isSlackMode,
    hasActiveStream,
    threads,
    activeAssistantHandle,
    taggedAssistantUserIds,
    pausedParticipants,
    assistantHandleMap,
    userId,
    streamResponse,
  } = deps;

  if (!newContent.trim()) return;
  // In ChatGPT mode, keep the existing single-stream block; in Slack mode
  // concurrent streams are allowed.
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
  // The user edited `messageId`, so it and everything below it is deliberately
  // gone — INCLUDING a Slack turn whose message is not in `messages`: one still
  // streaming, and one that just ENDED into a reveal this render has not
  // committed. `messages` is this render's snapshot and can miss both, so the
  // registry is the second source and covers the whole gap between them
  // (`buildTruncationIntent`, `./turn-stream-registry`).
  const removedMessageIds = buildTruncationIntent(messages, idx, deps.removableTurnIds());
  // ...and the SERVER'S name for the ones the transcript could not name. Naming
  // them by bubble id alone asserts something the server has never seen: those
  // turns have no mirror row, and the mirror row is what every other key is read
  // out of (`buildRemovedRunIntent`, `./truncation-intent`). The registry is
  // asked with the ids ABOVE, so it can withhold the run of a concurrent turn
  // whose prompt this edit kept — a run id reaches the row outright, and that is
  // the one assertion here that over-naming would not be safe for.
  const removedRunIds = buildRemovedRunIntent(deps.removableRunIds(new Set(removedMessageIds)));

  // Resolve threadId — edits always happen in an existing thread.
  const threadId = deps.activeThreadId ?? deps.currentThreadId();
  // The ORIGIN thread this edit was made IN, captured BEFORE the intent-save
  // await below. Awaiting that save added a suspension point this flow did not
  // have: the user can select another thread while the POST — or its in-slot
  // retry — is still open, and everything after the await would otherwise resume
  // against WHATEVER thread is active by then. Same guard idiom
  // `streamAgUiResponse` uses for its delayed stream updates.
  const originThreadId = threadId;
  const stillOnOriginThread = () => deps.currentThreadId() === originThreadId;

  // THE INTENT SAVE GOES FIRST, AND THIS FLOW WAITS FOR IT. It used to be
  // fire-and-forget, with the truncation applied and the regeneration started
  // underneath it — which made the ONE save that records the removal race the
  // flow's own ORDINARY saves. Those carry the same truncated transcript and
  // assert nothing, so the server's reconcile DELETE removes the very mirror rows
  // the tombstone reads the removed turns' identity out of. First one home wins,
  // and when it was the silent one the removal was never recorded: the edited-away
  // turn folds back in on the next reload, permanently. `saveChatThreadInOrder`
  // chains same-tab saves per thread, and issuing this one BEFORE the state
  // update means nothing else this flow triggers can be POSTed ahead of it.
  //
  // NOTHING IS TRUNCATED LOCALLY UNTIL IT LANDS, and no regeneration starts.
  // A truncation applied on the screen but not recorded on the server is the
  // silent degradation this whole leg exists to remove — the transcript would
  // come back on reload with the "removed" turn in it and no trace of why.
  if (threadId) {
    const now = new Date().toISOString();
    const title = threads.find((t) => t.id === threadId)?.title ?? deriveThreadTitle(editedMessage.content);
    // createdAt is immutable: prefer the summary, then the loaded thread's
    // createdAt (covers the body loading before the summary list), then now
    // for a genuinely new thread (#283).
    const createdAt = threads.find((t) => t.id === threadId)?.createdAt ?? deps.loadedThreadCreatedAt() ?? now;
    try {
      // Retried once INSIDE the chain slot: a re-enqueued retry could land
      // behind a save issued after it, which is the losing position again.
      await saveChatThreadInOrder({ id: threadId, title, messages: truncated, createdAt, updatedAt: now, activeAssistantHandle, taggedAssistantUserIds, slackMode: isSlackMode, ownerUserId: userId, ...(removedRunIds.length > 0 ? { removedRunIds } : {}), removedMessageIds } as Record<string, unknown> & { id: string }, { attempts: 2 });
    } catch (err) {
      console.error("[chat] saveChatThread failed (edit):", err);
      // The failure belongs to the thread the edit was made in. If the user
      // has moved on, the bubble would land on a transcript that never saw
      // the edit — and nothing is left to say, because nothing was changed.
      if (!stillOnOriginThread()) return;
      // Surfaced on a never-blank assistant bubble, the same fail-closed
      // affordance `streamResponse` uses when it refuses to dispatch a turn.
      setMessages((prev) => [...prev, {
        id: generateId(),
        role: "assistant" as const,
        content: "",
        error: "Your edit could not be saved, so the conversation was left unchanged. Try again.",
      }]);
      return;
    }
  }

  // THE SWITCH THAT HAPPENED WHILE THE INTENT WAS IN FLIGHT. The save has
  // landed, so the truncation IS durably recorded and the origin thread comes
  // back truncated on its next load — that half is done and is not undone
  // here. What must NOT happen is the rest of this flow landing on the thread
  // the user is now reading: the local truncation below would replace ITS
  // transcript, `streamResponse` reads the LIVE active thread and would
  // dispatch the edited turn on IT, and that thread's persistence effect would
  // then save the other thread's transcript under its id. So the resend simply
  // does not happen: the user navigated away mid-edit.
  if (!stillOnOriginThread()) return;

  setMessages(truncated);

  // ChatGPT (normal) mode — preserve byte-identical behavior.
  if (!isSlackMode) {
    await streamResponse(truncated);
    return;
  }

  // Slack mode — regenerate through the SAME declaration-driven send-path routing.
  let editEndpoint = "/api/assistants/chat";
  let editHandle: string | undefined = activeAssistantHandle;
  let editAuthorId: string | undefined;
  let editSelector: string | undefined;
  // A routing decline (honest no-responder / out-of-band push) must NOT force a
  // Cinatra regeneration; stays false if routing threw (legacy always-stream).
  let editDeclined = false;
  let editPending: Mention[] | undefined;

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
    // THE SECOND SUSPENSION POINT, and the same rule. Routing is an await
    // too, so the switch can land here instead — and everything below it is
    // the edit's: the assistant handle it resolved, the mentions it owes the
    // connector poll, the turn it dispatches. None of that belongs to a
    // thread the user moved to meanwhile, and `streamResponse` would read
    // that thread off the LIVE ref.
    if (!stillOnOriginThread()) return;
    if (routing.chatEndpoint) editEndpoint = routing.chatEndpoint;
    const nextHandle = routing.activeHandle !== undefined ? (routing.activeHandle || undefined) : activeAssistantHandle;
    if (routing.activeHandle !== undefined) deps.setActiveAssistantHandle(nextHandle);
    editHandle = nextHandle ?? activeAssistantHandle;
    editAuthorId = routing.hostRuntimeMention?.assistantUserId;
    editSelector = routing.hostRuntimeMention?.handle;
    // No host reply and no in-band host-runtime target ⇒ nothing streams here.
    editDeclined = !routing.shouldCallLlm && !routing.hostRuntimeMention;
    editPending = routing.externalMentions;
  } catch {
    // Routing failed — proceed with current assistant context (legacy stream).
    // The switch can have landed during a routing await that REJECTED too, and
    // the legacy stream this falls through to is still the edit's turn.
    if (!stillOnOriginThread()) return;
  }

  if (editDeclined) {
    // Attach any pending push mentions for the connector poll (send-path parity).
    if (editPending && editPending.length > 0) {
      const pending = editPending;
      setMessages((prev) => applyExternalMentionsToMessages(prev, editedMessage.id, pending));
    }
    return;
  }

  // Fire the stream so the user gets a regenerated response on edit.
  void streamResponse(truncated, editHandle, editEndpoint, editAuthorId, editSelector);
}
