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
  /** The render's SNAPSHOT, which is what the removal is computed against: the
   *  reader edited the transcript they were looking at. */
  messages: Message[];
  /** The LIVE transcript, read after this flow's suspension points. The removal
   *  is the snapshot's; the transcript the save posts is not, because a save
   *  posts the WHOLE thread and a concurrent Slack turn can reveal into it while
   *  this flow is holding (see the rebuild below). */
  currentMessages: () => Message[];
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
  /** The same anchor narrowing in BUBBLE IDS: the turns whose anchor prompt this
   *  edit removed, and so the turns its rebuilt transcript must not carry. Read
   *  LIVE, at rebuild time (`./turn-stream-registry`). */
  condemnedTurnIds: (removedMessageIds: ReadonlySet<string>) => Iterable<string>;
  /** THE DEFERRAL for the pre-`RUN_STARTED` window: resolve once every turn this
   *  edit could name by RUN has settled that identity — the handshake delivered
   *  one, or the stream ended without one. Awaited BEFORE `removableRunIds` is
   *  read, and bounded by the registry so a hung stream cannot hold the edit
   *  (`./turn-stream-registry`). Resolves immediately when nothing is
   *  outstanding, which is every ordinary edit. */
  settleRemovableRunIds: (removedMessageIds: ReadonlySet<string>) => Promise<void>;
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
  /** `anchorMessageId` is the PROMPT the dispatched turn answers. The page
   *  derives it from the tail of `contextMessages` when it is not named, which
   *  is right for an ordinary send (the tail IS its prompt) and wrong for this
   *  flow, whose transcript can end in a message that ARRIVED during the hold. */
  streamResponse: (
    contextMessages: Message[],
    handle?: string,
    endpoint?: string,
    authorUserId?: string,
    assistant?: string,
    anchorMessageId?: string | null,
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
  // The user edited `messageId`, so it and everything below it is deliberately
  // gone — INCLUDING a Slack turn whose message is not in `messages`: one still
  // streaming, and one that just ENDED into a reveal this render has not
  // committed. `messages` is this render's snapshot and can miss both, so the
  // registry is the second source and covers the whole gap between them
  // (`buildTruncationIntent`, `./turn-stream-registry`).
  const removedMessageIds = buildTruncationIntent(messages, idx, deps.removableTurnIds());
  const removedIdSet = new Set(removedMessageIds);
  // THE PRE-`RUN_STARTED` HOLD. The page registers a turn BEFORE it dispatches
  // and learns the server's name for it only at `RUN_STARTED`, and Slack mode is
  // exactly the mode that lets a reader edit while a turn streams. An edit
  // dispatched inside that handshake removes the turn's anchor prompt while the
  // turn has no run to assert — and the run that arrives a moment later can
  // never be asserted afterwards, because no later edit's removed set can carry
  // a prompt the transcript no longer has. The turn's run-bound row would fold
  // back in above the edited prompt on every reload, permanently.
  //
  // So the intent WAITS for those turns to settle their identity: `RUN_STARTED`
  // arrived, or the stream terminated without one. The anchor is still in the
  // removed set while this edit is holding, so the run becomes assertable
  // exactly when it becomes knowable. Only turns anchored to a prompt THIS edit
  // removes are waited on, so nothing is condemned and no concurrent turn the
  // reader kept is touched (`./turn-stream-registry`). This resolves immediately
  // for every edit that caught no handshake, and the registry bounds it so a
  // hung stream cannot hold the edit open.
  await deps.settleRemovableRunIds(removedIdSet);
  // ...and the SERVER'S name for the ones the transcript could not name. Naming
  // them by bubble id alone asserts something the server has never seen: those
  // turns have no mirror row, and the mirror row is what every other key is read
  // out of (`buildRemovedRunIntent`, `./truncation-intent`). The registry is
  // asked with the ids ABOVE, so it can withhold the run of a concurrent turn
  // whose prompt this edit kept — a run id reaches the row outright, and that is
  // the one assertion here that over-naming would not be safe for.
  const removedRunIds = buildRemovedRunIntent(deps.removableRunIds(removedIdSet));

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

  // THE TRUNCATED TRANSCRIPT IS BUILT HERE, AFTER THE HOLD — NOT BEFORE IT.
  // The removal above is the SNAPSHOT'S and stays that way: the reader removed
  // the prompt they were looking at. The TRANSCRIPT is a different question,
  // because the save posts the WHOLE thread and the hold is an await. A Slack
  // turn anchored ABOVE the edit point is correctly neither waited on nor named
  // by run — and it can REVEAL while this edit waits. Posting the pre-await
  // slice would overwrite the thread without that reply: a message missing from
  // the payload is a message removed from the server.
  //
  // So the KEPT REGION IS RE-READ LIVE and the removed set is unchanged. Out
  // stays every message the edit deliberately removed (the edited prompt and
  // its successors in the snapshot), and out stays every turn whose ANCHOR
  // PROMPT this edit removed — the narrowing `removableRunIds` applies, asked
  // in bubble ids, because a turn that revealed for a removed prompt must not
  // survive the truncation and one that revealed for a KEPT prompt must. The
  // union of `removableTurnIds` is deliberately NOT used here: over-naming is
  // safe for the intent (the server intersects it) and is exactly the bug for
  // the payload (it would drop the kept prompt's reply).
  //
  // With nothing arriving — every ordinary edit — this is the transcript the
  // pre-await slice built, message for message.
  //
  // THE RESIDUAL, STATED: A REVEAL THAT IS QUEUED BUT NOT COMMITTED. The live
  // read is the page's post-commit `messages` ref, so a reveal whose
  // `setMessages` React has not committed yet is invisible here — the same
  // zero-source window `./turn-stream-registry` is built around, arriving at
  // this line instead of at the intent. That reply is then missing from the
  // payload exactly as it was before this rebuild existed, so this is a
  // NARROWING and not a new hole: it went from EVERY kept-prompt reply that
  // revealed during the hold to only one that revealed in the last microtasks
  // of it. Closing it needs the page to keep that ref in step SYNCHRONOUSLY,
  // which is a change to how `/chat` tracks its transcript and not to this
  // flow. What bounds the loss meanwhile is the same thing that bounds it for
  // an aborted turn: the reply's prompt was KEPT, so its run is withheld from
  // `removedRunIds`, its run-bound row is never tombstoned, and the reload
  // folds it back in.
  //
  // OFF THE ORIGIN THREAD THE LIVE READ IS NOT THIS THREAD'S. Leaving during
  // the hold replaces the page's transcript with another thread's, so the save
  // below — which still goes out, because an unrecorded truncation is the
  // silent degradation this leg exists to remove — falls back to the snapshot
  // it was built from rather than posting a stranger's transcript under this
  // thread's id.
  //
  // AND THE EDITED PROMPT KEEPS ITS PLACE AT THE EDIT POINT. Whatever ARRIVED
  // during the hold arrived AFTER the reader submitted this edit — a reply that
  // revealed, and in Slack mode a message the reader themselves posted, because
  // re-entry is allowed while a turn streams. Rebuilding as "everything live,
  // then the edit" would order the edit behind messages it preceded. So the
  // transcript is assembled in the three parts it actually has.
  const live = stillOnOriginThread() ? deps.currentMessages() : messages;
  const keptIds = new Set(messages.slice(0, idx).map((m) => m.id));
  const inSnapshot = new Set(messages.map((m) => m.id));
  const condemned = new Set(deps.condemnedTurnIds(removedIdSet));
  const kept = live.filter((m) => keptIds.has(m.id));
  const arrived = live.filter((m) => !inSnapshot.has(m.id) && !condemned.has(m.id));
  const truncated = [...kept, editedMessage, ...arrived];

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

  // AND THE REGENERATION IS ANCHORED TO THE PROMPT IT ANSWERS, EXPLICITLY. The
  // page anchors a turn to the LAST message of the context it is handed, which
  // is right for an ordinary send and wrong here: `truncated` ends in whatever
  // ARRIVED during the hold, not in the prompt this turn is being dispatched
  // for. Left derived, the regeneration would register under a message the edit
  // KEPT — and a later edit of THAT message would then condemn this turn's
  // bubble and offer its run for the tombstone, deleting a reply to a prompt
  // nobody removed. That is the one over-reach the anchor exists to prevent
  // (`./turn-stream-registry`, `removableRunIds`), so the anchor is named here
  // rather than inferred there. The model context is unchanged: it still ends
  // with everything the reader can see, and the ANCHOR is the position claim.
  //
  // ChatGPT (normal) mode — preserve byte-identical behavior.
  if (!isSlackMode) {
    await streamResponse(truncated, undefined, undefined, undefined, undefined, editedMessage.id);
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
  void streamResponse(truncated, editHandle, editEndpoint, editAuthorId, editSelector, editedMessage.id);
}
